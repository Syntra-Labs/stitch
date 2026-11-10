import { filesystemFixture } from './helpers/vm-filesystem.js';
import { SyntheticAuthorityStore } from './helpers/transactional-authority.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installAuthorityControls } from '../src/authority-ui.js';
import { installRecoveryControls } from '../src/recovery-ui.js';
import { exportRecoveryBundle, recoveryObject } from '../src/recovery.js';
import { createOperatorExperience, integrityLabel, executionLabel } from '../src/product-experience.js';
import { placementStatus } from '../src/layer3-storage/custody.js';
import { parseCanonicalJson } from '../src/layer1-uor/custody.js';
import { ResourceAdmission, wireBytes, reserveNetwork } from '../src/layer2-schedulers/policy.js';
import { generateAuthority, signPointer, PointerObserver, PointerPublisher, pointerDnsText, parsePointerDnsText } from '../src/layer1-uor/pointer.js';
import { LiveUorMeshDatabase } from '../src/layer3-storage/index.js';
import { LinuxVmNode, LiveDistributedComputeCoordinator } from '../src/layer4-compute/index.js';
import { createCheckpoint, demoProgram, replayProgram } from '../src/layer4-compute/replay.js';
import { DohResolver, WebRtcTransportNode, readBoundedText } from '../src/layer5-transport/index.js';
import { BudgetPacedSurvivalScheduler } from '../src/layer2-schedulers/index.js';
const code = expected => error => error.code === expected;
const limits = overrides => ({ requests: 100, transferBytes: 10000000, storageBytes: 100000, computeSteps: 10000, ...overrides });
const admission = overrides => new ResourceAdmission({ clock: () => 0, durationMs: 100, limit: limits(overrides) });
const transport = () => ({ peerId: 'local', sent: [], openPeers: () => [{ remoteId: 'remote' }],
  sendToPeer(_, packet) { this.sent.push(packet); return true; },
  broadcast(packet) { this.sent.push(packet); return 1; },
  async publishWarmEnvelope(packet) { this.sent.push(packet); return true; },
  async fetchWarmEnvelopes() { return []; } });

test('effect admission reserves before work, keeps unknown charges, and never resets its epoch', () => {
  let now = 5;
  const policy = new ResourceAdmission({ clock: () => now, durationMs: 10, limit: limits({ requests: 1 }) });
  let effects = 0;
  assert.throws(() => policy.run('place', { requests: 1 }, () => { effects++; throw Error('ambiguous'); }), /ambiguous/);
  assert.equal(policy.state.spent.requests, 1);
  assert.throws(() => policy.run('repair', { requests: 1 }, () => effects++), code('budget-exhausted'));
  const exposed = policy.state; exposed.spent.requests = 0; exposed.limit.requests = 100;
  assert.equal(policy.state.spent.requests, 1);
  now = 4;
  assert.throws(() => policy.reserve('refresh'), code('clock-regression'));
  now = 15;
  assert.throws(() => policy.reserve('refresh'), code('epoch-expired'));
  assert.equal(effects, 1);
});

test('live storage refuses cache and outbound effects before their budgets can be exceeded', async () => {
  const t = transport();
  const noCache = new LiveUorMeshDatabase({ transport: t, admission: admission({ storageBytes: 0 }) });
  await assert.rejects(noCache.put('secret'), code('budget-exhausted'));
  assert.equal(noCache.objects.size, 0); assert.equal(t.sent.length, 0);
  const noNetwork = new LiveUorMeshDatabase({ transport: t, admission: admission({ requests: 0 }) });
  await noNetwork.put('local only');
  assert.equal(t.sent.length, 0);
  assert.equal(noNetwork.pendingTransfers.size, 0);
  assert.equal([...noNetwork.placements.values()][0].requests[0].status, 'uncertain');
  await assert.rejects(noNetwork.syncFromNetwork(), code('budget-exhausted'));
  assert.equal(t.sent.length, 0);
});

test('local wipe is ordered after pending writes, clears pending bytes, and cannot refund spent policy', async () => {
  const t = transport(), policy = admission();
  const db = new LiveUorMeshDatabase({ transport: t, admission: policy });
  const original = new TextEncoder().encode('snapshot before queue');
  const work = db.put(original); original.fill(0);
  const entry = await work;
  assert.equal(db.get(entry.addressHex).text, 'snapshot before queue');
  const spent = policy.state.spent;
  const second = db.put('queued second');
  await db.clearLocal(); await second;
  assert.equal(db.objects.size, 0); assert.equal(db.placements.size, 0); assert.equal(db.pendingTransfers.size, 0);
  assert.ok(policy.state.spent.storageBytes >= spent.storageBytes);
  assert.ok(policy.state.spent.requests >= spent.requests);
});

test('live compute reserves every replay, and refusal prevents publishing or storing a claimed result', async () => {
  const t = transport(), policy = admission({ computeSteps: 0 });
  let writes = 0;
  const coordinator = new LiveDistributedComputeCoordinator({ transport: t, admission: policy,
    liveDb: { put: async () => { writes++; return { addressHex: 'x' }; } } });
  const program = demoProgram(3), checkpoint = await createCheckpoint(program, 1);
  assert.equal(await coordinator.ingestCheckpoint({ type: 'compute_ckpt', jobId: 'j', program, checkpoint, ownerPeerId: 'remote' }), false);
  assert.equal(coordinator.jobs.size, 0);
  await assert.rejects(coordinator.startOrResumeJob({ jobId: 'j', totalSteps: 3, stepDelayMs: 0 }), code('budget-exhausted'));
  assert.equal(t.sent.length, 0); assert.equal(writes, 0);
  assert.throws(() => replayProgram(program, 3, admission({ computeSteps: 2 })), code('budget-exhausted'));
  const full = admission();
  replayProgram(program, 3, full);
  assert.equal(full.state.spent.computeSteps, 3);
});

test('real WebRTC and DNS adapters share request/UTF-8 limits, including failed sends', async () => {
  const policy = admission({ requests: 1, transferBytes: 1000 });
  const events = [];
  const node = new WebRtcTransportNode({ peerId: 'p', admission: policy, onEvent: e => events.push(e) });
  let sends = 0, fetches = 0;
  node.peers.set('r', { dc: { readyState: 'open', send: () => { sends++; throw Error('uncertain'); }, close() { this.readyState = 'closed'; } } });
  const packet = { type: 'data', value: '☃' };
  assert.equal(node.sendToPeer('r', packet), true, 'accepted queue reports the unknown browser send outcome separately');
  assert.ok(events.some(e => e.type === 'channel_send_result' && e.outcome === 'unknown'));
  assert.equal(node.sendToPeer('r', packet), false, 'poisoned channel is not replayed');
  assert.equal(policy.state.spent.transferBytes, wireBytes(packet));
  assert.equal(policy.state.spent.requests, 1);
  node.peers.set('r', { dc: { readyState: 'open', send: () => { sends++; }, close() { this.readyState = 'closed'; } } });
  assert.throws(() => node.sendToPeer('r', packet), code('budget-exhausted'));
  node.close();
  const dns = new DohResolver({ admission: policy, fetchImpl: async () => { fetches++; return new Response('{}'); } });
  await assert.rejects(dns.resolve('example.test'), code('budget-exhausted'));
  await assert.rejects(dns.writeCloudflareRecord({ zoneId: 'z', apiToken: 't', name: 'example.test' }), code('budget-exhausted'));
  assert.equal(sends, 1); assert.equal(fetches, 0);
});

test('response readers cancel oversized streaming bodies and relay failure keeps its charge', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedText(new Response(body), 10), code('response-limit'));
  assert.equal(cancelled, true);
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  try {
    globalThis.fetch = async () => { fetches++; throw Error('uncertain'); };
    const policy = admission({ requests: 1 });
    const node = new WebRtcTransportNode({ peerId: 'p', admission: policy });
    assert.equal(await node.publishWarmEnvelope({ type: 'test' }, { publicData: true }), false);
    assert.equal(await node.publishWarmEnvelope({ type: 'test' }, { publicData: true }), false);
    assert.equal(fetches, 1); assert.equal(policy.state.spent.requests, 1);
  } finally { globalThis.fetch = savedFetch; }
});

test('warm compute recovery accepts only bounded delivery metadata without treating it as authority', async () => {
  const program = demoProgram(5), checkpoint = await createCheckpoint(program, 3);
  const packet = { type: 'compute_ckpt', jobId: 'j', program, checkpoint, ownerPeerId: 'remote', from: 'delivery-peer', tsMs: 10 };
  const t = transport(); t.fetchWarmEnvelopes = async () => [packet];
  const c = new LiveDistributedComputeCoordinator({ transport: t, admission: admission(), allowPublicRelay: true,
    liveDb: { put: async () => ({ addressHex: 'x' }) } });
  assert.deepEqual(await c.syncAndTakeOverJobs(), []);
  assert.equal(c.jobs.get('j').stepIndex, 3);
  assert.equal(c.jobs.get('j').ownerPeerId, 'remote');
  const bad = new LiveDistributedComputeCoordinator({ transport: { ...t, fetchWarmEnvelopes: async () => [{ ...packet, injected: true }] },
    admission: admission(), allowPublicRelay: true, liveDb: {} });
  assert.deepEqual(await bad.syncAndTakeOverJobs(), []);
  assert.equal(bad.jobs.size, 0);
});

test('retained pointer heads serialize forks, reject foreign pins, and preserve complete multipart DNS roots', async () => {
  const authority = await generateAuthority();
  const make = (revision, previousDigest) => signPointer({ version: 1, name: 'state.example.test', authorityKey: authority.publicKey,
    revision, previousDigest, objectRoot: 'sha256:' + 'f'.repeat(64), validFromMs: 0, validUntilMs: 100 }, authority.privateKey);
  const observer = new PointerObserver({ name: 'state.example.test', trustedAuthorityKey: authority.publicKey, clock: () => 5, admission: admission() });
  const first = await make(0, null);
  assert.deepEqual(parsePointerDnsText(pointerDnsText(first)), first);
  assert.ok(pointerDnsText(first).length > 255);
  await observer.admit(first);
  const next = await make(1, first.pointerDigest);
  const outcomes = await Promise.allSettled([observer.admit(next), observer.admit(next)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(observer.head.revision, 1);
  const snapshot = observer.head; snapshot.revision = 0;
  assert.equal(observer.head.revision, 1);
  await assert.rejects(observer.admit(first), code('pointer-conflict'));
  const attacker = await generateAuthority();
  const foreign = new PointerObserver({ name: 'state.example.test', trustedAuthorityKey: attacker.publicKey, clock: () => 5 });
  await assert.rejects(foreign.admit(first), code('wrong-authority'));
  const noCache = new PointerObserver({ name: 'state.example.test', trustedAuthorityKey: authority.publicKey, clock: () => 5,
    admission: admission({ storageBytes: 0 }) });
  await assert.rejects(noCache.admit(first), code('budget-exhausted'));
  assert.equal(noCache.head, null);
});

async function browserHarness({ AdmissionClass = ResourceAdmission, AuthorityClass = SyntheticAuthorityStore, VmClass = null, publicationMode = 'success' } = {}) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
  const elements = new Map();
  const element = (tagName = '') => ({ tagName: tagName.toUpperCase(), value: '', checked: false, files: [], selected: false, textContent: '', style: {}, listeners: {}, attributes: {}, children: [],
    get selectedOptions() { return this.children.filter(node => node.selected); },
    querySelectorAll(selector) {
      if (selector !== 'button') throw Error(`Unsupported harness selector ${selector}`);
      const section = html.slice(html.indexOf('id="recoveryControls"'), html.indexOf('<!-- LIVE PANEL B:'));
      return [...section.matchAll(/<button[^>]*id="([^"]+)"/g)].map(match => document.getElementById(match[1]));
    },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    replaceChildren(...nodes) { this.children = nodes; if (this.tagName === 'SELECT') this.value = nodes[0]?.value ?? ''; }, append() {}, click() {}, focus() { this.focused = true; }, scrollIntoView() {} });
  const document = { getElementById(id) { if (!elements.has(id)) {
    const tag = html.match(new RegExp(`<([a-z]+)[^>]*id="${id}"`))?.[1] || '';
    elements.set(id, element(tag));
  } return elements.get(id); }, createElement: element };
  document.getElementById('meshKeyInput').value = 'test';
  document.getElementById('dnsQueryInput').value = 'state.example.test';
  document.getElementById('dbPayloadInput').value = 'browser object';
  document.getElementById('dbLabelInput').value = 'state.txt';
  document.getElementById('vmRuntimeSeconds').value = '300';
  let mesh, db, coordinator, vm, tick, exportedBlob; const published = [], dnsCalls = [];
  class FakeTransport {
    constructor(options) { Object.assign(this, transport(), options); this.sendToPeer = FakeTransport.prototype.sendToPeer; this.broadcast = FakeTransport.prototype.broadcast; mesh = this; }
    signalTopic() { return 'signal'; } warmCacheTopic() { return 'warm'; }
    get lifecycle() { return { generation: this.joined ? 1 : 0, closed: !this.joined }; }
    connect() { this.joined = true; } close() { this.joined = false; }
    sendToPeer(_, packet) { reserveNetwork(this.admission, 'place', packet); this.sent.push(packet); return true; }
    broadcast(packet) { reserveNetwork(this.admission, 'retrieve', packet, this.openPeers().length); this.sent.push(packet); return this.openPeers().length; }
  }
  class FakeDb extends LiveUorMeshDatabase { constructor(options) { super(options); db = this; } }
  class FakeCoordinator extends LiveDistributedComputeCoordinator { constructor(options) { super(options); coordinator = this; } }
  class FakeDns {
    constructor(options) { this.admission = options.admission; }
    async listCloudflareRecords({ name }) {
      dnsCalls.push('GET');
      this.admission.reserve('retrieve', { requests: 1 });
      return published.length ? [{ id: 'record-1', name, type: 'TXT', content: pointerDnsText(published.at(-1)) }] : [];
    }
    async writeCloudflareRecord(options) {
      this.admission.reserve('refresh', { requests: 1 }); dnsCalls.push(options.recordId ? 'PUT' : 'POST');
      if (publicationMode === 'lost-not-created') return { ok: false, outcome: 'unknown' };
      published.push(parsePointerDnsText(options.content));
      if (publicationMode === 'lost-created') return { ok: false, outcome: 'unknown' };
      return { ok: true, outcome: 'published', id: 'record-1' };
    }
  }
  const bindings = { document, window: { addEventListener() {} }, location: { hash: '' }, navigator: {},
    fetch: async () => new Response('colo=TEST\n'), setInterval: callback => { tick = callback; return 1; },
    URL: { createObjectURL(blob) { exportedBlob = blob; return 'blob:test'; }, revokeObjectURL() {} }, setTimeout: callback => callback(),
    installAuthorityControls, installRecoveryControls, createOperatorExperience, integrityLabel, executionLabel, placementStatus, parseCanonicalJson,
    BrowserAuthorityStore: AuthorityClass, ResourceAdmission: AdmissionClass, generateAuthority, signPointer, PointerObserver, PointerPublisher, pointerDnsText, parsePointerDnsText,
    readBoundedText, ExperimentTrialLogger: class { entries = []; logTrial() {} },
    BudgetPacedSurvivalScheduler, LiveUorMeshDatabase: FakeDb, LiveDistributedComputeCoordinator: FakeCoordinator,
    WebRtcTransportNode: FakeTransport, DohResolver: FakeDns,
    LinuxVmNode: VmClass ? class extends VmClass { constructor(options) { super(options); vm = this; } } : class {
      constructor(options) { vm = this; this.options = options; this.phase = 'idle'; this.boots = 0; this.commands = 0; }
      get lifecycle() { return { phase: this.phase, canBoot: !['ready', 'booting'].includes(this.phase), canExecute: this.phase === 'ready' }; }
      commandEvidence() { return null; }
      setRuntimeAllowance(milliseconds) { this.vmRuntimeMs = milliseconds; }
      boot() { this.boots++; this.setPhase('booting'); }
      setPhase(phase) { this.phase = phase; this.options.onStatus({ state: phase === 'ready' ? 'online' : phase, ip: 'test' }); }
      async executeShellCommand() { this.commands++; return new TextEncoder().encode('observed guest stdout'); }
      async mountUorObject() {}
    },
    benchmarkUorHashers: () => [], benchmarkSchedulers: () => [], benchmarkStorageStrategies: () => [], benchmarkComputeStrategies: () => [] };
  new Function(...Object.keys(bindings), script)(...Object.values(bindings));
  await db.flush();
  await Promise.resolve();
  return { document, elements, mesh, db, coordinator, vm, published, dnsCalls,
    click: id => elements.get(id).listeners.click(), tick: () => tick(),
    exported: async () => JSON.parse(await exportedBlob.text()) };
}

test('actual browser script sends v1 channel sync and gates full pointer publishing on explicit pin and retained head', async () => {
  const { document, elements, mesh, db, published, click } = await browserHarness();
  await db.flush();
  await mesh.onEvent({ type: 'channel_open', remoteId: 'remote' });
  assert.deepEqual(mesh.sent.at(-1), { type: 'uor_sync_req', version: 1 });
  await click('dbPutBtn');
  await click('writeSignedDnsBtn');
  assert.equal(document.getElementById('pointerJsonInput').value, '');
  assert.match(elements.get('wireLogBox').textContent, /MODEL-REFUSED/);
  await click('pinSessionAuthorityBtn');
  await click('writeSignedDnsBtn');
  const first = JSON.parse(document.getElementById('pointerJsonInput').value);
  assert.equal(first.revision, 0); assert.equal(first.objectRoot, [...db.objects.keys()][0]);
  await click('writeSignedDnsBtn');
  assert.equal(JSON.parse(document.getElementById('pointerJsonInput').value).pointerDigest, first.pointerDigest);
  document.getElementById('cfZoneInput').value = 'a'.repeat(32);
  document.getElementById('cfTokenInput').value = 'test-token';
  await click('writeSignedDnsBtn');
  await click('writeSignedDnsBtn');
  assert.equal(published.length, 2);
  assert.equal(published[0].revision, 0); assert.equal(published[1].revision, 1);
  assert.equal(published[1].previousDigest, published[0].pointerDigest);
  document.getElementById('pointerJsonInput').value = JSON.stringify(first);
  await assert.rejects(click('admitPointerBtn'), code('pointer-conflict'));
});

test('custody ingress snapshots queued wire bytes, refuses overfull queues, and cannot create cache ghosts on refusal', async () => {
  const source = new LiveUorMeshDatabase({ transport: transport(), admission: admission() });
  await source.put('wire snapshot');
  const packet = structuredClone(source.transport.sent.find(p => p.type === 'uor_shard'));
  Object.assign(packet, { purpose: 'recovery', requestId: null, holder: null, leaseExpiresAt: 0 });
  const target = new LiveUorMeshDatabase({ transport: transport(), admission: admission() });
  const receiving = target.handleMeshMessage('remote', packet);
  packet.shardBytes.fill(255);
  await receiving;
  assert.equal(target.replicationsReceived, 1);
  const noCache = new LiveUorMeshDatabase({ transport: transport(), admission: admission({ storageBytes: 0 }) });
  assert.equal(await noCache.handleMeshMessage('remote', source.transport.sent[0]), false); // wrong placement holder
  const valid = structuredClone(source.transport.sent[0]);
  Object.assign(valid, { purpose: 'recovery', requestId: null, holder: null, leaseExpiresAt: 0 });
  assert.equal(await noCache.handleMeshMessage('remote', valid), false);
  assert.equal(noCache.objects.size, 0);
  target.maxPendingWork = 1;
  const first = target.handleMeshMessage('remote', { type: 'uor_sync_req', version: 1 });
  await assert.rejects(target.handleMeshMessage('remote', { type: 'uor_sync_req', version: 1 }), code('CapacityLimit'));
  await first;
  const program = demoProgram(2), checkpoint = await createCheckpoint(program, 1);
  const c = new LiveDistributedComputeCoordinator({ transport: transport(), liveDb: {}, admission: admission() });
  c.maxPendingIngress = 1;
  const accepted = c.ingestCheckpoint({ type: 'compute_ckpt', jobId: 'j', program, checkpoint, ownerPeerId: 'remote' });
  assert.equal(await c.ingestCheckpoint({ type: 'compute_ckpt', jobId: 'j', program, checkpoint, ownerPeerId: 'remote' }), false);
  assert.equal(await accepted, true);
});

test('joining another mesh closes old holders before any new-key sync and bounds peer sessions', () => {
  const saved = { BroadcastChannel: globalThis.BroadcastChannel, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  let closed = 0, signalingWrites = 0;
  try {
    globalThis.BroadcastChannel = class { close() {} postMessage() { signalingWrites++; } };
    globalThis.WebSocket = class { close() {} };
    globalThis.fetch = async () => { signalingWrites++; return new Response(''); };
    const node = new WebRtcTransportNode({ channelKey: 'old', admission: admission(), publicSignaling: false });
    node.peers.set('old-holder', { pc: { close() { closed++; } }, dc: { readyState: 'open', close() { closed++; } } });
    node.connect('new');
    assert.equal(node.channelKey, 'new'); assert.equal(closed, 2); assert.equal(node.peers.size, 0);
    assert.equal(node.broadcast({ type: 'uor_sync_req', version: 1 }), 0);
    assert.equal(signalingWrites, 0);
    node.maxPeers = 0;
    assert.throws(() => node.getOrCreatePeer('remote'), code('peer-capacity'));
    // Cancel asynchronous signing before restoring global provider adapters.
    node.close();
  } finally { Object.assign(globalThis, saved); }
});

test('browser epochs expire visibly, renew only by explicit choice, and preserve prior ledgers, objects, jobs and pointer heads', async () => {
  let now = 0;
  class ControlledAdmission extends ResourceAdmission {
    constructor(options = {}) { super({ ...options, clock: () => now }); }
  }
  const h = await browserHarness({ AdmissionClass: ControlledAdmission });
  const { document, db, coordinator, click } = h;
  const field = id => document.getElementById(id);
  assert.equal(field('budgetMinutesInput').value, '10');
  assert.match(field('budgetStatus').textContent, /Epoch 1 active/);
  await click('dbPutBtn');
  await click('pinSessionAuthorityBtn');
  await click('writeSignedDnsBtn');
  const pointer = JSON.parse(field('pointerJsonInput').value);
  const program = demoProgram(3), checkpoint = await createCheckpoint(program, 1);
  assert.equal(await coordinator.ingestCheckpoint({ type: 'compute_ckpt', jobId: 'paused', program, checkpoint, ownerPeerId: h.mesh.peerId }), true);
  const objects = [...db.objects.keys()];
  let rejectOldEffect;
  const oldEffect = db.admission.run('place', { requests: 1 }, () => new Promise((_, reject) => { rejectOldEffect = reject; }));
  oldEffect.catch(() => {});
  const beforeExpiry = db.admission.state;
  now = beforeExpiry.endMs;
  h.tick();
  assert.match(field('budgetStatus').textContent, /Epoch expired.*Start New Epoch/);
  assert.match(field('budgetLabel').textContent, /0s left/);
  await assert.rejects(db.put('not admitted after expiry'), code('epoch-expired'));
  const sharedHandle = db.admission;
  assert.equal(coordinator.admission, sharedHandle); assert.equal(h.mesh.admission, sharedHandle);
  assert.equal(field('budgetPolicyPanel').open, true);
  assert.deepEqual([...db.objects.keys()], objects);
  assert.deepEqual(sharedHandle.state, beforeExpiry);
  // Merely changing form values or waiting cannot reset the epoch.
  field('budgetMinutesInput').value = '2';
  field('budgetRequestsInput').value = '2';
  field('budgetTransferInput').value = '500000';
  field('budgetStorageInput').value = '100000';
  field('budgetComputeInput').value = '100000';
  field('budgetActionsInput').value = '100';
  field('budgetRefreshInput').value = '3';
  h.tick(); h.tick();
  assert.deepEqual(sharedHandle.state, beforeExpiry);
  field('budgetActionsInput').value = '70000';
  click('renewBudgetBtn');
  assert.match(field('budgetStatus').textContent, /Policy unchanged/);
  assert.deepEqual(sharedHandle.state, beforeExpiry);
  field('budgetActionsInput').value = '100';
  click('renewBudgetBtn');
  assert.match(field('budgetStatus').textContent, /Epoch 2 active/);
  assert.equal(db.admission, sharedHandle); assert.equal(coordinator.admission, sharedHandle);
  assert.equal(sharedHandle.state.limit.requests, 2);
  assert.equal(sharedHandle.state.endMs - sharedHandle.state.startMs, 120000);
  assert.deepEqual(sharedHandle.state.spent, { requests: 0, transferBytes: 0, storageBytes: 0, computeSteps: 0 });
  assert.deepEqual([...db.objects.keys()], objects);
  assert.equal(coordinator.jobs.get('paused').stepIndex, 1);
  assert.equal(coordinator.running.size, 0); // No hidden retries on renewal.
  assert.match(field('budgetHistoryBox').textContent, /Epoch 1.*reservations retained/);
  rejectOldEffect(Error('old outcome remains uncertain'));
  await assert.rejects(oldEffect, /uncertain/);
  // Renewal cannot turn a replayed pointer into a new genesis or lose its pin/head.
  field('pointerJsonInput').value = JSON.stringify(pointer);
  await assert.rejects(click('admitPointerBtn'), code('pointer-conflict'));
  await click('takeoverJobsBtn');
  await coordinator.running.get('paused');
  assert.equal(coordinator.jobs.get('paused').status, 'completed');
  assert.equal(sharedHandle.state.spent.requests, 2);
  let effects = 0;
  assert.throws(() => sharedHandle.run('place', { requests: 1 }, () => effects++), code('budget-exhausted'));
  assert.equal(effects, 0);
  assert.match(field('budgetStatus').textContent, /refused.*budget-exhausted.*Start New Epoch/);
  const secondEpoch = sharedHandle.state;
  click('exportBudgetHistoryBtn');
  let exported = await h.exported();
  assert.equal(exported.epochs.length, 2);
  assert.deepEqual(exported.epochs[0].budget, beforeExpiry);
  assert.deepEqual(exported.epochs[1].budget, secondEpoch);
  assert.ok(exported.epochs[0].budget.reservations.every(r => r.status === 'reserved'));
  field('budgetRequestsInput').value = '5';
  click('renewBudgetBtn');
  assert.equal(sharedHandle.state.limit.requests, 5);
  assert.equal(sharedHandle.state.spent.requests, 0);
  click('exportBudgetHistoryBtn');
  exported = await h.exported();
  assert.equal(exported.epochs.length, 3);
  assert.deepEqual(exported.epochs[0].budget, beforeExpiry);
  assert.deepEqual(exported.epochs[1].budget, secondEpoch);
});


test('actual browser unknown publication reconciles without duplicate POST or concurrent-click effects', async () => {
  const h = await browserHarness({ publicationMode: 'lost-created' });
  await h.click('dbPutBtn'); await h.click('pinSessionAuthorityBtn');
  h.document.getElementById('cfZoneInput').value = 'a'.repeat(32);
  h.document.getElementById('cfTokenInput').value = 'test-token';
  await Promise.all([h.click('writeSignedDnsBtn'), h.click('writeSignedDnsBtn')]);
  assert.deepEqual(h.dnsCalls, ['GET', 'POST']);
  assert.match(h.elements.get('wireLogBox').textContent, /POINTER-UNKNOWN/);
  assert.equal(h.elements.get('writeSignedDnsBtn').hidden, true);
  assert.equal(h.elements.get('reconcilePointerBtn').hidden, false);
  assert.equal(h.elements.get('pointerPublicationSetup').open, true);
  assert.equal(h.elements.get('pointersEvidence').attributes['data-experience-state'], 'pointerUnknown');
  await h.click('writeSignedDnsBtn');
  assert.deepEqual(h.dnsCalls, ['GET', 'POST'], 'forced write cannot bypass unknown-publication model guard');
  const candidate = JSON.parse(h.document.getElementById('pointerJsonInput').value);
  await h.click('dbWipeLocalBtn');
  await h.click('reconcilePointerBtn');
  assert.deepEqual(h.dnsCalls, ['GET', 'POST', 'GET']);
  assert.equal(JSON.parse(h.document.getElementById('pointerJsonInput').value).pointerDigest, candidate.pointerDigest);
  assert.match(h.elements.get('wireLogBox').textContent, /Reconciled/);
});

test('actual browser retries only provider reads while an absent prior create remains unknown', async () => {
  const h = await browserHarness({ publicationMode: 'lost-not-created' });
  await h.click('dbPutBtn'); await h.click('pinSessionAuthorityBtn');
  h.document.getElementById('cfZoneInput').value = 'a'.repeat(32);
  h.document.getElementById('cfTokenInput').value = 'test-token';
  await h.click('writeSignedDnsBtn'); await h.click('reconcilePointerBtn');
  assert.deepEqual(h.dnsCalls, ['GET', 'POST', 'GET']);
  assert.match(h.elements.get('wireLogBox').textContent, /POINTER-UNKNOWN/);
  assert.doesNotMatch(h.elements.get('wireLogBox').textContent, /CF-DNS/);
});


test('browser requires explicit signaling disclosure and join, and withdrawal closes the mesh', async () => {
  const h = await browserHarness(); const field = id => h.document.getElementById(id);
  assert.equal(Boolean(h.mesh.joined), false);
  assert.equal(field('reconnectBtn').disabled, true);
  assert.equal(field('meshEvidence').attributes['data-experience-state'], 'meshDisclosure');
  await h.click('reconnectBtn');
  assert.equal(Boolean(h.mesh.joined), false, 'programmatic click must not bypass the model guard');
  field('allowMeshSignalingInput').checked = true;
  field('allowMeshSignalingInput').listeners.change();
  assert.equal(Boolean(h.mesh.joined), false, 'disclosure alone does not initiate signaling');
  assert.equal(field('meshEvidence').attributes['data-experience-state'], 'meshReady');
  await h.click('reconnectBtn'); assert.equal(h.mesh.joined, true);
  field('allowMeshSignalingInput').checked = false;
  field('allowMeshSignalingInput').listeners.change();
  assert.equal(h.mesh.joined, false); assert.equal(field('reconnectBtn').disabled, true);
  assert.equal(field('allowPublicRelayInput').checked, false);
});

test('browser mixed jobs cannot mask an unfinished unverified checkpoint with completed replay evidence', async () => {
  const h = await browserHarness(); const field = id => h.document.getElementById(id);
  h.coordinator.jobs.set('done', { status: 'completed', verification: 'replayed' });
  h.coordinator.jobs.set('needs-replay', { status: 'running', verification: 'unverified' });
  h.tick();
  assert.equal(field('computeEvidence').attributes['data-experience-state'], 'computeUnverified');
  assert.equal(field('takeoverJobsBtn').disabled, false, 'retained local unfinished jobs can resume before joining');
  h.coordinator.jobs.get('needs-replay').verification = 'replayed'; h.tick();
  assert.equal(field('computeEvidence').attributes['data-experience-state'], 'computeReplay');
  h.coordinator.jobs.get('needs-replay').status = 'completed'; h.tick();
  assert.equal(field('computeEvidence').attributes['data-experience-state'], 'computeDone');
});

test('browser zero network allowance and an oversized refusal do not deny cheaper local work', async () => {
  class LocalOnlyAdmission extends ResourceAdmission {
    constructor(options = {}) { super({ ...options, limit: limits({ requests: 0, transferBytes: 0, storageBytes: 20000 }) }); }
  }
  const h = await browserHarness({ AdmissionClass: LocalOnlyAdmission });
  const field = id => h.document.getElementById(id);
  assert.equal(field('dbPutBtn').disabled, false);
  field('dbPayloadInput').value = 'x'.repeat(30000);
  await assert.rejects(h.click('dbPutBtn'), code('budget-exhausted'));
  assert.equal(h.db.objects.size, 0);
  assert.equal(field('dbPutBtn').disabled, false, 'an operation-specific refusal is not a global stop');
  assert.equal(field('resourcesEvidence').attributes['data-experience-state'], 'resourcesBlocked');
  field('dbPayloadInput').value = 'cheap local object'; await h.click('dbPutBtn');
  assert.equal(h.db.objects.size, 1); assert.equal(h.db.admission.state.spent.requests, 0);
  assert.equal(field('startJobBtn').disabled, false);
});

test('browser VM controls follow observed lifecycle and forced repeated clicks cannot bypass readiness', async () => {
  const h = await browserHarness(); const field = id => h.document.getElementById(id);
  field('vmCmdInput').value = 'uname -a';
  await h.click('runVmCmdBtn'); assert.equal(h.vm.commands, 0);
  await h.click('bootVmBtn'); await h.click('bootVmBtn');
  assert.equal(h.vm.boots, 1); assert.equal(field('bootVmBtn').disabled, true);
  assert.equal(field('vmEvidence').attributes['data-experience-state'], 'vmBooting');
  h.vm.setPhase('ready');
  assert.equal(field('runVmCmdBtn').disabled, false);
  await h.click('runVmCmdBtn'); assert.equal(h.vm.commands, 1);
  assert.match(field('vmExplanation').textContent, /not evidence/);
  h.vm.setPhase('failed');
  assert.equal(field('runVmCmdBtn').disabled, true); assert.equal(field('bootVmBtn').disabled, false);
  await h.click('runVmCmdBtn'); assert.equal(h.vm.commands, 1);
});


test('actual pasted-pointer journey refuses duplicate JSON names before trust admission', async () => {
  const h = await browserHarness();
  await h.click('pinSessionAuthorityBtn');
  const input = h.document.getElementById('pointerJsonInput');
  input.value = '{"version":1,"\\u0076ersion":1}';
  await assert.rejects(h.click('admitPointerBtn'), code('InvalidCanonicalValue'));
});

test('actual browser recovery controls admit bounded files locally and model their evidence', async () => {
  const h = await browserHarness(); const field = id => h.document.getElementById(id);
  assert.equal(field('importRecoveryBtn').disabled, true);
  const program = demoProgram(3);
  const wire = await exportRecoveryBundle({ version: 1, objects: [await recoveryObject(new Uint8Array([5, 6]))],
    jobs: [{ program, checkpoint: await createCheckpoint(program, 1) }], anchors: [] });
  const bytes = new TextEncoder().encode(wire);
  let reads = 0;
  field('recoveryFile').files = [{ size: bytes.length, arrayBuffer: async () => { reads++; return bytes.buffer; } }];
  field('recoveryFile').listeners.change();
  assert.equal(field('importRecoveryBtn').disabled, false);
  const sent = h.mesh.sent.length, liveObjects = h.db.objects.size, liveJobs = h.coordinator.jobs.size;
  await h.click('importRecoveryBtn');
  assert.equal(reads, 1);
  assert.match(field('recoveryEvidence').textContent, /SESSION-ONLY VERIFIED EVIDENCE/);
  assert.equal(field('recoveryObjects').children.length, 1);
  assert.equal(field('recoveryJobs').children.length, 1);
  assert.equal(field('resumeRecoveredJobBtn').disabled, false);
  await h.click('resumeRecoveredJobBtn');
  assert.match(field('recoveryStatus').textContent, /Pure local replay finished at step 3/);
  assert.equal(h.mesh.sent.length, sent); assert.equal(h.db.objects.size, liveObjects);
  assert.equal(h.coordinator.jobs.size, liveJobs); assert.equal(h.vm.commands, 0); assert.equal(h.published.length, 0);
  field('recoveryByteLimit').value = '1';
  await h.click('importRecoveryBtn'); assert.equal(reads, 1);
  assert.match(field('recoveryStatus').textContent, /Refused/);
  assert.equal(field('recoveryObjects').children.length, 1);
});


test('browser exposes precise local errors, checks input ranges and reports clipboard failure honestly', async () => {
  const h = await browserHarness(); const field = id => h.document.getElementById(id);
  await h.click('copyCliProofBtn');
  assert.match(field('meshActionStatus').textContent, /Clipboard unavailable/);
  field('jobStepsInput').value = '1.5'; field('jobDelayInput').value = '800';
  await assert.rejects(h.click('startJobBtn'), /whole steps/);
  assert.match(field('computeActionStatus').textContent, /Action refused/);
  assert.equal(h.coordinator.jobs.size, 0);
  field('pointerAuthorityInput').value = 'a'.repeat(64); field('pointerAuthorityInput').listeners.input();
  assert.equal(field('pointerPublicationSetup').hidden, false, 'restart recovery must not require volatile object RAM');
  assert.equal(field('loadPublicationBtn').disabled, false);
  assert.equal(field('writeSignedDnsBtn').disabled, true);
});

test('browser keeps authority/storage failures beside the authority controls without inventing replacement success', async () => {
  class BrokenStore extends SyntheticAuthorityStore { transaction() { return Promise.reject(Error('synthetic storage unavailable')); } }
  const h = await browserHarness({ AuthorityClass: BrokenStore });
  await assert.rejects(h.click('saveAuthorityBtn'), /synthetic storage unavailable/);
  assert.match(h.document.getElementById('authorityStorageStatus').textContent, /setup failed/);
  assert.match(h.document.getElementById('pointersActionStatus').textContent, /synthetic storage unavailable/);
  assert.equal(h.document.getElementById('pointerAuthorityInput').value, '');
  assert.equal(h.published.length, 0);
});

test('browser stdout text remains accessible when output object storage refuses and stop is not labeled error', async () => {
  const h = await browserHarness(); const field = id => h.document.getElementById(id);
  h.vm.setPhase('ready'); field('vmCmdInput').value = 'echo output';
  h.db.put = async () => { throw Error('synthetic storage refusal'); };
  await h.click('runVmCmdBtn');
  assert.equal(field('vmStdoutText').textContent, 'observed guest stdout');
  assert.match(field('vmStdoutSummary').textContent, /21 observed bytes/);
  assert.match(field('vmActionStatus').textContent, /synthetic storage refusal/);
  h.vm.options.onStatus({ state: 'offline', message: 'VM stopped. Destroy before booting a fresh VM.' });
  assert.match(field('vmStatusLabel').textContent, /^VM stopped/);
  assert.doesNotMatch(field('vmStatusLabel').textContent, /ERROR/);
});


test('browser can reconcile an earlier retained command without selecting or replaying the latest command', async () => {
  let dispatches = 0;
  class RetainedVm extends LinuxVmNode {
    constructor(options) {
      super(options); this.vmPhase = 'Ready'; this.bootGeneration = 4;
      this.v86 = { fs9p: filesystemFixture(), keyboard_send_text() { dispatches++; } };
      this.v86.fs9p.setResult('done_earlier', Uint8Array.of(1));
      this.v86.fs9p.setResult('out_earlier', new TextEncoder().encode('earlier result'));
      for (const [id, outcome] of [['earlier', 'unknown'], ['latest', 'completed']]) {
        this.commands.set(id, { id, outcome, generation: 4, vm: this.v86, dispatched: true, outName: `out_${id}`, doneName: `done_${id}`, output: Uint8Array.of(9) });
      }
      this.lastCommandId = 'latest';
    }
  }
  const h = await browserHarness({ VmClass: RetainedVm }); const field = id => h.document.getElementById(id);
  field('vmCommandSelection').value = 'earlier'; field('vmCommandSelection').listeners.change();
  assert.equal(field('vmCommandSelection').children.length, 2);
  assert.equal(field('forgetVmCommandBtn').disabled, true, 'unknown effects must stay retained');
  assert.equal(field('reconcileVmCommandBtn').disabled, false);
  await h.click('reconcileVmCommandBtn');
  assert.equal(h.vm.lastCommandId, 'latest'); assert.equal(dispatches, 0);
  assert.equal(h.vm.commandEvidence('earlier').outcome, 'completed');
  assert.equal(field('vmStdoutText').textContent, 'earlier result');
  assert.match(field('vmStdoutSummary').textContent, /^Command earlier:/);
  assert.equal(field('forgetVmCommandBtn').disabled, false);
  await h.click('forgetVmCommandBtn');
  assert.equal(h.vm.commands.has('earlier'), false); assert.equal(h.vm.commands.has('latest'), true);
  assert.equal(field('vmStdoutText').textContent, 'Output preview forgotten.');
});


test('browser bounds text output without hiding its full byte length and distinguishes empty output', async () => {
  const h = await browserHarness(); const field = id => h.document.getElementById(id);
  h.vm.setPhase('ready'); field('vmCmdInput').value = 'large output';
  h.vm.executeShellCommand = async () => new Uint8Array(17000).fill(65);
  await h.click('runVmCmdBtn');
  assert.equal(field('vmStdoutText').textContent.length, 16384);
  assert.match(field('vmStdoutSummary').textContent, /17000 observed bytes. Showing first 16384 bytes/);
  h.vm.executeShellCommand = async () => new Uint8Array();
  await h.click('runVmCmdBtn');
  assert.equal(field('vmStdoutText').textContent, '(Empty output)');
  assert.match(field('vmStdoutSummary').textContent, /0 observed bytes/);
});


test('actual browser script restores an explicitly accepted recent anchor only into matching pin and resumes ordinary succession without effects', async () => {
  const h = await browserHarness(), field = id => h.document.getElementById(id);
  const authority = await generateAuthority(), now = Date.now();
  const body = { version: 1, name: 'state.example.test', authorityKey: authority.publicKey, revision: 7,
    previousDigest: 'sha256:' + 'a'.repeat(64), objectRoot: 'sha256:' + 'b'.repeat(64), validFromMs: now - 1000, validUntilMs: now + 100000 };
  const anchor = await signPointer(body, authority.privateKey);
  const bytes = new TextEncoder().encode(await exportRecoveryBundle({ version: 1, objects: [], jobs: [], anchors: [anchor] }));
  field('recoveryFile').files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  field('recoveryFile').listeners.change(); await h.click('importRecoveryBtn');
  assert.equal(field('restoreRecoveryAnchorBtn').disabled, true);
  field('recoveryAuthority').value = authority.publicKey; field('recoveryDigest').value = anchor.pointerDigest;
  field('recoveryAnchorConsent').checked = true; field('recoveryAnchorConsent').listeners.change();
  await h.click('acceptRecoveryAnchorBtn');
  assert.equal(field('restoreRecoveryAnchorBtn').disabled, true, 'acceptance must not repin live authority');
  field('pointerAuthorityInput').value = authority.publicKey; field('pointerAuthorityInput').listeners.input();
  assert.equal(field('restoreRecoveryAnchorBtn').disabled, false);
  assert.match(field('recoveryEvidence').textContent, /OPERATOR-ACCEPTED RECENT ANCHOR/);
  field('pointerJsonInput').value = JSON.stringify(anchor);
  await assert.rejects(h.click('admitPointerBtn'), code('pointer-bootstrap'));
  const sent = h.mesh.sent.length, requests = h.db.admission.state.spent.requests;
  await h.click('restoreRecoveryAnchorBtn');
  assert.match(field('recoveryEvidence').textContent, /STRICT SUCCESSION AVAILABLE/);
  const spent = h.db.admission.state.spent.storageBytes;
  await h.click('restoreRecoveryAnchorBtn'); assert.equal(h.db.admission.state.spent.storageBytes, spent);
  const next = await signPointer({ ...body, revision: 8, previousDigest: anchor.pointerDigest }, authority.privateKey);
  field('pointerJsonInput').value = JSON.stringify(next); await h.click('admitPointerBtn');
  assert.match(field('wireLogBox').textContent, /Retained revision 8/);
  assert.equal(field('restoreRecoveryAnchorBtn').disabled, true, 'old accepted head cannot roll back the successor');
  assert.equal(h.mesh.sent.length, sent); assert.equal(h.db.admission.state.spent.requests, requests);
  assert.deepEqual(h.dnsCalls, []); assert.equal(h.vm.commands, 0); assert.equal(h.vm.boots, 0);
  assert.equal(h.db.objects.size, 0); assert.equal(h.coordinator.jobs.size, 0);
});

test('browser cancellation reports pending whole-VM stop beside the selected command and never resolves prior effects', async () => {
  let finish, stops = 0;
  class CancelVm extends LinuxVmNode {
    constructor(options) {
      super(options); this.vmPhase = 'Ready'; this.bootGeneration = 1;
      this.v86 = { stop: () => { stops++; return new Promise(resolve => { finish = resolve; }); } };
      this.commands.set('selected', { id: 'selected', vm: this.v86, generation: 1, dispatched: true, outcome: 'unknown' });
      this.lastCommandId = 'selected';
    }
  }
  const h = await browserHarness({ VmClass: CancelVm }); const field = id => h.document.getElementById(id);
  field('vmCommandSelection').value = 'selected'; field('vmCommandSelection').listeners.change();
  assert.equal(field('cancelVmObservationBtn').disabled, false);
  const pending = h.click('cancelVmObservationBtn');
  assert.equal(stops, 1); assert.equal(field('cancelVmObservationBtn').disabled, true);
  assert.match(field('vmStatusLabel').textContent, /awaiting emulator confirmation/);
  assert.doesNotMatch(field('vmStatusLabel').textContent, /ERROR/);
  assert.match(field('vmCommandOutcome').textContent, /unknown.*stop-pending/);
  finish(); await pending;
  assert.match(field('vmCommandOutcome').textContent, /unknown.*vm-stopped/);
  assert.equal(field('forgetVmCommandBtn').disabled, true);
});

test('browser runtime entry validates before boot rather than silently resetting an invalid allowance', async () => {
  class RuntimeVm extends LinuxVmNode { boots = 0; boot() { this.boots++; } }
  const h = await browserHarness({ VmClass: RuntimeVm }); const field = id => h.document.getElementById(id);
  for (const input of ['', '0', '301', 'not a number']) {
    field('vmRuntimeSeconds').value = input; await h.click('bootVmBtn');
    assert.equal(h.vm.boots, 0); assert.match(field('vmActionStatus').textContent, /1–300 seconds/);
  }
  field('vmRuntimeSeconds').value = '2'; await h.click('bootVmBtn');
  assert.equal(h.vm.boots, 1); assert.equal(h.vm.vmRuntimeMs, 2000);
});

test('actual browser saved-key rotation is explicit, leaves the pin unchanged and requires a fresh explicit pin before signing', async () => {
  const h = await browserHarness(), field = id => h.document.getElementById(id);
  await h.click('saveAuthorityBtn');
  const original = field('pointerAuthorityInput').value;
  field('authorityLifecyclePanel').open = true;
  await field('authorityLifecyclePanel').listeners.toggle();
  // Toggle schedules inspection; an explicit storage inspection also waits for its render.
  await h.click('inspectAuthorityStorageBtn');
  field('authorityExpectedKey').value = original; field('authorityLifecycleConsent').checked = true;
  await h.click('rotateAuthorityBtn');
  assert.match(field('authorityLifecycleStatus').textContent, /New saved signer/);
  assert.equal(field('pointerAuthorityInput').value, original);
  await h.click('dbPutBtn');
  await h.click('writeSignedDnsBtn');
  assert.match(field('wireLogBox').textContent, /does not hold the private key/);
  assert.equal(field('pointerJsonInput').value, '');
  await h.click('pinSessionAuthorityBtn');
  assert.notEqual(field('pointerAuthorityInput').value, original);
  await h.click('writeSignedDnsBtn');
  assert.equal(JSON.parse(field('pointerJsonInput').value).authorityKey, field('pointerAuthorityInput').value);
  assert.deepEqual(h.dnsCalls, []);
});
