import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryVault, recoveryObject, exportRecoveryBundle, verifyRecoveryBundle, RECOVERY_LIMITS } from '../src/recovery.js';
import { canonicalBytes, sha256Bytes } from '../src/layer1-uor/custody.js';
import { demoProgram, createCheckpoint } from '../src/layer4-compute/replay.js';
import { generateAuthority, signPointer } from '../src/layer1-uor/pointer.js';
const empty = () => ({ version: 1, objects: [], jobs: [], anchors: [] });
const wire = value => new TextDecoder().decode(canonicalBytes(value, { maxBytes: RECOVERY_LIMITS.wireBytes, maxStringLength: 131072, maxEntries: 262144 }));
async function fixture() {
  const bundle = empty();
  bundle.objects.push(await recoveryObject(new TextEncoder().encode('recover me')));
  const program = demoProgram(5);
  bundle.jobs.push({ program, checkpoint: await createCheckpoint(program, 3) });
  return bundle;
}
test('roundtrip restores exact object and replay evidence without host effects', async () => {
  const vault = new RecoveryVault();
  const bundle = await fixture();
  const exported = await exportRecoveryBundle(bundle);
  const result = await vault.import(exported);
  assert.equal(result.entries, 2); assert.deepEqual(result.effects, []);
  assert.equal(result.durability, 'session-only');
  assert.equal(new TextDecoder().decode(await vault.objectBytes(bundle.objects[0].manifest.object.contentDigest)), 'recover me');
  assert.equal(await vault.export(), exported);
  await vault.import(exported); // exact duplicate is idempotent evidence
  assert.equal(vault.snapshot().entries, 2);
});
test('maximum live object survives export/import, reduced operator cap refuses', async () => {
  const bundle = empty(); const bytes = new Uint8Array(128 * 1024); bytes[bytes.length - 1] = 199;
  bundle.objects.push(await recoveryObject(bytes));
  const exported = await exportRecoveryBundle(bundle); const vault = new RecoveryVault();
  await vault.import(exported);
  assert.deepEqual(await vault.objectBytes(bundle.objects[0].manifest.object.contentDigest), bytes);
  await assert.rejects(new RecoveryVault({ wireBytes: 1000 }).import(exported));
});
test('corruption, partial objects, unknown fields, noncanonical and duplicate evidence refuse atomically', async () => {
  const vault = new RecoveryVault(); const bundle = await fixture(); await vault.import(wire(bundle));
  const before = vault.snapshot();
  const cases = [];
  let bad = structuredClone(bundle); bad.objects[0].fragments[0].hex = '00'; cases.push(wire(bad));
  bad = structuredClone(bundle); bad.objects[0].fragments.pop(); cases.push(wire(bad));
  bad = structuredClone(bundle); bad.objects.push(bad.objects[0]); cases.push(wire(bad));
  bad = structuredClone(bundle); bad.privateKey = 'secret'; cases.push(wire(bad));
  cases.push(wire(bundle) + ' '); cases.push('{"version":1,"version":1,"objects":[],"jobs":[],"anchors":[]}');
  for (const invalid of cases) { await assert.rejects(vault.import(invalid)); assert.deepEqual(vault.snapshot(), before); }
});
test('forged state with recomputed digest fails replay, foreign model fails identity', async () => {
  const bundle = await fixture(); const checkpoint = bundle.jobs[0].checkpoint;
  checkpoint.stateHex = '0x1';
  const { checkpointDigest, ...body } = checkpoint;
  checkpoint.checkpointDigest = await sha256Bytes(canonicalBytes(body), 'checkpoint');
  await assert.rejects(verifyRecoveryBundle(wire(bundle)), /checkpoint-replay/);
  checkpoint.modelDigest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(verifyRecoveryBundle(wire(bundle)), /checkpoint-model/);
});
test('direct successor without retained predecessor does not overwrite evidence', async () => {
  const bundle = await fixture(); const vault = new RecoveryVault(); await vault.import(wire(bundle));
  const before = vault.snapshot(); bundle.jobs[0].checkpoint = await createCheckpoint(bundle.jobs[0].program, 4);
  await assert.rejects(vault.import(wire(bundle)), /conflict/); assert.deepEqual(vault.snapshot(), before);
});
test('aggregate limits precede replay and bound merged entries', async () => {
  const bundle = await fixture();
  await assert.rejects(new RecoveryVault({ replaySteps: 2 }).import(wire(bundle)), /replay-limit/);
  const vault = new RecoveryVault({ entries: 2 }); await vault.import(wire(bundle)); const before = vault.snapshot();
  const more = empty(); more.objects.push(await recoveryObject(new Uint8Array([1])));
  await assert.rejects(vault.import(wire(more)), /capacity/); assert.deepEqual(vault.snapshot(), before);
});
test('anchors stay untrusted; separate exact recent consent, signature, expiry and conflict required', async () => {
  const authority = await generateAuthority(); const bundle = empty();
  const anchor = await signPointer({ version: 1, name: 'example', authorityKey: authority.publicKey, revision: 7,
    previousDigest: 'sha256:' + 'a'.repeat(64), objectRoot: 'sha256:' + 'b'.repeat(64), validFromMs: 10, validUntilMs: 100 }, authority.privateKey);
  bundle.anchors.push(anchor); const vault = new RecoveryVault(); await vault.import(wire(bundle));
  assert.deepEqual(vault.snapshot().acceptedAnchors, []);
  const approval = { name: anchor.name, authorityKey: authority.publicKey, expectedDigest: anchor.pointerDigest, nowMs: 20, operatorAccepted: true };
  for (const patch of [{ operatorAccepted: false }, { expectedDigest: 'sha256:' + 'c'.repeat(64) }, { nowMs: 100 }, { nowMs: 9 }]) {
    await assert.rejects(vault.acceptRecentAnchor({ ...approval, ...patch })); assert.deepEqual(vault.snapshot().acceptedAnchors, []);
  }
  assert.deepEqual(await vault.acceptRecentAnchor(approval), anchor);
  const copy = new RecoveryVault(); await copy.import(await vault.export());
  assert.deepEqual(copy.snapshot().acceptedAnchors, []); // trust never transits a file
});
test('concurrent imports cannot lose a committed update', async () => {
  const a = await fixture(), b = empty(); b.objects.push(await recoveryObject(new Uint8Array([2])));
  const vault = new RecoveryVault(); const result = await Promise.allSettled([vault.import(wire(a)), vault.import(wire(b))]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
});

test('monotonic job progress imports; stale state and forked direct links refuse atomically', async () => {
  const bundle = await fixture(); const vault = new RecoveryVault(); await vault.import(wire(bundle));
  const older = wire(bundle); bundle.jobs[0].checkpoint = await createCheckpoint(bundle.jobs[0].program, 4, bundle.jobs[0].checkpoint);
  await vault.import(wire(bundle)); assert.equal(vault.snapshot().bundle.jobs[0].checkpoint.stepIndex, 4);
  const before = vault.snapshot(); await assert.rejects(vault.import(older), /rollback/); assert.deepEqual(vault.snapshot(), before);
});
test('new signed anchor evidence retains old trust until separate exact acceptance', async () => {
  const authority = await generateAuthority(); const bundle = empty();
  const base = { version: 1, name: 'example', authorityKey: authority.publicKey, revision: 7,
    previousDigest: 'sha256:' + 'a'.repeat(64), objectRoot: 'sha256:' + 'b'.repeat(64), validFromMs: 10, validUntilMs: 100 };
  const first = await signPointer(base, authority.privateKey); bundle.anchors.push(first);
  const vault = new RecoveryVault(); await vault.import(wire(bundle));
  const approval = { name: base.name, authorityKey: authority.publicKey, nowMs: 20, operatorAccepted: true };
  await vault.acceptRecentAnchor({ ...approval, expectedDigest: first.pointerDigest });
  const second = await signPointer({ ...base, revision: 8, previousDigest: first.pointerDigest }, authority.privateKey);
  bundle.anchors = [second]; await vault.import(wire(bundle));
  assert.equal(vault.snapshot().acceptedAnchors[0].pointerDigest, first.pointerDigest);
  await assert.rejects(vault.acceptRecentAnchor({ ...approval, expectedDigest: first.pointerDigest }));
  await vault.acceptRecentAnchor({ ...approval, expectedDigest: second.pointerDigest });
  assert.equal(vault.snapshot().acceptedAnchors[0].pointerDigest, second.pointerDigest);
  const before = vault.snapshot(); bundle.anchors = [first]; await assert.rejects(vault.import(wire(bundle)), /rollback/);
  assert.deepEqual(vault.snapshot(), before);
});
test('explicit codec budgets preserve bytes and reject invalid bounds', () => {
  const value = { unicode: 'é', integer: 17, list: [true, null] };
  assert.deepEqual(canonicalBytes(value), canonicalBytes(value, { maxBytes: 1000, maxDepth: 8, maxEntries: 100, maxStringLength: 100 }));
  for (const options of [{ maxBytes: -1 }, { maxEntries: Infinity }, { maxDepth: 1.5 }, { maxStringLength: NaN }]) {
    assert.throws(() => canonicalBytes(value, options));
  }
  assert.throws(() => canonicalBytes({ value: 'é' }, { maxBytes: 13 }));
});

test('typed CONCAT and POW survive recovery with exact widths and priced work admission', async () => {
  const { programWork, resumeProgram, replayProgram } = await import('../src/layer4-compute/replay.js');
  const program = { version: 2, bits: 8, capacityBits: 24, initialValueHex: '0x1', instructions: [
    { op: 14, argBits: 16, argHex: '0x2' }, { op: 17, argBits: 24, argHex: '0x3' }
  ] };
  const checkpoint = await createCheckpoint(program, 1);
  const bundle = { ...empty(), jobs: [{ program, checkpoint }] };
  const encoded = await exportRecoveryBundle(bundle);
  const cost = programWork(program, 0, 1);
  assert.equal((await verifyRecoveryBundle(encoded)).cost.replaySteps, cost);
  assert.ok(cost > checkpoint.stepIndex);
  await assert.rejects(new RecoveryVault({ replaySteps: cost - 1 }).import(encoded), /replay-limit/);
  const vault = new RecoveryVault({ replaySteps: cost }); await vault.import(encoded);
  const restored = vault.snapshot().bundle.jobs[0];
  assert.equal(restored.checkpoint.stateBits, 24);
  const resumed = await resumeProgram(restored.program, restored.checkpoint);
  const expected = replayProgram(program);
  assert.equal(resumed.stateBits, expected.stateBits); assert.equal(resumed.stateHex, expected.stateHex);
  assert.deepEqual(resumed.effects, []);
  assert.equal(await vault.export(), encoded);
});
