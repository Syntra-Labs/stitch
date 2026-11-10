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
