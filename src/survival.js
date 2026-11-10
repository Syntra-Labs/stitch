/**
 * @file survival.js
 * @description Survival process estimator, binary & route-set Shannon entropy,
 * and hysteresis-bounded refresh scheduler for the stitch persistence fabric.
 */

const LN2 = Math.LN2;

/**
 * Estimate Poisson event/failure rate lambda (events per second) from observed timestamps.
 * @param {number[]} timestampsSeconds - Monotonically increasing event timestamps in seconds.
 * @param {number} [defaultLambda=0.05] - Fallback rate when fewer than 2 events exist.
 * @returns {number} Estimated rate lambda (1/s).
 */
export function estimateLambda(timestampsSeconds, defaultLambda = 0.05) {
  if (!Array.isArray(timestampsSeconds) || timestampsSeconds.length < 2) {
    return defaultLambda;
  }
  const intervals = [];
  for (let i = 1; i < timestampsSeconds.length; i++) {
    const dt = timestampsSeconds[i] - timestampsSeconds[i - 1];
    if (dt > 0) {
      intervals.push(dt);
    }
  }
  if (intervals.length === 0) {
    return defaultLambda;
  }
  const meanInterval = intervals.reduce((acc, v) => acc + v, 0) / intervals.length;
  return 1.0 / meanInterval;
}

/**
 * Survival probability P(alive at age t) = exp(-lambda * t).
 * @param {number} lambda - Failure/churn rate (1/s).
 * @param {number} ageSeconds - Time elapsed since last verified refresh (s).
 * @returns {number} Probability in [0, 1].
 */
export function survivalProbability(lambda, ageSeconds) {
  if (ageSeconds <= 0) return 1.0;
  if (lambda <= 0) return 1.0;
  return Math.exp(-lambda * ageSeconds);
}

/**
 * Binary Shannon entropy H(p) = -p log2(p) - (1-p) log2(1-p) in bits [0, 1].
 * Measures uncertainty of "alive vs. stale/dead".
 * @param {number} p - Survival probability in [0, 1].
 * @returns {number} Binary entropy in bits [0, 1].
 */
export function binaryEntropy(p) {
  if (p <= 0.0 || p >= 1.0) return 0.0;
  return -(p * (Math.log(p) / LN2) + (1.0 - p) * (Math.log(1.0 - p) / LN2));
}

/**
 * Compute route-set entropy across multiple next-hops / candidate pointers,
 * separating healthy diversity from age-induced staleness.
 *
 * @param {Array<{id: string, lambda: number, ageSeconds: number, weight?: number}>} routes
 * @returns {{rawDiversityEntropy: number, effectiveSurvival: number, staleUncertaintyEntropy: number}}
 */
export function routeSetMetrics(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    return { rawDiversityEntropy: 0, effectiveSurvival: 0, staleUncertaintyEntropy: 1 };
  }

  const survivals = routes.map(r => {
    const w = r.weight ?? 1.0;
    return w * survivalProbability(r.lambda, r.ageSeconds);
  });

  const sumS = survivals.reduce((a, b) => a + b, 0);
  if (sumS <= 1e-12) {
    return { rawDiversityEntropy: 0, effectiveSurvival: 0, staleUncertaintyEntropy: 1 };
  }

  const normalized = survivals.map(s => s / sumS);
  let diversityH = 0;
  for (const p of normalized) {
    if (p > 0) {
      diversityH -= p * (Math.log(p) / LN2);
    }
  }

  // Probability that at least one independent route in the set survives:
  // P(any alive) = 1 - prod(1 - p_i)
  let probAllDead = 1.0;
  for (const r of routes) {
    const pAlive = survivalProbability(r.lambda, r.ageSeconds);
    probAllDead *= (1.0 - pAlive);
  }
  const effectiveSurvival = 1.0 - probAllDead;
  const staleUncertaintyEntropy = binaryEntropy(effectiveSurvival);

  return {
    rawDiversityEntropy: diversityH,
    effectiveSurvival,
    staleUncertaintyEntropy
  };
}

/**
 * Compute optimal refresh delay in seconds:
 *   t_refresh = min(ttlSeconds / 2, -ln(survivalFloor) / lambda)
 * Also enforces a minimum protocol floor (e.g., 5s for BGP keepalive stability).
 *
 * @param {object} params
 * @param {number} params.lambda - Observed churn/failure rate (1/s).
 * @param {number} [params.ttlSeconds=60] - Record TTL or BGP hold timer (s).
 * @param {number} [params.epsilon=0.05] - Acceptable staleness probability (or decay threshold).
 * @param {number} [params.minFloorSeconds=5] - Hard minimum interval to prevent route flapping.
 * @param {number} [params.jitterFraction=0.1] - Symmetric jitter fraction [0, 0.5).
 * @param {() => number} [params.rng=Math.random] - Random number generator for deterministic testing.
 * @returns {number} Recommended refresh interval in seconds.
 */
export function computeRefreshInterval({
  lambda,
  ttlSeconds = 60,
  epsilon = 0.05,
  minFloorSeconds = 5,
  jitterFraction = 0.1,
  rng = Math.random
}) {
  const safeLambda = Math.max(lambda, 1e-6);
  const halfTtl = ttlSeconds * 0.5;

  // Target survival probability (1 - epsilon) if epsilon < 0.5, or direct decay bound -ln(epsilon)/lambda
  const survivalBound = -Math.log(Math.max(1e-6, Math.min(0.999999, 1.0 - epsilon))) / safeLambda;
  const baseInterval = Math.min(halfTtl, survivalBound);

  // Apply jitter in [1 - jitterFraction, 1 + jitterFraction]
  const jitter = 1.0 + (rng() * 2.0 - 1.0) * jitterFraction;
  const jittered = baseInterval * jitter;

  return Math.max(minFloorSeconds, jittered);
}

/**
 * Stateful SurvivalClock that tracks liveness events, computes real-time entropy,
 * and decides when to trigger a pointer/route refresh with hysteresis.
 */
export class SurvivalClock {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlSeconds=60]
   * @param {number} [options.epsilon=0.08] - Max acceptable staleness probability (1 - P_alive).
   * @param {number} [options.entropyThreshold=0.40] - Binary entropy threshold in bits to trigger refresh.
   * @param {number} [options.hysteresis=0.05] - Hysteresis band in bits.
   * @param {number} [options.minFloorSeconds=5] - Minimum refresh interval floor (s).
   * @param {number} [options.maxHistory=64] - Rolling window of timestamps.
   */
  constructor(options = {}) {
    this.ttlSeconds = options.ttlSeconds ?? 60;
    this.epsilon = options.epsilon ?? 0.08;
    this.entropyThreshold = options.entropyThreshold ?? 0.40;
    this.hysteresis = options.hysteresis ?? 0.05;
    this.minFloorSeconds = options.minFloorSeconds ?? 5;
    this.maxHistory = options.maxHistory ?? 64;

    this.failureTimestamps = [];
    this.lastRefreshTime = null;
    this.inHighEntropyState = false;
    this.refreshCount = 0;
  }

  /**
   * Record a churn, failure, or timeout event at `timestampSeconds`.
   * @param {number} timestampSeconds
   */
  recordChurnEvent(timestampSeconds) {
    this.failureTimestamps.push(timestampSeconds);
    if (this.failureTimestamps.length > this.maxHistory) {
      this.failureTimestamps.shift();
    }
  }

  /**
   * Mark that the pointer/route was refreshed at `timestampSeconds`.
   * @param {number} timestampSeconds
   */
  markRefreshed(timestampSeconds) {
    this.lastRefreshTime = timestampSeconds;
    this.inHighEntropyState = false;
    this.refreshCount += 1;
  }

  /**
   * Evaluate current survival telemetry and whether a refresh should fire now.
   * @param {number} nowSeconds
   * @returns {{
   *   lambda: number,
   *   ageSeconds: number,
   *   pAlive: number,
   *   entropyBits: number,
   *   nextRefreshInSeconds: number,
   *   shouldRefresh: boolean,
   *   reason: string | null
   * }}
   */
  evaluate(nowSeconds) {
    if (this.lastRefreshTime === null) {
      this.lastRefreshTime = nowSeconds;
    }

    const lambda = estimateLambda(this.failureTimestamps, 1.0 / this.ttlSeconds);
    const ageSeconds = Math.max(0, nowSeconds - this.lastRefreshTime);
    const pAlive = survivalProbability(lambda, ageSeconds);
    const entropyBits = binaryEntropy(pAlive);

    const targetInterval = computeRefreshInterval({
      lambda,
      ttlSeconds: this.ttlSeconds,
      epsilon: this.epsilon,
      minFloorSeconds: this.minFloorSeconds,
      jitterFraction: 0.0
    });

    // Hysteresis evaluation on binary entropy (while pAlive > 0.5)
    const upperBound = this.entropyThreshold + this.hysteresis;
    const lowerBound = Math.max(0, this.entropyThreshold - this.hysteresis);

    if (entropyBits >= upperBound || pAlive <= 0.5) {
      this.inHighEntropyState = true;
    } else if (entropyBits <= lowerBound && pAlive > 0.5) {
      this.inHighEntropyState = false;
    }

    let shouldRefresh = false;
    let reason = null;

    if (ageSeconds >= this.minFloorSeconds) {
      if (ageSeconds >= this.ttlSeconds * 0.8) {
        shouldRefresh = true;
        reason = 'ttl_cap';
      } else if (1.0 - pAlive >= this.epsilon) {
        shouldRefresh = true;
        reason = 'survival_threshold';
      } else if (this.inHighEntropyState) {
        shouldRefresh = true;
        reason = 'entropy_hysteresis';
      }
    }

    const nextRefreshInSeconds = Math.max(0, targetInterval - ageSeconds);

    return {
      lambda,
      ageSeconds,
      pAlive,
      entropyBits,
      nextRefreshInSeconds,
      shouldRefresh,
      reason
    };
  }
}

/**
 * Run a deterministic A/B comparison between Fixed-TTL refresh and Entropy-Driven refresh
 * across a synthetic sequence of network churn events.
 *
 * @param {object} config
 * @param {number} [config.durationSeconds=600]
 * @param {number} [config.ttlSeconds=60]
 * @param {number[]} config.dropTimestamps - Moments when the underlying link/pointer goes stale.
 * @returns {{
 *   fixed: { refreshes: number, staleSeconds: number, stalenessRatio: number },
 *   entropy: { refreshes: number, staleSeconds: number, stalenessRatio: number }
 * }}
 */
export function compareFixedVsEntropy({
  durationSeconds = 600,
  ttlSeconds = 60,
  dropTimestamps = []
}) {
  const drops = [...dropTimestamps].sort((a, b) => a - b);

  // 1. Fixed schedule: refreshes blindly every ttlSeconds * 0.5
  const fixedInterval = Math.max(5, Math.floor(ttlSeconds * 0.5));
  let fixedRefreshes = 0;
  let fixedStaleSeconds = 0;
  let fixedPointerAlive = true;
  let dropIdxA = 0;

  for (let t = 1; t <= durationSeconds; t++) {
    while (dropIdxA < drops.length && drops[dropIdxA] <= t) {
      fixedPointerAlive = false;
      dropIdxA++;
    }
    if (t % fixedInterval === 0) {
      fixedPointerAlive = true;
      fixedRefreshes++;
    }
    if (!fixedPointerAlive) {
      fixedStaleSeconds++;
    }
  }

  // 2. Entropy-driven schedule: adapts to observed drop cadence
  const clock = new SurvivalClock({
    ttlSeconds,
    epsilon: 0.10,
    entropyThreshold: 0.42,
    hysteresis: 0.03,
    minFloorSeconds: 5
  });
  clock.markRefreshed(0);

  let entropyPointerAlive = true;
  let entropyStaleSeconds = 0;
  let dropIdxB = 0;

  for (let t = 1; t <= durationSeconds; t++) {
    while (dropIdxB < drops.length && drops[dropIdxB] <= t) {
      entropyPointerAlive = false;
      clock.recordChurnEvent(drops[dropIdxB]);
      dropIdxB++;
    }
    const status = clock.evaluate(t);
    if (status.shouldRefresh) {
      entropyPointerAlive = true;
      clock.markRefreshed(t);
    }
    if (!entropyPointerAlive) {
      entropyStaleSeconds++;
    }
  }

  return {
    fixed: {
      refreshes: fixedRefreshes,
      staleSeconds: fixedStaleSeconds,
      stalenessRatio: fixedStaleSeconds / durationSeconds
    },
    entropy: {
      refreshes: clock.refreshCount - 1, // exclude initial t=0 mark
      staleSeconds: entropyStaleSeconds,
      stalenessRatio: entropyStaleSeconds / durationSeconds
    }
  };
}
