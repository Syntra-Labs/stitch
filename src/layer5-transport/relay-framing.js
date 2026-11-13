/** Stitch application framing over ntfy's bounded text-message API.
 * No attachment URLs are followed. SHA-256 binds reconstructed bytes, not a
 * publisher identity, availability, durable retention, or delivery to a peer.
 */
import { model } from '../layer1-uor/generated-model.js';
import { parseCanonicalJson, sha256Bytes } from '../layer1-uor/custody.js';
import { natural, record, refuse } from '../layer1-uor/contracts.js';
import { wireBytes } from '../layer2-schedulers/policy.js';

const call = (name, ...args) => model[`Stitch.Relay.${name}`](...args);
const utf8 = new TextEncoder();
const ascii = value => utf8.encode(value);
const limits = call('limits');
export const RELAY_LIMITS = Object.freeze(Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Number(value)])));
export const RELAY_LIFETIMES = Object.freeze({ signal: Number(call('signalLifetime')), warm: Number(call('warmLifetime')) });
export const RELAY_EVENT_BYTES = 16 * 1024;
const KEYS = ['v', 'p', 'c', 's', 'm', 't', 'b', 'n', 'i', 'x'];
const JSON_LIMITS = Object.freeze({ maxBytes: RELAY_LIMITS.messageBytes, maxDepth: 32,
  maxEntries: Math.floor(RELAY_LIMITS.messageBytes / 2) + 1, maxStringLength: RELAY_LIMITS.messageBytes });
const hexDigest = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const validPurpose = value => typeof value === 'string' && Object.hasOwn(RELAY_LIFETIMES, value);
const purpose = value => { if (!validPurpose(value)) refuse('relay-purpose'); return value; };
const objectEnvelope = value => value && typeof value === 'object' && !Array.isArray(value);

export const relayCapacity = (entries = 0, retainedBytes = 0, tombstones = 0) => ({ entries, retainedBytes, tombstones });
export const relayAdmissionAllowed = (capacity, bytes) => call('admissionAllowed', limits, capacity, bytes);
export const relayEffectAllowed = (node, capturedGeneration, sessionMatches, consentCurrent) =>
  call('effectAllowed', node.closed, node.generation, capturedGeneration, sessionMatches, consentCurrent);

export function newRelaySession() {
  if (!globalThis.crypto?.getRandomValues) refuse('relay-crypto-unavailable');
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** JSON is snapshotted before any await; a digest never binds a mutable object. */
export function snapshotRelayMessage(value) {
  const raw = JSON.stringify(value);
  if (typeof raw !== 'string') refuse('relay-envelope');
  const bytes = utf8.encode(raw);
  if (!bytes.length || bytes.length > RELAY_LIMITS.messageBytes) refuse('relay-message-limit');
  if (!objectEnvelope(parseCanonicalJson(raw, JSON_LIMITS))) refuse('relay-envelope');
  return Object.freeze({ raw, byteLength: bytes.length });
}

export async function relayChannel(channelKey) {
  if (typeof channelKey !== 'string') refuse('relay-channel');
  // JSON escapes lone UTF-16 surrogates, preserving exact browser topic identity.
  const raw = JSON.stringify(channelKey);
  if (wireBytes(raw) > RELAY_LIMITS.messageBytes) refuse('relay-channel-limit');
  return sha256Bytes(utf8.encode(raw), 'relay-channel');
}

export function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1
    || value.length > Math.ceil(RELAY_LIMITS.chunkBytes * 4 / 3)) refuse('relay-base64');
  let binary;
  try { binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); }
  catch { refuse('relay-base64'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  // Reject nonzero pad bits, padding and alternate encodings (RFC4648 section3.5).
  if (encodeBase64Url(bytes) !== value) refuse('relay-base64');
  return bytes;
}

export async function frameRelayMessage(snapshot, { channelKey, session, scope, createdAtMs = Date.now() }) {
  purpose(scope); natural(createdAtMs);
  if (!/^[0-9a-f]{32}$/.test(session)) refuse('relay-session');
  const { raw } = snapshot;
  const bytes = utf8.encode(raw);
  if (typeof raw !== 'string' || bytes.length !== snapshot.byteLength
    || !bytes.length || bytes.length > RELAY_LIMITS.messageBytes) refuse('relay-message-limit');
  // The caller owns this immutable snapshot until framing completes.
  const [channel, digest] = await Promise.all([relayChannel(channelKey), sha256Bytes(bytes, 'relay-message')]);
  const count = Math.ceil(bytes.length / RELAY_LIMITS.chunkBytes);
  if (count > RELAY_LIMITS.frames) refuse('relay-frame-limit');
  const frames = [];
  for (let index = 0; index < count; index++) {
    const frame = { v: 'stitch/1', p: scope, c: channel, s: session, m: digest, t: createdAtMs,
      b: bytes.length, n: count, i: index,
      x: encodeBase64Url(bytes.subarray(index * RELAY_LIMITS.chunkBytes, (index + 1) * RELAY_LIMITS.chunkBytes)) };
    const serialized = JSON.stringify(frame);
    if (wireBytes(serialized) > RELAY_LIMITS.wireBytes) refuse('relay-wire-limit');
    frames.push(serialized);
  }
  return { frames, digest, bytes: frames.reduce((sum, frame) => sum + wireBytes(frame), 0) };
}

const identity = frame => ({ channel: ascii(frame.c), session: ascii(frame.s), digest: ascii(frame.m), purpose: ascii(frame.p),
  created: frame.t, messageBytes: frame.b, frames: frame.n });
const frameState = (frame, payloadBytes, length) => ({ identity: identity(frame), index: frame.i, payloadBytes, wireBytes: length });
const keyOf = frame => `${frame.p}:${frame.c}:${frame.s}:${frame.m}`;

/** Bounded session-local assembler. Active payload buffers, pending inputs and
 * completed/rejected tombstones all have independent, explicit ceilings.
 * Cleanup uses the local monotonic clock, never a sender-controlled extension.
 */
export class RelayReassembler {
  #entries = new Map();
  #tombstones = new Map();
  #capacity = relayCapacity();
  #pendingInputs = 0;
  #lastNow = 0;
  #generation = 0;
  #disposed = false;
  #timer = null;
  constructor({ channelKey, scope, admission, clock = () => Math.floor(performance.now()), wallClock = Date.now,
    current = () => true, consentCurrent = () => true, chargeIngress = true, automaticCleanup = true, verificationPool = new Map() } = {}) {
    this.scope = purpose(scope); this.channelKey = channelKey;
    this.channel = relayChannel(channelKey);
    // A constructor's rejected promise must not become an unhandled rejection.
    this.channel.catch(() => {});
    this.admission = admission;
    this.clock = clock; this.wallClock = wallClock;
    this.current = current; this.consentCurrent = consentCurrent;
    this.chargeIngress = chargeIngress; this.automaticCleanup = automaticCleanup;
    this.verificationPool = verificationPool;
  }
  get state() {
    this.#prune(this.#now());
    return { entries: Number(this.#capacity.entries), retainedBytes: Number(this.#capacity.retainedBytes),
      tombstones: this.#tombstones.size, pendingInputs: this.#pendingInputs, disposed: this.#disposed };
  }
  #now() {
    const now = this.clock(); natural(now);
    if (now < this.#lastNow) refuse('relay-clock-regression');
    this.#lastNow = now; return now;
  }
  #schedule(now) {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.automaticCleanup || this.#disposed) return;
    const deadlines = [...this.#entries.values()].filter(entry => !entry.cancelled).map(entry => Math.min(entry.started + RELAY_LIMITS.assemblyAge, entry.expires))
      .concat([...this.#tombstones.values()]);
    if (!deadlines.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      try { this.#prune(this.#now()); } catch { this.dispose(); }
    }, Math.max(1, Math.min(...deadlines) - now));
    this.#timer.unref?.();
  }
  #retire(key, entry, now) {
    if (this.#entries.get(key) !== entry) return;
    // A pending host digest still owns the immutable input buffer. Cancellation
    // may fence delivery, but cannot release its resident-memory reservation.
    if (entry.verificationPending) { entry.cancelled = true; this.#schedule(now); return; }
    this.#entries.delete(key);
    entry.buffer = null; entry.seen = null;
    this.#capacity = call('release', this.#capacity, entry.header.b);
    this.#tombstones.set(key, entry.expires);
    this.#schedule(now);
  }
  #prune(now) {
    for (const [key, entry] of this.#entries) {
      if (now >= entry.started + RELAY_LIMITS.assemblyAge || now >= entry.expires) this.#retire(key, entry, now);
    }
    for (const [key, expires] of this.#tombstones) if (now >= expires) this.#tombstones.delete(key);
    this.#capacity = { ...this.#capacity, tombstones: this.#tombstones.size };
    this.#schedule(now);
  }
  dispose() {
    this.#disposed = true; this.#generation++;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const [key, entry] of this.#entries) this.#retire(key, entry, this.#lastNow);
    this.#tombstones.clear();
    this.#capacity = { ...this.#capacity, tombstones: 0 };
  }
  /** Returns one complete verified logical envelope, or null. Refusals throw a
   * bounded machine-readable error; a corrupt assembly is tombstoned, not retried.
   */
  async accept(raw) {
    if (this.#disposed || !this.current() || !this.consentCurrent()) return null;
    if (typeof raw !== 'string' || raw.length > RELAY_LIMITS.wireBytes) refuse('relay-wire-limit');
    const length = wireBytes(raw);
    if (length > RELAY_LIMITS.wireBytes) refuse('relay-wire-limit');
    if (this.#pendingInputs >= RELAY_LIMITS.frames) refuse('relay-input-capacity');
    this.admission?.reserve('retrieve', { computeSteps: 1, ...(this.chargeIngress ? { transferBytes: length } : {}) });
    this.#pendingInputs++;
    const generation = this.#generation;
    try {
      const frame = parseCanonicalJson(raw, { maxBytes: RELAY_LIMITS.wireBytes, maxDepth: 2, maxEntries: 16,
        maxStringLength: RELAY_LIMITS.wireBytes });
      record(frame, KEYS);
      if (frame.v !== 'stitch/1' || frame.p !== this.scope || !hexDigest(frame.c) || !hexDigest(frame.m)
        || typeof frame.s !== 'string' || !/^[0-9a-f]{32}$/.test(frame.s)) refuse('relay-frame');
      for (const field of ['t', 'b', 'n', 'i']) natural(frame[field]);
      // Reject count/length before decoding or allocating message-sized buffers.
      if (!frame.b || frame.b > RELAY_LIMITS.messageBytes || !frame.n || frame.n > RELAY_LIMITS.frames
        || frame.i >= frame.n) refuse('relay-frame-limit');
      const chunk = decodeBase64Url(frame.x);
      const state = frameState(frame, chunk.length, length);
      const channel = await this.channel;
      if (this.#disposed || generation !== this.#generation || !this.current() || !this.consentCurrent()) return null;
      const now = this.#now(), wallNow = this.wallClock(); natural(wallNow);
      this.#prune(now);
      if (!call('frameAllowed', limits, state, ascii(channel), ascii(this.scope), wallNow, RELAY_LIFETIMES[this.scope])) refuse('relay-frame');
      const key = keyOf(frame);
      if (this.#tombstones.has(key)) return null;
      let entry = this.#entries.get(key);
      if (entry && !call('sameIdentity', entry.state.identity, state.identity)) {
        this.#retire(key, entry, now); refuse('relay-mixed-message');
      }
      if (!entry) {
        // Include verification work retained by older transport generations.
        const older = [...this.verificationPool.values()].filter(item => item.owner !== this);
        const capacity = relayCapacity(Number(this.#capacity.entries) + older.length,
          Number(this.#capacity.retainedBytes) + older.reduce((sum, item) => sum + item.bytes, 0), this.#tombstones.size);
        if (!relayAdmissionAllowed(capacity, frame.b)) refuse('relay-reassembly-capacity');
        this.admission?.reserve('retrieve', { storageBytes: frame.b, computeSteps: frame.b + frame.n });
        const expires = now + Math.min(RELAY_LIFETIMES[this.scope], Math.max(0, frame.t + RELAY_LIFETIMES[this.scope] - wallNow));
        entry = { header: { b: frame.b }, cancelled: false, verificationPending: false, buffer: new Uint8Array(frame.b), seen: new Uint8Array(frame.n), started: now, expires,
          state: { identity: state.identity, receivedFrames: 0, receivedBytes: 0, started: now, last: now, verifying: false } };
        this.#entries.set(key, entry);
        this.#capacity = call('admitCapacity', limits, this.#capacity, frame.b);
      }
      if (entry.cancelled) return null;
      const offset = frame.i * RELAY_LIMITS.chunkBytes;
      if (entry.seen[frame.i]) {
        if (chunk.some((byte, index) => entry.buffer[offset + index] !== byte)) {
          this.#retire(key, entry, now); refuse('relay-conflicting-duplicate');
        }
        return null;
      }
      if (!call('appendAllowed', limits, entry.state, state, now, false)) refuse('relay-assembly-state');
      entry.buffer.set(chunk, offset); entry.seen[frame.i] = 1;
      entry.state = call('append', limits, entry.state, state, now, false);
      this.#schedule(now);
      if (!call('ready', entry.state)) return null;
      entry.state = call('beginVerification', entry.state);
      const bytes = entry.buffer;
      let result = null;
      try {
        const pendingBytes = [...this.verificationPool.values()].reduce((sum, item) => sum + item.bytes, 0);
        if (!relayAdmissionAllowed(relayCapacity(this.verificationPool.size, pendingBytes), frame.b)) refuse('relay-verification-capacity');
        entry.verificationPending = true;
        this.verificationPool.set(entry, { owner: this, bytes: frame.b });
        const digestVerified = await sha256Bytes(bytes, 'relay-message') === frame.m;
        if (!digestVerified) refuse('relay-integrity');
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const envelope = parseCanonicalJson(decoded, JSON_LIMITS);
        const envelopeValid = objectEnvelope(envelope) && typeof envelope.from === 'string' && envelope.from.length > 0 && envelope.from.length <= 128
          && (this.scope !== 'signal' || envelope.channelKey === this.channelKey);
        const stillCurrent = !entry.cancelled && !this.#disposed && generation === this.#generation && this.#entries.get(key) === entry && this.current();
        const currentConsent = this.consentCurrent();
        const finishedAt = this.#now();
        if (finishedAt >= entry.started + RELAY_LIMITS.assemblyAge || finishedAt >= entry.expires) return null;
        if (call('deliveryAllowed', entry.state, digestVerified, true, !!envelopeValid, stillCurrent, currentConsent)) result = envelope;
        else if (!envelopeValid) refuse('relay-envelope');
        return result;
      } finally {
        entry.verificationPending = false; this.verificationPool.delete(entry);
        this.#retire(key, entry, this.#now());
      }
    } finally { this.#pendingInputs--; }
  }
}
