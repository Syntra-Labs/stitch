import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryVault, exportRecoveryBundle } from '../src/recovery.js';
import { generateAuthority, signPointer, PointerObserver } from '../src/layer1-uor/pointer.js';
import { model } from '../src/layer1-uor/generated-model.js';
const root = c => `sha256:${c.repeat(64)}`;
async function fixture() {
  const authority = await generateAuthority();
  let now = 20, reservations = 0;
  const body = { version: 1, name: 'state.example', authorityKey: authority.publicKey,
    revision: 7, previousDigest: root('a'), objectRoot: root('b'), validFromMs: 10, validUntilMs: 100 };
  const sign = patch => signPointer({ ...body, ...patch }, authority.privateKey);
  const anchor = await sign({});
  const vault = new RecoveryVault();
  const importAnchor = async pointer => vault.import(await exportRecoveryBundle({ version: 1, objects: [], jobs: [], anchors: [pointer] }));
  const accept = (pointer = anchor) => vault.acceptRecentAnchor({ name: body.name, authorityKey: authority.publicKey,
    expectedDigest: pointer.pointerDigest, nowMs: now, operatorAccepted: true });
  const observer = () => new PointerObserver({ name: body.name, trustedAuthorityKey: authority.publicKey,
    clock: () => now, admission: { reserve() { reservations++; } } });
  await importAnchor(anchor);
  return { authority, anchor, vault, sign, accept, observer, importAnchor, now: value => { now = value; }, reservations: () => reservations };
}
const restore = (observer, f, options = {}) => observer.restoreFromRecovery(f.vault, { expectedDigest: f.anchor.pointerDigest, ...options });
function delayVerification(t) {
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const original = crypto.subtle.verify.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'verify', async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return original(...args);
  });
  return { release, reached };
}

test('source restore guard refuses missing trust, every wrong scope/digest/signature observation, expiry and any different head', () => {
  const allowed = (...args) => model['Stitch.Pointer.restoreAllowed'](...args);
  const good = [true, true, true, true, 10, 100, 20, false, false];
  assert.equal(allowed(...good), true);
  for (const index of [0, 1, 2, 3]) { const bad = [...good]; bad[index] = false; assert.equal(allowed(...bad), false); }
  assert.equal(allowed(true, true, true, true, 10, 100, 9, false, false), false);
  assert.equal(allowed(true, true, true, true, 10, 100, 100, false, false), false);
  assert.equal(allowed(true, true, true, true, 10, 100, 20, true, false), false);
  assert.equal(allowed(true, true, true, true, 10, 100, 20, true, true), true);
  for (let mask = 0; mask < 64; mask++) for (const now of [9, 10, 99, 100]) {
    const [accepted, scope, digest, signature, present, same] = Array.from({ length: 6 }, (_, i) => Boolean(mask & (1 << i)));
    assert.equal(allowed(accepted, scope, digest, signature, 10, 100, now, present, same),
      accepted && scope && digest && signature && 10 <= now && now < 100 && (!present || same));
  }
});

test('import, acceptance and explicit exact-scope live restore are separate; normal strict succession then works', async () => {
  const f = await fixture(), observer = f.observer();
  await assert.rejects(observer.admit(f.anchor), /pointer-bootstrap/);
  await assert.rejects(restore(observer, f), /anchor-not-accepted/);
  assert.equal(observer.head, null);
  await f.accept(); assert.equal(observer.head, null);
  assert.deepEqual(await restore(observer, f), f.anchor);
  const next = await f.sign({ revision: 8, previousDigest: f.anchor.pointerDigest });
  assert.deepEqual(await observer.admit(next), next);
  for (const pointer of [f.anchor, await f.sign({ revision: 10 }), await f.sign({ revision: 9, previousDigest: root('e') })]) {
    await assert.rejects(observer.admit(pointer), /pointer-conflict/); assert.deepEqual(observer.head, next);
  }
  await assert.rejects(restore(observer, f), /pointer-restore-conflict-or-stale/); assert.deepEqual(observer.head, next);
  const restartedVault = new RecoveryVault(); await restartedVault.import(await f.vault.export());
  await assert.rejects(f.observer().restoreFromRecovery(restartedVault, { expectedDigest: f.anchor.pointerDigest }), /anchor-not-accepted/);
});

test('only a branded vault accepted decision qualifies, pins cannot change and mismatched scope/digest refuses', async () => {
  const f = await fixture(); await f.accept(); const observer = f.observer();
  for (const fake of [f.vault.snapshot(), { acceptedAnchor: () => f.anchor }]) {
    await assert.rejects(observer.restoreFromRecovery(fake, { expectedDigest: f.anchor.pointerDigest }));
  }
  await assert.rejects(restore(observer, f, { expectedDigest: root('e') }), /anchor-not-accepted/);
  for (const options of [{ name: 'other', trustedAuthorityKey: f.authority.publicKey },
    { name: f.anchor.name, trustedAuthorityKey: (await generateAuthority()).publicKey }]) {
    await assert.rejects(restore(new PointerObserver(options), f), /anchor-not-accepted/);
  }
  assert.throws(() => { observer.name = 'other'; }, TypeError);
  assert.throws(() => { observer.trustedAuthorityKey = '0'.repeat(64); }, TypeError);
  const changed = f.vault.snapshot(); changed.acceptedAnchors[0].revision = 999;
  assert.deepEqual(await restore(observer, f), f.anchor);
});

test('no different retained head is overwritten, even by an independently accepted newer anchor', async () => {
  const f = await fixture(); await f.accept(); const observer = f.observer();
  const genesis = await f.sign({ revision: 0, previousDigest: null }); await observer.admit(genesis);
  await assert.rejects(restore(observer, f), /pointer-restore-conflict-or-stale/);
  assert.deepEqual(observer.head, genesis); assert.equal(f.reservations(), 1);
});

test('duplicate restore is storage-idempotent and restore/admit share serialized CAS in either order', async () => {
  const f = await fixture(); await f.accept(); let observer = f.observer();
  assert.deepEqual(await Promise.all([restore(observer, f), restore(observer, f)]), [f.anchor, f.anchor]);
  assert.equal(f.reservations(), 1);
  const next = await f.sign({ revision: 8, previousDigest: f.anchor.pointerDigest });
  observer = f.observer();
  const forward = await Promise.allSettled([restore(observer, f), observer.admit(next)]);
  assert.deepEqual(forward.map(r => r.status), ['fulfilled', 'fulfilled']); assert.deepEqual(observer.head, next);
  observer = f.observer();
  const reverse = await Promise.allSettled([observer.admit(next), restore(observer, f)]);
  assert.deepEqual(reverse.map(r => r.status), ['rejected', 'fulfilled']); assert.deepEqual(observer.head, f.anchor);
  observer = f.observer(); const genesis = await f.sign({ revision: 0, previousDigest: null });
  const retainedFirst = await Promise.allSettled([observer.admit(genesis), restore(observer, f)]);
  assert.deepEqual(retainedFirst.map(r => r.status), ['fulfilled', 'rejected']); assert.deepEqual(observer.head, genesis);
});

test('expiry is sampled after async verification; a failed attempt does not poison the queue', async t => {
  const f = await fixture(); await f.accept(); const observer = f.observer(), gate = delayVerification(t);
  const pending = restore(observer, f); await gate.reached; f.now(100); gate.release();
  await assert.rejects(pending, /pointer-restore-conflict-or-stale/); assert.equal(observer.head, null);
  f.now(20); assert.deepEqual(await restore(observer, f), f.anchor);
});

test('a concurrently replaced acceptance and canceled UI scope cannot commit stale restoration', async t => {
  const f = await fixture(); await f.accept(); const observer = f.observer(), gate = delayVerification(t);
  const pending = restore(observer, f); await gate.reached;
  const newer = await f.sign({ revision: 8, previousDigest: f.anchor.pointerDigest });
  await f.importAnchor(newer); await f.accept(newer); gate.release();
  await assert.rejects(pending, /anchor-not-accepted/); assert.equal(observer.head, null);
  await assert.rejects(observer.restoreFromRecovery(f.vault, { expectedDigest: newer.pointerDigest, scopeStillCurrent: () => false }), /pointer-restore-conflict-or-stale/);
  assert.equal(observer.head, null);
});

test('restore rechecks actual signature and local resource refusal preserves missing head', async t => {
  const f = await fixture(); await f.accept();
  const observer = f.observer();
  const verification = t.mock.method(crypto.subtle, 'verify', async () => false);
  await assert.rejects(restore(observer, f), /pointer-signature/); assert.equal(observer.head, null); verification.mock.restore();
  const refused = new PointerObserver({ name: f.anchor.name, trustedAuthorityKey: f.authority.publicKey,
    clock: () => 20, admission: { reserve() { throw Error('budget-exhausted'); } } });
  await assert.rejects(restore(refused, f), /budget-exhausted/); assert.equal(refused.head, null);
});
