/**
 * Layer 3 reference object recovery and placement transitions.
 *
 * No transport is performed here. An acknowledgement is an assertion by the
 * named holder with bytes checked locally, not an authenticated storage receipt.
 * Distinct holder strings do not establish distinct machines/failure domains.
 * Placement summaries are conditional on truthful, currently reachable holders.
 * State arguments are trusted local observations produced by these transitions,
 * not signed transferable evidence. Schema guards do not authenticate history.
 */
import {
  CUSTODY_LIMITS, CustodyError, canonicalBytes, sha256Bytes, commitObject,
  fragmentDigest, verifyManifest, verifyFragment, copyBytes,
  snapshotRecord, exactKeys, deepFreeze,
} from '../layer1-uor/custody.js';
import { custodyCommitAllowed, custodyRetireAllowed, custodyPairAllowed } from '../layer1-uor/generated-model.js';

const fail = (code, message) => { throw new CustodyError(code, message); };

function split(bytes) {
  const length = Math.ceil(bytes.length / 2);
  const a = new Uint8Array(length), b = new Uint8Array(length), parity = new Uint8Array(length);
  a.set(bytes.subarray(0, length));
  b.set(bytes.subarray(length));
  for (let i = 0; i < length; i++) parity[i] = a[i] ^ b[i];
  return [a, b, parity];
}

/** Raw, self-contained encoding only. The caller's bytes are never retained. */
export async function createObject(bytes) {
  const snapshot = copyBytes(bytes);
  const shards = split(snapshot);
  const object = await commitObject(snapshot);
  const encodingDigest = await sha256Bytes(snapshot, 'encoding');
  const digests = await Promise.all(shards.map((b, i) => fragmentDigest(encodingDigest, i, b)));
  const body = {
    version: 1,
    object,
    encoding: { format: 'raw', encodingDigest, byteLength: snapshot.length, dependencies: [] },
    fragments: { scheme: 'xor-2-of-3', threshold: 2, count: 3, byteLength: shards[0].length, digests },
  };
  const manifest = deepFreeze({ ...body, manifestDigest: await sha256Bytes(canonicalBytes(body), 'manifest') });
  return { manifest, fragments: shards.map((b, index) => ({ index, bytes: b })) };
}

/**
 * Any two distinct valid fragments recover the object. Every supplied fragment,
 * the exact padding, all three regenerated fragment commitments, raw encoding,
 * object bytes and complete manifest commitment are checked, even with 3 inputs.
 * Refuses malformed/duplicate fragments rather than silently choosing a subset.
 */
export async function recoverObject(manifest, fragments) {
  if (!Array.isArray(fragments) || Object.getPrototypeOf(fragments) !== Array.prototype
    || fragments.length < 2 || fragments.length > 3) fail('InsufficientFragments', 'Supply two or three fragments');
  // Snapshot every fragment synchronously before the first await. Never retain
  // mutable network buffers across asynchronous digest checks.
  const inputs = [];
  for (let i = 0; i < fragments.length; i++) {
    const d = Object.getOwnPropertyDescriptor(fragments, String(i));
    if (!d || !Object.hasOwn(d, 'value')) fail('InvalidSchema', 'Sparse/accessor fragment list');
    const f = d.value;
    if (!f || typeof f !== 'object' || Array.isArray(f)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(f))) fail('InvalidSchema', 'Invalid fragment');
    const descriptors = Object.getOwnPropertyDescriptors(f);
    if (Reflect.ownKeys(f).length !== 2 || !descriptors.index?.enumerable || !descriptors.bytes?.enumerable
      || !Object.hasOwn(descriptors.index, 'value') || !Object.hasOwn(descriptors.bytes, 'value')) {
      fail('InvalidSchema', 'Fragment requires only index and bytes');
    }
    const index = descriptors.index.value;
    if (!Number.isInteger(index) || index < 0 || index > 2) fail('InvalidSchema', 'Invalid fragment index');
    if (inputs.some(v => v.index === index)) fail('DuplicateFragment', 'Fragment indices must be distinct');
    inputs.push({ index, bytes: copyBytes(descriptors.bytes.value, Math.ceil(CUSTODY_LIMITS.maxObjectBytes / 2)) });
  }
  if (Reflect.ownKeys(fragments).length !== fragments.length + 1) fail('InvalidSchema', 'Extended fragment list');
  const m = await verifyManifest(manifest);
  const checked = await Promise.all(inputs.map(f => verifyFragment(m, f)));
  if (!custodyPairAllowed(checked[0].index, checked[1].index, true, true, m.encoding.dependencies.length === 0)) {
    fail('InvalidTransition', 'Generated model refused the recovery pair');
  }
  const shards = [null, null, null];
  for (const f of checked) shards[f.index] = f.bytes;
  const n = m.fragments.byteLength;
  if (!shards[0] || !shards[1]) {
    const absent = shards[0] ? 1 : 0;
    shards[absent] = new Uint8Array(n);
    for (let i = 0; i < n; i++) shards[absent][i] = shards[1 - absent][i] ^ shards[2][i];
  }
  if (m.object.byteLength % 2 === 1 && shards[1][n - 1] !== 0) fail('InvalidPadding', 'Nonzero XOR padding');
  const bytes = new Uint8Array(m.object.byteLength);
  bytes.set(shards[0]);
  bytes.set(shards[1].subarray(0, bytes.length - n), n);
  const object = await commitObject(bytes);
  if (object.contentDigest !== m.object.contentDigest) fail('ObjectDigestMismatch', 'Recovered object commitment does not match');
  if (await sha256Bytes(bytes, 'encoding') !== m.encoding.encodingDigest) {
    fail('EncodingDigestMismatch', 'Recovered encoding commitment does not match');
  }
  const regenerated = split(bytes);
  for (let i = 0; i < 3; i++) {
    if (await fragmentDigest(m.encoding.encodingDigest, i, regenerated[i]) !== m.fragments.digests[i]) {
      fail('InvalidParity', 'Complete fragment manifest is inconsistent with recovered bytes');
    }
  }
  return bytes;
}

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value)) {
    fail('InvalidSchema', 'Holder and request IDs must be bounded ASCII identifiers');
  }
}

function index(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2) fail('InvalidSchema', 'Invalid fragment index');
}

function clock(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('InvalidSchema', 'Expected an explicit nonnegative integer clock observation');
}

function observeClock(s, nowMs) {
  if (nowMs < s.lastObservedMs) fail('ClockRegression', 'Placement clock observation regressed');
  s.lastObservedMs = nowMs;
}

const liveCommitted = (s, nowMs) => s.copies.filter(c => c.status === 'committed'
  && s.requests.find(r => r.requestId === c.requestId).leaseExpiresAt > nowMs);

function stateSnapshot(state) {
  const s = snapshotRecord(state);
  exactKeys(s, ['version', 'manifest', 'revision', 'lastObservedMs', 'copies', 'requests'], 'placement');
  clock(s.lastObservedMs);
  if (s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || s.revision >= Number.MAX_SAFE_INTEGER) {
    fail('InvalidPlacement', 'Invalid placement version or revision');
  }
  if (!Array.isArray(s.requests) || s.requests.length > CUSTODY_LIMITS.maxRequests
    || !Array.isArray(s.copies) || s.copies.length > CUSTODY_LIMITS.maxCopies) {
    fail('CapacityLimit', 'Placement state exceeds its bounded capacity');
  }
  const requests = new Map();
  for (const r of s.requests) {
    exactKeys(r, ['requestId', 'index', 'holder', 'fromRequestId', 'status', 'leaseExpiresAt'], 'request');
    id(r.requestId); id(r.holder); index(r.index);
    clock(r.leaseExpiresAt);
    if (r.fromRequestId !== null) id(r.fromRequestId);
    if (!['requested', 'acknowledged', 'committed', 'failed', 'uncertain'].includes(r.status)
      || requests.has(r.requestId)) fail('InvalidPlacement', 'Invalid or duplicate request');
    requests.set(r.requestId, r);
  }
  for (const r of s.requests) {
    if (r.fromRequestId !== null) {
      const old = requests.get(r.fromRequestId);
      if (!old || old.status !== 'committed' || old.index !== r.index || old.holder === r.holder) {
        fail('InvalidPlacement', 'Invalid migration predecessor');
      }
    }
  }
  const copyKeys = new Set(), activeIndices = new Set(), activeHolders = new Set();
  for (const c of s.copies) {
    exactKeys(c, ['index', 'holder', 'requestId', 'status'], 'copy');
    id(c.holder); id(c.requestId); index(c.index);
    const r = requests.get(c.requestId);
    if (!r || r.index !== c.index || r.holder !== c.holder
      || !['acknowledged', 'committed', 'superseded'].includes(c.status)
      || (c.status === 'acknowledged' && r.status !== 'acknowledged')
      || (c.status === 'committed' && r.status !== 'committed')
      || (c.status === 'superseded' && !['committed', 'failed', 'uncertain'].includes(r.status))) {
      fail('InvalidPlacement', 'Copy is inconsistent with request history');
    }
    const key = `${c.holder}\0${c.index}`;
    if (copyKeys.has(key)) fail('InvalidPlacement', 'Duplicate physical copy assertion');
    copyKeys.add(key);
    if (c.status === 'committed') {
      if (activeIndices.has(c.index) || activeHolders.has(c.holder)) fail('HolderConflict', 'Active fragments require distinct holders');
      activeIndices.add(c.index); activeHolders.add(c.holder);
    }
  }
  for (const r of s.requests) {
    if (r.status === 'acknowledged' && !s.copies.some(c => c.requestId === r.requestId && c.status === 'acknowledged')) {
      fail('InvalidPlacement', 'Acknowledged request has no copy assertion');
    }
  }
  return s;
}

async function checkedState(state) {
  const s = stateSnapshot(state);
  s.manifest = await verifyManifest(s.manifest);
  return s;
}

function finish(s) {
  s.revision++;
  // Enforce the same aggregate bound on outputs as on inputs.
  return deepFreeze(stateSnapshot(s));
}

export async function createPlacement(manifest) {
  return deepFreeze({ version: 1, manifest: await verifyManifest(manifest), revision: 0, lastObservedMs: 0, copies: [], requests: [] });
}

async function request(state, parameters, migration) {
  const p = snapshotRecord(parameters);
  exactKeys(p, ['requestId', 'index', 'holder', 'leaseExpiresAt'], 'placement request');
  id(p.requestId); id(p.holder); index(p.index);
  clock(p.leaseExpiresAt);
  const s = await checkedState(state);
  if (s.requests.length >= CUSTODY_LIMITS.maxRequests) fail('CapacityLimit', 'Request history is full');
  if (s.requests.some(r => r.requestId === p.requestId)) fail('RequestConflict', 'Request IDs cannot be reused');
  if (s.requests.some(r => r.index === p.index && ['requested', 'acknowledged'].includes(r.status))) {
    fail('RequestConflict', 'Fragment already has a pending request');
  }
  const active = s.copies.filter(c => c.status === 'committed');
  const old = active.find(c => c.index === p.index);
  if (migration ? !old : !!old) fail('InvalidTransition', migration ? 'Migration needs a committed source' : 'Fragment already committed; request a migration');
  if (active.some(c => c.holder === p.holder)
    || s.copies.some(c => c.index === p.index && c.holder === p.holder && c.status !== 'superseded')) {
    fail('HolderConflict', 'Target already holds an active fragment or this copy');
  }
  s.requests.push({ ...p, fromRequestId: old?.requestId ?? null, status: 'requested' });
  return finish(s);
}

export const requestPlacement = (state, parameters) => request(state, parameters, false);
export const requestMigration = (state, parameters) => request(state, parameters, true);

/**
 * Receipt = {requestId,index,holder,manifestDigest,fragmentDigest,leaseExpiresAt,bytes}.
 * Host must separately authenticate peers if that is part of its policy. Bytes
 * here prove only that this caller supplied a valid fragment, not remote storage.
 */
export async function acknowledgePlacement(state, receipt, nowMs) {
  clock(nowMs);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(receipt))) fail('InvalidSchema', 'Invalid acknowledgement');
  const d = Object.getOwnPropertyDescriptors(receipt);
  const keys = ['requestId', 'index', 'holder', 'manifestDigest', 'fragmentDigest', 'leaseExpiresAt', 'bytes'];
  if (Reflect.ownKeys(receipt).length !== keys.length || keys.some(k => !d[k]?.enumerable || !Object.hasOwn(d[k], 'value'))) {
    fail('InvalidSchema', 'Acknowledgement has missing or unknown fields');
  }
  const p = snapshotRecord(Object.fromEntries(keys.filter(k => k !== 'bytes').map(k => [k, d[k].value])));
  const bytes = copyBytes(d.bytes.value, Math.ceil(CUSTODY_LIMITS.maxObjectBytes / 2));
  const s = await checkedState(state);
  observeClock(s, nowMs);
  const r = s.requests.find(r => r.requestId === p.requestId);
  if (!r || r.status !== 'requested') fail('InvalidTransition', 'Only a requested transfer can be acknowledged');
  if (r.leaseExpiresAt <= nowMs) fail('InvalidTransition', 'Acknowledgement lease has expired');
  if (p.index !== r.index || p.holder !== r.holder || p.manifestDigest !== s.manifest.manifestDigest
    || p.fragmentDigest !== s.manifest.fragments.digests[r.index] || p.leaseExpiresAt !== r.leaseExpiresAt) {
    fail('ReceiptMismatch', 'Acknowledgement is not bound to this request');
  }
  await verifyFragment(s.manifest, { index: p.index, bytes });
  // A fresh checked receipt for the same physical holder/index renews that
  // assertion, not an additional copy. Until this check the old assertion stays.
  s.copies = s.copies.filter(c => !(c.index === r.index && c.holder === r.holder && c.status === 'superseded'));
  if (s.copies.length >= CUSTODY_LIMITS.maxCopies) fail('CapacityLimit', 'Too many retained copies');
  r.status = 'acknowledged';
  s.copies.push({ index: r.index, holder: r.holder, requestId: r.requestId, status: 'acknowledged' });
  return finish(s);
}

/** Commit only a checked acknowledgement; retain the source until this point. */
export async function commitPlacement(state, requestId, nowMs) {
  id(requestId);
  clock(nowMs);
  const s = await checkedState(state);
  observeClock(s, nowMs);
  const r = s.requests.find(r => r.requestId === requestId);
  if (!r || r.status !== 'acknowledged') fail('InvalidTransition', 'Commit requires an acknowledged transfer');
  const active = s.copies.filter(c => c.status === 'committed');
  const old = active.find(c => c.index === r.index);
  if ((old?.requestId ?? null) !== r.fromRequestId) fail('StaleRequest', 'Migration source changed or was lost');
  if (active.some(c => c.holder === r.holder && c.index !== r.index)) fail('HolderConflict', 'Target holder is already committed to another fragment');
  const target = s.copies.find(c => c.requestId === r.requestId && c.status === 'acknowledged');
  if (!target) fail('InvalidTransition', 'Acknowledged target missing');
  if (!custodyCommitAllowed(true, r.status === 'acknowledged', true, true,
    target.holder === r.holder, r.leaseExpiresAt > nowMs,
    (old?.requestId ?? null) === r.fromRequestId
      && (!old || s.requests.find(v => v.requestId === old.requestId).leaseExpiresAt > nowMs),
    !active.some(c => c.holder === r.holder && c.index !== r.index))) {
    fail('InvalidTransition', 'Generated model refused an expired or unsafe commitment');
  }
  if (old) old.status = 'superseded';
  target.status = 'committed';
  r.status = 'committed';
  return finish(s);
}

/** A failed/uncertain action never removes the old committed source. */
export async function failPlacement(state, requestId, outcome = 'failed') {
  id(requestId);
  if (!['failed', 'uncertain'].includes(outcome)) fail('InvalidSchema', 'Outcome must be failed or uncertain');
  const s = await checkedState(state);
  const r = s.requests.find(r => r.requestId === requestId);
  if (!r || !['requested', 'acknowledged'].includes(r.status)) fail('InvalidTransition', 'Transfer is not pending');
  r.status = outcome;
  const copy = s.copies.find(c => c.requestId === requestId);
  if (copy) copy.status = 'superseded'; // may still occupy storage; do not hide it
  return finish(s);
}

/**
 * Record local observation of holder loss. It is not proof of global death or
 * deletion. Supersedes reachable assertions while retaining possible physical
 * copies for accounting. Expired leases use this same conservative transition.
 */
export async function observeHolderLoss(state, holder) {
  id(holder);
  const s = await checkedState(state);
  for (const c of s.copies) if (c.holder === holder) c.status = 'superseded';
  for (const r of s.requests) {
    if (r.holder === holder && ['requested', 'acknowledged'].includes(r.status)) r.status = 'uncertain';
  }
  return finish(s);
}

/**
 * Host-observed release of a superseded copy, only after at least two active
 * distinct-holder fragments remain. Does not issue or prove remote deletion.
 */
export async function retirePlacement(state, parameters, nowMs) {
  clock(nowMs);
  const p = snapshotRecord(parameters);
  exactKeys(p, ['index', 'holder'], 'retirement');
  index(p.index); id(p.holder);
  const s = await checkedState(state);
  observeClock(s, nowMs);
  const target = s.copies.find(c => c.index === p.index && c.holder === p.holder);
  if (!target || target.status !== 'superseded') fail('InvalidTransition', 'Only superseded copies may be retired');
  const active = liveCommitted(s, nowMs);
  const remaining = new Set(active.map(c => c.index)).size;
  if (!custodyRetireAllowed(active.some(c => c.index === target.index), remaining, 2)) {
    fail('UnsafeMigration', 'Retirement requires two live active fragments on distinct holders');
  }
  s.copies = s.copies.filter(c => c !== target);
  return finish(s);
}

/** Summary of local assertions, not a network availability or durability proof. */
export function placementStatus(state, nowMs) {
  clock(nowMs);
  const s = stateSnapshot(state);
  if (nowMs < s.lastObservedMs) fail('ClockRegression', 'Placement clock observation regressed');
  const active = liveCommitted(s, nowMs);
  return Object.freeze({
    committedFragments: active.length,
    distinctHolders: new Set(active.map(c => c.holder)).size,
    canRecoverFromCommitted: active.length >= 2,
    toleratesOneHolderLoss: active.length === 3,
    acknowledgedTransfers: s.requests.filter(r => r.status === 'acknowledged').length,
    requestedTransfers: s.requests.filter(r => r.status === 'requested').length,
    uncertainTransfers: s.requests.filter(r => r.status === 'uncertain').length,
    assertedCopies: s.copies.length,
    assertedStoredBytes: s.copies.length * s.manifest.fragments.byteLength,
    evidence: 'digest-checked-peer-assertions',
    conditions: 'exact-encoding-and-truthful-reachable-holders',
  });
}
