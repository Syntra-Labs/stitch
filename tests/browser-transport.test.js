import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRtcTransportNode } from '../src/layer5-transport/index.js';

function replace(t, name, value) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  t.after(() => prior ? Object.defineProperty(globalThis, name, prior) : delete globalThis[name]);
}

test('explicit local-only ICE and caller configuration are snapshotted before browser allocation', t => {
  const seen = [];
  replace(t, 'RTCPeerConnection', class {
    constructor(config) { seen.push(config); }
    close() {}
  });
  const input = [{ urls: ['turn:example.test:3478'], username: 'scoped-user', credential: 'test-only' }];
  const node = new WebRtcTransportNode({ iceServers: input });
  t.after(() => node.close());
  input[0].urls[0] = 'stun:changed.test'; input[0].credential = 'changed'; input.push({ urls: 'stun:new.test' });
  node.getOrCreatePeer('remote');
  assert.deepEqual(seen[0], { iceServers: [{ urls: ['turn:example.test:3478'], username: 'scoped-user', credential: 'test-only' }] });
  const local = new WebRtcTransportNode({ iceServers: [] });
  t.after(() => local.close()); local.getOrCreatePeer('remote');
  assert.deepEqual(seen[1], { iceServers: [] });
});

test('malformed or excessive ICE configuration refuses before allocating peers', t => {
  let calls = 0;
  replace(t, 'RTCPeerConnection', class { constructor() { calls++; } });
  for (const iceServers of [{}, [{}], [{ urls: [] }], [{ urls: 'https://example.test' }],
    [{ urls: 'stun:with space' }], [{ urls: 'stun:example.test', credential: {} }],
    [{ urls: 'stun:example.test', unsupported: true }], Array(17).fill({ urls: 'stun:example.test' })]) {
    assert.throws(() => new WebRtcTransportNode({ iceServers }), /Invalid ICE server configuration/);
  }
  assert.equal(calls, 0);
});

test('same-origin discovery announces without waiting for an unavailable public signaling socket', async t => {
  const frames = [], sockets = [];
  replace(t, 'BroadcastChannel', class {
    postMessage(value) { frames.push(value); }
    close() {}
  });
  replace(t, 'WebSocket', class {
    constructor() { sockets.push(this); }
    close() {}
  });
  t.mock.method(globalThis, 'fetch', async () => { throw Error('provider unreachable'); });
  const node = new WebRtcTransportNode({ iceServers: [] });
  t.after(() => node.close());
  node.connect();
  await node.signalTail;
  assert.equal(sockets.length, 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.kind, 'announce');
  assert.equal(frames[0].from, node.routingPeerId);
  assert.match(frames[0].signature, /^[A-Za-z0-9_-]+$/);
});

test('explicit local signaling mode cannot open provider sockets or POST, even while fetch exists', async t => {
  let sockets = 0, fetches = 0;
  const frames = [];
  replace(t, 'BroadcastChannel', class { postMessage(frame) { frames.push(frame); } close() {} });
  replace(t, 'WebSocket', class { constructor() { sockets++; } close() {} });
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw Error('No provider access allowed'); });
  const node = new WebRtcTransportNode({ iceServers: [], publicSignaling: false });
  t.after(() => node.close());
  node.connect(); await node.signalTail;
  assert.equal(sockets, 0); assert.equal(fetches, 0); assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.kind, 'announce');
});
