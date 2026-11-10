/** Single-writer pointer admission. The caller supplies an independently trusted authority key. */
import { canonicalBytes, sha256Bytes } from './custody.js';
import { record, natural, identifier, digest, refuse } from './contracts.js';
import { pointerSuccessorAllowed } from './generated-model.js';
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
function unhex(value, length) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) refuse('invalid-key-or-signature');
  return Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
}
function validateBody(body) {
  record(body, ['version', 'name', 'authorityKey', 'revision', 'previousDigest', 'objectRoot', 'validFromMs', 'validUntilMs']);
  if (body.version !== 1) refuse('unsupported-pointer');
  identifier(body.name); unhex(body.authorityKey, 32); natural(body.revision); digest(body.objectRoot);
  natural(body.validFromMs); natural(body.validUntilMs);
  if (body.validUntilMs <= body.validFromMs) refuse('invalid-validity');
  if (body.previousDigest !== null) digest(body.previousDigest);
  return body;
}
const snapshot = value => JSON.parse(new TextDecoder().decode(canonicalBytes(value)));
const signingBytes = body => canonicalBytes({ domain: 'stitch/pointer/v1', body });
export async function generateAuthority() {
  const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const publicKey = hex(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)));
  return { publicKey, privateKey: keyPair.privateKey };
}
export async function signPointer(body, privateKey) {
  body = snapshot(body);
  validateBody(body);
  const signature = hex(new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', privateKey, signingBytes(body))));
  const pointer = { ...structuredClone(body), signature };
  return { ...pointer, pointerDigest: await sha256Bytes(canonicalBytes(pointer), 'pointer') };
}
export async function verifyPointer(pointer, trustedAuthorityKey) {
  pointer = snapshot(pointer);
  record(pointer, ['version', 'name', 'authorityKey', 'revision', 'previousDigest', 'objectRoot', 'validFromMs', 'validUntilMs', 'signature', 'pointerDigest']);
  const { signature, pointerDigest, ...body } = pointer;
  validateBody(body); digest(pointerDigest); unhex(trustedAuthorityKey, 32);
  if (body.authorityKey !== trustedAuthorityKey) refuse('wrong-authority');
  if (pointerDigest !== await sha256Bytes(canonicalBytes({ ...body, signature }), 'pointer')) refuse('pointer-integrity');
  const key = await globalThis.crypto.subtle.importKey('raw', unhex(trustedAuthorityKey, 32), { name: 'Ed25519' }, false, ['verify']);
  if (!await globalThis.crypto.subtle.verify('Ed25519', key, unhex(signature, 64), signingBytes(body))) refuse('pointer-signature');
  return body;
}
/** Compare-and-swap against this observer's retained head, not global linearizability. */
export async function admitPointer(current, candidate, { name, trustedAuthorityKey, nowMs }) {
  candidate = snapshot(candidate); if (current !== null) current = snapshot(current);
  identifier(name); natural(nowMs);
  await verifyPointer(candidate, trustedAuthorityKey);
  if (candidate.name !== name) refuse('pointer-name');
  if (!(candidate.validFromMs <= nowMs && nowMs < candidate.validUntilMs)) refuse('pointer-expired');
  if (current === null) {
    if (candidate.revision !== 0 || candidate.previousDigest !== null) refuse('pointer-bootstrap');
  } else {
    await verifyPointer(current, trustedAuthorityKey);
    if (current.name !== name || current.revision === Number.MAX_SAFE_INTEGER ||
        !pointerSuccessorAllowed(current.revision, candidate.revision, candidate.previousDigest === current.pointerDigest,
          true, true, candidate.validFromMs, candidate.validUntilMs, nowMs)) refuse('pointer-conflict');
  }
  return structuredClone(candidate);
}

/** Retained observer-local head; pinning a key is an explicit host decision. */
export class PointerObserver {
  #head = null;
  #pending = Promise.resolve();
  constructor({ name, trustedAuthorityKey, clock = Date.now, admission = null }) {
    identifier(name); unhex(trustedAuthorityKey, 32);
    this.name = name; this.trustedAuthorityKey = trustedAuthorityKey;
    this.clock = clock; this.admission = admission;
  }
  get head() { return this.#head === null ? null : structuredClone(this.#head); }
  admit(candidate) {
    // Snapshot synchronously and serialize compare-and-swap plus head retention.
    try { candidate = snapshot(candidate); } catch (error) { return Promise.reject(error); }
    const work = this.#pending.then(async () => {
      const admitted = await admitPointer(this.#head, candidate, { name: this.name,
        trustedAuthorityKey: this.trustedAuthorityKey, nowMs: this.clock() });
      this.admission?.reserve('refresh', { storageBytes: canonicalBytes(admitted).length });
      this.#head = admitted;
      return this.head;
    });
    this.#pending = work.catch(() => {});
    return work;
  }
}

/** Full pointer JSON needs multiple DNS TXT strings; never truncate commitments. */
export function pointerDnsText(pointer) {
  const text = new TextDecoder().decode(canonicalBytes(pointer));
  return text.match(/.{1,200}/g).map(part => JSON.stringify(part)).join(' ');
}
export function parsePointerDnsText(text) {
  if (typeof text !== 'string' || text.length > 4096) refuse('invalid-pointer-dns');
  if (text.startsWith('{')) return JSON.parse(text);
  const chunks = text.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks || chunks.join(' ') !== text.trim()) refuse('invalid-pointer-dns');
  return JSON.parse(chunks.map(part => JSON.parse(part)).join(''));
}

/** Session-local DNS publication state, scoped to destination and pinned authority.
 * Reconciliation observes the provider; it is neither atomic CAS nor global order.
 * Credentials are used for this call only and never retained in publication state.
 */
export class PointerPublisher {
  #states = new Map();
  #busy = new Set();
  constructor({ resolver, clock = Date.now }) { this.resolver = resolver; this.clock = clock; }
  pending({ zoneId, name, trustedAuthorityKey }) {
    const state = this.#states.get(JSON.stringify([String(zoneId).toLowerCase(), name, trustedAuthorityKey]));
    return state?.outcome === 'unknown' ? structuredClone(state.candidate) : null;
  }
  async publish({ zoneId, apiToken, name, trustedAuthorityKey, candidate }) {
    // Snapshot all caller-controlled data before the first await.
    candidate = snapshot(candidate);
    if (typeof zoneId !== 'string' || !/^[a-f0-9]{32}$/i.test(zoneId)
      || typeof apiToken !== 'string' || !apiToken) refuse('invalid-dns-destination');
    zoneId = zoneId.toLowerCase();
    identifier(name); unhex(trustedAuthorityKey, 32);
    const scope = JSON.stringify([zoneId, name, trustedAuthorityKey]);
    if (this.#busy.has(scope)) refuse('dns-publication-in-flight');
    this.#busy.add(scope);
    try {
      await verifyPointer(candidate, trustedAuthorityKey);
      if (candidate.name !== name) refuse('pointer-name');
      const previous = this.#states.get(scope);
      if (previous?.outcome === 'unknown' && previous.pointerDigest !== candidate.pointerDigest) refuse('dns-publication-unresolved');
      // Reserve retained publication-state capacity before any provider effect,
      // so a successful/uncertain write cannot outlive an admission refusal.
      this.resolver.admission?.reserve('refresh', { storageBytes: canonicalBytes(candidate).length + canonicalBytes(scope).length });
      let records;
      try { records = await this.resolver.listCloudflareRecords({ zoneId, apiToken, name }); }
      catch (error) {
        if (previous?.outcome === 'unknown') return { outcome: 'unknown', reason: 'Provider reconciliation failed; retry a read without repeating the write.' };
        throw error;
      }
      // Defense in depth for adapters: never overwrite ambiguous or foreign rows.
      if (!Array.isArray(records) || records.length > 1) refuse('dns-record-conflict');
      const remote = records[0];
      let recordId = null;
      if (remote) {
        if (remote.name !== name || remote.type !== 'TXT' || typeof remote.id !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}$/.test(remote.id)) refuse('dns-record-conflict');
        const pointer = parsePointerDnsText(remote.content);
        await verifyPointer(pointer, trustedAuthorityKey);
        if (pointer.name !== name || (previous?.recordId && previous.recordId !== remote.id)) refuse('dns-record-conflict');
        recordId = remote.id;
        if (pointer.pointerDigest === candidate.pointerDigest) {
          this.#states.set(scope, { outcome: 'published', pointerDigest: candidate.pointerDigest, recordId });
          return { outcome: 'published', recordId, reconciled: true };
        }
        if (pointer.pointerDigest !== candidate.previousDigest || pointer.revision + 1 !== candidate.revision) refuse('dns-record-conflict');
      }
      if (previous?.outcome === 'unknown') {
        return { outcome: 'unknown', reason: 'The earlier write may have completed. Provider has not shown the exact candidate; retry reconciliation, not publication.' };
      }
      if (!remote && previous?.recordId) refuse('dns-record-missing');
      const now = this.clock();
      if (!(candidate.validFromMs <= now && now < candidate.validUntilMs)) refuse('pointer-expired');
      const result = await this.resolver.writeCloudflareRecord({ zoneId, apiToken, recordId, type: 'TXT', name,
        content: pointerDnsText(candidate), ttl: 60 });
      const outcome = result.outcome === 'refused' ? 'refused'
        : result.ok === true && result.outcome === 'published' && typeof result.id === 'string' ? 'published' : 'unknown';
      this.#states.set(scope, { outcome, pointerDigest: candidate.pointerDigest, candidate: outcome === 'unknown' ? candidate : undefined, recordId: outcome === 'published' ? result.id : recordId });
      return { outcome, recordId: outcome === 'published' ? result.id : recordId,
        reason: outcome === 'unknown' ? 'Publication completion is unknown. Retry to read the provider without repeating this write.' : undefined };
    } catch (error) {
      if (this.#states.get(scope)?.outcome === 'unknown') return { outcome: 'unknown',
        reason: 'The earlier write is unresolved and this read could not safely reconcile it. Check the provider record, then retry reconciliation; no write was repeated.' };
      throw error;
    } finally { this.#busy.delete(scope); }
  }
}
