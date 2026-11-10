/**
 * @file tests/run_all.js
 * @description Isolated unit tests and comparative benchmark runner for all 5 strata.
 */

import assert from 'node:assert/strict';
import { createCheckpoint, demoProgram } from '../src/layer4-compute/replay.js';

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
  LiveUorMeshDatabase,
  benchmarkStorageStrategies
} from '../src/layer3-storage/index.js';

import {
  executeProgramSlice,
  finalizeAndVerifyExecution,
  LiveDistributedComputeCoordinator,
  benchmarkComputeStrategies
} from '../src/layer4-compute/index.js';

import {
  parsePointerTxt,
  formatPointerTxt,
  parseSrvRecord,
  generatePointerKeyPair,
  signPointerTxt,
  verifyPointerTxt,
  DohResolver,
  ExperimentTrialLogger
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
// LAYER 5 TESTS: DNS SRV & TXT Pointer Parsing, C8 Ed25519 Signing, C2 Staleness, O5 JSONL Logger
// ============================================================================
{
  const txt = formatPointerTxt({ peerId: 'node-1', endpoint: 'wss://ntfy.sh/t', rootAddress: 'uor:ca:01', timestampSec: 12345 });
  const parsed = parsePointerTxt(txt);
  assert.equal(parsed.v, 'uor1');
  assert.equal(parsed.peer, 'node-1');
  assert.equal(parsed.root, 'uor:ca:01');

  const srv = parseSrvRecord('10 20 443 node.example.net.');
  assert.deepEqual(srv, { priority: 10, weight: 20, port: 443, target: 'node.example.net' });

  // Claim C8 & C10: Ed25519 signed TXT pointer verification & byte size bound (<= 255B)
  const kp = await generatePointerKeyPair();
  const signed = await signPointerTxt(
    { peerId: 'node-1', endpoint: 'syntra-uor-bus-01', rootAddress: '66a5cdda2e757277b806e89ae7615aa5', timestampSec: 1700000000 },
    kp.privateKey
  );
  assert.equal(signed.c10_within_255b, true);
  assert.ok(signed.byteLength <= 200);

  const verifiedPtr = await verifyPointerTxt(signed.txt, kp.publicKeyB64Url);
  assert.equal(verifiedPtr.ok, true);
  assert.ok(verifiedPtr.verifyLatencyMs < 50);

  // Tampered pointer must fail verification
  const tamperedTxt = signed.txt.replace('peer=node-1', 'peer=node-9');
  const badVerify = await verifyPointerTxt(tamperedTxt, kp.publicKeyB64Url);
  assert.equal(badVerify.ok, false);

  // Claim C2 & Objective O2: Cloudflare SRV/TXT writer + staleness measurement against TTL
  const cfCalls = [];
  let dohPolls = 0;
  const mockDoh = new DohResolver({ format: "json",
    fetchImpl: async (url, opts) => {
      if (url.includes('api.cloudflare.com')) {
        cfCalls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
        return {
          ok: true,
          json: async () => ({ success: true, result: { id: 'cf-rec-1' } })
        };
      }
      dohPolls++;
      // Simulate resolver returning stale record on poll 1 and fresh SRV record on poll 2
      const targetHost = dohPolls >= 2 ? 'fresh.peer.example.net.' : 'stale.peer.example.net.';
      return {
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: [{ name: 'e1._stitch._udp.example.net.', type: 33, TTL: 30, data: `10 20 443 ${targetHost}` }]
        })
      };
    }
  });

  const cfRes = await mockDoh.writeCloudflareRecord({
    zoneId: 'zone-123',
    apiToken: 'tok-xyz',
    type: 'SRV',
    name: 'e1._stitch._udp.example.net',
    srvData: { priority: 10, weight: 20, port: 443, target: 'fresh.peer.example.net' },
    ttl: 30
  });
  assert.equal(cfRes.ok, true);
  assert.equal(cfCalls.length, 1);
  assert.equal(cfCalls[0].body.type, 'SRV');
  assert.equal(cfCalls[0].body.ttl, 30);

  const c2Probe = await mockDoh.measurePointerStaleness({
    name: 'e1._stitch._udp.example.net',
    type: 'SRV',
    expectedSubstring: 'fresh.peer.example.net',
    ttlSeconds: 30,
    pollIntervalMs: 10,
    maxWaitMs: 500
  });
  assert.equal(c2Probe.resolved, true);
  assert.equal(c2Probe.c2_within_2x_ttl, true);
  assert.equal(c2Probe.polls, 2);

  // Objective O5 & Claim C1: Pre-registered JSONL Trial Logger
  const logger = new ExperimentTrialLogger();
  for (let i = 0; i < 30; i++) {
    logger.logTrial('C1', {
      network_pair_class: 'home<->mobile',
      success: i < 24, // 24/30 = 80% >= 60%
      used_turn: false,
      ice_setup_sec: 1.8, heartbeats_passed: i < 24 ? 10 : 2, qualification_elapsed_sec: 9,
      ordered_channel: true, selected_path_observed: true
    });
  }
  const c1Summary = logger.summarizeC1('home<->mobile');
  assert.equal(c1Summary.trials, 30);
  assert.equal(c1Summary.direct_success_rate, 0.8);
  assert.equal(c1Summary.c1_status, 'THRESHOLDS_MET');
  assert.equal(logger.toJsonl().trim().split('\n').length, 30);
}

// ============================================================================
// END-TO-END MULTI-PEER WIRE TEST (LiveUorMeshDatabase + LiveDistributedComputeCoordinator)
// ============================================================================
{
  const warmBus = [];
  const createWiredNode = peerId => {
    const handlers = [];
    const peers = new Map();
    return {
      peerId,
      handlers,
      peers,
      openPeers() {
        return Array.from(peers.keys()).map(remoteId => ({ remoteId }));
      },
      sendToPeer(remoteId, pkt) {
        const target = peers.get(remoteId);
        if (target) {
          for (const fn of target.handlers) fn(peerId, pkt);
          return true;
        }
        return false;
      },
      broadcast(pkt) {
        let count = 0;
        for (const [remoteId, target] of peers.entries()) {
          for (const fn of target.handlers) fn(peerId, pkt);
          count++;
        }
        return count;
      },
      async publishWarmEnvelope(pkt) {
        warmBus.push(pkt);
        return true;
      },
      async fetchWarmEnvelopes() {
        return [...warmBus];
      }
    };
  };

  // 1. Peer A writes UOR object -> shards travel over wire to Peer B & Warm Relay
  //    Then BOTH Peer A and Peer B are destroyed (0 live peers), and Peer C boots from Warm Relay!
  const netA = createWiredNode('node-A');
  const netB = createWiredNode('node-B');
  netA.peers.set('node-B', netB);
  netB.peers.set('node-A', netA);

  const mountedInVmB = [];
  const dbA = new LiveUorMeshDatabase({ transport: netA });
  const dbB = new LiveUorMeshDatabase({
    transport: netB,
    vmBridge: {
      async mountUorObject(addressHex, bytes, label) {
        mountedInVmB.push({ addressHex, bytes, label });
      }
    }
  });
  netA.handlers.push((from, msg) => dbA.handleMeshMessage(from, msg));
  netB.handlers.push((from, msg) => dbB.handleMeshMessage(from, msg));

  const written = await dbA.put('state-across-zero-peer-gap', { label: 'kernel_state.txt', persistWarm: true, publicData: true });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(dbB.get(written.addressHex).ok, false); // Only one assigned fragment, never fake full replication.
  assert.equal(mountedInVmB.length, 0);

  // Destroy BOTH Peer A and Peer B (0 live peers online), then spawn Peer C and recover from warm buffer
  dbA.objects.clear();
  dbB.objects.clear();
  const netC = createWiredNode('node-C');
  const dbC = new LiveUorMeshDatabase({ transport: netC });
  const recoveredCount = await dbC.syncFromNetwork('30m', { publicData: true });
  assert.equal(recoveredCount, 1);
  assert.equal(dbC.get(written.addressHex).text, 'state-across-zero-peer-gap');

  // 2. Peer A starts a 9-step compute job, crashes at step 3 (after checkpointing to warm bus),
  //    and Peer C takes over from step 3, finishes steps 3..9, and verifies the 9-step UOR Trace!
  const coordC = new LiveDistributedComputeCoordinator({ transport: netC, liveDb: dbC, allowPublicRelay: true });
  // A canonical checkpoint identifies the complete program and input; replay checks its state.
  const program = demoProgram(9);
  await netA.publishWarmEnvelope({ type: 'compute_ckpt', jobId: 'job-crash-test', program,
    checkpoint: await createCheckpoint(program, 3), ownerPeerId: 'node-A-dead' });

  const resumedIds = await coordC.syncAndTakeOverJobs();
  assert.deepEqual(resumedIds, ['job-crash-test']);
  // Wait for zero-delay takeover completion
  await coordC.running.get('job-crash-test');
  const completedJob = coordC.jobs.get('job-crash-test');
  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.stepIndex, 9);
  assert.equal(completedJob.verified, true);
  assert.equal(dbC.get(completedJob.resultAddressHex).ok, true);
}

// ============================================================================
// PRINT COMPARATIVE BENCHMARK TABLES
// ============================================================================
console.log('\n[LAYER 1 BENCHMARK] UOR Hasher Substitution Axis Comparison (1,000 objects x 64B)');
console.table(benchmarkUorHashers(1000, 64));

const uniformDrops = [];
for (let t = 18; t < 600; t += 18) uniformDrops.push(t);
console.log('\n[LAYER 2 BENCHMARK A — CLAIM C3/C4 FALSIFICATION] Equal Refresh Budget (B=30) on Uniform Churn (CV=0.0)');
console.table(benchmarkSchedulers({ durationSeconds: 600, ttlSeconds: 60, dropTimestamps: uniformDrops, maxRefreshBudget: 30 }));

// Regime-switching churn: calm window (t=0..415, ~68s spacing) -> storm window (t=420..600, 9s spacing)
const burstyDrops = [63, 131, 197, 269, 341, 411, 420, 429, 438, 447, 456, 465, 474, 483, 492, 501, 510, 519, 528, 537, 546, 555, 564, 573, 582, 591];
const burstyBench = benchmarkSchedulers({ durationSeconds: 600, ttlSeconds: 60, dropTimestamps: burstyDrops, maxRefreshBudget: 30 });
console.log('\n[LAYER 2 BENCHMARK B — CLAIM C3/C4 REGIME TEST] Equal Refresh Budget (B=30) on Bursty Regime Churn (CV>1.0)');
console.table(burstyBench);

// Enforce C3 falsification discipline:
// 1. Unpaced Poisson-Survival loses to Fixed-Interval when capped at equal refresh budget B=30 (refutes naive C3)
// 2. Budget-Paced-Survival (Cauchy-Schwarz sqrt hazard pacing) beats Fixed-Interval at equal refresh budget B=30 on CV>1.0
const fixedBursty = burstyBench.find(r => r.scheduler === 'Fixed-Interval (TTL/2)');
const unpacedPoissonBursty = burstyBench.find(r => r.scheduler === 'Poisson-Survival');
const budgetPacedBursty = burstyBench.find(r => r.scheduler === 'Budget-Paced-Survival');
assert.equal(fixedBursty.refreshes_issued, 30);
assert.equal(budgetPacedBursty.refreshes_issued, 30);
assert.ok(unpacedPoissonBursty.unavailable_seconds > fixedBursty.unavailable_seconds);
assert.ok(budgetPacedBursty.unavailable_seconds < fixedBursty.unavailable_seconds);

console.log('\n[LAYER 3 BENCHMARK] Ephemeral UOR Database Durability Under 100% Node Turnover (0 initial nodes surviving)');
console.table(benchmarkStorageStrategies({ objectCount: 24, objectSizeBytes: 256, initialNodes: 5, generations: 8 }));

console.log('\n[LAYER 4 BENCHMARK] Distributed UOR Compute Engine Under Worker Churn (20 tasks x 24 ring ops)');
console.table(benchmarkComputeStrategies({ taskCount: 20, stepsPerTask: 24, workerLambda: 0.08, dropStepModulo: 9 }));

console.log('\n✓ All 5 isolated strata passed unit verification and comparative benchmarks.');
