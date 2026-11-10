/** Deterministic ring jobs. Replay proves agreement with this interpreter, not correctness of host effects. */
import { PrimitiveOp } from '../layer1-uor/index.js';
import { canonicalBytes, sha256Bytes } from '../layer1-uor/custody.js';
import { record, natural, hexValue, digest, refuse } from '../layer1-uor/contracts.js';

import { checkpointLinkAllowed, model, modelExecutionDigest } from '../layer1-uor/generated-model.js';
export const MAX_PROGRAM_STEPS = 1024;
// Local parsing/memory/work policy, not universal UOR/TermValue limits.
export const MAX_TERM_BITS = 32768;
export const MAX_PROGRAM_WORK = 1000000;
const unary = new Set([PrimitiveOp.NEG, PrimitiveOp.BNOT, PrimitiveOp.SUCC, PrimitiveOp.PRED]);
const binary = new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17]);
const hex = value => '0x' + value.toString(16);
const hash = (value, domain) => sha256Bytes(canonicalBytes(value), domain);
const snapshot = value => JSON.parse(new TextDecoder().decode(canonicalBytes(value)));

function byteWidth(bits) {
  natural(bits, MAX_TERM_BITS);
  if (bits % 8 !== 0) refuse('unsupported-width');
  return bits;
}
function termHex(value, bits) {
  if (typeof value !== 'string' || value.length > 2 + Math.max(1, bits / 4) || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) refuse('invalid-ring-value');
  if (BigInt(value) >> BigInt(bits)) refuse('invalid-ring-value');
  return value;
}
function planProgram(program) {
  const typed = program?.version === 2;
  record(program, typed ? ['version', 'bits', 'capacityBits', 'initialValueHex', 'instructions'] : ['version', 'bits', 'initialValueHex', 'instructions']);
  if (typed) {
    byteWidth(program.bits); byteWidth(program.capacityBits);
    if (program.bits > program.capacityBits) refuse('term-capacity');
    termHex(program.initialValueHex, program.bits);
  } else {
    if (program.version !== 1 || ![8, 16, 32, 64, 128].includes(program.bits)) refuse('unsupported-program');
    hexValue(program.initialValueHex, program.bits);
  }
  if (!Array.isArray(program.instructions) || program.instructions.length > MAX_PROGRAM_STEPS) refuse('program-limit');
  const plan = []; let bits = program.bits, total = 0n;
  for (const instruction of program.instructions) {
    let argument = 0n, argumentBits = 0;
    if (unary.has(instruction?.op)) record(instruction, ['op']);
    else if (binary.has(instruction?.op) || typed && instruction?.op === PrimitiveOp.CONCAT) {
      record(instruction, typed ? ['op', 'argHex', 'argBits'] : ['op', 'argHex']);
      if (typed) { argumentBits = byteWidth(instruction.argBits); termHex(instruction.argHex, argumentBits); }
      else { argumentBits = bits; hexValue(instruction.argHex, bits); }
      argument = BigInt(instruction.argHex);
    } else refuse('unsupported-operation');
    const source = typed ? { opcode: instruction.op, argument, argumentBits } : { opcode: instruction.op, argument };
    if (typed && !model['Stitch.Compute.typedInstructionAllowed'](source, bits, program.capacityBits)) refuse('invalid-typed-operation');
    const work = typed ? model['Stitch.Compute.typedInstructionWork'](source, bits) : model['Stitch.Compute.instructionWork'](source, bits);
    total += work;
    if (total > BigInt(MAX_PROGRAM_WORK)) refuse('program-work-limit');
    const nextBits = typed ? Number(model['Stitch.Compute.typedResultBits'](source, bits)) : bits;
    plan.push({ source, bits, nextBits, work: Number(work) }); bits = nextBits;
  }
  return plan;
}
export function validateProgram(program) { planProgram(program); return program; }

/** Deterministic abstract work units, not a wall-clock/BigInt implementation benchmark. */
export function programWork(program, start = 0, end = program.instructions.length) {
  const plan = planProgram(program); natural(start, plan.length); natural(end, plan.length);
  if (start > end) refuse('invalid-step-range');
  return plan.slice(start, end).reduce((total, step) => total + step.work, 0);
}
function runPlan(program, plan, start, end, initial, admission) {
  const computeSteps = plan.slice(start, end).reduce((total, step) => total + step.work, 0);
  admission?.reserve('checkpoint', { computeSteps });
  let word = initial;
  for (let i = start; i < end; i++) {
    const step = plan[i];
    word = program.version === 2 ? model['Stitch.Compute.typedStep'](step.source, word) : {
      bits: word.bits,
      value: model['Stitch.Compute.ringStep'](step.source, word.value, 1n << BigInt(step.bits))
    };
  }
  return word;
}

export async function identifyProgram(program) {
  validateProgram(program);
  return hash(program, 'program');
}

export function replayProgram(program, endStep = program.instructions.length, admission = null) {
  const plan = planProgram(program); natural(endStep, plan.length);
  const word = runPlan(program, plan, 0, endStep, { bits: BigInt(program.bits), value: BigInt(program.initialValueHex) }, admission);
  return { stepIndex: endStep, stateHex: hex(word.value), ...(program.version === 2 ? { stateBits: Number(word.bits) } : {}) };
}

export async function createCheckpoint(program, stepIndex, previous = null, { admission = null } = {}) {
  program = snapshot(program);
  if (previous !== null) previous = snapshot(previous);
  const jobId = await identifyProgram(program);
  if (previous !== null) {
    await verifyCheckpoint(program, previous, undefined, { admission });
    if (previous.stepIndex >= stepIndex) refuse('checkpoint-order');
  }
  const state = replayProgram(program, stepIndex, admission);
  const body = { version: program.version, jobId, modelDigest: modelExecutionDigest, ...state, previousDigest: previous?.checkpointDigest ?? null };
  return { ...body, checkpointDigest: await hash(body, 'checkpoint') };
}

/** Full replay from identified input is required even when no predecessor was retained.
 * modelDigest binds executable semantics and adapters, not unrelated proofs or
 * product metadata. Exact whole-source provenance remains in MODEL_SOURCE.
 * Legacy whole-source checkpoint roots are not implicitly accepted.
 */
export async function verifyCheckpoint(program, checkpoint, previous = undefined, { admission = null } = {}) {
  program = snapshot(program); checkpoint = snapshot(checkpoint);
  if (previous !== undefined && previous !== null) previous = snapshot(previous);
  validateProgram(program);
  record(checkpoint, ['version', 'jobId', 'modelDigest', 'stepIndex', 'stateHex', 'previousDigest', 'checkpointDigest', ...(program.version === 2 ? ['stateBits'] : [])]);
  if (checkpoint.version !== program.version) refuse('unsupported-checkpoint');
  digest(checkpoint.jobId); digest(checkpoint.checkpointDigest);
  if (checkpoint.modelDigest !== modelExecutionDigest) refuse('checkpoint-model');
  if (checkpoint.previousDigest !== null) digest(checkpoint.previousDigest);
  natural(checkpoint.stepIndex, program.instructions.length);
  if (program.version === 2) { byteWidth(checkpoint.stateBits); termHex(checkpoint.stateHex, checkpoint.stateBits); }
  else hexValue(checkpoint.stateHex, program.bits);
  if (checkpoint.jobId !== await identifyProgram(program)) refuse('program-mismatch');
  const { checkpointDigest, ...body } = checkpoint;
  if (checkpointDigest !== await hash(body, 'checkpoint')) refuse('checkpoint-integrity');
  const replay = replayProgram(program, checkpoint.stepIndex, admission);
  if (replay.stateHex !== checkpoint.stateHex || program.version === 2 && replay.stateBits !== checkpoint.stateBits) refuse('checkpoint-replay');
  if (previous === null && checkpoint.previousDigest !== null) refuse('checkpoint-predecessor');
  if (previous !== undefined && previous !== null) {
    // Do not trust an unchecked predecessor supplied by a caller.
    await verifyCheckpoint(program, previous, undefined, { admission });
    if (!checkpointLinkAllowed(true, true, true, true, checkpoint.previousDigest === previous.checkpointDigest,
      true, previous.stepIndex, checkpoint.stepIndex, program.instructions.length)) {
      refuse('checkpoint-predecessor');
    }
  }
  return { integrity: true, execution: 'replayed', predecessor: previous === undefined ? 'not-checked' : 'checked',
    complete: checkpoint.stepIndex === program.instructions.length };
}

export async function resumeProgram(program, checkpoint, { admission = null } = {}) {
  program = snapshot(program); checkpoint = snapshot(checkpoint);
  await verifyCheckpoint(program, checkpoint, undefined, { admission });
  const plan = planProgram(program);
  const word = runPlan(program, plan, checkpoint.stepIndex, program.instructions.length,
    { bits: BigInt(program.version === 2 ? checkpoint.stateBits : program.bits), value: BigInt(checkpoint.stateHex) }, admission);
  return { jobId: checkpoint.jobId, stateHex: hex(word.value), stepIndex: program.instructions.length,
    ...(program.version === 2 ? { stateBits: Number(word.bits) } : {}), execution: 'replayed', effects: [] };
}

/** Existing demo workload, now carried in every checkpoint instead of inferred from labels. */
export function demoProgram(totalSteps = 12, initialValue = 104729n) {
  natural(totalSteps, MAX_PROGRAM_STEPS);
  const program = { version: 1, bits: 64, initialValueHex: hex(BigInt(initialValue)),
    instructions: Array.from({ length: totalSteps }, (_, step) => step % 3 === 0
      ? { op: PrimitiveOp.ADD, argHex: hex(BigInt((step + 1) * 257)) }
      : step % 3 === 1 ? { op: PrimitiveOp.XOR, argHex: '0x9e3779b97f4a7c15' } : { op: PrimitiveOp.SUCC }) };
  return validateProgram(program);
}
