import test from 'node:test';
import assert from 'node:assert/strict';
import { filesystemFixture } from './helpers/vm-filesystem.js';
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
    listeners = new Map(); commands = []; files = []; destroyed = 0; stopped = 0; started = 0; fs9p = filesystemFixture();
    constructor(options) { this.options = options; instances.push(this); }
    run() { this.started++; }
    stop() { this.stopped++; }
    add_listener(name, callback) { this.listeners.set(name, callback); if (name === 'emulator-loaded') callback(); }
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
    expire: () => deadlines.get(node.bootDeadline)?.(),
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
  assert.equal(f.intervals.size, 0); assert.equal(f.deadlines.size, 1);
});

test('boot deadline cleans up and stale listeners cannot affect retry', t => {
  const f = fixture(t); f.node.boot();
  const old = f.node.v86, stalePoll = [...f.intervals.values()][0], staleDeadline = f.deadlines.get(f.node.bootDeadline);
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
  f.node.setEthernetSharing(true); fresh.listeners.get('net0-send')(new Uint8Array(14)); assert.equal(f.sent.length, 1);
});

test('download cleanup failure retains instance until explicit successful destroy', async t => {
  const f = fixture(t); f.node.boot();
  f.node.v86.destroy = () => Promise.reject(Error('not initialized'));
  f.node.v86.listeners.get('download-error')();
  await Promise.resolve();
  const retained = f.node.v86;
  assert.ok(retained); assert.equal(f.node.booting, false);
  assert.match(f.statuses.at(-1).message, /Cleanup outcome unknown/);
  f.node.boot(); assert.equal(f.node.v86, retained);
  retained.destroy = () => {}; await f.node.destroy();
  f.node.boot(); f.node.v86.keyboard_send_text = () => { throw Error('guest unavailable'); };
  f.ready(); f.poll();
  assert.equal(f.node.v86, null); assert.equal(f.node.booting, false);
  assert.match(f.statuses.at(-1).message, /guest unavailable/);
});

test('late object mirror cannot write into a replacement VM or report success', async t => {
  const f = fixture(t); f.node.setObjectSharing(true); f.node.boot();
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
  const f = fixture(t); f.node.setObjectSharing(true); f.node.boot();
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
  const f = fixture(t); f.node.setObjectSharing(true); f.node.boot(); let resume; const writes = [];
  f.node.v86.create_file = async (name, data) => { writes.push({ name, data: data.slice() }); if (writes.length === 1) await new Promise(resolve => { resume = resolve; }); };
  const bytes = Uint8Array.of(1, 2), pending = f.node.mountUorObject('sha256:' + 'a'.repeat(64), bytes, 'label');
  bytes.fill(99); resume();
  assert.equal(await pending, true);
  assert.deepEqual(writes.map(write => Array.from(write.data)), [[1, 2], [1, 2]]);
});

test('grants default off; revoked mirrors and malformed Ethernet cannot cross host boundary', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  const root = 'sha256:' + 'a'.repeat(64), vm = f.node.v86;
  assert.equal(await f.node.mountUorObject(root, Uint8Array.of(1)), false);
  let received = 0; vm.bus = { send: () => received++ };
  vm.listeners.get('net0-send')(new Uint8Array(14));
  f.node.handleIncomingEthFrame(Array(14).fill(0));
  assert.equal(f.sent.length + received, 0);
  f.node.setEthernetSharing(true);
  for (const frame of [[], [1], Array(14), Array(14).fill(256), Array(1519).fill(0), Array(14).fill(NaN)]) f.node.handleIncomingEthFrame(frame);
  assert.equal(received, 0);
  f.node.handleIncomingEthFrame(Array(14).fill(0)); assert.equal(received, 1);
  f.node.transport.closed = true; f.node.handleIncomingEthFrame(Array(14).fill(0)); assert.equal(received, 1);
  f.node.transport.closed = false; f.node.setEthernetSharing(false);
  vm.listeners.get('net0-send')(new Uint8Array(14)); assert.equal(f.sent.length, 0);
  f.node.setObjectSharing(true);
  let resume; vm.create_file = () => new Promise(resolve => { resume = resolve; });
  const pending = f.node.mountUorObject(root, Uint8Array.of(1), 'label');
  f.node.setObjectSharing(false); f.node.setObjectSharing(true); resume();
  assert.equal(await pending, false);
});

test('timeout retains a unique handle that can observe completion without another dispatch', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  let id; await assert.rejects(f.node.executeShellCommand('echo one', 0), error => { id = error.commandId; return error.outcome === 'unknown'; });
  assert.equal(f.node.commandEvidence(id).outcome, 'unknown');
  const before = f.node.v86.commands.length;
  const handle = f.node.commands.get(id);
  f.node.v86.fs9p.setResult(handle.doneName, Uint8Array.of(1));
  f.node.v86.fs9p.setResult(handle.outName, Uint8Array.of(42));
  assert.deepEqual(await f.node.reconcileCommand(id), Uint8Array.of(42));
  assert.equal(f.node.v86.commands.length, before);
  assert.equal(f.node.commandEvidence(id).outcome, 'completed');
});

test('replacement fences asynchronous command completion and double-click dispatch', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  const old = f.node.v86; let resume;
  old.fs9p.setResult('placeholder', Uint8Array.of(1));
  old.fs9p.SearchPath = () => ({ id: 1 });
  old.fs9p.Read = () => new Promise(resolve => { resume = resolve; });
  const pending = f.node.executeShellCommand('echo old', 1000);
  const rejected = assert.rejects(pending, /replaced/);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await assert.rejects(f.node.executeShellCommand('echo duplicate'), /busy/);
  await f.node.destroy(); f.node.boot(); f.ready(); f.poll();
  resume(Uint8Array.of(1));
  await rejected;
  assert.equal(f.node.commandEvidence(f.node.lastCommandId).outcome, 'unknown');
  assert.equal(f.node.v86.commands.length, 1);
});

test('stop and destroy failures quarantine instance; repeated administration is fenced', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  const vm = f.node.v86; f.node.setObjectSharing(true); f.node.setEthernetSharing(true);
  vm.stop = () => { throw Error('stop failed'); };
  assert.equal(await f.node.stop(), false); assert.equal(f.node.objectSharing, false); assert.equal(f.node.ethernetSharing, false);
  f.node.boot(); assert.equal(f.instances.length, 1);
  vm.destroy = () => Promise.reject(Error('destroy failed'));
  assert.equal(await f.node.destroy(), false); assert.equal(f.node.v86, vm);
  let resume, calls = 0; vm.destroy = () => { calls++; return new Promise(resolve => { resume = resolve; }); };
  const pending = f.node.destroy(); assert.equal(await f.node.destroy(), false); assert.equal(calls, 1);
  resume(); assert.equal(await pending, true); f.node.boot(); assert.equal(f.instances.length, 2);
});

test('cancel before dispatch and command bounds preserve intentional general shell syntax', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  for (const command of ['', '\0', 'x'.repeat(16385)]) await assert.rejects(f.node.executeShellCommand(command));
  await assert.rejects(f.node.executeShellCommand('true', Infinity));
  let resume; f.node.v86.create_file = () => new Promise(resolve => { resume = resolve; });
  const pending = f.node.executeShellCommand('for x in 1 2; do echo "$x"; done');
  f.node.cancelCommandObservation(f.node.lastCommandId); resume();
  await assert.rejects(pending, /before shell dispatch/);
  assert.equal(f.node.v86.commands.length, 1);
});

test('pending boot-failure destroy blocks retry and success releases the instance', async t => {
  const f = fixture(t); f.node.boot(); const old = f.node.v86; let resume;
  old.destroy = () => new Promise(resolve => { resume = resolve; });
  old.listeners.get('download-error')();
  assert.equal(f.node.v86, old); assert.equal(f.node.adminBusy, true);
  f.node.boot(); assert.equal(f.instances.length, 1);
  assert.equal(await f.node.destroy(), false);
  resume(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.node.v86, null); assert.equal(f.node.adminBlocked, false);
  f.node.boot(); assert.equal(f.instances.length, 2);
});

test('explicit resolved evidence disposal releases command capacity and output; unknown is retained', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  for (let i = 0; i < 128; i++) f.node.commands.set(`resolved_${i}`, { outcome: 'completed', output: Uint8Array.of(i), vm: f.node.v86 });
  f.node.lastCommandId = 'resolved_127';
  const retained = f.node.commands.get(f.node.lastCommandId);
  await assert.rejects(f.node.executeShellCommand('true', 0), /capacity/);
  assert.equal(f.node.lifecycle.canForgetCommand, true);
  assert.equal(f.node.forgetCommand(f.node.lastCommandId), true);
  assert.equal(retained.output, undefined); assert.equal(retained.vm, null);
  assert.equal(f.node.commands.size, 127); assert.equal(f.node.lastCommandId, 'resolved_126');
  await assert.rejects(f.node.executeShellCommand('true', 0), /completion is unknown/);
  const unknown = f.node.lastCommandId;
  assert.equal(f.node.forgetCommand(unknown), false); assert.equal(f.node.commands.has(unknown), true);
  assert.equal(f.node.forgetCommand('resolved_1'), true);
});


test('retained command admission can be inspected by handle without mutating the latest selection', t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  const command = { generation: f.node.bootGeneration, vm: f.node.v86, dispatched: true, outcome: 'unknown' };
  f.node.commands.set('prior', command); f.node.commands.set('latest', { ...command, outcome: 'completed' });
  f.node.lastCommandId = 'latest';
  assert.equal(f.node.commandLifecycle('prior').canForgetCommand, false);
  assert.equal(f.node.commandLifecycle('prior').canReconcileCommand, true);
  assert.equal(f.node.commandLifecycle('latest').canForgetCommand, true);
  assert.equal(f.node.commandLifecycle('missing').canReconcileCommand, false);
  assert.equal(f.node.lastCommandId, 'latest');
  f.node.bootGeneration++;
  assert.equal(f.node.commandLifecycle('prior').canReconcileCommand, false);
});

test('boot installs filesystem controls before run and refuses an unsupported v86 boundary', async t => {
  const f = fixture(t); f.node.boot(); const vm = f.node.v86;
  assert.equal(vm.options.autostart, false); assert.equal(vm.started, 1);
  assert.ok(f.node.filesystemUsage);
  const usage = f.node.filesystemUsage;
  vm.listeners.get('emulator-loaded')(); assert.equal(vm.started, 1); assert.equal(f.node.filesystemUsage, usage);
  await f.node.destroy();
  globalThis.V86 = class extends f.FakeVm { fs9p = {}; };
  f.node.boot();
  assert.equal(f.instances.at(-1).started, 0);
  assert.equal(f.instances.at(-1).destroyed, 1);
  assert.match(f.statuses.at(-1).message, /controls are unavailable/);
});

test('cancellation after dispatch stops the whole VM, revokes bridges and retains unknown effects', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  await assert.rejects(f.node.executeShellCommand('while true; do :; done', 0), /unknown/);
  const id = f.node.lastCommandId, vm = f.node.v86;
  f.node.setObjectSharing(true); f.node.setEthernetSharing(true);
  assert.equal(await f.node.cancelCommand(id), true);
  assert.equal(vm.stopped, 1); assert.equal(f.node.booted, false);
  assert.equal(f.node.objectSharing, false); assert.equal(f.node.ethernetSharing, false);
  assert.equal(f.node.commandEvidence(id).outcome, 'unknown');
  assert.equal(f.node.commandEvidence(id).termination, 'vm-stopped');
  assert.equal(f.node.lifecycle.canBoot, false);
  assert.equal(await f.node.cancelCommand(id), false); assert.equal(vm.stopped, 1);
  assert.equal(f.node.forgetCommand(id), false);
});

test('cancel interrupts a stalled host result read and a failed stop is explicitly unknown', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll(); const vm = f.node.v86;
  vm.fs9p.SearchPath = () => ({ id: vm.fs9p.setResult('done', Uint8Array.of(1)) });
  vm.fs9p.Read = () => new Promise(() => {});
  vm.stop = () => { throw Error('stop failed'); };
  const pending = f.node.executeShellCommand('sleep 1000');
  const rejected = assert.rejects(pending, /stopped.*unknown/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(await f.node.cancelCommand(f.node.lastCommandId), false);
  await rejected;
  assert.equal(f.node.commandBusy, false);
  assert.equal(f.node.commandEvidence(f.node.lastCommandId).termination, 'stop-unknown');
  assert.equal(f.node.adminBlocked, true); assert.equal(f.node.v86, vm);
});

test('VM runtime expiry is separate from command observation and stops background work', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  const vm = f.node.v86, expire = f.deadlines.get(f.node.runtimeDeadline);
  await assert.rejects(f.node.executeShellCommand('sleep 1000 &', 0), /not cancelled/);
  assert.equal(f.node.booted, true);
  expire(); await f.node.boundaryStop;
  assert.equal(vm.stopped, 1); assert.equal(f.node.booted, false);
  assert.match(f.node.boundaryReason, /runtime allowance/);
  expire(); assert.equal(vm.stopped, 1);
});

test('oversized guest output is rejected before range read and fail-stops the VM', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  await assert.rejects(f.node.executeShellCommand('echo output', 0));
  const vm = f.node.v86, command = f.node.commands.get(f.node.lastCommandId);
  vm.fs9p.setResult(command.doneName, Uint8Array.of(1));
  const id = vm.fs9p.setResult(command.outName, Uint8Array.of(42)); vm.fs9p.inodes[id].size = 4194305;
  await assert.rejects(f.node.reconcileCommand(command.id), error => error.code === 'vm-output-limit');
  assert.equal(vm.fs9p.reads.some(read => read.id === id), false);
  assert.equal(vm.stopped, 1); assert.equal(f.node.commandEvidence(command.id).outcome, 'unknown');
});

test('filesystem overflow stops the running VM before allocation and host bridge continuations are fenced', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll(); const vm = f.node.v86;
  f.node.setEthernetSharing(true); f.node.setObjectSharing(true);
  const id = vm.fs9p.CreateFile('large', 0);
  assert.throws(() => vm.fs9p.ChangeSize(id, 16777217), error => error.code === 'vm-filesystem-limit');
  assert.equal(vm.fs9p.allocations.length, 0); assert.equal(f.node.adminBlocked, true);
  vm.listeners.get('net0-send')(new Uint8Array(14)); assert.equal(f.sent.length, 0);
  await f.node.boundaryStop; assert.equal(vm.stopped, 1);
});

test('runtime allowances validate before boot and cannot renew an existing guest instance', async t => {
  const f = fixture(t);
  for (const vmRuntimeMs of [0, 999, 300001, Infinity, NaN]) {
    assert.throws(() => new LinuxVmNode({ vmRuntimeMs }), error => error.code === 'vm-runtime-limit-invalid');
    assert.throws(() => f.node.setRuntimeAllowance(vmRuntimeMs), error => error.code === 'vm-runtime-limit-invalid');
  }
  f.node.setRuntimeAllowance(1000); f.node.boot();
  assert.equal(f.node.vmRuntimeMs, 1000);
  assert.throws(() => f.node.setRuntimeAllowance(300000), error => error.code === 'vm-runtime-active');
  await f.node.destroy(); f.node.setRuntimeAllowance(2000);
  assert.equal(f.node.vmRuntimeMs, 2000);
});

test('pending VM termination is reported as pending, not confirmed success', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll(); let finish;
  f.node.v86.stop = () => new Promise(resolve => { finish = resolve; });
  const pending = f.node.stop();
  assert.equal(f.node.adminBusy, true); assert.equal(f.statuses.at(-1).state, 'stopping');
  assert.match(f.statuses.at(-1).message, /awaiting emulator confirmation/);
  assert.equal(await f.node.destroy(), false);
  finish(); await pending;
  assert.equal(f.statuses.at(-1).state, 'offline');
});

test('aggregate retained-output ceiling is checked before oversized read and missing output does not resolve a command', async t => {
  const f = fixture(t); f.node.boot(); f.ready(); f.poll();
  await assert.rejects(f.node.executeShellCommand('echo result', 0));
  const vm = f.node.v86, command = f.node.commands.get(f.node.lastCommandId);
  vm.fs9p.setResult(command.doneName, Uint8Array.of(1));
  assert.equal(await f.node.reconcileCommand(command.id), null);
  assert.equal(f.node.commandEvidence(command.id).outcome, 'unknown');
  f.node.commands.set('retained', { outcome: 'completed', output: new Uint8Array(16777216), vm });
  const outputId = vm.fs9p.setResult(command.outName, Uint8Array.of(1));
  await assert.rejects(f.node.reconcileCommand(command.id), error => error.code === 'vm-output-limit');
  assert.equal(vm.fs9p.reads.some(read => read.id === outputId), false);
  assert.equal(vm.stopped, 1);
});
