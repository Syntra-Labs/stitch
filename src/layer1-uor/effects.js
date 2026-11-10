/** Lifecycle refinement boundary. The source owns phase/identity admission;
 * browsers, provider completeness, signatures and guest readiness remain host facts.
 * These projections reuse live runtime state. They do not journal effects or refund work.
 */
import { model } from './generated-model.js';
// JS string identity is UTF-16 code-unit identity. UTF-8 replacement of lone
// surrogates would collapse distinct signaling topics/peer IDs into one model ID.
const bytes = value => {
  if (typeof value !== 'string') throw new TypeError('Lifecycle identity must be a string');
  const encoded = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    encoded[index * 2] = unit >>> 8; encoded[index * 2 + 1] = unit & 255;
  }
  return encoded;
};
const tag = value => ({ tag: value, fields: [] });
const call = (name, ...args) => model[`Stitch.Effects.${name}`](...args);
const count = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError('Lifecycle generation exceeds host integer range');
  return number;
};
export const transportState = node => ({ generation: node.generation, closed: node.closed,
  channelKey: bytes(node.channelKey), localPeer: bytes(node.peerId) });
export const captureTransport = (node, remotePeer = '') => ({ generation: node.generation,
  channelKey: bytes(node.channelKey), localPeer: bytes(node.peerId), remotePeer: bytes(remotePeer) });
export const transportCanSend = node => call('transportCanSend', transportState(node));
export const transportSessionCurrent = (node, callback) => call('transportSessionMatches', transportState(node), callback);
export const transportPeerCurrent = (node, callback, remotePeer, entry) => call('transportPeerCallbackAllowed',
  transportState(node), callback, bytes(remotePeer), node.peers.get(remotePeer) === entry);
export const transportChannelCurrent = (node, callback, remotePeer, entry, channel) => call('transportChannelCallbackAllowed',
  transportState(node), callback, bytes(remotePeer), node.peers.get(remotePeer) === entry, entry.dc === channel);
export const transportSignalAllowed = (node, message) => !!message && typeof message.channelKey === 'string'
  && typeof message.from === 'string' && message.from.length > 0 && (message.to == null || typeof message.to === 'string')
  && call('transportSignalAllowed', transportState(node), bytes(message.channelKey), bytes(message.from),
    bytes(message.to ?? ''), message.to == null);
export const transportPeerAllocationAllowed = node => call('transportPeerAllocationAllowed', transportState(node), node.peers.size, node.maxPeers);
export function closeTransport(node) {
  const next = call('transportClose', transportState(node));
  node.generation = count(next.generation); node.closed = next.closed;
}
export function openTransport(node, channelKey) {
  // channelKey is preserved as the real browser topic, never replaced by an invented ID.
  const next = call('transportOpen', transportState(node), bytes(channelKey));
  node.closed = next.closed; node.channelKey = channelKey;
}
const dnsPhase = previous => tag(({ idle: 'Idle', published: 'Published', refused: 'Refused', unknown: 'Unknown' })[previous?.outcome ?? 'idle']);
const dnsScope = scope => ({ zoneId: bytes(scope.zoneId), name: bytes(scope.name), authorityKey: bytes(scope.trustedAuthorityKey) });
const publication = (scope, previous) => ({ scope: dnsScope(scope), phase: dnsPhase(previous),
  pointerDigest: bytes(previous?.pointerDigest ?? ''), recordId: bytes(previous?.recordId ?? ''), hasRecordId: !!previous?.recordId });
const dnsCandidate = (scope, candidate) => ({ scope: dnsScope(scope), pointerDigest: bytes(candidate.pointerDigest),
  previousDigest: bytes(candidate.previousDigest ?? ''), hasPrevious: candidate.previousDigest !== null,
  revision: candidate.revision, validFrom: candidate.validFromMs, validUntil: candidate.validUntilMs });
const dnsRead = (scope, candidate, remote, pointer) => ({ scope: dnsScope(scope), candidateDigest: bytes(candidate.pointerDigest),
  complete: true, authenticated: !!pointer, recordPresent: !!remote, recordId: bytes(remote?.id ?? ''),
  pointerDigest: bytes(pointer?.pointerDigest ?? ''), revision: pointer?.revision ?? 0 });
export const dnsRequestAllowed = (scope, previous, candidate, busy) => call('dnsRequestAllowed',
  publication(scope, previous), dnsCandidate(scope, candidate), busy);
export const dnsReadDecision = (scope, previous, candidate, remote, pointer, now) => call('dnsReadDecision',
  publication(scope, previous), dnsCandidate(scope, candidate), dnsRead(scope, candidate, remote, pointer), now).tag;
export function dnsWriteState(scope, previous, candidate, remote, pointer, now) {
  if (!['Create', 'Update'].includes(dnsReadDecision(scope, previous, candidate, remote, pointer, now))) throw Error('Model refused DNS write admission');
  const next = call('dnsBeginWrite', publication(scope, previous), dnsCandidate(scope, candidate), dnsRead(scope, candidate, remote, pointer), now);
  if (next.phase.tag !== 'Unknown') throw Error('Model refused DNS write transition');
  return { outcome: 'unknown', pointerDigest: candidate.pointerDigest, candidate, recordId: remote?.id ?? null };
}
export function dnsWriteOutcome(scope, pending, result) {
  const next = call('dnsFinishWrite', publication(scope, pending), { scope: dnsScope(scope),
    candidateDigest: bytes(pending.pointerDigest), recordId: bytes(typeof result?.id === 'string' ? result.id : ''),
    recordIdValid: typeof result?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.id),
    acknowledged: result?.ok === true && result?.outcome === 'published', refused: result?.outcome === 'refused' });
  return ({ Published: 'published', Refused: 'refused', Unknown: 'unknown' })[next.phase.tag];
}
export function dnsLifecycle(previous, busy = false) {
  return { outcome: previous?.outcome ?? 'idle', recordId: previous?.recordId ?? null, pointerDigest: previous?.pointerDigest ?? null,
    canPublish: !busy && call('dnsMayWritePhase', dnsPhase(previous)),
    canReconcile: !busy && call('dnsMayReconcile', dnsPhase(previous)) };
}
const vmState = node => ({ generation: node.bootGeneration, phase: tag(node.vmPhase) });
export const vmCanBoot = node => call('vmCanBoot', vmState(node));
export const vmIsBooting = node => call('vmIsBooting', vmState(node));
export const vmCanExecute = node => call('vmCanExecute', vmState(node));
export const vmCallbackCurrent = (node, generation, vm) => call('vmCallbackAllowed', vmState(node), generation, node.v86 === vm);
export const vmFailAllowed = (node, generation) => call('vmFailAllowed', vmState(node), generation);
function applyVm(node, next) { node.bootGeneration = count(next.generation); node.vmPhase = next.phase.tag; }
export const startVm = node => applyVm(node, call('vmStart', vmState(node)));
export const failVm = (node, generation) => applyVm(node, call('vmFail', vmState(node), generation));
export const readyVm = (node, generation, vm, readinessObserved) => applyVm(node,
  call('vmObserveReady', vmState(node), generation, node.v86 === vm, readinessObserved));
const c1Progress = entry => ({ startedAt: Math.floor(entry.startedAtMs * 1000),
  lastSequence: entry.lastHeartbeatSeq ?? 0, hasSequence: entry.lastHeartbeatSeq !== null, consecutive: entry.heartbeatsPassed });
const c1Clock = (entry, nowMs) => Math.floor(entry.startedAtMs * 1000) + Math.ceil((nowMs - entry.startedAtMs) * 1000);
export function observeC1Probe(entry, sequence, nowMs, correlated) {
  const next = call('c1ObserveProbe', c1Progress(entry), sequence, c1Clock(entry, nowMs), correlated);
  entry.lastHeartbeatSeq = next.hasSequence ? count(next.lastSequence) : null;
  entry.heartbeatsPassed = count(next.consecutive);
}
export const c1ConnectionQualified = (entry, nowMs) => call('c1ConnectionQualified', c1Progress(entry), c1Clock(entry, nowMs), entry.dc?.ordered === true);
export const c1DirectSuccess = (entry, nowMs, selectedPathObserved, usedRelay) => call('c1DirectSuccess',
  c1Progress(entry), c1Clock(entry, nowMs), entry.dc?.ordered === true, selectedPathObserved, usedRelay);
export function c1SampleStructurallyValid(sample) {
  return typeof sample.success === 'boolean'
    && Number.isSafeInteger(sample.heartbeats_passed) && sample.heartbeats_passed >= 0
    && Number.isFinite(sample.qualification_elapsed_sec) && sample.qualification_elapsed_sec >= 0
    && (sample.ice_setup_sec === null || (Number.isFinite(sample.ice_setup_sec) && sample.ice_setup_sec >= 0 && sample.ice_setup_sec <= sample.qualification_elapsed_sec))
    && typeof sample.ordered_channel === 'boolean' && typeof sample.selected_path_observed === 'boolean'
    && typeof sample.used_turn === 'boolean' && (!sample.success || c1SampleQualified(sample));
}
export function c1SampleQualified(sample) {
  if (!Number.isSafeInteger(sample.heartbeats_passed) || sample.heartbeats_passed < 0
    || !Number.isFinite(sample.qualification_elapsed_sec) || sample.qualification_elapsed_sec < 0
    || sample.qualification_elapsed_sec > 10
    || !Number.isFinite(sample.ice_setup_sec) || sample.ice_setup_sec < 0 || sample.ice_setup_sec > 10
    || sample.ice_setup_sec > sample.qualification_elapsed_sec
    || typeof sample.ordered_channel !== 'boolean' || typeof sample.selected_path_observed !== 'boolean'
    || typeof sample.used_turn !== 'boolean') return false;
  const elapsed = Math.round(sample.qualification_elapsed_sec * 1000000);
  if (!Number.isSafeInteger(elapsed)) return false;
  return call('c1DirectSuccess', { startedAt: 0, lastSequence: 0, hasSequence: false, consecutive: sample.heartbeats_passed },
    elapsed, sample.ordered_channel, sample.selected_path_observed, sample.used_turn);
}
