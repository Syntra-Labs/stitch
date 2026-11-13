import test from 'node:test';
import { Datum, applyPrimitiveOp } from '../src/layer1-uor/index.js';
import assert from 'node:assert/strict';
import { canonicalBytes, sha256Bytes } from '../src/layer1-uor/custody.js';
import { createCheckpoint, verifyCheckpoint, resumeProgram, replayProgram, demoProgram, identifyProgram } from '../src/layer4-compute/replay.js';
import { generateAuthority, signPointer, admitPointer } from '../src/layer1-uor/pointer.js';
import { createBudget, reserveAction, settleAction, zeroCost } from '../src/layer2-schedulers/policy.js';
import { BudgetPacedSurvivalScheduler } from '../src/layer2-schedulers/index.js';
import { LiveDistributedComputeCoordinator } from '../src/layer4-compute/index.js';
const code = expected => e => e.code === expected;

test('checkpoints replay every operation and resume equals uninterrupted execution', async () => {
  for (const bits of [8, 16, 32, 64, 128]) {
    const instructions = [];
    for (const op of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]) {
      instructions.push(op <= 3 ? { op } : { op, argHex: '0x3' });
    }
    const program = { version: 1, bits, initialValueHex: '0x7', instructions };
    let independent = new Datum(bits, 7n);
    for (const instr of instructions) independent = applyPrimitiveOp(instr.op, independent, instr.argHex ? new Datum(bits, BigInt(instr.argHex)) : null);
    assert.equal(replayProgram(program).stateHex, '0x' + independent.value.toString(16));
    for (let cut = 0; cut <= instructions.length; cut++) {
      const cp = await createCheckpoint(program, cut);
      assert.equal((await verifyCheckpoint(program, cp)).execution, 'replayed');
      assert.equal((await resumeProgram(program, cp)).stateHex, replayProgram(program).stateHex);
    }
  }
});

test('checkpoint tampering, semantic forgery, wrong program and broken links fail', async () => {
  const program = demoProgram(9);
  const first = await createCheckpoint(program, 3);
  const next = await createCheckpoint(program, 6, first);
  assert.equal((await verifyCheckpoint(program, next, first)).predecessor, 'checked');
  await assert.rejects(verifyCheckpoint(program, { ...first, stateHex: '0x0' }), code('checkpoint-integrity'));
  const body = { ...first, stateHex: '0x0' }; delete body.checkpointDigest;
  const forged = { ...body, checkpointDigest: await sha256Bytes(canonicalBytes(body), 'checkpoint') };
  await assert.rejects(verifyCheckpoint(program, forged), code('checkpoint-replay'));
  await assert.rejects(verifyCheckpoint(demoProgram(9, 1n), first), code('program-mismatch'));
  await assert.rejects(verifyCheckpoint(program, next, await createCheckpoint(program, 2)), code('checkpoint-predecessor'));
  await assert.rejects(verifyCheckpoint(program, { ...first, trusted: true }), code('invalid-record'));
  await assert.rejects(identifyProgram({ ...program, instructions: [{ op: 18, argHex: '0x2' }] }), code('unsupported-operation'));
  await assert.rejects(identifyProgram({ ...program, initialValueHex: '0x00' }), code('invalid-ring-value'));
  await assert.rejects(identifyProgram({ ...program, instructions: new Array(4097).fill({ op: 2 }) }), code('program-limit'));
  assert.equal((await createCheckpoint(demoProgram(0), 0)).stateHex, '0x19919');
});

test('single-writer pointers require pinned authority, exact successor and fresh signed data', async () => {
  const alice = await generateAuthority(); const mallory = await generateAuthority();
  const objectRoot = 'sha256:' + 'a'.repeat(64);
  const body = { version: 1, name: 'workspace', authorityKey: alice.publicKey, revision: 0,
    previousDigest: null, objectRoot, validFromMs: 100, validUntilMs: 200 };
  const genesis = await signPointer(body, alice.privateKey);
  const options = { name: 'workspace', trustedAuthorityKey: alice.publicKey, nowMs: 150 };
  assert.deepEqual(await admitPointer(null, genesis, options), genesis);
  const successor = await signPointer({ ...body, revision: 1, previousDigest: genesis.pointerDigest }, alice.privateKey);
  assert.deepEqual(await admitPointer(genesis, successor, options), successor);
  await assert.rejects(admitPointer(successor, genesis, options), code('pointer-conflict'));
  await assert.rejects(admitPointer(null, successor, options), code('pointer-bootstrap'));
  await assert.rejects(admitPointer(genesis, successor, { ...options, nowMs: 200 }), code('pointer-expired'));
  const attacker = await signPointer({ ...body, authorityKey: mallory.publicKey }, mallory.privateKey);
  await assert.rejects(admitPointer(null, attacker, options), code('wrong-authority'));
  const wrongSigner = await signPointer(body, mallory.privateKey);
  await assert.rejects(admitPointer(null, wrongSigner, options), code('pointer-signature'));
  await assert.rejects(admitPointer(null, { ...genesis, objectRoot: 'sha256:' + 'b'.repeat(64) }, options), code('pointer-integrity'));
  await assert.rejects(admitPointer(null, genesis, { ...options, name: 'other' }), code('pointer-name'));
});

test('budget admission is bounded, monotonic, duplicate-safe, and conservative on ambiguous effects', () => {
  const limit = { requests: 2, transferBytes: 100, storageBytes: 50, computeSteps: 10 };
  const initial = createBudget({ epoch: 'run-1', startMs: 100, endMs: 200, limit });
  const requested = { requests: 1, transferBytes: 80, storageBytes: 50, computeSteps: 5 };
  const reserved = reserveAction(initial, { id: 'a', kind: 'place', cost: requested }, 120);
  assert.deepEqual(initial.spent, zeroCost());
  assert.deepEqual(reserved.spent, requested);
  assert.throws(() => reserveAction(reserved, { id: 'b', kind: 'repair', cost: requested }, 130), code('budget-exhausted'));
  assert.throws(() => reserveAction(reserved, { id: 'a', kind: 'repair', cost: zeroCost() }, 130), code('duplicate-action'));
  assert.throws(() => reserveAction(reserved, { id: 'b', kind: 'repair', cost: zeroCost() }, 119), code('clock-regression'));
  assert.throws(() => reserveAction(reserved, { id: 'b', kind: 'repair', cost: zeroCost() }, 200), code('epoch-expired'));
  assert.throws(() => settleAction(reserved, 'a', { ...requested, transferBytes: 81 }), code('reservation-exceeded'));
  const actual = { requests: 1, transferBytes: 20, storageBytes: 25, computeSteps: 3 };
  const settled = settleAction(reserved, 'a', actual);
  assert.deepEqual(settled.spent, actual);
  assert.throws(() => settleAction(settled, 'a', zeroCost()), code('unknown-reservation'));
  assert.throws(() => reserveAction({ ...reserved, spent: zeroCost() }, { id: 'b', kind: 'place', cost: requested }, 130), code('invalid-budget'));
});

test('live scheduler uses an elapsed epoch and enforces its own budget', () => {
  for (const origin of [0, 1700000000]) {
    const scheduler = new BudgetPacedSurvivalScheduler({ durationSeconds: 100, maxRefreshBudget: 2, minFloorSeconds: 1 });
    scheduler.markRefreshed(origin);
    assert.equal(scheduler.markRefreshed(origin + 30), true);
    assert.equal(scheduler.markRefreshed(origin + 60), true);
    assert.equal(scheduler.evaluate(origin + 90).shouldRefresh, false);
    assert.equal(scheduler.markRefreshed(origin + 90), false);
    assert.equal(scheduler.refreshCount - 1, 2);
    assert.throws(() => scheduler.evaluate(origin + 89), /Clock regression/);
  }
});

test('live coordinator rejects forged/legacy checkpoints and replays takeover with no relay by default', async () => {
  const warm = []; const sent = [];
  const transport = { peerId: 'peer-b', openPeers: () => [], broadcast: p => sent.push(p),
    publishWarmEnvelope: async p => warm.push(p), fetchWarmEnvelopes: async () => { throw Error('must not contact relay'); } };
  const coordinator = new LiveDistributedComputeCoordinator({ transport, liveDb: { put: async () => ({ addressHex: 'result' }) } });
  assert.equal(await coordinator.ingestCheckpoint({ type: 'compute_ckpt', verified: true, jobId: 'fake' }), false);
  const program = demoProgram(9);
  const checkpoint = await createCheckpoint(program, 3);
  assert.equal(await coordinator.ingestCheckpoint({ type: 'compute_ckpt', jobId: 'job-1', program, checkpoint, ownerPeerId: 'peer-a' }), true);
  assert.deepEqual(await coordinator.syncAndTakeOverJobs(), ['job-1']);
  await coordinator.running.get('job-1');
  assert.equal(coordinator.jobs.get('job-1').currentValueHex, replayProgram(program).stateHex);
  assert.equal(coordinator.jobs.get('job-1').verification, 'replayed');
  assert.equal(warm.length, 0);
  assert.equal(sent.length, 6);
});

test('live compute publishes stable authenticated owners and takes over only absent routing identities', async () => {
  let initialized = false;
  const sent = [];
  const peers = [{ remoteId: 'key-remote' }];
  const transport = { peerId: 'friendly-local',
    get routingPeerId() { return initialized ? 'key-local' : this.peerId; },
    signaling: { async identity() { initialized = true; return { id: 'key-local' }; } },
    openPeers: () => peers,
    broadcast: packet => sent.push(packet)
  };
  const coordinator = new LiveDistributedComputeCoordinator({ transport,
    liveDb: { put: async () => ({ addressHex: 'result' }) } });
  await coordinator.startOrResumeJob({ jobId: 'own', totalSteps: 0, stepDelayMs: 0 });
  assert.equal(sent[0].ownerPeerId, 'key-local', 'initial work must not publish a transient display identity');
  assert.equal(coordinator.jobs.get('own').sourceTag, 'local:friendly-local');
  const program = demoProgram(3), checkpoint = await createCheckpoint(program, 1);
  assert.equal(await coordinator.ingestCheckpoint({ type: 'compute_ckpt', jobId: 'remote', program,
    checkpoint, ownerPeerId: 'key-remote' }), true);
  assert.equal(await coordinator.ingestCheckpoint({ type: 'compute_ckpt', jobId: 'retained-own', program,
    checkpoint, ownerPeerId: 'key-local' }), true);
  assert.deepEqual(await coordinator.syncAndTakeOverJobs(), [], 'a connected authenticated owner and our own owner are present');
  peers.length = 0;
  assert.deepEqual(await coordinator.syncAndTakeOverJobs(), ['remote']);
  await coordinator.running.get('remote');
  assert.equal(coordinator.jobs.get('remote').status, 'completed');
  assert.equal(coordinator.jobs.get('remote').ownerPeerId, 'key-local');
  assert.equal(coordinator.jobs.get('retained-own').stepIndex, 1, 'local pending work is not a missing remote owner');
});

test('replaced signaling session cannot publish a transient owner while identity resolves', async () => {
  let releaseIdentity, enteredIdentity;
  const gate = new Promise(resolve => { releaseIdentity = resolve; });
  const entered = new Promise(resolve => { enteredIdentity = resolve; });
  const sent = [];
  const transport = { peerId: 'label', routingPeerId: 'key-new',
    signaling: { async identity() { enteredIdentity(); await gate; } },
    openPeers: () => [], broadcast: packet => sent.push(packet)
  };
  const coordinator = new LiveDistributedComputeCoordinator({ transport,
    liveDb: { put: async () => { throw Error('No completed result may be stored'); } } });
  const work = coordinator.startOrResumeJob({ jobId: 'changed-session', totalSteps: 0, stepDelayMs: 0 });
  await entered;
  transport.signaling = { async identity() {} };
  releaseIdentity();
  await assert.rejects(work, code('transport-session-changed'));
  assert.equal(sent.length, 0);
  assert.equal(coordinator.jobs.size, 0);
});
