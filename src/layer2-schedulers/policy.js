/** Conservative reservation ledger. Failed or ambiguous effects keep their reservation charged. */
import { identifier, natural, record, refuse } from '../layer1-uor/contracts.js';
import { snapshotRecord } from '../layer1-uor/custody.js';
import { budgetReserveAllowed, budgetSettlementAllowed } from '../layer1-uor/generated-model.js';
let runtimeEpoch = 0; // origin-local instance identity, never a distributed clock
const kinds = ['refresh', 'place', 'repair', 'checkpoint', 'retrieve'];
const measures = ['requests', 'transferBytes', 'storageBytes', 'computeSteps'];
function cost(value) { record(value, measures); for (const k of measures) natural(value[k]); return value; }
export const zeroCost = () => Object.fromEntries(measures.map(k => [k, 0]));
export function createBudget({ epoch, startMs, endMs, limit }) {
  identifier(epoch); natural(startMs); natural(endMs); cost(limit);
  if (endMs <= startMs) refuse('invalid-epoch');
  return { epoch, startMs, endMs, lastObservedMs: startMs, limit: { ...limit }, spent: zeroCost(), reservations: [] };
}
function validate(state) {
  record(state, ['epoch', 'startMs', 'endMs', 'lastObservedMs', 'limit', 'spent', 'reservations']);
  identifier(state.epoch); natural(state.startMs); natural(state.endMs); natural(state.lastObservedMs);
  cost(state.limit); cost(state.spent);
  if (state.endMs <= state.startMs || state.lastObservedMs < state.startMs || !Array.isArray(state.reservations)) refuse('invalid-budget');
  const ids = new Set(); const totals = zeroCost();
  for (const r of state.reservations) {
    record(r, ['id', 'kind', 'cost', 'status']); identifier(r.id); cost(r.cost);
    if (ids.has(r.id) || !kinds.includes(r.kind) || !['reserved', 'settled'].includes(r.status)) refuse('invalid-reservation');
    ids.add(r.id);
    for (const k of measures) totals[k] += r.cost[k];
  }
  for (const k of measures) {
    natural(totals[k]);
    if (totals[k] !== state.spent[k] || state.spent[k] > state.limit[k]) refuse('invalid-budget');
  }
}
export function reserveAction(state, { id, kind, cost: requested }, nowMs) {
  requested = snapshotRecord(requested);
  validate(state); identifier(id); natural(nowMs); cost(requested);
  if (!kinds.includes(kind)) refuse('unsupported-action');
  if (nowMs < state.lastObservedMs) refuse('clock-regression');
  if (nowMs >= state.endMs) refuse('epoch-expired');
  if (state.reservations.some(r => r.id === id)) refuse('duplicate-action');
  const spent = zeroCost();
  for (const k of measures) {
    if (!budgetReserveAllowed(state.spent[k], 0, requested[k], state.limit[k], nowMs, state.lastObservedMs, state.endMs)) refuse('budget-exhausted');
    spent[k] = state.spent[k] + requested[k];
  }
  return { ...structuredClone(state), lastObservedMs: nowMs, spent,
    reservations: [...structuredClone(state.reservations), { id, kind, cost: { ...requested }, status: 'reserved' }] };
}
/** Only a completed, exact local accounting receipt can release unused reservation. */
export function settleAction(state, id, actualCost) {
  actualCost = snapshotRecord(actualCost);
  validate(state); identifier(id); cost(actualCost);
  const reservation = state.reservations.find(r => r.id === id);
  if (!reservation || reservation.status !== 'reserved') refuse('unknown-reservation');
  const spent = { ...state.spent };
  for (const k of measures) {
    if (!budgetSettlementAllowed(reservation.cost[k], reservation.cost[k], actualCost[k], true)) refuse('reservation-exceeded');
    spent[k] -= reservation.cost[k] - actualCost[k];
  }
  return { ...structuredClone(state), spent, reservations: state.reservations.map(r => r.id === id
    ? { ...r, cost: { ...actualCost }, status: 'settled' } : structuredClone(r)) };
}

/**
 * Local effect admission. Charges are cumulative ceilings in one explicit epoch,
 * not measurements of TLS, ICE/STUN, browser memory, VM work, or host overhead.
 * Failed/unknown effects stay charged. No automatic refund or epoch rollover.
 */
export class ResourceAdmission {
  #state;
  #sequence = 0;
  constructor({ clock = () => Math.floor(performance.now()), durationMs = 600000,
    limit = { requests: 4096, transferBytes: 16 * 1024 * 1024,
      storageBytes: 16 * 1024 * 1024, computeSteps: 1000000 }, maxActions = 16384 } = {}) {
    natural(durationMs); natural(maxActions, 65536);
    this.clock = clock;
    this.maxActions = maxActions;
    const startMs = clock(); natural(startMs);
    natural(startMs + durationMs);
    this.#state = createBudget({ epoch: `runtime-${++runtimeEpoch}`, startMs, endMs: startMs + durationMs, limit });
  }
  get state() { return structuredClone(this.#state); }
  /** Read-only admission evidence for a correlated still-pending effect. */
  reservationCurrent(id, epoch) {
    const now = this.clock();
    return Number.isSafeInteger(now) && now >= this.#state.lastObservedMs
      && now < this.#state.endMs && this.#state.epoch === epoch
      && this.#state.reservations.some(r => r.id === id && r.status === 'reserved');
  }
  reserve(kind, requested = {}) {
    if (this.#sequence >= this.maxActions) refuse('action-capacity');
    const amount = { ...zeroCost(), ...requested };
    const id = `effect-${this.#sequence + 1}`;
    const next = reserveAction(this.#state, { id, kind, cost: amount }, this.clock());
    this.#state = next;
    this.#sequence++;
    return id;
  }
  run(kind, requested, effect) {
    this.reserve(kind, requested);
    return effect();
  }
}

/** Exact UTF-8 application payload length, excluding lower-layer overhead. */
export const wireBytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
export function reserveNetwork(admission, kind, payload, destinations = 1) {
  natural(destinations);
  if (destinations) admission.reserve(kind, { requests: destinations, transferBytes: wireBytes(payload) * destinations });
}
