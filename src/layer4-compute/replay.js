/** Deterministic ring jobs. Replay proves agreement with this interpreter, not correctness of host effects. */
import { PrimitiveOp } from '../layer1-uor/index.js';
import { canonicalBytes, sha256Bytes } from '../layer1-uor/custody.js';
import { record, natural, hexValue, digest, refuse } from '../layer1-uor/contracts.js';

import { checkpointLinkAllowed, model, modelExecutionDigest } from '../layer1-uor/generated-model.js';
export const MAX_PROGRAM_STEPS = 1024;
const unary = new Set([PrimitiveOp.NEG, PrimitiveOp.BNOT, PrimitiveOp.SUCC, PrimitiveOp.PRED]);
const binary = new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]);
const hex = value => '0x' + value.toString(16);
const hash = (value, domain) => sha256Bytes(canonicalBytes(value), domain);
const snapshot = value => JSON.parse(new TextDecoder().decode(canonicalBytes(value)));

export function validateProgram(program) {
  record(program, ['version', 'bits', 'initialValueHex', 'instructions']);
  if (program.version !== 1 || ![8, 16, 32, 64, 128].includes(program.bits)) refuse('unsupported-program');
  hexValue(program.initialValueHex, program.bits);
  if (!Array.isArray(program.instructions) || program.instructions.length > MAX_PROGRAM_STEPS) refuse('program-limit');
  for (const instruction of program.instructions) {
    if (unary.has(instruction?.op)) record(instruction, ['op']);
    else if (binary.has(instruction?.op)) {
      record(instruction, ['op', 'argHex']); hexValue(instruction.argHex, program.bits);
    } else refuse('unsupported-operation');
  }
  return program;
}

export async function identifyProgram(program) {
  validateProgram(program);
  return hash(program, 'program');
}

export function replayProgram(program, endStep = program.instructions.length, admission = null) {
  validateProgram(program); natural(endStep, program.instructions.length);
  admission?.reserve('checkpoint', { computeSteps: endStep });
  let value = BigInt(program.initialValueHex);
  const modulus = 1n << BigInt(program.bits);
  for (let i = 0; i < endStep; i++) {
    const instruction = program.instructions[i];
    value = model['Stitch.Compute.ringStep']({ opcode: instruction.op,
      argument: binary.has(instruction.op) ? BigInt(instruction.argHex) : 0n }, value, modulus);
  }
  return { stepIndex: endStep, stateHex: hex(value) };
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
  const body = { version: 1, jobId, modelDigest: modelExecutionDigest, ...state, previousDigest: previous?.checkpointDigest ?? null };
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
  record(checkpoint, ['version', 'jobId', 'modelDigest', 'stepIndex', 'stateHex', 'previousDigest', 'checkpointDigest']);
  validateProgram(program);
  if (checkpoint.version !== 1) refuse('unsupported-checkpoint');
  digest(checkpoint.jobId); digest(checkpoint.checkpointDigest);
  if (checkpoint.modelDigest !== modelExecutionDigest) refuse('checkpoint-model');
  if (checkpoint.previousDigest !== null) digest(checkpoint.previousDigest);
  natural(checkpoint.stepIndex, program.instructions.length); hexValue(checkpoint.stateHex, program.bits);
  if (checkpoint.jobId !== await identifyProgram(program)) refuse('program-mismatch');
  const { checkpointDigest, ...body } = checkpoint;
  if (checkpointDigest !== await hash(body, 'checkpoint')) refuse('checkpoint-integrity');
  if (replayProgram(program, checkpoint.stepIndex, admission).stateHex !== checkpoint.stateHex) refuse('checkpoint-replay');
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
  admission?.reserve('checkpoint', { computeSteps: program.instructions.length - checkpoint.stepIndex });
  let value = BigInt(checkpoint.stateHex);
  const modulus = 1n << BigInt(program.bits);
  for (let step = checkpoint.stepIndex; step < program.instructions.length; step++) {
    const instruction = program.instructions[step];
    value = model['Stitch.Compute.ringStep']({ opcode: instruction.op,
      argument: binary.has(instruction.op) ? BigInt(instruction.argHex) : 0n }, value, modulus);
  }
  return { jobId: checkpoint.jobId, stateHex: hex(value), stepIndex: program.instructions.length,
    execution: 'replayed', effects: [] };
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
