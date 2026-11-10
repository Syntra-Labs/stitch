/**
 * @file tests/run_all.js
 * @description Isolated unit tests and comparative benchmark runner for all 5 strata.
 */

import assert from 'node:assert/strict';

import {
  Datum,
  PrimitiveOp,
  applyPrimitiveOp,
  ringCyclicDistance,
  hammingDistance,
  Fnv1aHasher16,
  Fnv1aHasher32,
  Sha256Hasher,
  mintContentAddress,
  TraceEvent,
  Trace,
  verifyTrace,
  benchmarkUorHashers
} from '../src/layer1-uor/index.js';

import {
  estimatePoissonRate,
  computeSurvivalProbability,
  computeBinaryEntropy,
  computeRouteSetTelemetry,
  benchmarkSchedulers
} from '../src/layer2-schedulers/index.js';

import {
  encodeXorShards2of3,
  decodeXorShards2of3,
  DistributedUorDatabase,
  benchmarkStorageStrategies
} from '../src/layer3-storage/index.js';

import {
  executeProgramSlice,
  finalizeAndVerifyExecution,
  benchmarkComputeStrategies
} from '../src/layer4-compute/index.js';

import {
  parsePointerTxt,
  formatPointerTxt,
  parseSrvRecord
} from '../src/layer5-transport/index.js';

// ============================================================================
// LAYER 1 TESTS: UOR Content Addressing, Ring Algebra & Trace Verification
// ============================================================================
{
  // Verify fundamental UOR Z/(2^n)Z involution identity: SUCC(x) == NEG(BNOT(x))
  for (const sample of [0, 1, 42, 127, 255]) {
    const x = Datum.w8(sample);
    const succ = applyPrimitiveOp(PrimitiveOp.SUCC, x);
    const negBnot = applyPrimitiveOp(PrimitiveOp.NEG, applyPrimitiveOp(PrimitiveOp.BNOT, x));
    assert.equal(succ.value, negBnot.value, `UOR identity failed at x=${sample}`);
  }

  // Verify cyclic ring distance and Hamming distance
  assert.equal(ringCyclicDistance(Datum.w8(255), Datum.w8(1)), 2n);
  assert.equal(hammingDistance(Datum.w8(0b10101010), Datum.w8(0b01010101)), 8);

  // Verify UOR Trace replay verifier rejects invalid traces and certifies valid traces
  const emptyRes = verifyTrace(new Trace([], new Fnv1aHasher16().finalize(), 64));
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.error, 'EmptyTrace');

  const payload = new Uint8Array([1, 2, 3, 4]);
  const { address, fingerprint } = mintContentAddress(payload, Fnv1aHasher16);
  const validTrace = new Trace([new TraceEvent(0, PrimitiveOp.SUCC, address)], fingerprint, 32);
  const validRes = verifyTrace(validTrace);
  assert.equal(validRes.ok, true);
  assert.equal(validRes.certificate.wittLevelBits, 32);

  // Out-of-order / non-contiguous trace steps must fail
  const badTrace = new Trace(
    [new TraceEvent(0, PrimitiveOp.SUCC, address), new TraceEvent(2, PrimitiveOp.ADD, address)],
    fingerprint,
    32
  );
  assert.equal(verifyTrace(badTrace).ok, false);
}

// ============================================================================
// LAYER 2 TESTS: Refresh & Liveness Schedulers
// ============================================================================
{
  const rate = estimatePoissonRate([0, 10, 20, 30]);
  assert.ok(Math.abs(rate - 0.1) < 1e-9);
  assert.equal(computeSurvivalProbability(0.1, 0), 1.0);
  assert.ok(Math.abs(computeBinaryEntropy(0.5) - 1.0) < 1e-9);

  const routeMetrics = computeRouteSetTelemetry([
    { id: 'r1', lambda: 0.02, ageSeconds: 5 },
    { id: 'r2', lambda: 0.02, ageSeconds: 5 }
  ]);
  assert.ok(routeMetrics.aggregate_survival_prob > 0.98);
}

// ============================================================================
// LAYER 3 TESTS: Distributed Ephemeral UOR Database & XOR Parity Shards
// ============================================================================
{
  const original = new Uint8Array([10, 20, 30, 40, 50, 60, 70]);
  const { originalLength, shards } = encodeXorShards2of3(original);

  // Drop shard 0 -> reconstruct from shard 1 + parity
  const rec0 = decodeXorShards2of3(originalLength, [null, shards[1], shards[2]]);
  assert.deepEqual(rec0, original);

  // Drop shard 1 -> reconstruct from shard 0 + parity
  const rec1 = decodeXorShards2of3(originalLength, [shards[0], null, shards[2]]);
  assert.deepEqual(rec1, original);

  // Verify 100% cohort turnover benchmark retains 100% of objects under proactive parity
  const storageResults = benchmarkStorageStrategies({
    objectCount: 16,
    objectSizeBytes: 128,
    initialNodes: 5,
    generations: 6
  });
  const proactiveRow = storageResults.find(r => r.strategy.includes('Proactive'));
  assert.equal(proactiveRow.initial_nodes_remaining, 0);
  assert.equal(proactiveRow.retention_rate, 1.0);
}

// ============================================================================
// LAYER 4 TESTS: Distributed UOR Compute Engine
// ============================================================================
{
  const seed = Datum.w64(100n);
  const program = [
    { op: PrimitiveOp.ADD, arg: Datum.w64(50n) },
    { op: PrimitiveOp.SUCC }
  ];
  const { datum, events } = executeProgramSlice({ initialDatum: seed, program });
  assert.equal(datum.value, 151n);
  const verified = finalizeAndVerifyExecution(datum, events);
  assert.equal(verified.verified, true);
}

// ============================================================================
// LAYER 5 TESTS: DNS SRV & TXT Pointer Parsing
// ============================================================================
{
  const txt = formatPointerTxt({ peerId: 'node-1', endpoint: 'wss://ntfy.sh/t', rootAddress: 'uor:ca:01', timestampSec: 12345 });
  const parsed = parsePointerTxt(txt);
  assert.equal(parsed.v, 'uor1');
  assert.equal(parsed.peer, 'node-1');
  assert.equal(parsed.root, 'uor:ca:01');

  const srv = parseSrvRecord('10 20 443 node.example.net.');
  assert.deepEqual(srv, { priority: 10, weight: 20, port: 443, target: 'node.example.net' });
}

// ============================================================================
// PRINT COMPARATIVE BENCHMARK TABLES
// ============================================================================
console.log('\n[LAYER 1 BENCHMARK] UOR Hasher Substitution Axis Comparison (1,000 objects x 64B)');
console.table(benchmarkUorHashers(1000, 64));

const drops = [];
for (let t = 18; t < 600; t += 18) drops.push(t);
console.log('\n[LAYER 2 BENCHMARK] Refresh Scheduler Comparison (600s window, drop interval = 18s, TTL = 60s)');
console.table(benchmarkSchedulers({ durationSeconds: 600, ttlSeconds: 60, dropTimestamps: drops }));

console.log('\n[LAYER 3 BENCHMARK] Ephemeral UOR Database Durability Under 100% Node Turnover (0 initial nodes surviving)');
console.table(benchmarkStorageStrategies({ objectCount: 24, objectSizeBytes: 256, initialNodes: 5, generations: 8 }));

console.log('\n[LAYER 4 BENCHMARK] Distributed UOR Compute Engine Under Worker Churn (20 tasks x 24 ring ops)');
console.table(benchmarkComputeStrategies({ taskCount: 20, stepsPerTask: 24, workerLambda: 0.08, dropStepModulo: 9 }));

console.log('\n✓ All 5 isolated strata passed unit verification and comparative benchmarks.');
