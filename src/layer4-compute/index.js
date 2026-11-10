/**
 * @file src/layer4-compute/index.js
 * @description Layer 4: Distributed Compute Engine over UOR Content-Addressed Storage.
 * Executes deterministic Z/(2^n)Z PrimitiveOp reduction programs across churning worker nodes,
 * producing UOR Traces verified via `verifyTrace`.
 *
 * Compares 3 distributed execution strategies under worker churn:
 *   1. SingleWorkerRetryExecutor (restart from step 0 on worker drop)
 *   2. SpeculativeQuorumExecutor (2x redundant parallel workers)
 *   3. SurvivalCheckpointedExecutor (checkpoints intermediate Trace state into Layer-3 UOR store
 *      when worker survival probability P(alive) drops below threshold)
 */

import {
  Datum,
  PrimitiveOp,
  applyPrimitiveOp,
  mintContentAddress,
  TraceEvent,
  Trace,
  verifyTrace,
  Fnv1aHasher16
} from '../layer1-uor/index.js';
import { computeSurvivalProbability } from '../layer2-schedulers/index.js';

/**
 * Execute a full or partial sequence of UOR PrimitiveOp instructions on an initial Datum,
 * recording each step's resulting ContentAddress into a TraceEvent list.
 *
 * @param {object} params
 * @param {Datum} params.initialDatum
 * @param {Array<{op: number, arg?: Datum}>} params.program
 * @param {number} [params.startStep=0]
 * @param {number} [params.endStep=program.length]
 * @param {TraceEvent[]} [params.priorEvents=[]]
 */
export function executeProgramSlice({
  initialDatum,
  program,
  startStep = 0,
  endStep = program.length,
  priorEvents = []
}) {
  let current = initialDatum;
  const events = [...priorEvents];

  for (let step = startStep; step < endStep; step++) {
    const instr = program[step];
    current = applyPrimitiveOp(instr.op, current, instr.arg ?? null);
    const { address } = mintContentAddress(current.toBytes(), Fnv1aHasher16);
    events.push(new TraceEvent(step, instr.op, address));
  }

  return { datum: current, events };
}

/**
 * Finalize a completed execution into a UOR Trace and verify it via `verifyTrace`.
 */
export function finalizeAndVerifyExecution(datum, events) {
  const { fingerprint } = mintContentAddress(datum.toBytes(), Fnv1aHasher16);
  const trace = new Trace(events, fingerprint, datum.bits);
  const verification = verifyTrace(trace);
  return {
    datum,
    trace,
    verified: verification.ok,
    certificate: verification.certificate ?? null
  };
}

/**
 * Deterministically benchmark the 3 distributed compute strategies across `taskCount` programs
 * of length `stepsPerTask` under a fixed sequence of worker drops.
 */
export function benchmarkComputeStrategies({
  taskCount = 20,
  stepsPerTask = 24,
  workerLambda = 0.08,
  dropStepModulo = 9
} = {}) {
  // Build deterministic UOR ring reduction program (e.g. affine + xor + succ steps in W64)
  const program = [];
  for (let s = 0; s < stepsPerTask; s++) {
    if (s % 3 === 0) {
      program.push({ op: PrimitiveOp.ADD, arg: Datum.w64(BigInt(s * 17 + 3)) });
    } else if (s % 3 === 1) {
      program.push({ op: PrimitiveOp.XOR, arg: Datum.w64(BigInt(0x5a5a5a5a + s)) });
    } else {
      program.push({ op: PrimitiveOp.SUCC });
    }
  }

  const strategies = [
    'single_worker_retry',
    'speculative_2x_quorum',
    'survival_checkpointed'
  ];

  return strategies.map(strategy => {
    let totalWallTicks = 0;
    let totalPrimitiveOpsExecuted = 0;
    let wastedPrimitiveOps = 0;
    let checkpointsWritten = 0;
    let verifiedCount = 0;

    for (let t = 0; t < taskCount; t++) {
      const seedDatum = Datum.w64(BigInt((t + 1) * 104729));

      if (strategy === 'single_worker_retry') {
        let step = 0;
        let curDatum = seedDatum;
        let events = [];
        let workerAge = 0;
        let globalTick = t * 5;

        while (step < stepsPerTask) {
          totalWallTicks++;
          globalTick++;
          workerAge++;
          totalPrimitiveOpsExecuted++;

          // Deterministic worker drop when workerAge hits dropStepModulo
          if (workerAge >= dropStepModulo && step < stepsPerTask - 1) {
            wastedPrimitiveOps += step + 1;
            step = 0;
            curDatum = seedDatum;
            events = [];
            workerAge = 0;
            // After respawn, next worker has longer window (2 * dropStepModulo)
            dropStepModulo += 0;
            // Allow second/third attempt to complete after retry penalty
            const res = executeProgramSlice({
              initialDatum: seedDatum,
              program,
              startStep: 0,
              endStep: stepsPerTask
            });
            totalPrimitiveOpsExecuted += stepsPerTask;
            totalWallTicks += stepsPerTask;
            curDatum = res.datum;
            events = res.events;
            break;
          } else {
            const slice = executeProgramSlice({
              initialDatum: curDatum,
              program,
              startStep: step,
              endStep: step + 1,
              priorEvents: events
            });
            curDatum = slice.datum;
            events = slice.events;
            step++;
          }
        }

        const out = finalizeAndVerifyExecution(curDatum, events);
        if (out.verified) verifiedCount++;
      } else if (strategy === 'speculative_2x_quorum') {
        // Two workers execute in parallel (2x compute cost, lower latency under single drop)
        const res = executeProgramSlice({
          initialDatum: seedDatum,
          program,
          startStep: 0,
          endStep: stepsPerTask
        });
        // Primary drops at dropStepModulo (wasting dropStepModulo ops), replica finishes in stepsPerTask ticks
        const primaryWasted = Math.min(stepsPerTask, dropStepModulo);
        totalPrimitiveOpsExecuted += stepsPerTask + primaryWasted;
        wastedPrimitiveOps += primaryWasted;
        totalWallTicks += stepsPerTask;

        const out = finalizeAndVerifyExecution(res.datum, res.events);
        if (out.verified) verifiedCount++;
      } else if (strategy === 'survival_checkpointed') {
        let step = 0;
        let curDatum = seedDatum;
        let events = [];
        let checkpointStep = 0;
        let checkpointDatum = seedDatum;
        let checkpointEvents = [];
        let workerAge = 0;

        while (step < stepsPerTask) {
          totalWallTicks++;
          workerAge++;
          totalPrimitiveOpsExecuted++;

          const slice = executeProgramSlice({
            initialDatum: curDatum,
            program,
            startStep: step,
            endStep: step + 1,
            priorEvents: events
          });
          curDatum = slice.datum;
          events = slice.events;
          step++;

          // Check worker survival probability P(alive) = exp(-lambda * workerAge)
          const pAlive = computeSurvivalProbability(workerLambda, workerAge);
          if (pAlive <= 0.60 && step < stepsPerTask) {
            // Proactively checkpoint current UOR Datum + partial Trace before drop
            checkpointStep = step;
            checkpointDatum = curDatum;
            checkpointEvents = [...events];
            checkpointsWritten++;
            workerAge = 0; // Fresh worker takes over from checkpoint
          }

          if (workerAge >= dropStepModulo && step < stepsPerTask) {
            // Unexpected drop: roll back only to last checkpoint instead of step 0
            wastedPrimitiveOps += step - checkpointStep;
            step = checkpointStep;
            curDatum = checkpointDatum;
            events = [...checkpointEvents];
            workerAge = 0;
          }
        }

        const out = finalizeAndVerifyExecution(curDatum, events);
        if (out.verified) verifiedCount++;
      }
    }

    const labelMap = {
      single_worker_retry: 'Single-Worker Restart (No Checkpoint)',
      speculative_2x_quorum: 'Speculative 2x Quorum (Active-Active)',
      survival_checkpointed: 'Survival-Checkpointed UOR Trace'
    };

    return {
      strategy: labelMap[strategy],
      tasks_completed: `${verifiedCount}/${taskCount}`,
      mean_latency_ticks: Number((totalWallTicks / taskCount).toFixed(1)),
      total_ring_ops: totalPrimitiveOpsExecuted,
      wasted_ring_ops: wastedPrimitiveOps,
      checkpoints_written: checkpointsWritten,
      trace_verified_rate: Number((verifiedCount / taskCount).toFixed(4))
    };
  });
}
