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
