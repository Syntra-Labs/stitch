import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRtcTransportNode, ExperimentTrialLogger } from '../src/layer5-transport/index.js';
import { c1SampleQualified } from '../src/layer1-uor/effects.js';
function fixture(t, candidateType = 'host') {
  let now = 0, timer = 1;
  const timers = new Map(), events = [], sent = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { const id = timer++; timers.set(id, { fn, delay }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'setInterval', () => 1000);
  t.mock.method(globalThis, 'clearInterval', () => {});
  class Channel { ordered = true; readyState = 'open'; send(raw) { sent.push(JSON.parse(raw)); } close() { this.readyState = 'closed'; } }
  class Peer {
    connectionState = 'new';
    createDataChannel() { return new Channel(); }
    close() {}
    async getStats() { return new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { type: 'local-candidate', candidateType: 'host' }],
      ['remote', { type: 'remote-candidate', candidateType }]
    ]); }
  }
  const before = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: Peer, configurable: true });
  t.after(() => before ? Object.defineProperty(globalThis, 'RTCPeerConnection', before) : delete globalThis.RTCPeerConnection);
  const logger = new ExperimentTrialLogger(), node = new WebRtcTransportNode({ peerId: 'local', trialLogger: logger, onEvent: event => events.push(event) });
  const entry = node.getOrCreatePeer('remote', true); entry.dc.onopen();
  t.after(() => node.close());
  return { node, entry, logger, events, sent, timers,
    at(value) { now = value; },
    probe(sequence, changes = {}) {
      const ping = { type: 'ping', seq: sequence, sentAtMs: 123000 + sequence, from: 'local' };
      node.sendToPeer('remote', ping);
      node.handleDataMessage('remote', { ...ping, type: 'pong', from: 'remote', ...changes });
    },
    deadline() { for (const item of [...timers.values()]) if (item.delay === 10000) item.fn(); }
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('C1 source/runtime count only issued exact ordered probe echoes, not pings, duplicates or out-of-order responses', async t => {
  const f = fixture(t);
  for (let seq = 1; seq <= 12; seq++) {
    f.node.handleDataMessage('remote', { type: 'pong', seq, sentAtMs: 1, from: 'remote' });
    f.node.handleDataMessage('remote', { type: 'ping', seq, sentAtMs: 1, from: 'remote' });
  }
  assert.equal(f.entry.heartbeatsPassed, 0);
  f.at(100); f.probe(1); assert.equal(f.entry.heartbeatsPassed, 1);
  f.node.handleDataMessage('remote', { type: 'pong', seq: 1, sentAtMs: 123001, from: 'remote' });
  assert.equal(f.entry.heartbeatsPassed, 1);
  f.at(200); f.probe(3); assert.equal(f.entry.heartbeatsPassed, 1, 'sequence gap resets consecutive run');
  f.at(300); f.probe(4); assert.equal(f.entry.heartbeatsPassed, 2);
  f.at(400); f.probe(2); assert.equal(f.entry.heartbeatsPassed, 2, 'late old sequence cannot complete another heartbeat');
  f.at(500); f.probe(5, { from: 'someone-else' }); assert.equal(f.entry.heartbeatsPassed, 2);
  f.at(600); f.probe(6, { sentAtMs: 7 }); assert.equal(f.entry.heartbeatsPassed, 2);
  assert.equal(f.logger.entries.length, 0);
});

test('ten consecutive correlated heartbeats inside the frozen window require selected direct path evidence', async t => {
  const f = fixture(t);
  for (let sequence = 1; sequence <= 10; sequence++) { f.at(sequence * 900); f.probe(sequence); }
  await settle();
  assert.equal(f.logger.entries.length, 1);
  const sample = f.logger.entries[0];
  assert.equal(sample.contract_version, '1.1.0'); assert.equal(sample.success, true);
  assert.equal(sample.connection_qualified, true); assert.equal(sample.selected_path_observed, true);
  assert.equal(sample.qualification_elapsed_sec, 9); assert.equal(sample.heartbeats_passed, 10);
  assert.equal(f.node.lifecycle.canSend, true);
});

for (const mode of ['remote-relay', 'missing-stats', 'unordered']) test(`C1 does not fabricate direct success for ${mode}`, async t => {
  const f = fixture(t, mode === 'remote-relay' ? 'relay' : 'host');
  if (mode === 'missing-stats') f.entry.pc.getStats = async () => { throw Error('unsupported'); };
  if (mode === 'unordered') f.entry.dc.ordered = false;
  for (let sequence = 1; sequence <= 10; sequence++) { f.at(sequence * 800); f.probe(sequence); }
  await settle();
  if (mode === 'unordered') { f.at(10000); f.deadline(); }
  assert.equal(f.logger.entries.length, 1); assert.equal(f.logger.entries[0].success, false);
  assert.equal(f.node.lifecycle.canSend, true, 'measurement does not gate transport');
  if (mode === 'remote-relay') assert.equal(f.logger.entries[0].used_turn, true);
});

test('frozen10s deadline records failure without increasing default5s traffic or closing the channel', t => {
  const f = fixture(t); assert.equal(f.node.heartbeatIntervalMs, 5000);
  f.at(5000); f.probe(1); f.at(10000); f.probe(2); f.deadline();
  assert.equal(f.logger.entries[0].success, false);
  assert.equal(f.logger.entries[0].heartbeats_passed, 2);
  assert.equal(f.entry.dc.readyState, 'open'); assert.equal(f.node.lifecycle.canSend, true);
  f.at(10001); f.probe(3); assert.equal(f.entry.heartbeatsPassed, 2);
  assert.equal(f.logger.entries.length, 1);
});

test('C1 summary refuses success booleans without coherent ordered/sequence/time/path evidence', () => {
  const sample = { success: true, network_pair_class: 'declared', used_turn: false, selected_path_observed: true,
    ordered_channel: true, heartbeats_passed: 10, ice_setup_sec: 1, qualification_elapsed_sec: 9 };
  assert.equal(c1SampleQualified(sample), true);
  for (const changes of [{ heartbeats_passed: 9 }, { ordered_channel: false }, { selected_path_observed: false }, { used_turn: true },
    { qualification_elapsed_sec: 10.1 }, { ice_setup_sec: 50, qualification_elapsed_sec: 1 }, { ice_setup_sec: 10, qualification_elapsed_sec: 9 }, { heartbeats_passed: undefined }]) assert.equal(c1SampleQualified({ ...sample, ...changes }), false, JSON.stringify(changes));
  const logger = new ExperimentTrialLogger();
  for (let index = 0; index < 30; index++) logger.logTrial('C1', { success: true, network_pair_class: 'declared', used_turn: false, ice_setup_sec: 1 });
  assert.equal(logger.summarizeC1('declared').direct_success_rate, 0);
  assert.equal(logger.summarizeC1('declared').c1_status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(logger.summarizeC1('declared').invalid_samples, 30);
});
