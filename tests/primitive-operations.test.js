import test from 'node:test';
import assert from 'node:assert/strict';
import { Datum, PrimitiveOp, applyPrimitiveOp } from '../src/layer1-uor/index.js';
import { model, modelExecutionDigest } from '../src/layer1-uor/generated-model.js';
import { createCheckpoint, replayProgram, resumeProgram, verifyCheckpoint, validateProgram, programWork, MAX_TERM_BITS, MAX_PROGRAM_WORK } from '../src/layer4-compute/replay.js';
import { canonicalBytes, sha256Bytes } from '../src/layer1-uor/custody.js';
import { ResourceAdmission } from '../src/layer2-schedulers/policy.js';
const call = (name, ...args) => model['Stitch.Compute.' + name](...args);
const hex = n => '0x' + n.toString(16);
const code = expected => e => e.code === expected;
// Independent left-to-right modular exponent oracle, including every exponent
// bit above 64. Never computes the unbounded integer x**exponent.
function pow(base, exponent, bits) {
  const mask = (1n << BigInt(bits)) - 1n;
  let value = 1n;
  for (const digit of exponent.toString(2)) { value = value * value & mask; if (digit === '1') value = value * base & mask; }
  return value;
}
const typed = (instructions, { bits = 16, capacityBits = 128, initialValueHex = '0xabcd' } = {}) => ({ version: 2, bits, capacityBits, initialValueHex, instructions });
const arg = (op, argBits, argument) => ({ op, argBits, argHex: hex(BigInt(argument)) });
const admission = computeSteps => new ResourceAdmission({ clock: () => 1, durationMs: 1000,
  limit: { requests: 100, transferBytes: 1000000, storageBytes: 1000000, computeSteps } });

test('POW conforms to pinned UOR 0.5.2 overflow, zero-unit and full-width exponent rules', () => {
  // Upstream foundation/tests/behavior_adr_053_ring_axis_completion.rs.
  for (const [a, b, expected] of [[2n, 8n, 0n], [3n, 5n, 243n], [5n, 4n, 113n], [0n, 0n, 1n]]) {
    assert.equal(applyPrimitiveOp(17, Datum.w8(a), Datum.w8(b)).value, expected);
    assert.equal(call('ringStep', { opcode: 17, argument: b }, a, 256n), expected);
  }
  for (const bits of [8, 16, 32, 64, 128]) {
    const m = 1n << BigInt(bits), values = [0n, 1n, 2n, 3n, m / 2n + 3n, m - 1n];
    for (const a of values) for (const b of values) {
      const expected = pow(a, b, bits);
      assert.equal(applyPrimitiveOp(17, new Datum(bits, a), new Datum(bits, b)).value, expected);
      assert.equal(call('ringStep', { opcode: 17, argument: b }, a, m), expected);
    }
    const program = { version: 1, bits, initialValueHex: '0x3', instructions: [{ op: 17, argHex: hex(m - 1n) }] };
    assert.equal(replayProgram(program).stateHex, hex(pow(3n, m - 1n, bits)));
    assert.equal(programWork(program), 1 + 2 * bits);
  }
  // A high exponent whose low64 bits are zero must not be mistaken for 0.
  assert.equal(call('ringStep', { opcode: 17, argument: 1n << 100n }, 2n, 1n << 128n), 0n);
  assert.equal(call('ringStep', { opcode: 17, argument: 1n << 100n }, 3n, 1n << 128n), 54740098937849875961756722746384973825n);
});

test('CONCAT appends big-endian term bytes, retaining widths and leading zero bytes', () => {
  // Upstream behavior_catamorphism_evaluator.rs: abcd⧺1234 -> abcd1234.
  const result = applyPrimitiveOp(14, Datum.w16(0xabcd), Datum.w16(0x1234));
  assert.equal(result.bits, 32); assert.equal(result.value, 0xabcd1234n);
  assert.deepEqual([...result.toBytes()], [0x34, 0x12, 0xcd, 0xab]); // legacy coordinate encoding stays LE
  const program = typed([arg(14, 16, 0x1234), arg(14, 8, 0), arg(14, 24, 1)]);
  assert.deepEqual(replayProgram(program), { stepIndex: 3, stateBits: 64, stateHex: '0xabcd123400000001' });
  assert.deepEqual(replayProgram(typed([arg(14, 16, 1)], { bits: 8, initialValueHex: '0x0' })), { stepIndex: 1, stateBits: 24, stateHex: '0x1' });
  for (let bits = 8; bits < 128; bits += 8) {
    const p = typed([arg(14, 8, 0)], { bits, initialValueHex: '0x1' });
    assert.equal(replayProgram(p).stateBits, bits + 8);
    assert.equal(replayProgram(p).stateHex, '0x100');
  }
  assert.throws(() => applyPrimitiveOp(14, new Datum(128, 1), Datum.w8(2)), RangeError);
  assert.throws(() => applyPrimitiveOp(14, Datum.w8(1)), TypeError);
  assert.throws(() => validateProgram({ version: 1, bits: 8, initialValueHex: '0x1', instructions: [{ op: 14, argHex: '0x2' }] }), code('unsupported-operation'));
});

test('empty byte sequences are CONCAT identities and keep their exact 0-bit width', () => {
  const empty = { bits: 0, capacityBits: 0, initialValueHex: '0x0' };
  assert.deepEqual(replayProgram(typed([arg(14, 0, 0)], empty)), { stepIndex: 1, stateBits: 0, stateHex: '0x0' });
  assert.deepEqual(replayProgram(typed([arg(14, 16, 1)], { ...empty, capacityBits: 16 })), { stepIndex: 1, stateBits: 16, stateHex: '0x1' });
  assert.deepEqual(replayProgram(typed([arg(14, 0, 0)])), { stepIndex: 1, stateBits: 16, stateHex: '0xabcd' });
  assert.deepEqual(replayProgram(typed([{ op: 2 }], { ...empty, capacityBits: 8 })), { stepIndex: 1, stateBits: 8, stateHex: '0x1' });
  assert.throws(() => validateProgram(typed([], { ...empty, initialValueHex: '0x1' })), code('invalid-ring-value'));
});

test('version 2 follows width-parametric term arithmetic and byte-sized comparisons', () => {
  assert.deepEqual(replayProgram(typed([arg(4, 24, 0xffffff)], { bits: 8, initialValueHex: '0x2' })), { stepIndex: 1, stateBits: 24, stateHex: '0x1' });
  const p = typed([arg(14, 8, 0xff), arg(10, 32, 0xffffff), arg(14, 32, 0x12345678)]);
  assert.deepEqual(replayProgram(p), { stepIndex: 3, stateBits: 40, stateHex: '0x112345678' });
  for (const op of [15, 16]) {
    assert.throws(() => validateProgram(typed([arg(op, 16, 0)])), code('invalid-typed-operation'));
    assert.equal(replayProgram({ version: 1, bits: 8, initialValueHex: '0xa', instructions: [{ op, argHex: '0x0' }] }).stateHex, '0x0');
  }
  for (const bits of [24, 40, 72, 120, 136]) {
    const cap = Math.max(256, bits), x = (1n << BigInt(bits)) - 3n;
    for (const op of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17]) {
      const instruction = op < 4 ? { op } : arg(op, bits, 3);
      const p = typed([instruction], { bits, capacityBits: cap, initialValueHex: hex(x) });
      const expected = op === 17 ? pow(x, 3n, bits) : call('ringStep', { opcode: op, argument: op < 4 ? 0 : 3 }, x, 1n << BigInt(bits));
      assert.equal(replayProgram(p).stateHex, hex(expected));
      assert.equal(replayProgram(p).stateBits, op >= 10 && op <= 13 ? 8 : bits);
    }
  }
});

test('version 2 checkpoints bind exact width, input, capacity, predecessor and execution semantics', async () => {
  const p = typed([arg(14, 8, 0), arg(17, 24, 3), arg(14, 16, 1)]);
  for (let step = 0; step <= p.instructions.length; step++) {
    const cp = await createCheckpoint(p, step);
    assert.equal(cp.version, 2); assert.equal(cp.modelDigest, modelExecutionDigest);
    assert.equal((await verifyCheckpoint(p, cp)).execution, 'replayed');
    const resumed = await resumeProgram(p, cp);
    assert.equal(resumed.stateHex, replayProgram(p).stateHex); assert.equal(resumed.stateBits, replayProgram(p).stateBits);
    if (step) {
      const prev = await createCheckpoint(p, step - 1), next = await createCheckpoint(p, step, prev);
      assert.equal((await verifyCheckpoint(p, next, prev)).predecessor, 'checked');
    }
    const forged = { ...cp, stateBits: cp.stateBits + 8 }; delete forged.checkpointDigest;
    forged.checkpointDigest = await sha256Bytes(canonicalBytes(forged), 'checkpoint');
    await assert.rejects(verifyCheckpoint(p, forged), code('checkpoint-replay'));
    await assert.rejects(verifyCheckpoint({ ...p, capacityBits: 256 }, cp), code('program-mismatch'));
    await assert.rejects(verifyCheckpoint(p, { ...cp, modelDigest: 'sha256:' + '0'.repeat(64) }), code('checkpoint-model'));
    await assert.rejects(verifyCheckpoint(p, { ...cp, version: 1 }), code('unsupported-checkpoint'));
  }
});

test('abstract work accounts multiplication rounds and bytes before evaluation and resume', async () => {
  const p = typed([arg(14, 8, 0), arg(17, 24, 3)]);
  assert.equal(programWork(p), 4 + 5); // concat writes 3 bytes, pow 3 uses 4 modular multiplications
  const policy = admission(8);
  assert.throws(() => replayProgram(p, 2, policy), code('budget-exhausted'));
  assert.equal(policy.state.spent.computeSteps, 0);
  const enough = admission(9); replayProgram(p, 2, enough); assert.equal(enough.state.spent.computeSteps, 9);
  const cp = await createCheckpoint(p, 1), resumed = admission(9);
  await resumeProgram(p, cp, { admission: resumed }); assert.equal(resumed.state.spent.computeSteps, 9);
  const zero = typed([arg(17, 16, 0)]); assert.equal(programWork(zero), 1);
  const exp = (1n << 128n) - 1n, wide = typed([arg(17, 128, exp)], { bits: 128, initialValueHex: '0x3' });
  assert.equal(programWork(wide), 1 + 4 * 256);
});

test('maximum declared capacity executes without stack growth; hostile size/work is refused', () => {
  const all = (1n << BigInt(MAX_TERM_BITS)) - 1n;
  const concat = typed([arg(14, MAX_TERM_BITS - 8, 1)], { bits: 8, capacityBits: MAX_TERM_BITS, initialValueHex: '0x1' });
  const r = replayProgram(concat); assert.equal(r.stateBits, MAX_TERM_BITS); assert.equal(BigInt(r.stateHex), (1n << BigInt(MAX_TERM_BITS - 8)) + 1n);
  const xor = typed([arg(7, MAX_TERM_BITS, all)], { bits: MAX_TERM_BITS, capacityBits: MAX_TERM_BITS, initialValueHex: hex(all) });
  assert.equal(replayProgram(xor).stateHex, '0x0'); assert.equal(programWork(xor), 1 + MAX_TERM_BITS);
  const hostile = typed([arg(17, MAX_TERM_BITS, all)], { bits: MAX_TERM_BITS, capacityBits: MAX_TERM_BITS, initialValueHex: '0x3' });
  assert.throws(() => validateProgram(hostile), code('program-work-limit'));
  // Test the source tail-recursive power primitive at maximum bit length without
  // permitting an undercharged program. No unbounded exponent integer is built.
  assert.equal(call('ringPow', MAX_TERM_BITS, 0, all, 1n << BigInt(MAX_TERM_BITS), 1), 0n);
  assert.throws(() => validateProgram({ ...concat, capacityBits: MAX_TERM_BITS + 8 }), code('invalid-integer'));
  assert.throws(() => validateProgram(typed([arg(14, 8, 1)], { bits: 128, capacityBits: 128, initialValueHex: '0x0' })), code('invalid-typed-operation'));
  assert.throws(() => validateProgram(typed([arg(14, 7, 1)])), code('unsupported-width'));
  assert.throws(() => validateProgram(typed([{ op: 14, argBits: 16, argHex: '0x10000' } ])), code('invalid-ring-value'));
  assert.throws(() => validateProgram(typed([{ op: 14, argBits: 16, argHex: '0x00' } ])), code('invalid-ring-value'));
  assert.throws(() => validateProgram(typed(new Array(1025).fill({ op: 2 }))), code('program-limit'));
  assert.ok(MAX_PROGRAM_WORK < Number.MAX_SAFE_INTEGER);
});
