import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelFlow, CHANNEL_LIMITS, channelMaximum } from '../src/layer5-transport/channel-flow.js';
function fixture(t, maximum = 1024, options = {}) {
  const sent = [], messages = [], results = [], charges = [];
  const channel = { readyState: 'open', ordered: true, bufferedAmount: 0,
    send(data) { sent.push(data); this.bufferedAmount += typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength; },
    close() { this.readyState = 'closed'; } };
  const flow = new ChannelFlow({ channel, pc: { sctp: { maxMessageSize: maximum } },
    admission: { reserve(kind, values) { charges.push({ kind, ...values }); } },
    onMessage: value => messages.push(value), onResult: value => results.push(value), ...options });
  t.after(() => flow.dispose());
  return { flow, channel, sent, messages, results, charges };
}
test('negotiated size, UTF8 wire accounting and complete 128KiB object JSON roundtrip', t => {
  const sender = fixture(t, 1024), receiver = fixture(t, 1024);
  const value = { type: 'uor_shard', bytes: Array.from({ length: 128 * 1024 }, (_, i) => i % 256) };
  assert.equal(sender.flow.enqueue(value), true);
  assert.ok(sender.sent.length > 100);
  assert.ok(sender.sent.every(frame => frame.byteLength <= 1024));
  for (const frame of sender.sent) receiver.flow.receive(frame);
  assert.equal(JSON.stringify(receiver.messages), JSON.stringify([value]));
  assert.equal(receiver.flow.state.receiving, 0);
  assert.equal(sender.charges[0].transferBytes, sender.sent.reduce((n, f) => n + f.byteLength, 0));
  assert.equal(sender.results[0].outcome, 'submitted');
  assert.equal(sender.results[0].delivered, false);
});
test('zero/unbounded negotiation, absent default, small limit and malformed negotiation', t => {
  for (const value of [0, Infinity, undefined]) assert.equal(channelMaximum({ sctp: { maxMessageSize: value } }), 65536);
  const { flow } = fixture(t, 16);
  assert.throws(() => flow.enqueue({ long: 'x'.repeat(40) }), e => e.code === 'channel-framing-size-unsupported');
  assert.equal(flow.enqueue({ x: 1 }), true);
  assert.throws(() => channelMaximum({ sctp: { maxMessageSize: -1 } }));
});
test('bufferedAmountLow resumes FIFO queue without growing browser buffer beyond budget', t => {
  const f = fixture(t, 1024); f.channel.bufferedAmount = CHANNEL_LIMITS.buffered;
  assert.equal(f.flow.enqueue({ text: 'é😀' }), true);
  assert.equal(f.flow.enqueue({ second: true }), true);
  assert.equal(f.sent.length, 0);
  f.channel.bufferedAmount = 0; f.channel.onbufferedamountlow();
  assert.deepEqual(f.sent.map(JSON.parse), [{ text: 'é😀' }, { second: true }]);
  assert.equal(f.flow.state.retained, 0);
  assert.equal(f.charges[0].transferBytes, new TextEncoder().encode(f.sent[0]).length);
});
test('queue exhaustion refuses synchronously and disposal releases aggregate reservations', t => {
  const pool = { queued: 0, messages: 0, receiving: 0, assemblies: 0 };
  const f = fixture(t, 65536, { pool }); f.channel.bufferedAmount = CHANNEL_LIMITS.buffered;
  for (let i = 0; i < 64; i++) f.flow.enqueue({ i });
  assert.throws(() => f.flow.enqueue({ overflow: true }), e => e.code === 'channel-queue-capacity');
  f.flow.dispose('generation-changed'); assert.equal(pool.queued, 0); assert.equal(pool.messages, 0);
  f.channel.bufferedAmount = 0; f.channel.onbufferedamountlow(); assert.equal(f.sent.length, 0);
  assert.equal(f.results.filter(x => x.outcome === 'cancelled').length, 64);
});
for (const failure of ['order', 'duplicate', 'corrupt', 'truncated', 'mixed']) test(`fragment ${failure} never exposes partial JSON`, t => {
  const s = fixture(t, 64), r = fixture(t, 64); s.flow.enqueue({ text: 'x'.repeat(1000) });
  if (failure === 'order') r.flow.receive(s.sent[1]);
  if (failure === 'duplicate') { r.flow.receive(s.sent[0]); r.flow.receive(s.sent[0]); }
  if (failure === 'corrupt') { const bad = s.sent.at(-1).slice(0); new Uint8Array(bad)[16] = 0xff; for (const f of [...s.sent.slice(0, -1), bad]) r.flow.receive(f); }
  if (failure === 'truncated') r.flow.receive(s.sent[0].slice(0, 14));
  if (failure === 'mixed') { r.flow.receive(s.sent[0]); r.flow.receive('{"other":true}'); }
  assert.deepEqual(r.messages, []); assert.equal(r.flow.state.disposed, true); assert.equal(r.flow.state.receiving, 0);
});
test('partial send failure and incomplete receive are classified, never replayed', t => {
  const s = fixture(t, 64), r = fixture(t, 64);
  const send = s.channel.send.bind(s.channel); let n = 0;
  s.channel.send = data => { if (++n === 3) throw Error('host failure'); send(data); };
  s.flow.enqueue({ text: 'x'.repeat(1000) });
  assert.equal(s.results.find(x => x.outcome === 'partial').frames, 2);
  r.flow.receive(s.sent[0]); r.flow.dispose('channel-closed');
  assert.ok(r.results.some(x => x.outcome === 'incomplete-receive'));
  assert.equal(r.flow.state.receiving, 0);
});
test('generation changes fence enqueue, buffered callbacks and incomplete receive', t => {
  let current = true;
  const s = fixture(t, 64, { current: () => current }), r = fixture(t, 64, { current: () => current });
  s.flow.enqueue({ text: 'x'.repeat(1000) }); r.flow.receive(s.sent[0]);
  s.channel.bufferedAmount = CHANNEL_LIMITS.buffered; s.flow.enqueue({ later: true });
  const count = s.sent.length; current = false;
  s.channel.bufferedAmount = 0; s.channel.onbufferedamountlow();
  for (const f of s.sent.slice(1)) r.flow.receive(f);
  assert.equal(s.sent.length, count); assert.deepEqual(r.messages, []);
  assert.equal(s.flow.enqueue({ stale: true }), false);
});
test('incomplete assembly expires and closes poisoned stream', t => {
  let now = 0, callback;
  t.mock.method(globalThis, 'setTimeout', fn => { callback = fn; return { unref() {} }; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const s = fixture(t, 64), r = fixture(t, 64, { clock: () => now });
  s.flow.enqueue({ text: 'x'.repeat(1000) }); r.flow.receive(s.sent[0]);
  now = CHANNEL_LIMITS.age; callback();
  assert.equal(r.channel.readyState, 'closed'); assert.equal(r.flow.state.receiving, 0);
});
test('binary frame replay after completion is refused and fresh flow starts at sequence one', t => {
  const s = fixture(t, 64), r = fixture(t, 64), fresh = fixture(t, 64);
  s.flow.enqueue({ text: 'x'.repeat(500) });
  for (const frame of s.sent) { r.flow.receive(frame); fresh.flow.receive(frame); }
  r.flow.receive(s.sent[0]);
  assert.equal(r.messages.length, 1); assert.equal(fresh.messages.length, 1); assert.equal(r.flow.state.disposed, true);
});
test('unreliable and unordered channels refuse sends explicitly', t => {
  const f = fixture(t, 64); f.channel.ordered = false;
  assert.throws(() => f.flow.enqueue({ test: 'x'.repeat(100) }), e => e.code === 'channel-framing-requires-reliable-ordered');
});
test('queued consent and resource epoch expiration fence deferred sends', t => {
  let consent = true, now = 1;
  const f = fixture(t), g = fixture(t, 1024, { admission: { reserve() {}, clock: () => now,
    get state() { return { lastObservedMs: 1, endMs: 10 }; } } });
  for (const x of [f, g]) x.channel.bufferedAmount = CHANNEL_LIMITS.buffered;
  f.flow.enqueue({ eth_frame: [1] }, { consentCurrent: () => consent });
  g.flow.enqueue({ test: true }); consent = false; now = 11;
  for (const x of [f, g]) { x.channel.bufferedAmount = 0; x.channel.onbufferedamountlow(); assert.equal(x.sent.length, 0); assert.equal(x.flow.state.disposed, true); }
});
test('legacy peer without framing protocol retains small JSON, rejects oversize precisely', t => {
  const f = fixture(t, 64); f.channel.protocol = '';
  assert.equal(f.flow.enqueue({ small: true }), true);
  assert.throws(() => f.flow.enqueue({ big: 'x'.repeat(1000) }), e => e.code === 'channel-peer-framing-unsupported');
});
test('multiple fragmented messages retain ordering across UTF8 chunk boundaries', t => {
  const s = fixture(t, 73), r = fixture(t, 73);
  const values = [{ text: '😀é'.repeat(400) }, { type: 'eth_frame', frame: Array.from({ length: 1500 }, (_, i) => i % 256) }, { last: true }];
  for (const v of values) s.flow.enqueue(v);
  for (const frame of s.sent) r.flow.receive(frame);
  assert.equal(JSON.stringify(r.messages), JSON.stringify(values));
});
test('retained byte ceiling spans peers, even below message count ceiling', t => {
  const pool = { queued: 0, messages: 0, receiving: 0, assemblies: 0 }, a = fixture(t, 65536, { pool }), b = fixture(t, 65536, { pool });
  a.channel.bufferedAmount = b.channel.bufferedAmount = CHANNEL_LIMITS.buffered;
  const value = { text: 'x'.repeat(500000) };
  for (const f of [a, b, a, b]) f.flow.enqueue(value);
  assert.throws(() => a.flow.enqueue(value), e => e.code === 'channel-queue-capacity');
  assert.equal(pool.messages, 4); a.flow.dispose(); b.flow.dispose(); assert.equal(pool.queued, 0);
});
