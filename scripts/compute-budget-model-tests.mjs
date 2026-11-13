/** Source-subset conformance tests, not cryptographic validation or kernel proofs.
 * Digest fixtures are typed host observations; no claim is made that these tokens
 * are real hashes of the records. Canonical wire hashing stays a host obligation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model } from '../src/layer1-uor/generated-model.js';
const call = (name, ...args) => model['Stitch.' + name](...args);
const root = n => Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['w' + i, BigInt(n + i)]));
const changeRoot = r => ({ ...r, w7: r.w7 + 1n });
const digest = expected => ({ expected: structuredClone(expected), observed: structuredClone(expected), domainMatches: true, canonicalSerializationMatches: true });
const observed = (input, expected) => ({ input: structuredClone(input), digest: digest(expected) });
const resources = (transferBytes = 0n, storageBytes = 0n, computeWork = 0n, refreshRequests = 0n) => ({ transferBytes: BigInt(transferBytes), storageBytes: BigInt(storageBytes), computeWork: BigInt(computeWork), refreshRequests: BigInt(refreshRequests) });
const zero = resources();
const clone = x => structuredClone(x);
const supported = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17];
function independentStep(op, x, y, bits) {
  const m = 1n << BigInt(bits), mask = m - 1n;
  const value = [() => -x, () => ~x, () => x + 1n, () => x - 1n,
    () => x + y, () => x - y, () => x * y, () => x ^ y,
    () => x & y, () => x | y, () => BigInt(x <= y), () => BigInt(x < y),
    () => BigInt(x >= y), () => BigInt(x > y), null,
    () => y === 0n ? 0n : x / y, () => y === 0n ? 0n : x % y, () => { let result = 1n; for (const bit of y.toString(2)) { result = result * result & mask; if (bit === '1') result = result * x & mask; } return result; }][op]();
  return value & mask;
}
function replay(job, step) {
  let value = job.initialValue;
  for (const instruction of job.program.instructions.slice(0, Number(step))) value = independentStep(Number(instruction.opcode), value, instruction.argument, job.program.bits);
  return value;
}
function jobCommitments(job) {
  return {
    program: observed({ version: 1n, modelRoot: job.program.modelRoot, bits: job.program.bits, instructions: clone(job.program.instructions) }, job.program.programRoot),
    input: observed({ version: 1n, bits: job.program.bits, value: job.initialValue }, job.inputRoot),
    job: observed({ version: 1n, programRoot: job.program.programRoot, inputRoot: job.inputRoot, modelRoot: job.program.modelRoot, initialValue: job.initialValue }, job.jobRoot)
  };
}
function checkpointCommitments(job, checkpoint) {
  const { jobRoot, programRoot, inputRoot, modelRoot, step, priorRoot, stateRoot, value } = checkpoint;
  return {
    state: observed({ version: 1n, jobRoot, programRoot, inputRoot, modelRoot, bits: job.program.bits, step, value }, stateRoot),
    checkpoint: observed({ version: 1n, jobRoot, programRoot, inputRoot, modelRoot, step, priorRoot, stateRoot, value }, checkpoint.checkpointRoot)
  };
}
function fixture() {
  const job = { jobRoot: root(10), program: { programRoot: root(20), modelRoot: root(30), bits: 8n, instructions: [{ opcode: 4n, argument: 1n }, { opcode: 7n, argument: 3n }, { opcode: 2n, argument: 0n }] }, inputRoot: root(40), initialValue: 255n };
  const checkpoint = (step, previous, identity) => ({ jobRoot: job.jobRoot, programRoot: job.program.programRoot, inputRoot: job.inputRoot, modelRoot: job.program.modelRoot, step, priorRoot: previous, stateRoot: root(identity), checkpointRoot: root(identity + 10), value: replay(job, step) });
  const current = checkpoint(0n, root(50), 60), candidate = checkpoint(2n, current.checkpointRoot, 80);
  return { job, current, candidate, jc: jobCommitments(job), cc: checkpointCommitments(job, current), nc: checkpointCommitments(job, candidate), expectedModelRoot: job.program.modelRoot };
}
const accepted = f => call('Compute.committedCheckpointAllowed', f.job, f.candidate, f.jc, f.nc, 3n, f.expectedModelRoot);
const advance = f => call('Compute.advanceCheckpoint', f.job, f.current, f.candidate, f.jc, f.cc, f.nc, 3n, f.expectedModelRoot);

test('full semantic admission rejects noncanonical operands, unsupported programs and out-of-ring inputs', () => {
  const { job } = fixture();
  assert.equal(call('Compute.jobAllowed', job, 3), true);
  assert.equal(call('Compute.jobAllowed', job, 2), false);
  assert.equal(call('Compute.jobAllowed', { ...job, initialValue: 256n }, 3), false);
  for (const bits of [0, 7, 24, 256]) assert.equal(call('Compute.jobAllowed', { ...job, program: { ...job.program, bits } }, 3), false);
  for (const opcode of [14, 18, 99]) assert.equal(call('Compute.programAllowed', { ...job.program, instructions: [{ opcode, argument: 0 }] }, 3), false);
  for (const opcode of supported) {
    const good = { opcode, argument: opcode < 4 ? 0 : 255 };
    assert.equal(call('Compute.programAllowed', { ...job.program, instructions: [good] }, 1), true);
    assert.equal(call('Compute.programAllowed', { ...job.program, instructions: [{ ...good, argument: opcode < 4 ? 1 : 256 }] }, 1), false);
  }
  for (const field of ['programRoot', 'modelRoot']) assert.equal(call('Compute.programAllowed', { ...job.program, [field]: { ...root(0), w3: 1n << 32n } }, 3), false);
});

test('all supported operations agree with an independent ring interpreter at every supported width', () => {
  for (const bits of [8, 16, 32, 64, 128]) {
    const m = 1n << BigInt(bits), values = [0n, 1n, m / 2n, m - 1n];
    for (const opcode of supported) for (const value of values) for (const argument of values) {
      const instruction = { opcode, argument: opcode < 4 ? 0n : argument };
      assert.equal(call('Compute.ringStep', instruction, value, m), independentStep(opcode, value, instruction.argument, bits));
    }
  }
});

test('every exact typed commitment input and digest observation field is bound', () => {
  const base = fixture();
  assert.equal(accepted(base), true);
  for (const container of ['jc', 'nc']) for (const name of Object.keys(base[container])) {
    const input = base[container][name].input;
    for (const field of Object.keys(input)) {
      const f = clone(base), value = f[container][name].input[field];
      f[container][name].input[field] = typeof value === 'bigint' ? value + 1n : Array.isArray(value)
        ? [...value, { opcode: 2n, argument: 0n }] : changeRoot(value);
      assert.equal(accepted(f), false, `${container}.${name}.input.${field}`);
    }
    for (const side of ['expected', 'observed']) for (let word = 0; word < 8; word++) {
      const f = clone(base);
      f[container][name].digest[side]['w' + word] += 1n;
      assert.equal(accepted(f), false, `${container}.${name}.digest.${side}.w${word}`);
    }
    for (const flag of ['domainMatches', 'canonicalSerializationMatches']) {
      const f = clone(base); f[container][name].digest[flag] = false;
      assert.equal(accepted(f), false, `${container}.${name}.${flag}`);
    }
    const f = clone(base), alien = root(900);
    f[container][name].digest.expected = alien;
    f[container][name].digest.observed = alien;
    assert.equal(accepted(f), false, `${container}.${name}: mutually matching hashes cannot replace the expected root`);
  }
  const wrongModel = clone(base); wrongModel.expectedModelRoot = root(999);
  assert.equal(accepted(wrongModel), false);
  for (const field of ['bits', 'instructions']) {
    const f = clone(base);
    f.job.program[field] = field === 'bits' ? 16n : [{ opcode: 2n, argument: 0n }];
    assert.equal(accepted(f), false, `changed program ${field} under unchanged observed commitment`);
  }
  const changedInput = clone(base); changedInput.job.initialValue = 254n;
  assert.equal(accepted(changedInput), false);
});

test('a self-consistent host commitment to a forged state still fails semantic replay', () => {
  const f = fixture();
  f.candidate.value = 7n;
  f.candidate.stateRoot = root(300);
  f.candidate.checkpointRoot = root(320);
  f.nc = checkpointCommitments(f.job, f.candidate);
  assert.equal(call('Compute.stateCommitted', f.job, f.candidate, f.nc.state), true);
  assert.equal(call('Compute.checkpointCommitted', f.candidate, f.nc.checkpoint), true);
  assert.equal(accepted(f), false);
  assert.deepEqual(advance(f), f.current);
  const unsupported = fixture();
  unsupported.job.program.instructions[0].opcode = 14n;
  unsupported.jc = jobCommitments(unsupported.job);
  assert.equal(accepted(unsupported), false);
});

test('committed checkpoint transitions require both admitted endpoints and the exact retained predecessor', () => {
  const f = fixture();
  assert.deepEqual(advance(f), f.candidate);
  for (const mutation of [
    x => { x.candidate.priorRoot = root(999); x.nc = checkpointCommitments(x.job, x.candidate); },
    x => { x.candidate.step = x.current.step; x.candidate.value = x.current.value; x.nc = checkpointCommitments(x.job, x.candidate); },
    x => { x.candidate.step = 4n; x.nc = checkpointCommitments(x.job, x.candidate); },
    x => { x.current.value = 2n; x.cc = checkpointCommitments(x.job, x.current); },
    x => { x.cc.checkpoint.input.value += 1n; }
  ]) {
    const bad = clone(f); mutation(bad);
    assert.deepEqual(advance(bad), bad.current);
  }
  for (let cut = 0; cut <= 3; cut++) {
    const prefix = f.job.program.instructions.slice(0, cut), suffix = f.job.program.instructions.slice(cut), modulus = 256n;
    assert.equal(call('Compute.execute', [...prefix, ...suffix], f.job.initialValue, modulus), call('Compute.execute', suffix, call('Compute.execute', prefix, f.job.initialValue, modulus), modulus));
  }
});

function ledger(limit = resources(20, 20, 20, 20), epoch = 7n) {
  return { budget: { epoch, start: 0n, end: 100n, last: 0n, limit, spent: zero, reserved: zero }, reservations: [] };
}
const settlement = (actionId, actual, epoch = 7n, tag = 'Known') => ({ actionId, epoch, actual, outcome: { tag, fields: [] } });
const charge = l => Object.fromEntries(Object.keys(zero).map(k => [k, l.budget.spent[k] + l.budget.reserved[k]]));

test('ledger reservation IDs are immutable, epoch-bound and charged in independent resource dimensions', () => {
  const empty = ledger(), id = root(1), cost = resources(8, 5, 3, 1);
  assert.equal(call('Budget.ledgerValid', empty), true);
  const a = call('Budget.reserveLedger', empty, id, cost, 10);
  assert.equal(call('Budget.ledgerValid', a), true);
  assert.deepEqual(a.budget.reserved, cost);
  assert.equal(a.reservations.length, 1);
  assert.equal(a.reservations[0].epoch, empty.budget.epoch);
  assert.deepEqual(call('Budget.reserveLedger', a, id, resources(1), 11), a);
  for (const now of [9, 100]) assert.deepEqual(call('Budget.reserveLedger', a, root(2), cost, now), a);
  for (const dimension of Object.keys(zero)) {
    const tooMuch = { ...zero, [dimension]: 21n };
    assert.deepEqual(call('Budget.reserveLedger', a, root(2), tooMuch, 11), a);
  }
  assert.deepEqual(call('Budget.reserveLedger', a, { ...id, w0: 1n << 32n }, cost, 11), a);
});

test('settlement consumes only its recorded ceiling, retains tombstones and cannot be replayed', () => {
  const idA = root(10), idB = root(20), aCost = resources(8, 5, 3, 2), bCost = resources(4, 9, 1, 1);
  const a = call('Budget.reserveLedger', ledger(), idA, aCost, 10);
  const both = call('Budget.reserveLedger', a, idB, bCost, 11);
  const actual = resources(6, 2, 1, 0), obs = settlement(idA, actual);
  const after = call('Budget.settleLedger', both, obs, 12);
  assert.equal(call('Budget.ledgerValid', after), true);
  assert.deepEqual(after.budget.spent, actual);
  assert.deepEqual(after.budget.reserved, bCost);
  assert.equal(after.reservations.length, 2);
  assert.equal(after.reservations.find(x => call('Identity.sameDigest', x.actionId, idA)).settled, true);
  assert.deepEqual(call('Budget.settleLedger', after, obs, 13), after);
  assert.deepEqual(call('Budget.reserveLedger', after, idA, aCost, 13), after);
  for (const observation of [
    settlement(idA, zero, 6n), settlement(idA, zero, 8n), settlement(root(999), zero),
    settlement(idA, zero, 7n, 'Unknown'), settlement(idA, resources(9)),
    settlement(idA, resources(0, 6)), settlement(idA, resources(0, 0, 4)), settlement(idA, resources(0, 0, 0, 3))
  ]) assert.deepEqual(call('Budget.settleLedger', both, observation, 12), both);
  for (const now of [10, 100]) assert.deepEqual(call('Budget.settleLedger', both, obs, now), both);
  const final = call('Budget.settleLedger', after, settlement(idB, bCost), 14);
  assert.equal(call('Budget.ledgerValid', final), true);
  assert.deepEqual(final.budget.reserved, zero);
  assert.deepEqual(final.budget.spent, resources(10, 11, 2, 1));
});

test('unattributed pooled reserves and forged reservation histories fail closed', () => {
  const original = call('Budget.reserveLedger', ledger(), root(1), resources(5, 4, 3, 2), 10);
  const invalid = [];
  let x = clone(original); x.budget.reserved.transferBytes += 1n; invalid.push(x);
  x = clone(original); x.budget.spent.computeWork += 1n; invalid.push(x);
  x = clone(original); x.reservations = []; invalid.push(x);
  x = clone(original); x.reservations.push(clone(x.reservations[0])); invalid.push(x);
  x = clone(original); x.reservations[0].epoch += 1n; invalid.push(x);
  x = clone(original); x.reservations[0].actual = resources(1); invalid.push(x);
  x = clone(original); x.reservations[0].actionId.w0 = 1n << 32n; invalid.push(x);
  x = clone(original); x.reservations[0].settled = true; x.reservations[0].actual = resources(6); x.budget.reserved = zero; x.budget.spent = resources(6); invalid.push(x);
  for (const bad of invalid) {
    assert.equal(call('Budget.ledgerValid', bad), false);
    assert.deepEqual(call('Budget.reserveLedger', bad, root(2), resources(1), 11), bad);
    assert.deepEqual(call('Budget.settleLedger', bad, settlement(root(1), zero), 11), bad);
  }
  const newEpoch = ledger(undefined, 8n);
  const reused = call('Budget.reserveLedger', newEpoch, root(1), resources(5), 10);
  assert.deepEqual(call('Budget.settleLedger', reused, settlement(root(1), resources(1), 7n), 11), reused);
});

test('finite ledger traces preserve limits and settlement never increases any charge dimension', () => {
  for (let ceiling = 0; ceiling <= 4; ceiling++) for (let actual = 0; actual <= 5; actual++) for (const tag of ['Known', 'Unknown']) {
    const before = call('Budget.reserveLedger', ledger(resources(4, 4, 4, 4)), root(1), resources(ceiling, ceiling, ceiling, ceiling), 1);
    const obs = settlement(root(1), resources(actual, actual, actual, actual), 7n, tag);
    const after = call('Budget.settleLedger', before, obs, 2);
    assert.equal(call('Budget.ledgerValid', after), true);
    for (const k of Object.keys(zero)) assert.ok(charge(after)[k] <= charge(before)[k]);
    if (tag === 'Unknown' || actual > ceiling) assert.deepEqual(after, before);
    else assert.deepEqual(after.budget.spent, resources(actual, actual, actual, actual));
  }
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) {
    const initial = ledger(resources(3, 3, 3, 3));
    const one = call('Budget.reserveLedger', initial, root(1), resources(a, a, a, a), 1);
    const two = call('Budget.reserveLedger', one, root(2), resources(b, b, b, b), 2);
    assert.equal(call('Budget.ledgerValid', two), true);
    for (const k of Object.keys(zero)) assert.ok(charge(two)[k] <= 3n);
    assert.equal(two.reservations.length, a + b <= 3 ? 2 : 1);
  }
});

test('structural settlement equals an independent first-match update on the complete short journal corpus', () => {
  const same = (a, b) => Object.keys(a).every(k => a[k] === b[k]);
  const reference = (records, observation) => {
    let consumed = false;
    return records.map(record => {
      if (consumed || !same(record.actionId, observation.actionId)) return clone(record);
      consumed = true;
      return { ...clone(record), actual: clone(observation.actual), settled: true };
    });
  };
  // Include duplicates and already settled entries: this checks the internal
  // traversal's exact first-match semantics, independently of ledger admission.
  for (let length = 0; length <= 4; length++) for (let pattern = 0; pattern < 3 ** length; pattern++) for (let settled = 0; settled < 2 ** length; settled++) {
    let digits = pattern;
    const records = Array.from({ length }, (_, i) => {
      const actionId = root(digits % 3); digits = Math.floor(digits / 3);
      return { actionId, epoch: 7n, ceiling: resources(8, 6, 4, 2), actual: resources(i, i, i, i), settled: Boolean(settled & (1 << i)) };
    });
    for (let selected = 0; selected < 4; selected++) {
      const observation = settlement(root(selected), resources(3, 2, 1, 0));
      assert.deepEqual(call('Budget.recordSettlement', records, observation), reference(records, observation));
    }
  }
});
