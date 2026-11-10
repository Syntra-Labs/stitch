import assert from 'node:assert/strict';
import {
  estimateLambda,
  survivalProbability,
  binaryEntropy,
  routeSetMetrics,
  computeRefreshInterval,
  SurvivalClock,
  compareFixedVsEntropy
} from '../src/survival.js';
import {
  parsePointerTxt,
  formatPointerTxt,
  parseSrvData
} from '../src/pointer.js';

// 1. Test Poisson rate estimator
{
  const ts = [0, 20, 40, 60];
  const lambda = estimateLambda(ts);
  assert.ok(Math.abs(lambda - 0.05) < 1e-9, `Expected lambda=0.05, got ${lambda}`);
}

// 2. Test survival probability and binary entropy
{
  const p0 = survivalProbability(0.05, 0);
  assert.equal(p0, 1.0);
  assert.equal(binaryEntropy(p0), 0.0);

  // At t = ln(2)/lambda, P(alive) = 0.5 and binary entropy H(0.5) = 1.0 bit
  const tHalf = Math.LN2 / 0.05;
  const pHalf = survivalProbability(0.05, tHalf);
  assert.ok(Math.abs(pHalf - 0.5) < 1e-9);
  assert.ok(Math.abs(binaryEntropy(pHalf) - 1.0) < 1e-9);
}

// 3. Test multi-route set entropy (distinguishing diversity vs staleness)
{
  const freshRoutes = [
    { id: 'r1', lambda: 0.02, ageSeconds: 1 },
    { id: 'r2', lambda: 0.02, ageSeconds: 1 }
  ];
  const mFresh = routeSetMetrics(freshRoutes);
  assert.ok(Math.abs(mFresh.rawDiversityEntropy - 1.0) < 1e-6);
  assert.ok(mFresh.effectiveSurvival > 0.99);

  const staleRoutes = [
    { id: 'r1', lambda: 0.05, ageSeconds: 60 },
    { id: 'r2', lambda: 0.05, ageSeconds: 60 }
  ];
  const mStale = routeSetMetrics(staleRoutes);
  assert.ok(mStale.effectiveSurvival < 0.15);
}

// 4. Test refresh interval floor and survival bound
{
  const interval = computeRefreshInterval({
    lambda: 0.05,
    ttlSeconds: 60,
    epsilon: 0.05,
    minFloorSeconds: 5,
    jitterFraction: 0
  });
  // -ln(0.95) / 0.05 = 1.0258s -> clamped to 5s BGP/DNS stability floor
  assert.equal(interval, 5);
}

// 5. Test A/B comparison (Entropy scheduler reduces staleness under frequent drops)
{
  const drops = [];
  for (let t = 18; t < 600; t += 18) {
    drops.push(t);
  }
  const ab = compareFixedVsEntropy({
    durationSeconds: 600,
    ttlSeconds: 60,
    dropTimestamps: drops
  });
  assert.ok(
    ab.entropy.staleSeconds < ab.fixed.staleSeconds,
    `Expected entropy staleSeconds (${ab.entropy.staleSeconds}) < fixed (${ab.fixed.staleSeconds})`
  );
}

// 6. Test DNS SRV and TXT pointer parsers
{
  const txt = formatPointerTxt({ peer: 'peer-abc', ep: 'wss://ntfy.sh/test', ts: 1700000000 });
  const parsed = parsePointerTxt(txt);
  assert.equal(parsed.v, 'stitch1');
  assert.equal(parsed.peer, 'peer-abc');
  assert.equal(parsed.ep, 'wss://ntfy.sh/test');
  assert.equal(parsed.ts, '1700000000');

  const srv = parseSrvData('10 5 443 stitch.example.net.');
  assert.deepEqual(srv, {
    priority: 10,
    weight: 5,
    port: 443,
    target: 'stitch.example.net'
  });
}

console.log('✓ All stitch survival, entropy, and pointer tests passed.');
