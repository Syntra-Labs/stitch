/**
 * @file src/layer2-schedulers/index.js
 * @description Layer 2: Isolated Liveness & Pointer Refresh Schedulers.
 * Compares 4 scheduling policies under identical failure traces:
 *   1. FixedIntervalScheduler (Static fraction of TTL)
 *   2. AdaptiveAimdScheduler (Additive-Increase Multiplicative-Decrease)
 *   3. PoissonSurvivalScheduler (MLE failure rate lambda, survival threshold 1 - epsilon)
 *   4. ShannonEntropyHysteresisScheduler (Binary entropy H(p) with hysteresis band)
 * Zero upward dependencies.
 */

const LN2 = Math.LN2;

/**
 * Estimate Poisson event rate lambda (1/s) from inter-arrival intervals.
 * @param {number[]} timestampsSeconds
 * @param {number} [fallbackLambda=0.02]
 * @returns {number}
 */
export function estimatePoissonRate(timestampsSeconds, fallbackLambda = 0.02) {
  if (!Array.isArray(timestampsSeconds) || timestampsSeconds.length < 2) {
    return fallbackLambda;
  }
  let sum = 0;
  let count = 0;
  for (let i = 1; i < timestampsSeconds.length; i++) {
    const dt = timestampsSeconds[i] - timestampsSeconds[i - 1];
    if (dt > 0) {
      sum += dt;
      count++;
    }
  }
  if (count === 0) return fallbackLambda;
  return count / sum;
}

/**
 * Exponential survival function P(alive at age t) = exp(-lambda * t).
 */
export function computeSurvivalProbability(lambda, ageSeconds) {
  if (ageSeconds <= 0 || lambda <= 0) return 1.0;
  return Math.exp(-lambda * ageSeconds);
}

/**
 * Binary Shannon entropy H(p) in bits [0, 1].
 */
export function computeBinaryEntropy(p) {
  if (p <= 0.0 || p >= 1.0) return 0.0;
  return -(p * (Math.log(p) / LN2) + (1.0 - p) * (Math.log(1.0 - p) / LN2));
}

/**
 * Age-weighted multi-route entropy and aggregate survival probability.
 * @param {Array<{id: string, lambda: number, ageSeconds: number}>} routes
 */
export function computeRouteSetTelemetry(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    return { diversity_entropy_bits: 0, aggregate_survival_prob: 0, staleness_entropy_bits: 1 };
  }
  const survivals = routes.map(r => computeSurvivalProbability(r.lambda, r.ageSeconds));
  const total = survivals.reduce((a, b) => a + b, 0);
  let diversityH = 0;
  if (total > 1e-12) {
    for (const s of survivals) {
      const p = s / total;
      if (p > 0) diversityH -= p * (Math.log(p) / LN2);
    }
  }
  let probAllFailed = 1.0;
  for (const s of survivals) {
    probAllFailed *= (1.0 - s);
  }
  const aggregateSurvival = 1.0 - probAllFailed;
  return {
    diversity_entropy_bits: diversityH,
    aggregate_survival_prob: aggregateSurvival,
    staleness_entropy_bits: computeBinaryEntropy(aggregateSurvival)
  };
}

// ============================================================================
// CANDIDATE SCHEDULER 1: Fixed-Interval Scheduler
// ============================================================================
export class FixedIntervalScheduler {
  static NAME = 'Fixed-Interval (TTL/2)';

  constructor({ ttlSeconds = 60, fraction = 0.5, minFloorSeconds = 5 } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.intervalSeconds = Math.max(minFloorSeconds, ttlSeconds * fraction);
    this.lastRefreshSec = 0;
    this.refreshCount = 0;
  }

  recordFailure(_timestampSec) {}

  markRefreshed(timestampSec) {
    this.lastRefreshSec = timestampSec;
    this.refreshCount++;
  }

  evaluate(nowSec) {
    const ageSeconds = Math.max(0, nowSec - this.lastRefreshSec);
    const shouldRefresh = ageSeconds >= this.intervalSeconds;
    return {
      ageSeconds,
      lambda: 1 / this.ttlSeconds,
      pAlive: computeSurvivalProbability(1 / this.ttlSeconds, ageSeconds),
      entropyBits: 0,
      targetIntervalSeconds: this.intervalSeconds,
      shouldRefresh,
      reason: shouldRefresh ? 'fixed_period' : null
    };
  }
}

// ============================================================================
// CANDIDATE SCHEDULER 2: Adaptive AIMD Scheduler
// ============================================================================
export class AdaptiveAimdScheduler {
  static NAME = 'Adaptive-AIMD';

  constructor({ ttlSeconds = 60, minFloorSeconds = 5, additiveStep = 2.0, multiplicativeFactor = 0.5 } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.minFloorSeconds = minFloorSeconds;
    this.additiveStep = additiveStep;
    this.multiplicativeFactor = multiplicativeFactor;
    this.currentInterval = ttlSeconds * 0.5;
    this.lastRefreshSec = 0;
    this.refreshCount = 0;
  }

  recordFailure(_timestampSec) {
    this.currentInterval = Math.max(
      this.minFloorSeconds,
      this.currentInterval * this.multiplicativeFactor
    );
  }

  markRefreshed(timestampSec) {
    this.lastRefreshSec = timestampSec;
    this.refreshCount++;
    this.currentInterval = Math.min(
      this.ttlSeconds * 0.8,
      this.currentInterval + this.additiveStep
    );
  }

  evaluate(nowSec) {
    const ageSeconds = Math.max(0, nowSec - this.lastRefreshSec);
    const shouldRefresh = ageSeconds >= this.currentInterval;
    const impliedLambda = 1 / Math.max(1, this.currentInterval);
    const pAlive = computeSurvivalProbability(impliedLambda, ageSeconds);
    return {
      ageSeconds,
      lambda: impliedLambda,
      pAlive,
      entropyBits: computeBinaryEntropy(pAlive),
      targetIntervalSeconds: this.currentInterval,
      shouldRefresh,
      reason: shouldRefresh ? 'aimd_window' : null
    };
  }
}

// ============================================================================
// CANDIDATE SCHEDULER 3: Poisson Survival Threshold Scheduler
// ============================================================================
export class PoissonSurvivalScheduler {
  static NAME = 'Poisson-Survival';

  constructor({ ttlSeconds = 60, epsilon = 0.10, minFloorSeconds = 5, maxHistory = 64 } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.epsilon = epsilon;
    this.minFloorSeconds = minFloorSeconds;
    this.maxHistory = maxHistory;
    this.failureTimestamps = [];
    this.lastRefreshSec = 0;
    this.refreshCount = 0;
  }

  recordFailure(timestampSec) {
    this.failureTimestamps.push(timestampSec);
    if (this.failureTimestamps.length > this.maxHistory) {
      this.failureTimestamps.shift();
    }
  }

  markRefreshed(timestampSec) {
    this.lastRefreshSec = timestampSec;
    this.refreshCount++;
  }

  evaluate(nowSec) {
    const lambda = estimatePoissonRate(this.failureTimestamps, 1 / this.ttlSeconds);
    const ageSeconds = Math.max(0, nowSec - this.lastRefreshSec);
    const pAlive = computeSurvivalProbability(lambda, ageSeconds);
    const entropyBits = computeBinaryEntropy(pAlive);

    const survivalBoundSec = -Math.log(Math.max(1e-6, 1.0 - this.epsilon)) / Math.max(1e-6, lambda);
    const targetIntervalSeconds = Math.max(
      this.minFloorSeconds,
      Math.min(this.ttlSeconds * 0.5, survivalBoundSec)
    );

    const shouldRefresh = ageSeconds >= targetIntervalSeconds;
    return {
      ageSeconds,
      lambda,
      pAlive,
      entropyBits,
      targetIntervalSeconds,
      shouldRefresh,
      reason: shouldRefresh ? 'survival_bound' : null
    };
  }
}

// ============================================================================
// CANDIDATE SCHEDULER 4: Shannon Entropy Hysteresis Scheduler
// ============================================================================
export class ShannonEntropyHysteresisScheduler {
  static NAME = 'Entropy-Hysteresis';

  constructor({
    ttlSeconds = 60,
    epsilon = 0.08,
    entropyThreshold = 0.40,
    hysteresis = 0.04,
    minFloorSeconds = 5,
    maxHistory = 64
  } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.epsilon = epsilon;
    this.entropyThreshold = entropyThreshold;
    this.hysteresis = hysteresis;
    this.minFloorSeconds = minFloorSeconds;
    this.maxHistory = maxHistory;
    this.failureTimestamps = [];
    this.lastRefreshSec = 0;
    this.inHighEntropyState = false;
    this.refreshCount = 0;
  }

  recordFailure(timestampSec) {
    this.failureTimestamps.push(timestampSec);
    if (this.failureTimestamps.length > this.maxHistory) {
      this.failureTimestamps.shift();
    }
  }

  markRefreshed(timestampSec) {
    this.lastRefreshSec = timestampSec;
    this.inHighEntropyState = false;
    this.refreshCount++;
  }

  evaluate(nowSec) {
    const lambda = estimatePoissonRate(this.failureTimestamps, 1 / this.ttlSeconds);
    const ageSeconds = Math.max(0, nowSec - this.lastRefreshSec);
    const pAlive = computeSurvivalProbability(lambda, ageSeconds);
    const entropyBits = computeBinaryEntropy(pAlive);

    const upper = this.entropyThreshold + this.hysteresis;
    const lower = Math.max(0, this.entropyThreshold - this.hysteresis);

    if (entropyBits >= upper || pAlive <= 0.5) {
      this.inHighEntropyState = true;
    } else if (entropyBits <= lower && pAlive > 0.5) {
      this.inHighEntropyState = false;
    }

    const survivalBoundSec = -Math.log(Math.max(1e-6, 1.0 - this.epsilon)) / Math.max(1e-6, lambda);
    const targetIntervalSeconds = Math.max(
      this.minFloorSeconds,
      Math.min(this.ttlSeconds * 0.8, survivalBoundSec)
    );

    let shouldRefresh = false;
    let reason = null;
    if (ageSeconds >= this.minFloorSeconds) {
      if (ageSeconds >= this.ttlSeconds * 0.8) {
        shouldRefresh = true;
        reason = 'ttl_cap';
      } else if (1.0 - pAlive >= this.epsilon) {
        shouldRefresh = true;
        reason = 'survival_epsilon';
      } else if (this.inHighEntropyState) {
        shouldRefresh = true;
        reason = 'entropy_hysteresis';
      }
    }

    return {
      ageSeconds,
      lambda,
      pAlive,
      entropyBits,
      targetIntervalSeconds,
      shouldRefresh,
      reason
    };
  }
}

// ============================================================================
// CANDIDATE SCHEDULER 5: Budget-Paced Survival Scheduler (Fixes C3 Budget Exhaustion)
// Allocates refresh budget B across horizon T proportional to short-term vs long-term hazard ratio.
// ============================================================================
export class BudgetPacedSurvivalScheduler {
  static NAME = 'Budget-Paced-Survival';

  constructor({ ttlSeconds = 60, durationSeconds = 600, maxRefreshBudget = 30, minFloorSeconds = 5 } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.durationSeconds = durationSeconds;
    this.maxRefreshBudget = maxRefreshBudget;
    this.minFloorSeconds = minFloorSeconds;
    this.failureTimestamps = [];
    this.lastRefreshSec = 0;
    this.refreshCount = 0;
  }

  recordFailure(timestampSec) {
    this.failureTimestamps.push(timestampSec);
  }

  markRefreshed(timestampSec) {
    this.lastRefreshSec = timestampSec;
    this.refreshCount++;
  }

  evaluate(nowSec) {
    const ageSeconds = Math.max(0, nowSec - this.lastRefreshSec);
    const shortFailures = this.failureTimestamps.slice(-4);
    const lambdaShort = estimatePoissonRate(shortFailures, 1 / this.ttlSeconds);
    const lambdaLong = estimatePoissonRate(this.failureTimestamps, 1 / this.ttlSeconds);
    // Cauchy-Schwarz optimal refresh spacing under budget constraint: dt* proportional to (lambda_long / lambda_short)^(1/2)
    const sqrtHazardRatio = Math.max(0.5, Math.min(2.5, Math.sqrt(lambdaShort / Math.max(1e-6, lambdaLong))));

    const refreshesUsed = Math.max(0, this.refreshCount - 1);
    const budgetRemaining = Math.max(1, this.maxRefreshBudget - refreshesUsed);
    const timeRemaining = Math.max(this.minFloorSeconds, this.durationSeconds - nowSec);
    const nominalBudgetInterval = timeRemaining / budgetRemaining;

    const targetIntervalSeconds = Math.max(
      this.minFloorSeconds,
      Math.min(this.ttlSeconds * 0.9, nominalBudgetInterval / sqrtHazardRatio)
    );
    const pAlive = computeSurvivalProbability(lambdaShort, ageSeconds);
    const shouldRefresh = ageSeconds >= targetIntervalSeconds;
    return {
      ageSeconds,
      lambda: lambdaShort,
      pAlive,
      entropyBits: computeBinaryEntropy(pAlive),
      targetIntervalSeconds,
      shouldRefresh,
      reason: shouldRefresh ? 'budget_paced_hazard' : null
    };
  }
}

/**
 * Compute sample mean, standard deviation, and Coefficient of Variation (CV = std / mean)
 * of inter-event intervals to test Claim C4 (memoryless exponential fit requires CV ~ 1.0).
 * @param {number[]} timestampsSeconds
 */
export function computeIntervalStats(timestampsSeconds) {
  if (!Array.isArray(timestampsSeconds) || timestampsSeconds.length < 3) {
    return { count: 0, mean_sec: 0, std_sec: 0, cv: 0, c4_exponential_valid: false };
  }
  const intervals = [];
  for (let i = 1; i < timestampsSeconds.length; i++) {
    const dt = timestampsSeconds[i] - timestampsSeconds[i - 1];
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length < 2) {
    return { count: intervals.length, mean_sec: 0, std_sec: 0, cv: 0, c4_exponential_valid: false };
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;
  return {
    count: intervals.length,
    mean_sec: Number(mean.toFixed(2)),
    std_sec: Number(std.toFixed(2)),
    cv: Number(cv.toFixed(3)),
    c4_exponential_valid: cv >= 0.5 && cv <= 2.0
  };
}

/**
 * Evaluate and compare all 4 scheduler candidates under Claim C3 protocol:
 *   - Supports an explicit `maxRefreshBudget` so all schedulers are capped at the
 *     exact same maximum refresh count (exposing whether adaptive scheduling wins
 *     at equal cost, rather than winning by simply polling 5x more often).
 *
 * @param {object} params
 * @param {number} [params.durationSeconds=600]
 * @param {number} [params.ttlSeconds=60]
 * @param {number[]} params.dropTimestamps
 * @param {number | null} [params.maxRefreshBudget=null]
 */
export function benchmarkSchedulers({
  durationSeconds = 600,
  ttlSeconds = 60,
  dropTimestamps = [],
  maxRefreshBudget = null
}) {
  const sortedDrops = [...dropTimestamps].sort((a, b) => a - b);
  const intervalStats = computeIntervalStats(sortedDrops);

  // If maxRefreshBudget is set, fixed-interval spreads that exact budget evenly across durationSeconds
  const fixedFraction = maxRefreshBudget
    ? Math.max(5, durationSeconds / maxRefreshBudget) / ttlSeconds
    : 0.5;

  const candidates = [
    () => new FixedIntervalScheduler({ ttlSeconds, fraction: fixedFraction, minFloorSeconds: 5 }),
    () => new AdaptiveAimdScheduler({ ttlSeconds, minFloorSeconds: 5 }),
    () => new PoissonSurvivalScheduler({ ttlSeconds, epsilon: 0.10, minFloorSeconds: 5, maxHistory: 8 }),
    () => new ShannonEntropyHysteresisScheduler({ ttlSeconds, epsilon: 0.08, entropyThreshold: 0.40, hysteresis: 0.04, minFloorSeconds: 5, maxHistory: 8 }),
    () => new BudgetPacedSurvivalScheduler({ ttlSeconds, durationSeconds, maxRefreshBudget: maxRefreshBudget || 30, minFloorSeconds: 5 })
  ];

  return candidates.map(factory => {
    const sched = factory();
    sched.markRefreshed(0);

    let alive = true;
    let unavailableSeconds = 0;
    let stalenessEvents = 0;
    let dropIdx = 0;
    let lastDropTime = null;
    const recoveryLags = [];

    for (let t = 1; t <= durationSeconds; t++) {
      while (dropIdx < sortedDrops.length && sortedDrops[dropIdx] <= t) {
        if (alive) {
          alive = false;
          stalenessEvents++;
          lastDropTime = sortedDrops[dropIdx];
        }
        sched.recordFailure(sortedDrops[dropIdx]);
        dropIdx++;
      }

      const refreshesUsed = sched.refreshCount - 1;
      const budgetRemaining = maxRefreshBudget === null || refreshesUsed < maxRefreshBudget;
      const status = sched.evaluate(t);

      if (status.shouldRefresh && budgetRemaining) {
        if (!alive && lastDropTime !== null) {
          recoveryLags.push(t - lastDropTime);
          lastDropTime = null;
        }
        alive = true;
        sched.markRefreshed(t);
      }

      if (!alive) {
        unavailableSeconds++;
      }
    }

    const refreshesIssued = sched.refreshCount - 1;
    const availabilityRatio = Number(((durationSeconds - unavailableSeconds) / durationSeconds).toFixed(4));
    const meanRecoveryLagSec = recoveryLags.length > 0
      ? Number((recoveryLags.reduce((a, b) => a + b, 0) / recoveryLags.length).toFixed(2))
      : 0;

    return {
      scheduler: sched.constructor.NAME,
      refreshes_issued: refreshesIssued,
      staleness_events: stalenessEvents,
      unavailable_seconds: unavailableSeconds,
      availability_ratio: availabilityRatio,
      mean_recovery_lag_sec: meanRecoveryLagSec,
      interval_cv: intervalStats.cv
    };
  });
}
