/** Reliable ordered DataChannel application adapter. Browser SCTP/DTLS owns
 * transport integrity. Application commitments remain the object authority.
 * Local queue acceptance and SCTP submission are NOT peer acknowledgements. */
import { model } from '../layer1-uor/generated-model.js';
import { refuse } from '../layer1-uor/contracts.js';
import { parseCanonicalJson } from '../layer1-uor/custody.js';
const call = (name, ...args) => model[`Stitch.ChannelFlow.${name}`](...args);
const encoder = new TextEncoder();
const HEADER = 16, MAGIC = 0x53544331;
export const CHANNEL_PROTOCOL = 'stitch.channel/1';
export const CHANNEL_LIMITS = Object.freeze({ message: 524288, queuedBytes: 2097152, queuedMessages: 64,
  buffered: 1048576, low: 524288, frame: 65536, age: 30000, assemblies: 16 });
const jsonLimits = { maxBytes: CHANNEL_LIMITS.message, maxEntries: CHANNEL_LIMITS.message, maxStringLength: CHANNEL_LIMITS.message };
export function channelMaximum(pc) {
  // RFC8841 absent max-message-size default is 64KiB. Zero/unbounded is limited
  // by our explicit scheduling quantum, not by a smaller logical message cap.
  const value = pc?.sctp?.maxMessageSize;
  if (value === undefined || value === null) return CHANNEL_LIMITS.frame;
  if (value === 0 || value === Infinity) return CHANNEL_LIMITS.frame;
  if (!Number.isSafeInteger(value) || value < 1) refuse('channel-negotiated-size');
  return Math.min(value, CHANNEL_LIMITS.frame);
}
export class ChannelFlow {
  constructor({ channel, pc, current = () => true, admission, onMessage = () => {}, onResult = () => {},
    onSent = () => {}, pool = { queued: 0, messages: 0, receiving: 0, assemblies: 0 }, clock = () => performance.now() }) {
    Object.assign(this, { channel, pc, current, admission, onMessage, onResult, onSent, pool, clock });
    this.queue = []; this.sequence = 0; this.receivedSequence = 0; this.assembly = null; this.disposed = false; this.timer = null;
    channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = CHANNEL_LIMITS.low;
    channel.onbufferedamountlow = () => this.drain();
  }
  result(value) { try { this.onResult(value); } catch { /* Observers cannot retain queue reservations. */ } }
  get state() { return { queued: this.queue.length, retained: this.queue.reduce((n, q) => n + q.bytes.length, 0),
    receiving: this.assembly?.total ?? 0, disposed: this.disposed }; }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    if (this.disposed) return;
    const times = this.queue.map(q => q.started + CHANNEL_LIMITS.age);
    if (this.assembly) times.push(this.assembly.started + CHANNEL_LIMITS.age);
    if (!times.length) return;
    this.timer = setTimeout(() => {
      if (!this.current()) return this.dispose('generation-changed');
      if (this.clock() >= Math.min(...times)) this.fail('channel-timeout'); else this.schedule();
    }, Math.max(1, Math.min(...times) - this.clock()));
    this.timer.unref?.();
  }
  enqueue(value, { onSubmitted = () => {}, consentCurrent = () => true } = {}) {
    if (this.disposed || !this.current() || !consentCurrent() || this.channel.readyState !== 'open') return false;
    const raw = JSON.stringify(value);
    if (typeof raw !== 'string') refuse('channel-envelope');
    const bytes = encoder.encode(raw);
    if (!call('queueAllowed', this.pool.messages, this.pool.queued, bytes.length)) refuse('channel-queue-capacity');
    const snapshot = parseCanonicalJson(raw, jsonLimits);
    const maximum = channelMaximum(this.pc), framed = bytes.length > maximum;
    if (framed && this.channel.protocol !== undefined && this.channel.protocol !== CHANNEL_PROTOCOL) refuse('channel-peer-framing-unsupported');
    if (framed && (this.channel.ordered === false || this.channel.maxRetransmits != null || this.channel.maxPacketLifeTime != null)) refuse('channel-framing-requires-reliable-ordered');
    if (framed && maximum <= HEADER) refuse('channel-framing-size-unsupported');
    if (framed && this.sequence === 0xffffffff) refuse('channel-sequence-exhausted');
    const frames = framed ? Math.ceil(bytes.length / (maximum - HEADER)) : 1;
    // Atomic resource charge includes every wire header; no refunds after failure.
    this.admission?.reserve('place', { requests: frames, transferBytes: bytes.length + (framed ? HEADER * frames : 0) });
    const state = this.admission?.state;
    const budget = state ? { endMs: state.endMs, lastObservedMs: state.lastObservedMs } : null;
    const job = { consentCurrent, budget, raw: framed ? null : raw, bytes, maximum, framed, id: framed ? ++this.sequence : 0,
      offset: 0, submitted: 0, started: this.clock(), onSubmitted: () => onSubmitted(snapshot), attempted: false };
    this.queue.push(job); this.pool.queued += bytes.length; this.pool.messages++;
    this.schedule(); this.drain(); return true;
  }
  release(job) { this.pool.queued -= job.bytes.length; this.pool.messages--; }
  drain() {
    if (this.disposed) return;
    if (!this.current()) return this.dispose('generation-changed');
    if (this.channel.readyState !== 'open') return this.dispose('channel-not-open');
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        if (!job.consentCurrent()) return this.fail('channel-consent-withdrawn');
        if (job.budget && this.admission?.clock) {
          const now = this.admission.clock();
          if (now < job.budget.lastObservedMs || now >= job.budget.endMs) return this.fail('channel-budget-expired');
        }
        if (this.clock() - job.started >= CHANNEL_LIMITS.age) return this.fail('channel-timeout');
        const remaining = job.bytes.length - job.offset;
        const length = job.framed ? Math.min(remaining, job.maximum - HEADER) : remaining;
        const wireLength = length + (job.framed ? HEADER : 0);
        const buffered = this.channel.bufferedAmount ?? 0;
        if (!Number.isSafeInteger(buffered) || buffered < 0) return this.fail('channel-buffer-invalid');
        const maximum = channelMaximum(this.pc);
        if (wireLength > maximum) return this.fail('channel-negotiated-size-changed');
        if (!call('sendAllowed', this.current(), this.channel.readyState === 'open', buffered, wireLength, maximum)) break;
        let wire = job.raw;
        if (job.framed) {
          wire = new ArrayBuffer(wireLength); const view = new DataView(wire);
          [MAGIC, job.id, job.bytes.length, job.offset].forEach((v, i) => view.setUint32(i * 4, v));
          new Uint8Array(wire, HEADER).set(job.bytes.subarray(job.offset, job.offset + length));
        }
        // send() success only proves browser acceptance. A throw may leave the
        // remote outcome unknown; never automatically replay a partially sent job.
        job.attempted = true; this.channel.send(wire); job.attempted = false; job.offset += length; job.submitted++;
        this.onSent(wireLength);
        if (job.offset === job.bytes.length) {
          this.queue.shift(); this.release(job); job.onSubmitted();
          this.result({ outcome: 'submitted', frames: job.submitted, bytes: job.bytes.length, delivered: false });
        }
      }
      this.schedule();
    } catch (error) { this.fail(error.code || 'channel-send-unknown'); }
  }
  receive(data) {
    if (this.disposed || !this.current()) return;
    try {
      const length = typeof data === 'string' ? encoder.encode(data).length : data?.byteLength;
      if (!Number.isSafeInteger(length) || length > CHANNEL_LIMITS.message) refuse('channel-wire-size');
      this.admission?.reserve('retrieve', { transferBytes: length, computeSteps: length });
      if (typeof data === 'string') {
        if (this.assembly) refuse('channel-interleaved-message');
        this.onMessage(parseCanonicalJson(data, jsonLimits)); return;
      }
      if (this.channel.protocol !== undefined && this.channel.protocol !== CHANNEL_PROTOCOL) refuse('channel-peer-framing-unsupported');
      if (this.channel.ordered === false || this.channel.maxRetransmits != null || this.channel.maxPacketLifeTime != null) refuse('channel-framing-requires-reliable-ordered');
      if (!(data instanceof ArrayBuffer) || length <= HEADER || length > CHANNEL_LIMITS.frame) refuse('channel-frame');
      const view = new DataView(data), [magic, id, total, offset] = Array.from({ length: 4 }, (_, i) => view.getUint32(i * 4));
      if (magic !== MAGIC || !id || !total || total > CHANNEL_LIMITS.message) refuse('channel-frame');
      if (!this.assembly) {
        if (offset !== 0 || id !== this.receivedSequence + 1) refuse('channel-frame-order');
        if (this.pool.assemblies >= CHANNEL_LIMITS.assemblies || this.pool.receiving + total > CHANNEL_LIMITS.queuedBytes) refuse('channel-receive-capacity');
        this.admission?.reserve('retrieve', { storageBytes: total });
        this.assembly = { id, total, received: 0, bytes: new Uint8Array(total), started: this.clock() };
        this.pool.receiving += total; this.pool.assemblies++;
      }
      const a = this.assembly, payload = new Uint8Array(data, HEADER);
      if (a.id !== id || a.total !== total || this.clock() - a.started >= CHANNEL_LIMITS.age
        || !call('appendAllowed', a.received, offset, payload.length, total)) refuse('channel-frame-order');
      a.bytes.set(payload, offset); a.received = Number(call('append', a.received, offset, payload.length, total));
      if (a.received === total) {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(a.bytes);
        const msg = parseCanonicalJson(raw, jsonLimits);
        this.receivedSequence = id; this.releaseAssembly();
        if (this.current()) this.onMessage(msg);
      }
      this.schedule();
    } catch (error) {
      // Invalid standalone JSON is ignored as before; binary/partial protocol
      // failures poison the stream rather than silently lose a logical message.
      if (typeof data !== 'string' || this.assembly) this.fail(error.code || 'channel-frame-invalid');
    }
  }
  releaseAssembly() {
    if (!this.assembly) return;
    this.pool.receiving -= this.assembly.total; this.pool.assemblies--; this.assembly = null;
  }
  fail(reason) { this.dispose(reason); this.channel.close?.(); }
  dispose(reason = 'channel-closed') {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer); this.timer = null;
    const jobs = this.queue.splice(0);
    for (const job of jobs) { this.release(job); this.result({ outcome: job.submitted ? 'partial' : job.attempted ? 'unknown' : 'cancelled', reason,
      frames: job.submitted, bytes: job.bytes.length, delivered: false }); }
    if (this.assembly) this.result({ outcome: 'incomplete-receive', reason, bytes: this.assembly.received, expected: this.assembly.total });
    this.releaseAssembly();
    this.result({ outcome: 'closed', reason, delivered: false });
  }
}
