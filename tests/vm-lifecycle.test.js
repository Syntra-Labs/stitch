import test from 'node:test';
import assert from 'node:assert/strict';
import { LinuxVmNode } from '../src/layer4-compute/index.js';

function fixture(t) {
  const statuses = [], sent = [], instances = [], intervals = new Map(), deadlines = new Map();
  let next = 1, prompt = '';
  for (const name of ['V86', 'V86Starter']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  t.mock.method(globalThis, 'setInterval', fn => { const id = next++; intervals.set(id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', id => intervals.delete(id));
  t.mock.method(globalThis, 'setTimeout', fn => { const id = next++; deadlines.set(id, fn); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => deadlines.delete(id));
  class FakeVm {
    listeners = new Map(); commands = []; files = []; destroyed = 0;
    constructor() { instances.push(this); }
    add_listener(name, callback) { this.listeners.set(name, callback); }
    keyboard_send_text(command) { this.commands.push(command); }
    destroy() { this.destroyed++; this.listeners.get('net0-send')?.([99]); }
    async create_file(name) { this.files.push(name); }
    async read_file() { return null; }
  }
  globalThis.V86 = FakeVm;
  const node = new LinuxVmNode({ transport: { peerId: 'test-1234', broadcast: frame => sent.push(frame) },
    screenContainer: { querySelectorAll: () => [{ innerText: prompt }] },
    onStatus: status => statuses.push(status), bootTimeoutMs: 1000 });
  return { node, statuses, sent, instances, intervals, deadlines, FakeVm,
    poll: () => [...intervals.values()].forEach(fn => fn()),
    expire: () => [...deadlines.values()].forEach(fn => fn()),
    ready: () => { prompt = 'root:~# '; } };
}

test('missing and throwing constructors report failure and allow explicit retry', t => {
  const f = fixture(t);
  globalThis.V86 = undefined;
  f.node.boot();
  assert.equal(f.node.booting, false); assert.equal(f.node.v86, null);
  assert.match(f.statuses.at(-1).message, /not loaded/);
  globalThis.V86 = class { constructor() { throw Error('constructor failed'); } };
  f.node.boot();
  assert.equal(f.node.booting, false); assert.equal(f.node.v86, null);
  assert.match(f.statuses.at(-1).message, /constructor failed/);
  globalThis.V86 = f.FakeVm;
  f.node.boot(); f.node.boot();
  assert.equal(f.instances.length, 1);
  f.ready(); f.poll();
  assert.equal(f.node.booted, true); assert.equal(f.node.booting, false);
  assert.equal(f.statuses.at(-1).state, 'online');
  assert.equal(f.intervals.size, 0); assert.equal(f.deadlines.size, 0);
});

test('boot deadline cleans up and stale listeners cannot affect retry', t => {
  const f = fixture(t); f.node.boot();
  const old = f.node.v86, stalePoll = [...f.intervals.values()][0], staleDeadline = [...f.deadlines.values()][0];
  f.expire();
  assert.equal(old.destroyed, 1); assert.equal(f.node.v86, null);
  assert.equal(f.node.booting, false); assert.equal(f.node.booted, false);
  assert.equal(f.intervals.size, 0); assert.equal(f.deadlines.size, 0);
  assert.equal(f.sent.length, 0);
  f.node.boot(); const fresh = f.node.v86, count = f.statuses.length;
  f.ready(); stalePoll(); staleDeadline(); old.listeners.get('download-error')(); old.listeners.get('net0-send')([1]);
  assert.equal(f.node.v86, fresh); assert.equal(f.node.booting, true);
  assert.equal(f.statuses.length, count); assert.equal(f.sent.length, 0);
  f.poll(); assert.equal(f.node.booted, true);
  fresh.listeners.get('net0-send')([2]); assert.equal(f.sent.length, 1);
});

test('download and readiness errors reset boot; cleanup errors cannot wedge retry', async t => {
  const f = fixture(t); f.node.boot();
  f.node.v86.destroy = () => Promise.reject(Error('not initialized'));
  f.node.v86.listeners.get('download-error')();
  await Promise.resolve();
  assert.equal(f.node.v86, null); assert.equal(f.node.booting, false);
  assert.match(f.statuses.at(-1).message, /download failed/);
  f.node.boot(); f.node.v86.keyboard_send_text = () => { throw Error('guest unavailable'); };
  f.ready(); f.poll();
  assert.equal(f.node.v86, null); assert.equal(f.node.booting, false);
  assert.match(f.statuses.at(-1).message, /guest unavailable/);
});

test('late object mirror cannot write into a replacement VM or report success', async t => {
  const f = fixture(t); f.node.boot();
  let resume;
  f.node.v86.create_file = () => new Promise(r => { resume = r; });
  const pending = f.node.mountUorObject('sha256:' + '1'.repeat(64), new Uint8Array([1]), 'label');
  f.expire(); f.node.boot();
  resume();
  assert.equal(await pending, false);
  assert.deepEqual(f.node.v86.files, []);
});

test('command timeout reports unknown completion rather than cancellation', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  await assert.rejects(f.node.executeShellCommand('echo hello', 0), /completion is unknown.*not cancelled/);
  assert.equal(f.node.booted, true);
  assert.equal(f.node.v86.commands.length, 2);
});

test('boot timeout configuration must be finite, positive and schedulable', t => {
  fixture(t);
  for (const bootTimeoutMs of [0, -1, Infinity, NaN, 2147483648]) {
    assert.throws(() => new LinuxVmNode({ bootTimeoutMs }), /Invalid VM boot timeout/);
  }
});

test('VM object filenames preserve the complete root and label aliases cannot collide across content', async t => {
  const f = fixture(t); f.node.boot();
  const first = 'sha256:' + 'abcde' + '1'.repeat(59), second = 'sha256:' + 'abcde' + '2'.repeat(59);
  assert.equal(await f.node.mountUorObject(first, Uint8Array.of(1), '../same/label'), true);
  assert.equal(await f.node.mountUorObject(second, Uint8Array.of(2), '.._same_label'), true);
  const files = f.node.v86.files;
  assert.equal(files.length, 4); assert.equal(new Set(files).size, 4);
  assert.ok(files[0].includes(first.slice(7))); assert.ok(files[2].includes(second.slice(7)));
  assert.ok(files[1].includes(first.slice(7))); assert.ok(files[3].includes(second.slice(7)));
  for (const filename of files) { assert.equal(filename.includes('/'), false); assert.ok(filename.length < 255); }
  assert.equal(await f.node.mountUorObject('sha256:abcde', Uint8Array.of(3)), false);
  assert.equal(f.node.v86.files.length, 4);
});

test('VM mirror snapshots bytes before asynchronous canonical and label writes', async t => {
  const f = fixture(t); f.node.boot(); let resume; const writes = [];
  f.node.v86.create_file = async (name, data) => { writes.push({ name, data: data.slice() }); if (writes.length === 1) await new Promise(resolve => { resume = resolve; }); };
  const bytes = Uint8Array.of(1, 2), pending = f.node.mountUorObject('sha256:' + 'a'.repeat(64), bytes, 'label');
  bytes.fill(99); resume();
  assert.equal(await pending, true);
  assert.deepEqual(writes.map(write => Array.from(write.data)), [[1, 2], [1, 2]]);
});
