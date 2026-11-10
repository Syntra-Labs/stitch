/** Authenticated, session-bound signaling. Key ownership is not human identity.
 * Discovery is public; a key is bound to one remote incarnation until reconnect.
 */
import { canonicalBytes, exactKeys } from '../layer1-uor/custody.js';
import { model } from '../layer1-uor/generated-model.js';
const PROFILE = 'stitch.signal/1';
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function bytes(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('signal-encoding');
  const out = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (out.length !== length || b64(out) !== value) throw Error('signal-encoding');
  return out;
}
const token = () => b64(crypto.getRandomValues(new Uint8Array(24)));
const encode = value => canonicalBytes(value, { maxBytes: 524288, maxStringLength: 524288 });
const snapshot = value => JSON.parse(new TextDecoder().decode(encode(value)));
const allowed = new Set(['announce', 'hello', 'ready', 'offer', 'answer', 'ice']);
async function keyId(raw) { return 'key-' + b64(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))); }

export class SignalSession {
  constructor(channelKey, { maxPeers = 64, maxVerifications = 8 } = {}) {
    this.channelKey = channelKey;
    this.session = token();
    this.maxPeers = maxPeers;
    this.maxVerifications = maxVerifications;
    this.active = true;
    this.verifying = 0;
    this.queuedBytes = 0;
    this.receiveTail = Promise.resolve();
    this.sequence = 0;
    this.peers = new Map();
    this.pending = new Map();
    // Lazy key generation avoids unhandled promises on unused transport nodes.
    this.identityPromise = null;
  }
  identity() {
    return this.identityPromise ??= (async () => {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      this.id = await keyId(raw);
      return { ...pair, publicKeyText: b64(raw), id: this.id };
    })();
  }
  close() { this.active = false; this.peers.clear(); this.pending.clear(); }
  async sign(payload) {
    const copy = snapshot(payload);
    if (!allowed.has(copy.kind)) throw Error('signal-kind');
    const identity = await this.identity();
    if (!this.active || this.sequence === Number.MAX_SAFE_INTEGER) throw Error('signal-closed');
    const to = copy.to ?? null;
    const targetSession = copy.targetSession ?? (to ? this.peers.get(to)?.session : null);
    if (copy.kind !== 'announce' && (!to || !targetSession)) throw Error('signal-unbound-peer');
    delete copy.to; delete copy.targetSession;
    const body = { profile: PROFILE, channelKey: this.channelKey, from: identity.id,
      publicKey: identity.publicKeyText, session: this.session, sequence: ++this.sequence,
      to, targetSession, payload: copy };
    const signature = b64(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, encode(body))));
    if (!this.active) throw Error('signal-closed');
    return { ...body, signature };
  }
  receive(input, consume = null) {
    // One bounded FIFO owns verification AND its RTC continuation. Crypto
    // completion order must never masquerade as wire replay/reordering.
    if (!this.active || this.verifying >= this.maxVerifications) return Promise.resolve(null);
    let m, size;
    try {
      const serialized = encode(input); size = serialized.byteLength;
      if (this.queuedBytes + size > 2097152) return Promise.resolve(null);
      m = JSON.parse(new TextDecoder().decode(serialized));
    } catch { return Promise.resolve(null); }
    this.verifying++; this.queuedBytes += size;
    const work = this.receiveTail.then(async () => {
      const result = this.active ? await this.verifyReceived(m) : null;
      if (consume) await consume(result);
      return result;
    }).finally(() => { this.verifying--; this.queuedBytes -= size; });
    this.receiveTail = work.catch(() => {});
    return work;
  }
  async verifyReceived(m) {
    try {
      exactKeys(m, ['profile','channelKey','from','publicKey','session','sequence','to','targetSession','payload','signature']);
      if (m.profile !== PROFILE || m.channelKey !== this.channelKey || !allowed.has(m.payload?.kind)
        || !Number.isSafeInteger(m.sequence) || m.sequence < 1) return null;
      bytes(m.session, 24);
      const kind = m.payload.kind;
      const identity = await this.identity();
      if (m.from === identity.id) return null;
      if (kind === 'announce' ? m.to !== null || m.targetSession !== null
        : m.to !== identity.id || m.targetSession !== this.session) return null;
      const raw = bytes(m.publicKey, 32), signature = bytes(m.signature, 64);
      if (await keyId(raw) !== m.from) return null;
      const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
      const { signature: _, ...body } = m;
      const verified = await crypto.subtle.verify('Ed25519', key, signature, encode(body));
      if (!this.active || !verified) return null;
      // FIFO verification commits replay state before the next admission.
      // Never evict a replay record during the live session.
      let peer = this.peers.get(m.from);
      if (peer && peer.session !== m.session) return null;
      if (peer && m.sequence <= peer.sequence) return null;
      if (kind === 'announce') {
        if (peer || this.pending.has(m.from) || this.pending.size + this.peers.size >= this.maxPeers) return null;
        this.pending.set(m.from, { session: m.session, sequence: m.sequence });
        return { reply: { kind: 'hello', to: m.from, targetSession: m.session } };
      }
      if (kind === 'ready') {
        const challenge = this.pending.get(m.from);
        if (!challenge || challenge.session !== m.session || m.sequence <= challenge.sequence) return null;
      }
      const handshake = kind === 'hello' || kind === 'ready';
      if (!model['Stitch.Signaling.admissionAllowed'](true, this.active, true, !!peer || handshake,
        BigInt(m.sequence), BigInt(peer?.sequence ?? 0))) return null;
      if (!peer) {
        if (!handshake || this.peers.size + this.pending.size - Number(this.pending.has(m.from)) >= this.maxPeers) return null;
        peer = { session: m.session, sequence: 0 }; this.peers.set(m.from, peer);
      }
      peer.sequence = m.sequence;
      this.pending.delete(m.from);
      const message = { ...m.payload, from: m.from, channelKey: m.channelKey, to: m.to };
      // No sender-controlled routing fields can override authenticated fields.
      if (handshake) message.kind = 'announce';
      return { message, reply: kind === 'hello' ? { kind: 'ready', to: m.from } : null };
    } catch { return null; }
  }
}
