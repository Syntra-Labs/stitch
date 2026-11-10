import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CustodyError, CUSTODY_LIMITS, canonicalBytes, sha256Bytes, commitObject, fragmentDigest,
  verifyManifest, verifyFragment, manifestBody,
} from '../src/layer1-uor/custody.js';
import {
  createObject, recoverObject, createPlacement, requestPlacement, requestMigration,
  acknowledgePlacement, commitPlacement, failPlacement, observeHolderLoss, retirePlacement, placementStatus,
} from '../src/layer3-storage/custody.js';
import { LiveUorMeshDatabase } from '../src/layer3-storage/index.js';

const bytes = text => new TextEncoder().encode(text);
const clone = value => structuredClone(value);
const rejects = (action, code) => assert.rejects(action, e => e instanceof CustodyError && (!code || e.code === code));
const throws = (action, code) => assert.throws(action, e => e instanceof CustodyError && (!code || e.code === code));
const pairs = [[0, 1], [0, 2], [1, 2]];
async function rehash(manifest) {
  manifest.manifestDigest = await sha256Bytes(canonicalBytes(manifestBody(manifest)), 'manifest');
  return manifest;
}
function receipt(bundle, { requestId, index, holder, leaseExpiresAt = 1000 }) {
  return { requestId, index, holder, leaseExpiresAt, manifestDigest: bundle.manifest.manifestDigest,
    fragmentDigest: bundle.manifest.fragments.digests[index], bytes: bundle.fragments[index].bytes };
}
async function place(s, bundle, index, holder = `peer-${index}`, requestId = `request-${index}`, nowMs = 10) {
  const p = { requestId, index, holder, leaseExpiresAt: 1000 };
  s = await requestPlacement(s, p);
  s = await acknowledgePlacement(s, receipt(bundle, p), nowMs);
  return commitPlacement(s, requestId, nowMs);
}

test('canonical encoding is deterministic, closed, bounded and does not execute accessors', () => {
  assert.deepEqual(canonicalBytes({ z: [true, null, 123], a: '\u2603' }), canonicalBytes({ a: '\u2603', z: [true, null, 123] }));
  assert.equal(new TextDecoder().decode(canonicalBytes({ b: 2, a: 1 })), '{"a":1,"b":2}');
  for (const value of [undefined, NaN, Infinity, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, 1n, new Date(), new Uint8Array(), '\ud800', '\udfff']) {
    throws(() => canonicalBytes(value), 'InvalidCanonicalValue');
  }
  for (const value of [[, 1], Object.assign([1], { extra: true }), Object.assign({}, { [Symbol('x')]: 1 })]) {
    throws(() => canonicalBytes(value), 'InvalidCanonicalValue');
  }
  let called = false;
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { called = true; return 1; } });
  throws(() => canonicalBytes(getter), 'InvalidCanonicalValue');
  assert.equal(called, false);
  throws(() => canonicalBytes(Object.defineProperty({}, 'hidden', { value: 1 })), 'InvalidCanonicalValue');
  const cycle = {}; cycle.self = cycle;
  throws(() => canonicalBytes(cycle), 'InvalidCanonicalValue');
  throws(() => canonicalBytes('a'.repeat(CUSTODY_LIMITS.maxStringLength + 1)), 'SizeLimit');
  let nested = null; for (let i = 0; i < 20; i++) nested = [nested];
  throws(() => canonicalBytes(nested), 'SizeLimit');
  throws(() => canonicalBytes(new Array(5000).fill(0)), 'SizeLimit');
});

test('domain-separated full commitments agree with independent Python vectors', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/custody-vectors.json', import.meta.url), 'utf8'));
  for (const vector of fixture.vectors) {
    const original = Uint8Array.from(Buffer.from(vector.objectHex, 'hex'));
    const actual = await createObject(original);
    assert.deepEqual(actual.manifest, vector.manifest, vector.name);
    for (let i = 0; i < 3; i++) assert.equal(Buffer.from(actual.fragments[i].bytes).toString('hex'), vector.fragments[i].hex);
    for (const pair of pairs) assert.deepEqual(await recoverObject(vector.manifest, pair.map(i => actual.fragments[i])), original);
    assert.notEqual(actual.manifest.object.contentDigest, actual.manifest.encoding.encodingDigest);
    assert.equal(actual.manifest.object.contentDigest.length, 71);
  }
  for (const vector of fixture.invalidVectors) {
    const fragments = vector.fragments.map(f => ({ index: f.index, bytes: Uint8Array.from(Buffer.from(f.hex, 'hex')) }));
    await rejects(() => recoverObject(vector.manifest, fragments), vector.expectedError);
  }
  await rejects(() => sha256Bytes(bytes('x'), 'stitch/object/v1'), 'InvalidSchema');
  await rejects(() => commitObject('implicit text coercion'), 'InvalidBytes');
});

test('every pair and triple recovers exact odd/even/empty bytes over deterministic corpus', async () => {
  for (const length of [...Array(80).keys(), 127, 128, 129, 255, 256, 257, 1023, 1024, 1025]) {
    const original = Uint8Array.from({ length }, (_, i) => (i * 71 + length * 19) & 255);
    const bundle = await createObject(original);
    for (const pair of pairs) assert.deepEqual(await recoverObject(bundle.manifest, pair.map(i => bundle.fragments[i])), original, `length ${length} pair ${pair}`);
    assert.deepEqual(await recoverObject(bundle.manifest, bundle.fragments), original);
  }
});

test('async boundaries snapshot original bytes, manifests and fragments', async () => {
  const input = bytes('original');
  const pending = createObject(input); input.fill(255);
  const bundle = await pending;
  assert.deepEqual(await recoverObject(bundle.manifest, bundle.fragments.slice(0, 2)), bytes('original'));
  const mutable = clone(bundle.manifest);
  const checked = verifyManifest(mutable); mutable.object.byteLength = 1;
  assert.equal((await checked).object.byteLength, 8);
  const fragments = bundle.fragments.map(f => ({ index: f.index, bytes: new Uint8Array(f.bytes) }));
  const recovering = recoverObject(bundle.manifest, fragments.slice(0, 2));
  fragments.forEach(f => f.bytes.fill(0));
  assert.deepEqual(await recovering, bytes('original'));
});

test('closed schemas reject truncated commitments, unsupported dependencies and hostile lengths', async () => {
  const { manifest } = await createObject(bytes('schema'));
  const mutations = [
    m => { m.extra = true; }, m => { delete m.object.digestAlgorithm; }, m => { m.version = 2; },
    m => { m.encoding.dependencies = ['missing-basis']; }, m => { m.encoding.format = 'external'; },
    m => { m.object.contentDigest = m.object.contentDigest.slice(0, 24); },
    m => { m.encoding.encodingDigest = m.encoding.encodingDigest.toUpperCase(); },
    m => { m.fragments.digests.pop(); }, m => { m.fragments.threshold = 1; },
    m => { m.fragments.byteLength += 1; }, m => { m.object.byteLength = -1; },
    m => { m.object.byteLength = Number.MAX_SAFE_INTEGER; }, m => { m.object.byteLength = 1.5; },
  ];
  for (const mutate of mutations) { const m = clone(manifest); mutate(m); await rejects(() => verifyManifest(m)); }
  const m = clone(manifest); m.object.contentDigest = 'sha256:' + '0'.repeat(64);
  await rejects(() => verifyManifest(m), 'ManifestDigestMismatch');
  const huge = new Uint8Array(CUSTODY_LIMITS.maxObjectBytes + 1);
  await rejects(() => createObject(huge), 'SizeLimit');
});

test('recovery rejects duplicate, invalid, truncated, mutated, mixed and extra corrupt fragments', async () => {
  const a = await createObject(bytes('fragment-A')), b = await createObject(bytes('fragment-B'));
  await rejects(() => recoverObject(a.manifest, [a.fragments[0]]), 'InsufficientFragments');
  await rejects(() => recoverObject(a.manifest, [a.fragments[0], a.fragments[0]]), 'DuplicateFragment');
  await rejects(() => recoverObject(a.manifest, [a.fragments[0], b.fragments[1]]), 'FragmentDigestMismatch');
  const malformed = [
    { index: 3, bytes: a.fragments[0].bytes }, { index: -1, bytes: a.fragments[0].bytes },
    { index: 0.5, bytes: a.fragments[0].bytes }, { index: 0, bytes: [1, 2] },
    { index: 0, bytes: a.fragments[0].bytes.subarray(1) },
    { index: 0, bytes: new Uint8Array(a.fragments[0].bytes.length + 1) },
    { index: 0, bytes: a.fragments[0].bytes, extra: true },
  ];
  for (const f of malformed) await rejects(() => verifyFragment(a.manifest, f));
  const corrupted = a.fragments.map(f => ({ index: f.index, bytes: new Uint8Array(f.bytes) }));
  corrupted[2].bytes[0] ^= 1;
  await rejects(() => recoverObject(a.manifest, corrupted), 'FragmentDigestMismatch');
  let called = false;
  const f = { index: 0, get bytes() { called = true; return a.fragments[0].bytes; } };
  await rejects(() => verifyFragment(a.manifest, f), 'InvalidSchema');
  assert.equal(called, false);
});

test('recovery checks complete absent-fragment commitment, object, encoding and canonical padding', async () => {
  const a = await createObject(new Uint8Array([1, 2, 3]));
  const absent = clone(a.manifest); absent.fragments.digests[2] = 'sha256:' + '0'.repeat(64);
  await rehash(absent);
  await rejects(() => recoverObject(absent, a.fragments.slice(0, 2)), 'InvalidParity');
  const wrongObject = clone(a.manifest); wrongObject.object.contentDigest = 'sha256:' + '0'.repeat(64);
  await rehash(wrongObject);
  await rejects(() => recoverObject(wrongObject, a.fragments.slice(0, 2)), 'ObjectDigestMismatch');
  const wrongEncoding = clone(a.manifest); wrongEncoding.encoding.encodingDigest = 'sha256:' + '0'.repeat(64);
  wrongEncoding.fragments.digests = await Promise.all(a.fragments.map(f => fragmentDigest(wrongEncoding.encoding.encodingDigest, f.index, f.bytes)));
  await rehash(wrongEncoding);
  await rejects(() => recoverObject(wrongEncoding, a.fragments.slice(0, 2)), 'EncodingDigestMismatch');
  const badPadding = a.fragments.map(f => ({ index: f.index, bytes: new Uint8Array(f.bytes) }));
  badPadding[1].bytes[1] = 7; badPadding[2].bytes[1] ^= 7;
  const paddingManifest = clone(a.manifest);
  paddingManifest.fragments.digests = await Promise.all(badPadding.map(f => fragmentDigest(paddingManifest.encoding.encodingDigest, f.index, f.bytes)));
  await rehash(paddingManifest);
  await rejects(() => recoverObject(paddingManifest, badPadding.slice(0, 2)), 'InvalidPadding');
});

test('placement requests and acknowledgements do not count before explicit commit', async () => {
  const b = await createObject(bytes('custody'));
  let s = await createPlacement(b.manifest);
  const initial = s;
  const p = { requestId: 'r0', index: 0, holder: 'p0', leaseExpiresAt: 1000 };
  s = await requestPlacement(s, p);
  assert.equal(initial.requests.length, 0);
  assert.equal(placementStatus(s, 10).committedFragments, 0);
  await rejects(() => commitPlacement(s, 'r0', 10), 'InvalidTransition');
  s = await acknowledgePlacement(s, receipt(b, p), 10);
  assert.equal(placementStatus(s, 10).committedFragments, 0);
  assert.equal(placementStatus(s, 10).assertedCopies, 1);
  s = await commitPlacement(s, 'r0', 10);
  assert.equal(placementStatus(s, 10).canRecoverFromCommitted, false);
  s = await place(s, b, 1);
  assert.equal(placementStatus(s, 10).canRecoverFromCommitted, true);
  assert.equal(placementStatus(s, 10).toleratesOneHolderLoss, false);
  s = await place(s, b, 2);
  assert.equal(placementStatus(s, 10).toleratesOneHolderLoss, true);
  assert.equal(Object.isFrozen(s.requests[0]), true);
  assert.equal(placementStatus(s, 1000).committedFragments, 0);
});

test('migration retains source on requested/failed/uncertain and accounts for superseded physical copies', async () => {
  const b = await createObject(bytes('safe-migration'));
  let s = await createPlacement(b.manifest);
  for (let i = 0; i < 3; i++) s = await place(s, b, i);
  const old = s;
  const p = { requestId: 'migration', index: 0, holder: 'replacement', leaseExpiresAt: 1000 };
  s = await requestMigration(s, p);
  assert.equal(placementStatus(s, 10).committedFragments, 3);
  assert.equal(old.requests.length, 3);
  const uncertain = await failPlacement(s, p.requestId, 'uncertain');
  assert.equal(placementStatus(uncertain, 10).committedFragments, 3);
  assert.equal(placementStatus(uncertain, 10).uncertainTransfers, 1);
  s = await acknowledgePlacement(s, receipt(b, p), 10);
  assert.equal(placementStatus(s, 10).assertedCopies, 4);
  const failed = await failPlacement(s, p.requestId);
  assert.equal(placementStatus(failed, 10).assertedCopies, 4);
  assert.equal(placementStatus(failed, 10).committedFragments, 3);
  s = await commitPlacement(s, p.requestId, 10);
  assert.equal(s.copies.find(c => c.holder === 'peer-0').status, 'superseded');
  assert.equal(placementStatus(s, 10).assertedCopies, 4);
  s = await retirePlacement(s, { index: 0, holder: 'peer-0' }, 10);
  assert.equal(placementStatus(s, 10).assertedCopies, 3);
  assert.equal(placementStatus(s, 10).toleratesOneHolderLoss, true);
});

test('receipt binding, leases, replay, stale source and distinct-holder guards fail closed', async () => {
  const b = await createObject(bytes('guards'));
  let s = await createPlacement(b.manifest);
  const p = { requestId: 'r', index: 0, holder: 'holder', leaseExpiresAt: 1000 };
  s = await requestPlacement(s, p);
  for (const change of [r => { r.holder = 'other'; }, r => { r.index = 1; }, r => { r.manifestDigest = 'sha256:' + '0'.repeat(64); },
    r => { r.fragmentDigest = 'sha256:' + '0'.repeat(64); }, r => { r.leaseExpiresAt = 999; }]) {
    const r = receipt(b, p); change(r);
    await rejects(() => acknowledgePlacement(s, r, 10), 'ReceiptMismatch');
  }
  await rejects(() => acknowledgePlacement(s, receipt(b, p), 1000), 'InvalidTransition');
  const ack = await acknowledgePlacement(s, receipt(b, p), 10);
  await rejects(() => commitPlacement(ack, 'r', 9), 'ClockRegression');
  throws(() => placementStatus(ack, 9), 'ClockRegression');
  await rejects(() => commitPlacement(ack, 'r', 1000), 'InvalidTransition');
  await rejects(() => commitPlacement(ack, 'r'), 'InvalidSchema');
  s = await commitPlacement(ack, 'r', 10);
  await rejects(() => acknowledgePlacement(s, receipt(b, p), 10), 'InvalidTransition');
  await rejects(() => requestPlacement(s, { requestId: 'same-holder', index: 1, holder: 'holder', leaseExpiresAt: 1000 }), 'HolderConflict');
  await rejects(() => requestPlacement(s, p), 'RequestConflict');
  const mp = { requestId: 'm', index: 0, holder: 'new-holder', leaseExpiresAt: 1000 };
  s = await requestMigration(s, mp);
  s = await acknowledgePlacement(s, receipt(b, mp), 10);
  s = await observeHolderLoss(s, 'holder');
  await rejects(() => commitPlacement(s, 'm', 10), 'StaleRequest');
  await rejects(() => retirePlacement(s, { index: 0, holder: 'new-holder' }, 10), 'InvalidTransition');
  const forged = clone(ack); forged.copies.push(clone(forged.copies[0]));
  await rejects(() => commitPlacement(forged, 'r', 10), 'InvalidPlacement');
});

test('concurrent target holder reuse cannot inflate recovery threshold', async () => {
  const b = await createObject(bytes('same physical holder'));
  let s = await createPlacement(b.manifest);
  for (let i = 0; i < 2; i++) {
    const p = { requestId: `r${i}`, index: i, holder: 'same', leaseExpiresAt: 1000 };
    s = await requestPlacement(s, p);
    s = await acknowledgePlacement(s, receipt(b, p), 10);
  }
  s = await commitPlacement(s, 'r0', 10);
  await rejects(() => commitPlacement(s, 'r1', 10), 'HolderConflict');
  assert.equal(placementStatus(s, 10).canRecoverFromCommitted, false);
});

function wire() {
  const warm = [], nodes = [];
  const node = peerId => {
    const n = { peerId, peers: new Map(), sent: [], handlers: [],
      openPeers() { return [...this.peers.keys()].map(remoteId => ({ remoteId })); },
      sendToPeer(remoteId, pkt) {
        const target = this.peers.get(remoteId);
        if (!target) return false;
        this.sent.push({ remoteId, pkt: clone(pkt) });
        for (const h of target.handlers) h(this.peerId, clone(pkt));
        return true;
      },
      broadcast(pkt) { let sent = 0; for (const id of this.peers.keys()) if (this.sendToPeer(id, pkt)) sent++; return sent; },
      async publishWarmEnvelope(pkt) { warm.push({ ...clone(pkt), from: this.peerId, tsMs: Date.now() }); return true; },
      async fetchWarmEnvelopes() { return clone(warm); },
    };
    n.db = new LiveUorMeshDatabase({ transport: n });
    n.handlers.push((from, msg) => n.db.handleMeshMessage(from, msg));
    nodes.push(n);
    return n;
  };
  const connect = (a, b) => { a.peers.set(b.peerId, b); b.peers.set(a.peerId, a); };
  const drain = async () => { for (let i = 0; i < 8; i++) await Promise.all(nodes.map(n => n.db.flush())); };
  return { node, connect, drain, warm };
}

test('live adapter places one fragment per distinct holder and recovers after a holder loss without relay', async () => {
  const w = wire(), writer = w.node('writer'), holders = [w.node('h0'), w.node('h1'), w.node('h2')];
  for (const h of holders) w.connect(writer, h);
  const entry = await writer.db.put('three separate fragment holders', { label: 'demo.txt' });
  await w.drain();
  assert.equal(w.warm.length, 0);
  assert.equal(entry.addressHex, entry.manifest.object.contentDigest);
  assert.equal(placementStatus(writer.db.placements.get(entry.addressHex), Date.now()).committedFragments, 3);
  for (let i = 0; i < 3; i++) {
    const e = holders[i].db.objects.get(entry.addressHex);
    assert.deepEqual([...e.heldIndices], [i]);
    assert.equal(e.shards.filter(Boolean).length, 1);
    assert.equal(holders[i].db.get(entry.addressHex).ok, false);
  }
  writer.db.objects.clear(); // recovery no longer consults the creator's full copy
  holders[2].db.objects.clear();
  const reader = w.node('reader');
  w.connect(reader, holders[0]); w.connect(reader, holders[1]);
  await reader.db.syncFromNetwork(); await w.drain();
  assert.equal(reader.db.get(entry.addressHex).text, 'three separate fragment holders');
  const returned = reader.db.get(entry.addressHex).bytes; returned.fill(0);
  assert.equal(reader.db.get(entry.addressHex).text, 'three separate fragment holders');
  assert.equal(reader.db.objects.get(entry.addressHex).shards.filter(Boolean).length, 2);
  assert.deepEqual([...reader.db.objects.get(entry.addressHex).heldIndices], []);
});

test('live partial placement stays partial and legacy/corrupt/non-byte packets never become verified objects', async () => {
  const w = wire(), a = w.node('a'), b = w.node('b'); w.connect(a, b);
  const e = await a.db.put('partial'); await w.drain();
  assert.equal(placementStatus(a.db.placements.get(e.addressHex), Date.now()).committedFragments, 1);
  assert.equal(b.db.get(e.addressHex).ok, false);
  assert.equal(a.sent.filter(s => s.pkt.type === 'uor_shard').length, 1);
  const victim = w.node('victim');
  assert.equal(await victim.db.ingestShardEnvelope({ type: 'uor_shard', addressHex: 'short', shardIndex: 0, shardBytes: [1] }), false);
  const packet = clone(a.sent.find(s => s.pkt.type === 'uor_shard').pkt);
  packet.purpose = 'recovery'; packet.requestId = null; packet.holder = null; packet.leaseExpiresAt = 0;
  packet.shardBytes[0] ^= 1;
  assert.equal(await victim.db.ingestShardEnvelope(packet), false);
  for (const value of [-1, 256, 1.5, '2']) {
    packet.shardBytes[0] = value;
    assert.equal(await victim.db.ingestShardEnvelope(packet), false);
  }
  assert.equal(victim.db.objects.size, 0);
});

test('public relay requires explicit opt-in for publishing and recovery; cold reader needs retained information', async () => {
  const w = wire(), writer = w.node('writer');
  await rejects(() => writer.db.put('private', { persistWarm: true }), 'PublicDataRequired');
  assert.equal(writer.db.objects.size, 0); assert.equal(w.warm.length, 0);
  await rejects(() => writer.db.put(new Uint8Array(2049), { persistWarm: true, publicData: true }), 'SizeLimit');
  assert.equal(writer.db.objects.size, 0);
  const entry = await writer.db.put('explicit public demo', { persistWarm: true, publicData: true });
  assert.equal(w.warm.length, 2);
  writer.db.objects.clear();
  const reader = w.node('reader');
  assert.equal(await reader.db.syncFromNetwork(), 0);
  assert.equal(reader.db.objects.size, 0);
  assert.equal(await reader.db.syncFromNetwork('30m', { publicData: true }), 1);
  assert.equal(reader.db.get(entry.addressHex).text, 'explicit public demo');
  w.warm.length = 0;
  const cold = w.node('cold');
  assert.equal(await cold.db.syncFromNetwork('30m', { publicData: true }), 0);
  assert.equal(cold.db.get(entry.addressHex).ok, false);
});

test('complete local put promotes a partial cache and repeated put honors a later relay opt-in', async () => {
  const w = wire(), a = w.node('a'), b = w.node('b'); w.connect(a, b);
  const original = await a.db.put('promote cached fragment'); await w.drain();
  assert.equal(b.db.get(original.addressHex).ok, false);
  const promoted = await b.db.put('promote cached fragment'); await w.drain();
  assert.equal(b.db.get(original.addressHex).text, 'promote cached fragment');
  assert.deepEqual([...promoted.heldIndices], [0]);
  assert.equal(b.db.placements.has(original.addressHex), true);
  assert.equal(w.warm.length, 0);
  await b.db.put('promote cached fragment', { persistWarm: true, publicData: true });
  assert.equal(w.warm.length, 2);
  assert.equal(w.warm.every(p => p.from === 'b' && Number.isSafeInteger(p.tsMs)), true);
});
