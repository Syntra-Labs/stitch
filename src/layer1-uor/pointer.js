/** Single-writer pointer admission. The caller supplies an independently trusted authority key. */
import { canonicalBytes, sha256Bytes, parseCanonicalJson } from './custody.js';
import { record, natural, identifier, digest, refuse } from './contracts.js';
import { pointerSuccessorAllowed } from './generated-model.js';
import { dnsRequestAllowed, dnsReadDecision, dnsWriteState, dnsWriteOutcome, dnsLifecycle } from './effects.js';
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
  const limits = { maxBytes: 4096, maxDepth: 8, maxEntries: 128, maxStringLength: 1024 };
  if (text.startsWith('{')) return structuredClone(parseCanonicalJson(text, limits));
  const chunks = text.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks || chunks.join(' ') !== text.trim()) refuse('invalid-pointer-dns');
  return structuredClone(parseCanonicalJson(chunks.map(part => parseCanonicalJson(part, limits)).join(''), limits));
}

/** DNS publication state scoped to destination and pinned authority.
 * Optional origin-local journal provides conservative restart reconciliation.
 * Reconciliation observes the provider; it is neither atomic CAS nor global order.
 * Credentials are used for this call only and never retained in publication state.
 */
export class PointerPublisher {
  #states = new Map();
  #busy = new Set();
  #journalBusy = false;
  constructor({ resolver, clock = Date.now, journal = null }) { this.resolver = resolver; this.clock = clock; this.journal = journal; }
  async restore(destination) {
    const scope = JSON.stringify([String(destination.zoneId).toLowerCase(), destination.name, destination.trustedAuthorityKey]);
    if (this.journal) {
      const state = await this.journal.readPublication(scope);
      if (state) this.#states.set(scope, state);
      else this.#states.delete(scope);
    }
    return this.pending(destination);
  }
  async publish(request) {
    if (!this.journal) return this.#publish(request);
    if (this.#journalBusy) refuse('dns-publication-in-flight');
    request = { ...request, candidate: snapshot(request.candidate) };
    this.#journalBusy = true;
    const scope = JSON.stringify([String(request.zoneId).toLowerCase(), request.name, request.trustedAuthorityKey]);
    try { return await this.journal.exclusivePublication(scope, () => this.#publishJournal(request)); }
    finally { this.#journalBusy = false; }
  }
  async #publishJournal(request) {
    if (!this.journal) return this.#publish(request);
    const { zoneId, name, trustedAuthorityKey } = request;
    if (typeof zoneId !== 'string' || !/^[a-f0-9]{32}$/i.test(zoneId)) refuse('invalid-dns-destination');
    identifier(name); unhex(trustedAuthorityKey, 32);
    if (typeof request.apiToken !== 'string' || !request.apiToken) refuse('invalid-dns-destination');
    const candidate = snapshot(request.candidate);
    await verifyPointer(candidate, trustedAuthorityKey);
    if (candidate.name !== name) refuse('pointer-name');
    const scope = JSON.stringify([zoneId.toLowerCase(), name, trustedAuthorityKey]);
    // Reads and local admission do not claim an uncertain external effect.
    // The Web Lock spans the read, write-ahead commit, dispatch and settlement.
    const prior = await this.journal.readPublication(scope);
    const effective = prior?.outcome === 'unknown' ? prior.candidate : candidate;
    if (prior) this.#states.set(scope, prior);
    else this.#states.delete(scope);
    let claim = null;
    const settle = async () => {
      const next = this.#states.get(scope);
      if (next && next.outcome !== 'unknown' && (claim?.writer || prior?.outcome === 'unknown')) {
        await this.journal.finishPublication(scope, effective.pointerDigest, claim?.owner, next);
      }
    };
    let result;
    try {
      result = await this.#publish({ ...request, candidate: effective }, async pending => {
        claim = await this.journal.claimPublication(scope, pending);
        if (!claim.writer) throw Error('An earlier publication must be reconciled before dispatch.');
      });
    } catch (error) {
      // A trusted adapter can prove it refused before dispatch. Persist that
      // definite refusal using the claim owner; failed settlement stays unknown.
      try { await settle(); }
      catch {
        await this.restore(request);
        return { outcome: 'unknown', reason: 'Could not save the definite refusal. Reconcile the retained candidate before any further write.' };
      }
      await this.restore(request);
      throw error;
    }
    try { await settle(); }
    catch {
      await this.restore(request);
      return { outcome: 'unknown', reason: 'Provider result could not be saved. Reconcile the retained exact candidate; do not repeat the write.' };
    }
    if (claim?.writer || prior?.outcome === 'unknown') await this.restore(request);
    return result;
  }

  pending({ zoneId, name, trustedAuthorityKey }) {
    const state = this.#states.get(JSON.stringify([String(zoneId).toLowerCase(), name, trustedAuthorityKey]));
    return state?.outcome === 'unknown' ? structuredClone(state.candidate) : null;
  }
  status({ zoneId, name, trustedAuthorityKey }) {
    const scope = JSON.stringify([String(zoneId).toLowerCase(), name, trustedAuthorityKey]);
    return dnsLifecycle(this.#states.get(scope), this.#busy.has(scope));
  }
  async #publish({ zoneId, apiToken, name, trustedAuthorityKey, candidate }, beforeWrite = async () => {}) {
    // Snapshot all caller-controlled data before the first await.
    candidate = snapshot(candidate);
    if (typeof zoneId !== 'string' || !/^[a-f0-9]{32}$/i.test(zoneId)
      || typeof apiToken !== 'string' || !apiToken) refuse('invalid-dns-destination');
    zoneId = zoneId.toLowerCase();
    identifier(name); unhex(trustedAuthorityKey, 32);
    const scope = JSON.stringify([zoneId, name, trustedAuthorityKey]);
    const destination = { zoneId, name, trustedAuthorityKey };
    const busy = this.#busy.has(scope), retained = this.#states.get(scope);
    if (!dnsRequestAllowed(destination, retained, candidate, busy)) {
      if (busy) refuse('dns-publication-in-flight');
      if (retained?.outcome === 'unknown') return { outcome: 'unknown', reason: 'Reconcile the earlier exact candidate before another publication.' };
      refuse('dns-publication-unresolved');
    }
    this.#busy.add(scope);
    try {
      await verifyPointer(candidate, trustedAuthorityKey);
      if (candidate.name !== name) refuse('pointer-name');
      const previous = this.#states.get(scope);
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
      let recordId = null, pointer = null;
      if (remote) {
        if (remote.name !== name || remote.type !== 'TXT' || typeof remote.id !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}$/.test(remote.id)) refuse('dns-record-conflict');
        pointer = parsePointerDnsText(remote.content);
        await verifyPointer(pointer, trustedAuthorityKey);
        if (pointer.name !== name || (previous?.recordId && previous.recordId !== remote.id)) refuse('dns-record-conflict');
        recordId = remote.id;
      }
      const now = this.clock();
      const decision = dnsReadDecision(destination, previous, candidate, remote, pointer, now);
      if (decision === 'Reconciled') {
        this.#states.set(scope, { outcome: 'published', pointerDigest: candidate.pointerDigest, recordId });
        return { outcome: 'published', recordId, reconciled: true };
      }
      if (decision === 'Wait') {
        return { outcome: 'unknown', reason: 'The earlier write may have completed. Provider has not shown the exact candidate; retry reconciliation, not publication.' };
      }
      if (decision === 'Refuse') {
        if (!remote && previous?.recordId) refuse('dns-record-missing');
        if (!(candidate.validFromMs <= now && now < candidate.validUntilMs)) refuse('pointer-expired');
        refuse('dns-record-conflict');
      }
      // Mark uncertain before dispatch. An adapter exception after this boundary
      // cannot silently authorize another mutation, even if it lost the response.
      const pending = dnsWriteState(destination, previous, candidate, remote, pointer, now);
      await beforeWrite(pending);
      this.#states.set(scope, pending);
      let result;
      try {
        result = await this.resolver.writeCloudflareRecord({ zoneId, apiToken, recordId, type: 'TXT', name,
          content: pointerDnsText(candidate), ttl: 60 });
      } catch (error) {
        if (error.effectDispatched === false) {
          // Built-in adapter refused before invoking fetch. Keep all resource
          // charges, but an explicit later attempt is safe after local repair.
          this.#states.set(scope, { ...pending, outcome: dnsWriteOutcome(destination, pending, { outcome: 'refused' }), candidate: undefined });
        }
        throw error;
      }
      const outcome = dnsWriteOutcome(destination, pending, result);
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
