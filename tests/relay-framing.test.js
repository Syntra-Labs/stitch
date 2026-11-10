import test from 'node:test';
import assert from 'node:assert/strict';
import { model } from '../src/layer1-uor/generated-model.js';
import { sha256Bytes } from '../src/layer1-uor/custody.js';
import { createObject } from '../src/layer3-storage/custody.js';
import { LiveUorMeshDatabase } from '../src/layer3-storage/index.js';
import { ResourceAdmission, wireBytes } from '../src/layer2-schedulers/policy.js';
import { WebRtcTransportNode } from '../src/layer5-transport/index.js';
import { RELAY_LIMITS, RELAY_LIFETIMES, RelayReassembler, snapshotRelayMessage, frameRelayMessage,
  decodeBase64Url, encodeBase64Url } from '../src/layer5-transport/relay-framing.js';

const now = 1700000000000;
const session = '0'.repeat(32);
const normalize = value => JSON.parse(JSON.stringify(value));
const code = expected => error => error.code === expected;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const frame = (payload, options = {}) => frameRelayMessage(snapshotRelayMessage({ from: 'remote', ...payload }), {
  channelKey: 'mesh', session, scope: 'warm', createdAtMs: now, ...options });
const assembler = (options = {}) => new RelayReassembler({ channelKey: 'mesh', scope: 'warm', wallClock: () => now,
  clock: () => 0, automaticCleanup: false, ...options });
const alter = (raw, updates) => JSON.stringify({ ...JSON.parse(raw), ...updates });
const policy = limit => new ResourceAdmission({ limit: { requests: 4096, transferBytes: 16 * 1024 * 1024,
  storageBytes: 16 * 1024 * 1024, computeSteps: 1000000, ...limit } });
const drain = node => Promise.all([...node.relayPending.values()].map(job => job.completion));
function globals(t, entries) {
  for (const [name, value] of Object.entries(entries)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
}

test('relay runtime limits and duplicate/closed/consent gates are source-derived', () => {
  const source = model['Stitch.Relay.limits']();
  assert.deepEqual(RELAY_LIMITS, Object.fromEntries(Object.entries(source).map(([key, value]) => [key, Number(value)])));
  assert.equal(RELAY_LIMITS.wireBytes, 4096);
  assert.equal(RELAY_LIMITS.messageBytes, 512 * 1024);
  assert.equal(model['Stitch.Relay.effectAllowed'](true, 0, 0, true, true), false);
  assert.equal(model['Stitch.Relay.effectAllowed'](false, 1, 0, true, true), false);
  assert.equal(model['Stitch.Relay.effectAllowed'](false, 0, 0, true, false), false);
});

test('RFC4648 unpadded base64url is byte-exact and refuses aliases/nonzero pad bits', () => {
  for (let length = 1; length <= 256; length++) {
    const bytes = Uint8Array.from({ length }, (_, index) => index);
    assert.deepEqual(decodeBase64Url(encodeBase64Url(bytes)), bytes);
  }
  for (const value of ['', 'A', 'AA=', 'AA==', '+w', '/w', '_x', 'AB', 'AAB', 'a a', 'é']) {
    assert.throws(() => decodeBase64Url(value), code('relay-base64'));
  }
});

test('full 512KiB logical JSON is framed below4096 UTF8 bytes without shrinking its message', async () => {
  const overhead = wireBytes({ from: 'remote', data: '' });
  const payload = { from: 'remote', data: 'x'.repeat(RELAY_LIMITS.messageBytes - overhead) };
  const encoded = await frame(payload);
  assert.equal(snapshotRelayMessage(payload).byteLength, RELAY_LIMITS.messageBytes);
  assert.ok(encoded.frames.length > 1 && encoded.frames.length <= RELAY_LIMITS.frames);
  assert.equal(encoded.bytes, encoded.frames.reduce((sum, item) => sum + wireBytes(item), 0));
  for (const raw of encoded.frames) assert.ok(wireBytes(raw) <= 4096);
  const receiver = assembler();
  let result;
  for (const raw of encoded.frames.reverse()) result = await receiver.accept(raw) ?? result;
  assert.deepEqual(normalize(result), payload);
  assert.equal(receiver.state.retainedBytes, 0);
  assert.throws(() => snapshotRelayMessage({ ...payload, data: payload.data + 'x' }), code('relay-message-limit'));
  receiver.dispose();
});

test('UTF8 split boundaries, reordering and duplicates preserve logical bytes and deliver only once', async () => {
  const payload = { from: 'peer', data: '😀é\n'.repeat(1800), nested: { objectRoot: 'unchanged' } };
  const encoded = await frame(payload);
  const receiver = assembler();
  assert.equal(await receiver.accept(encoded.frames[1]), null);
  assert.equal(await receiver.accept(encoded.frames[1]), null);
  let result, deliveries = 0;
  for (const raw of encoded.frames.slice().reverse()) {
    const message = await receiver.accept(raw);
    if (message) { result = message; deliveries++; }
  }
  for (const raw of encoded.frames) assert.equal(await receiver.accept(raw), null);
  assert.equal(deliveries, 1);
  assert.deepEqual(normalize(result), payload);
  assert.equal(receiver.state.entries, 0); assert.equal(receiver.state.tombstones, 1);
  receiver.dispose();
});

test('corrupt chunks and conflicting duplicates tombstone exactly their assembly', async () => {
  const encoded = await frame({ data: 'x'.repeat(6000) });
  const other = await frame({ data: 'y'.repeat(6000) }, { session: '1'.repeat(32) });
  const receiver = assembler();
  await receiver.accept(encoded.frames[0]); await receiver.accept(other.frames[0]);
  const parsed = JSON.parse(encoded.frames[0]);
  const bytes = decodeBase64Url(parsed.x); bytes[0] ^= 1;
  await assert.rejects(receiver.accept(alter(encoded.frames[0], { x: encodeBase64Url(bytes) })), code('relay-conflicting-duplicate'));
  for (const raw of encoded.frames) assert.equal(await receiver.accept(raw), null);
  let result;
  for (const raw of other.frames.slice(1)) result = await receiver.accept(raw) ?? result;
  assert.equal(result.data, 'y'.repeat(6000));
  assert.equal(receiver.state.retainedBytes, 0);
  receiver.dispose();
  const corrupt = assembler();
  await corrupt.accept(alter(encoded.frames[0], { x: encodeBase64Url(bytes) }));
  await corrupt.accept(encoded.frames[1]);
  await assert.rejects(corrupt.accept(encoded.frames[2]), code('relay-integrity'));
  assert.equal(corrupt.state.entries, 0); assert.equal(corrupt.state.retainedBytes, 0);
  corrupt.dispose();
});

test('mixed metadata is refused, while sender sessions never concatenate', async () => {
  const encoded = await frame({ data: 'x'.repeat(6000) });
  const receiver = assembler();
  await receiver.accept(encoded.frames[0]);
  await assert.rejects(receiver.accept(alter(encoded.frames[0], { b: JSON.parse(encoded.frames[0]).b + 1 })), code('relay-mixed-message'));
  assert.equal(receiver.state.entries, 0);
  const separate = assembler();
  await separate.accept(encoded.frames[0]);
  for (const raw of encoded.frames.slice(1)) assert.equal(await separate.accept(alter(raw, { s: 'f'.repeat(32) })), null);
  assert.equal(separate.state.entries, 2);
  assert.equal(separate.state.retainedBytes, 2 * JSON.parse(encoded.frames[0]).b);
  receiver.dispose(); separate.dispose();
});

test('wrong channel/purpose, malformed schema and oversized declarations never allocate an assembly', async () => {
  const encoded = await frame({ data: 'x'.repeat(6000) });
  const receiver = assembler();
  const bad = [alter(encoded.frames[0], { p: 'signal' }), alter(encoded.frames[0], { c: 'sha256:' + 'f'.repeat(64) }),
    alter(encoded.frames[0], { b: RELAY_LIMITS.messageBytes + 1 }), alter(encoded.frames[0], { n: RELAY_LIMITS.frames + 1 }),
    alter(encoded.frames[0], { n: 0 }), alter(encoded.frames[0], { i: 999 }), alter(encoded.frames[0], { extra: true }),
    encoded.frames[0].replace('"v":', '"v":"stitch/1","v":'), 'é'.repeat(4096)];
  for (const raw of bad) await assert.rejects(receiver.accept(raw));
  assert.equal(receiver.state.entries, 0); assert.equal(receiver.state.retainedBytes, 0);
  receiver.dispose();
});

test('sender timestamps cannot extend local assembly horizons and expired bytes are reclaimed', async () => {
  let monotonic = 0, wall = now;
  const encoded = await frame({ data: 'x'.repeat(6000) }, { scope: 'signal' });
  const receiver = assembler({ scope: 'signal', clock: () => monotonic, wallClock: () => wall });
  await receiver.accept(encoded.frames[0]);
  monotonic = RELAY_LIMITS.assemblyAge;
  assert.equal(receiver.state.entries, 0); assert.equal(receiver.state.retainedBytes, 0);
  assert.equal(await receiver.accept(encoded.frames[1]), null);
  monotonic = RELAY_LIFETIMES.signal; wall += RELAY_LIFETIMES.signal;
  assert.equal(receiver.state.tombstones, 0);
  await assert.rejects(receiver.accept(encoded.frames[0]), code('relay-frame'));
  const future = await frame({ data: 'x'.repeat(6000) }, { scope: 'signal', createdAtMs: wall + RELAY_LIMITS.futureSkew + 1 });
  await assert.rejects(receiver.accept(future.frames[0]), code('relay-frame'));
  receiver.dispose();
});

test('active entry/declared byte caps and tombstone admission never evict another message', async () => {
  const encoded = await frame({ data: 'x'.repeat(6000) });
  const receiver = assembler();
  for (let index = 0; index < RELAY_LIMITS.entries; index++) {
    await receiver.accept(alter(encoded.frames[0], { s: index.toString(16).padStart(32, '0') }));
  }
  await assert.rejects(receiver.accept(alter(encoded.frames[0], { s: 'e'.repeat(32) })), code('relay-reassembly-capacity'));
  assert.equal(receiver.state.entries, RELAY_LIMITS.entries);
  receiver.dispose();
  const big = assembler();
  const header = { b: RELAY_LIMITS.messageBytes, n: Math.ceil(RELAY_LIMITS.messageBytes / RELAY_LIMITS.chunkBytes) };
  for (let index = 0; index < RELAY_LIMITS.retainedBytes / RELAY_LIMITS.messageBytes; index++) {
    await big.accept(alter(encoded.frames[0], { ...header, s: index.toString(16).padStart(32, '0') }));
  }
  await assert.rejects(big.accept(alter(encoded.frames[0], { ...header, s: 'e'.repeat(32) })), code('relay-reassembly-capacity'));
  assert.equal(big.state.retainedBytes, RELAY_LIMITS.retainedBytes);
  big.dispose();
  const small = await frame({ data: 'one' }), tombstones = assembler();
  for (let index = 0; index < RELAY_LIMITS.tombstones; index++) {
    assert.ok(await tombstones.accept(alter(small.frames[0], { s: index.toString(16).padStart(32, '0') })));
  }
  await assert.rejects(tombstones.accept(alter(small.frames[0], { s: 'e'.repeat(32) })), code('relay-reassembly-capacity'));
  assert.equal(tombstones.state.tombstones, RELAY_LIMITS.tombstones);
  tombstones.dispose();
});

test('pending verification cannot deliver after disposal or consent withdrawal', async t => {
  const encoded = await frame({ data: 'one' });
  let consent = true;
  const receiver = assembler({ consentCurrent: () => consent });
  await receiver.channel;
  const gate = deferred(), entered = deferred(), original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  const pending = receiver.accept(encoded.frames[0]);
  await entered.promise; consent = false; receiver.dispose(); gate.resolve();
  assert.equal(await pending, null);
  assert.equal(receiver.state.retainedBytes, 0);
});

test('complete untrusted bytes are not deliverable JSON with duplicate keys or invalid UTF8', async () => {
  for (const bytes of [new TextEncoder().encode('{"from":"a","from":"b"}'), Uint8Array.from([0xff])]) {
    const normal = await frame({ data: 'one' });
    const raw = alter(normal.frames[0], { m: await sha256Bytes(bytes, 'relay-message'), b: bytes.length, n: 1, i: 0, x: encodeBase64Url(bytes) });
    const receiver = assembler();
    await assert.rejects(receiver.accept(raw));
    assert.equal(receiver.state.retainedBytes, 0);
    receiver.dispose();
  }
});

test('2048 all-ff object survives cold ntfy cache recovery with no oversized provider POST', async t => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options?.method === 'POST') {
      const size = wireBytes(options.body);
      // Model ntfy's documented long-body attachment conversion to catch regressions.
      posts.push(size <= 4096 ? { event: 'message', message: options.body } : { event: 'message', message: 'attachment', attachment: { url: 'https://unused.invalid' } });
      return { ok: true, status: 200 };
    }
    return new Response([...posts.slice().reverse(), posts[0]].map(item => JSON.stringify(item)).join('\n'));
  });
  const sender = new WebRtcTransportNode({ peerId: 'writer', channelKey: 'mesh' });
  const receiver = new WebRtcTransportNode({ peerId: 'reader', channelKey: 'mesh' });
  t.after(() => { sender.close(); receiver.close(); });
  const writer = new LiveUorMeshDatabase({ transport: sender });
  const bytes = new Uint8Array(2048).fill(255);
  const stored = await writer.put(bytes, { persistWarm: true, publicData: true });
  const { fragments } = await createObject(bytes);
  const packet = writer._packet(stored, 0, fragments[0].bytes, { purpose: 'public-relay', holder: 'public-relay' });
  assert.ok(wireBytes({ ...packet, from: sender.peerId, tsMs: Date.now() }) > 4096);
  assert.equal(stored.warmPublished, 2); assert.ok(posts.length >= 4);
  assert.ok(posts.every(item => !item.attachment && wireBytes(item.message) <= 4096));
  await writer.clearLocal();
  const reader = new LiveUorMeshDatabase({ transport: receiver });
  assert.equal(await reader.syncFromNetwork('30m', { publicData: true }), 1);
  assert.deepEqual(reader.get(stored.addressHex).bytes, bytes);
  assert.equal(reader.get(stored.addressHex).entry.manifest.manifestDigest, stored.manifest.manifestDigest);
});

test('actual signal WebSocket path reassembles large SDP and ignores stale/wrong-channel packets', async t => {
  const posts = [], received = [];
  class Socket { close() {} }
  globals(t, { WebSocket: Socket, BroadcastChannel: undefined });
  t.mock.method(globalThis, 'fetch', async (_, options) => { posts.push(options.body); return { ok: true, status: 200 }; });
  const sender = new WebRtcTransportNode({ peerId: 'sender', channelKey: 'mesh' });
  const receiver = new WebRtcTransportNode({ peerId: 'receiver', channelKey: 'mesh' });
  t.after(() => { sender.close(); receiver.close(); });
  receiver.connect(); receiver.handleSignal = async msg => { received.push(normalize(msg)); };
  const payload = { kind: 'offer', to: 'receiver', sdp: { type: 'offer', sdp: 'v=0\r\n'.repeat(2500) } };
  assert.equal(sender.sendSignal(payload), true); await drain(sender);
  assert.ok(posts.length > 1 && posts.every(raw => wireBytes(raw) <= 4096));
  for (const raw of [...posts.slice().reverse(), ...posts]) await receiver.ws.onmessage({ data: JSON.stringify({ event: 'message', message: raw }) });
  assert.equal(received.length, 1); assert.deepEqual(received[0].sdp, payload.sdp);
  const oldSocket = receiver.ws;
  receiver.connect('different');
  for (const raw of posts) {
    await oldSocket.onmessage({ data: JSON.stringify({ event: 'message', message: raw }) });
    await receiver.ws.onmessage({ data: JSON.stringify({ event: 'message', message: raw }) });
  }
  assert.equal(received.length, 1);
});

test('warm direct boundary requires explicit opt-in, and failed batches retain exact framed charges', async t => {
  const posts = [], events = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { posts.push(options.body); return { ok: false, status: 429 }; });
  const admission = policy(), node = new WebRtcTransportNode({ peerId: 'writer', admission, onEvent: event => events.push(event) });
  t.after(() => node.close());
  assert.equal(await node.publishWarmEnvelope({ data: 'private' }), false);
  assert.deepEqual(await node.fetchWarmEnvelopes(), []);
  assert.equal(posts.length, 0); assert.equal(admission.state.spent.requests, 0);
  assert.equal(await node.publishWarmEnvelope({ data: 'x'.repeat(6000) }, { publicData: true }), false);
  const outcome = events.find(event => event.type === 'relay_publish_result');
  assert.equal(outcome.outcome, 'refused'); assert.equal(outcome.httpStatus, 429);
  assert.equal(outcome.attempted, 1); assert.ok(outcome.planned > 1); assert.equal(outcome.acknowledged, 0);
  assert.equal(admission.state.spent.requests, outcome.planned);
  const first = JSON.parse(posts[0]);
  const expected = await frameRelayMessage(snapshotRelayMessage({ data: 'x'.repeat(6000), from: node.peerId, tsMs: first.t }), {
    channelKey: node.channelKey, session: first.s, scope: 'warm', createdAtMs: first.t });
  assert.equal(admission.state.spent.transferBytes, expected.bytes);
});

test('consent withdrawal stops a partly published batch before another external effect', async t => {
  let consent = true;
  const gate = deferred(), entered = deferred(), posts = [], events = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { posts.push(options.body); entered.resolve(); await gate.promise; return { ok: true, status: 200 }; });
  const node = new WebRtcTransportNode({ peerId: 'writer', onEvent: event => events.push(event) });
  t.after(() => node.close());
  const work = node.publishWarmEnvelope({ data: 'x'.repeat(6000) }, { publicData: true, consentCurrent: () => consent });
  await entered.promise; consent = false; gate.resolve();
  assert.equal(await work, false); assert.equal(posts.length, 1);
  const outcome = events.find(event => event.type === 'relay_publish_result');
  assert.equal(outcome.outcome, 'partial'); assert.equal(outcome.acknowledged, 1);
  assert.equal(node.admission.state.spent.requests, outcome.planned);
});

test('generation change before async digest dispatch sends no frames and spends no batch budget', async t => {
  const posts = [], gate = deferred(), entered = deferred(), original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  t.mock.method(globalThis, 'fetch', async (_, options) => { posts.push(options.body); return { ok: true, status: 200 }; });
  const node = new WebRtcTransportNode({ peerId: 'writer' });
  assert.equal(node.sendSignal({ kind: 'offer', sdp: { sdp: 'x'.repeat(6000) } }), true);
  const work = drain(node); await entered.promise;
  node.close(); gate.resolve(); await work;
  assert.equal(posts.length, 0); assert.equal(node.admission.state.spent.requests, 0); assert.equal(node.relayPending.size, 0);
});

test('in-flight outbound work is bounded before asynchronous framing allocates more work', async t => {
  const gate = deferred(), original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => { await gate.promise; return original(...args); });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
  const node = new WebRtcTransportNode({ peerId: 'writer' });
  for (let index = 0; index < RELAY_LIMITS.entries; index++) assert.equal(node.sendSignal({ kind: 'announce', index }), true);
  assert.equal(node.sendSignal({ kind: 'announce', index: 999 }), false);
  assert.equal(node.relayPending.size, RELAY_LIMITS.entries);
  node.close(); gate.resolve(); await drain(node);
  assert.equal(node.relayPending.size, 0);
});

test('warm polling is single-flight, never follows attachments, drops incomplete data, and permits later complete recovery', async t => {
  const gate = deferred(), entered = deferred(), encoded = await frame({ data: 'x'.repeat(6000) }, { createdAtMs: Date.now() });
  let calls = 0, complete = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; entered.resolve(); await gate.promise;
    const frames = complete ? encoded.frames : encoded.frames.slice(0, 1);
    return new Response([{ event: 'message', message: 'old attachment', attachment: { url: 'https://never.invalid' } },
      ...frames.map(message => ({ event: 'message', message }))].map(item => JSON.stringify(item)).join('\n'));
  });
  const node = new WebRtcTransportNode({ peerId: 'reader', channelKey: 'mesh' });
  t.after(() => node.close());
  const work = node.fetchWarmEnvelopes('30m', { publicData: true }); await entered.promise;
  assert.deepEqual(await node.fetchWarmEnvelopes('30m', { publicData: true }), []);
  assert.equal(calls, 1); gate.resolve(); assert.deepEqual(await work, []);
  complete = true;
  const recovered = await node.fetchWarmEnvelopes('30m', { publicData: true });
  assert.equal(recovered.length, 1); assert.equal(recovered[0].data, 'x'.repeat(6000)); assert.equal(calls, 2);
});

test('expired/disposed verifications retain their bytes and shared admission until stalled digests settle', async t => {
  let monotonic = 0;
  const pool = new Map();
  const overhead = wireBytes({ from: 'remote', data: '' });
  const encoded = await frame({ data: 'x'.repeat(RELAY_LIMITS.messageBytes - overhead) });
  const receiver = assembler({ clock: () => monotonic, verificationPool: pool });
  const next = assembler({ clock: () => monotonic, verificationPool: pool });
  await Promise.all([receiver.channel, next.channel]);
  const gate = deferred(), original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => { await gate.promise; return original(...args); });
  const pending = [];
  for (let index = 0; index < RELAY_LIMITS.retainedBytes / RELAY_LIMITS.messageBytes; index++) {
    const s = index.toString(16).padStart(32, '0');
    for (let chunk = 0; chunk < encoded.frames.length - 1; chunk++) await receiver.accept(alter(encoded.frames[chunk], { s }));
    pending.push(receiver.accept(alter(encoded.frames.at(-1), { s })));
    // Reach the actual SHA await before admitting another complete message.
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(pool.size, 4); assert.equal(receiver.state.retainedBytes, RELAY_LIMITS.retainedBytes);
  monotonic = RELAY_LIMITS.assemblyAge;
  assert.equal(receiver.state.retainedBytes, RELAY_LIMITS.retainedBytes);
  receiver.dispose();
  assert.equal(receiver.state.retainedBytes, RELAY_LIMITS.retainedBytes);
  await assert.rejects(next.accept(alter(encoded.frames[0], { s: 'f'.repeat(32) })), code('relay-reassembly-capacity'));
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), [null, null, null, null]);
  assert.equal(pool.size, 0); assert.equal(receiver.state.retainedBytes, 0);
  assert.equal(await next.accept(alter(encoded.frames[0], { s: 'f'.repeat(32) })), null);
  next.dispose();
});

test('entire128KiB live object range survives framed relay without a contrived2048-byte cap', async t => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options?.method === 'POST') {
      const size = wireBytes(options.body);
      // Model ntfy's documented long-body attachment conversion to catch regressions.
      posts.push(size <= 4096 ? { event: 'message', message: options.body } : { event: 'message', message: 'attachment', attachment: { url: 'https://unused.invalid' } });
      return { ok: true, status: 200 };
    }
    return new Response([...posts.slice().reverse(), posts[0]].map(item => JSON.stringify(item)).join('\n'));
  });
  const sender = new WebRtcTransportNode({ peerId: 'writer', channelKey: 'mesh' });
  const receiver = new WebRtcTransportNode({ peerId: 'reader', channelKey: 'mesh' });
  t.after(() => { sender.close(); receiver.close(); });
  const writer = new LiveUorMeshDatabase({ transport: sender });
  const bytes = new Uint8Array(128 * 1024).fill(255);
  const stored = await writer.put(bytes, { persistWarm: true, publicData: true });
  const { fragments } = await createObject(bytes);
  const packet = writer._packet(stored, 0, fragments[0].bytes, { purpose: 'public-relay', holder: 'public-relay' });
  assert.ok(wireBytes({ ...packet, from: sender.peerId, tsMs: Date.now() }) > 4096);
  assert.equal(stored.warmPublished, 2); assert.ok(posts.length >= 4);
  assert.ok(posts.every(item => !item.attachment && wireBytes(item.message) <= 4096));
  await writer.clearLocal();
  const reader = new LiveUorMeshDatabase({ transport: receiver });
  assert.equal(await reader.syncFromNetwork('30m', { publicData: true }), 1);
  assert.deepEqual(reader.get(stored.addressHex).bytes, bytes);
  assert.equal(reader.get(stored.addressHex).entry.manifest.manifestDigest, stored.manifest.manifestDigest);
});
