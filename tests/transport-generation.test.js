import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRtcTransportNode } from '../src/layer5-transport/index.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const effects = [], events = [];
  class Channel {
    readyState = 'open';
    close() { this.readyState = 'closed'; this.onclose?.(); }
    send(value) { effects.push(['data', value]); }
  }
  class Peer {
    connectionState = 'new';
    signalingState = 'stable';
    calls = [];
    createDataChannel() { return new Channel(); }
    async createOffer() { this.calls.push('offer'); return {}; }
    async createAnswer() { this.calls.push('answer'); return {}; }
    async setLocalDescription(value) { this.calls.push('local'); this.localDescription = value; }
    async setRemoteDescription(value) { this.calls.push('remote'); this.remoteDescription = value; }
    close() { this.connectionState = 'closed'; this.iceConnectionState = 'closed'; this.oniceconnectionstatechange?.(); }
  }
  class SignalSocket {
    constructor(url) { this.url = url; effects.push(['socket', url]); }
    close() {}
  }
  class Broadcast {
    constructor(topic) { this.topic = topic; }
    postMessage(frame) { effects.push(['signal', frame]); }
    close() {}
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => { effects.push(['fetch', url, options]); return { ok: true }; });
  for (const [name, value] of Object.entries({ RTCPeerConnection: Peer, RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } }, WebSocket: SignalSocket, BroadcastChannel: Broadcast })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  const node = new WebRtcTransportNode({ peerId: 'local', channelKey: 'old', onEvent: ev => events.push(ev) });
  // These tests isolate lifecycle continuations after authentication. The real
  // wire boundary is exercised separately in authenticated-signaling.test.js.
  const authenticateFixture = () => {
    t.mock.method(node.signaling, 'receive', async (message, consume) => {
      const authenticated = { message };
      await consume(authenticated);
      return authenticated;
    });
    t.mock.method(node.signaling, 'sign', async payload => ({ ...payload, from: node.peerId, channelKey: node.channelKey }));
  };
  authenticateFixture();
  const connect = node.connect.bind(node);
  t.mock.method(node, 'connect', (...args) => { connect(...args); authenticateFixture(); });
  t.after(() => node.close());
  return { node, effects, events, Channel };
}

test('wrong or absent channel signals cannot create peers or spend admission', async t => {
  const { node, effects } = fixture(t);
  const before = node.admission.state;
  for (const channelKey of ['elsewhere', undefined]) await node.handleSignal({ kind: 'announce', from: 'remote', channelKey });
  assert.equal(node.peers.size, 0);
  assert.deepEqual(node.admission.state, before);
  assert.deepEqual(effects, []);
});

for (const phase of ['offer', 'local', 'remote', 'answer', 'answer-local']) {
  test(`mesh switch invalidates pending ${phase} continuation before further effects`, async t => {
    const { node, effects } = fixture(t);
    const entry = node.getOrCreatePeer('remote');
    const gate = deferred(), entered = deferred();
    const method = { offer: 'createOffer', local: 'setLocalDescription', remote: 'setRemoteDescription', answer: 'createAnswer', 'answer-local': 'setLocalDescription' }[phase];
    entry.pc[method] = async () => { entered.resolve(); await gate.promise; return {}; };
    const work = node.handleSignal({ kind: ['remote', 'answer', 'answer-local'].includes(phase) ? 'offer' : 'announce', from: 'remote', channelKey: 'old', sdp: {} });
    await entered.promise;
    node.connect('new');
    const calls = [...entry.pc.calls], observed = effects.length, budget = node.admission.state;
    gate.resolve(); await work;
    assert.deepEqual(entry.pc.calls, calls);
    assert.equal(effects.length, observed);
    assert.deepEqual(node.admission.state, budget);
    assert.equal(node.peers.size, 0);
  });
}

test('late callbacks from old sockets and data channels have no current-session effects', async t => {
  const { node, effects, events } = fixture(t);
  node.connect('old');
  const ws = node.ws, bc = node.bc, entry = node.getOrCreatePeer('remote', true), dc = entry.dc;
  node.connect('new');
  const fresh = node.getOrCreatePeer('remote', true);
  const baseline = { effects: effects.length, events: events.length, budget: node.admission.state };
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ event: 'message', message: JSON.stringify({ kind: 'announce', from: 'stranger', channelKey: 'old' }) }) });
  bc.onmessage({ data: { kind: 'announce', from: 'stranger', channelKey: 'old' } });
  entry.pc.onicecandidate({ candidate: { candidate: 'old candidate' } });
  entry.pc.oniceconnectionstatechange();
  dc.onopen(); dc.onclose(); dc.onmessage({ data: JSON.stringify({ type: 'ping' }) });
  await Promise.resolve();
  assert.equal(node.peers.get('remote'), fresh);
  assert.equal(node.hbTimer, null);
  assert.equal(effects.length, baseline.effects);
  assert.equal(events.length, baseline.events);
  assert.deepEqual(node.admission.state, baseline.budget);
});

test('replacing a peer within the same session fences its callbacks and pending offer', async t => {
  const { node, effects, Channel } = fixture(t);
  const old = node.getOrCreatePeer('remote', true), gate = deferred();
  old.pc.createOffer = () => gate.promise;
  // Do not let the open fake channel short-circuit the signal path.
  old.dc.readyState = 'connecting';
  const work = node.handleSignal({ kind: 'announce', from: 'remote', channelKey: 'old' });
  old.pc.connectionState = 'failed';
  const replacement = node.getOrCreatePeer('remote', true);
  const baseline = effects.length;
  old.dc.onclose(); old.pc.iceConnectionState = 'failed'; old.pc.oniceconnectionstatechange();
  const orphan = new Channel(); old.pc.ondatachannel({ channel: orphan });
  gate.resolve({}); await work;
  assert.equal(orphan.readyState, 'closed');
  assert.equal(node.peers.get('remote'), replacement);
  assert.deepEqual(old.pc.calls, []);
  assert.equal(effects.length, baseline);
});

test('close invalidates pending work and same-topic reconnect starts a fresh session', async t => {
  const { node, effects } = fixture(t);
  const old = node.getOrCreatePeer('remote'), gate = deferred();
  old.pc.createOffer = () => gate.promise;
  const work = node.handleSignal({ kind: 'announce', from: 'remote', channelKey: 'old' });
  node.close();
  const baseline = effects.length, budget = node.admission.state;
  assert.equal(node.sendSignal({ kind: 'announce' }), false);
  await node.handleSignal({ kind: 'announce', from: 'other', channelKey: 'old' });
  gate.resolve({}); await work;
  assert.equal(effects.length, baseline);
  assert.deepEqual(node.admission.state, budget);
  node.connect('old');
  await node.handleSignal({ kind: 'announce', from: 'remote', channelKey: 'old' });
  assert.notEqual(node.peers.get('remote'), old);
  await Promise.all([...node.signalSigning.values(), ...node.relayPending.values()].map(job => job.completion));
  assert.ok(effects.some(([type, frame]) => type === 'signal' && frame.kind === 'offer' && frame.channelKey === 'old'));
});


test('superseded data channel cannot delete its replacement or deliver frames', t => {
  const { node, Channel, events } = fixture(t);
  const entry = node.getOrCreatePeer('remote', true), old = entry.dc;
  const replacement = new Channel(); node.bindDataChannel('remote', replacement);
  const before = events.length;
  old.onclose(); old.onopen(); old.onmessage({ data: JSON.stringify({ type: 'eth_frame', frame: [1] }) });
  assert.equal(node.peers.get('remote'), entry);
  assert.equal(entry.dc, replacement);
  assert.equal(events.length, before);
  assert.equal(node.hbTimer, null);
});

test('already queued old heartbeat cannot broadcast after reconnect', t => {
  const { node, effects } = fixture(t);
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 123; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  node.startHeartbeat();
  node.connect('new');
  const before = effects.length, budget = node.admission.state;
  tick();
  assert.equal(effects.length, before);
  assert.deepEqual(node.admission.state, budget);
});

test('malformed Unicode identities refuse before invalidating a live signaling session', async t => {
  const { node, effects } = fixture(t);
  node.connect('valid-😀-é');
  const before = effects.length, budget = node.admission.state, generation = node.generation;
  for (const invalid of ['\ud800', '\ud801']) assert.throws(() => node.connect(invalid), error => error.code === 'InvalidCanonicalValue');
  assert.equal(node.channelKey, 'valid-😀-é');
  assert.equal(node.generation, generation); assert.equal(node.closed, false);
  await node.handleSignal({ kind: 'announce', from: '\ud800', channelKey: node.channelKey });
  assert.equal(node.peers.size, 0); assert.equal(effects.length, before); assert.deepEqual(node.admission.state, budget);
  assert.throws(() => new WebRtcTransportNode({ peerId: '\ud800' }), error => error.code === 'InvalidCanonicalValue');
});


test('invalid local identity types refuse before invalidating a live signaling session', t => {
  const { node } = fixture(t); node.connect('current');
  const generation = node.generation;
  assert.throws(() => node.connect(123), TypeError);
  assert.equal(node.generation, generation);
  assert.equal(node.channelKey, 'current');
  assert.equal(node.closed, false);
  assert.throws(() => new WebRtcTransportNode({ peerId: 123 }), TypeError);
});

test('bounded application channel parsing discards duplicate-key and malformed Unicode payloads', t => {
  const { node, events } = fixture(t), channel = node.getOrCreatePeer('remote', true).dc;
  const count = events.length;
  channel.onmessage({ data: '{"type":"ping","type":"uor_shard","manifest":{}}' });
  channel.onmessage({ data: '{"type":"uor_shard","label":"\\ud800"}' });
  assert.equal(events.length, count);
  channel.onmessage({ data: '{"type":"eth_frame","frame":[1]}' });
  assert.equal(events.at(-1).type, 'mesh_message');
});

for (const state of ['disconnected', 'failed', 'closed', 'channel-close']) {
  test(`terminal ${state} closes and releases the removed RTC connection exactly once`, t => {
    const { node } = fixture(t), entry = node.getOrCreatePeer('remote', true);
    const close = t.mock.method(entry.pc, 'close', entry.pc.close.bind(entry.pc));
    entry.pendingHeartbeats.set(1, {});
    if (state === 'channel-close') entry.dc.close();
    else { entry.pc.iceConnectionState = state; entry.pc.oniceconnectionstatechange(); }
    assert.equal(node.peers.size, 0);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(entry.c1Deadline, null);
    assert.equal(entry.statsDeadline, null);
    assert.equal(entry.pendingHeartbeats.size, 0);
    node.close(); assert.equal(close.mock.callCount(), 1);
  });
}

test('replacement closes old RTC after fencing synchronous and late callbacks', t => {
  const { node, events } = fixture(t), old = node.getOrCreatePeer('remote', true);
  const close = t.mock.method(old.pc, 'close', old.pc.close.bind(old.pc));
  old.pc.connectionState = 'failed';
  const fresh = node.getOrCreatePeer('remote', true);
  assert.notEqual(fresh, old);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(node.peers.get('remote'), fresh);
  const before = events.length;
  old.dc.onclose(); old.pc.oniceconnectionstatechange();
  assert.equal(node.peers.get('remote'), fresh);
  assert.equal(events.length, before);
  assert.equal(fresh.pc.connectionState, 'new');
});

test('reentrant disposal observer replacement is retained rather than overwritten or closed', t => {
  const { node } = fixture(t), old = node.getOrCreatePeer('remote', true);
  let replacement;
  node.onEvent = event => {
    if (event.type === 'channel_send_result' && event.outcome === 'closed' && !replacement) {
      replacement = node.getOrCreatePeer('remote', true);
    }
  };
  old.pc.connectionState = 'failed';
  const actual = node.getOrCreatePeer('remote', true);
  assert.ok(replacement);
  assert.equal(actual, replacement);
  assert.equal(node.peers.get('remote'), replacement);
  assert.equal(old.pc.connectionState, 'closed');
  assert.equal(replacement.pc.connectionState, 'new');
});

test('transport cleanup cannot close provider handles installed by a reentrant reconnect', t => {
  const { node } = fixture(t);
  node.connect('old');
  const old = node.getOrCreatePeer('remote', true);
  let freshSocketClose, freshBroadcastClose;
  node.onEvent = event => {
    if (event.type !== 'channel_send_result' || event.outcome !== 'closed' || freshSocketClose) return;
    node.connect('new');
    freshSocketClose = t.mock.method(node.ws, 'close', node.ws.close.bind(node.ws));
    freshBroadcastClose = t.mock.method(node.bc, 'close', node.bc.close.bind(node.bc));
  };
  node.close();
  assert.equal(old.pc.connectionState, 'closed');
  assert.equal(node.channelKey, 'new');
  assert.equal(node.closed, false);
  assert.equal(freshSocketClose.mock.callCount(), 0);
  assert.equal(freshBroadcastClose.mock.callCount(), 0);
});

test('throwing event observer does not interrupt closing other peers or captured providers', t => {
  const { node } = fixture(t);
  node.connect('old');
  const entries = ['first', 'second'].map(id => node.getOrCreatePeer(id, true));
  const closes = entries.map(entry => t.mock.method(entry.pc, 'close', entry.pc.close.bind(entry.pc)));
  const socketClose = t.mock.method(node.ws, 'close', node.ws.close.bind(node.ws));
  const broadcastClose = t.mock.method(node.bc, 'close', node.bc.close.bind(node.bc));
  node.onEvent = () => { throw new Error('observer failed'); };
  assert.doesNotThrow(() => node.close());
  assert.equal(node.peers.size, 0);
  for (const close of closes) assert.equal(close.mock.callCount(), 1);
  assert.equal(socketClose.mock.callCount(), 1);
  assert.equal(broadcastClose.mock.callCount(), 1);
});
