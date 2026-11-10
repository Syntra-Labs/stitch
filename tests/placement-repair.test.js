import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveUorMeshDatabase } from '../src/layer3-storage/index.js';
import { reserveNetwork, ResourceAdmission } from '../src/layer2-schedulers/policy.js';
import { createObject, placementStatus } from '../src/layer3-storage/custody.js';
import { model } from '../src/layer1-uor/generated-model.js';
import { experienceFacts, experienceActionAllowed } from '../src/product-experience.js';

function network() {
  const nodes = [], sent = [], withheld = [];
  let filter = () => true;
  const node = (peerId, admission) => {
    const n = { peerId, peers: new Map(), admission,
      openPeers() { return [...this.peers].map(([remoteId, p]) => ({ remoteId, dc: p.route })); },
      sendToPeer(remoteId, packet) {
        const p = this.peers.get(remoteId);
        if (!p) return false;
        if (this.admission) reserveNetwork(this.admission, 'place', packet);
        const envelope = { from: this.peerId, to: remoteId, packet: structuredClone(packet) };
        sent.push(envelope);
        if (filter(envelope)) p.node.db.handleMeshMessage(this.peerId, envelope.packet);
        else withheld.push(envelope);
        return true;
      },
      broadcast(packet) { for (const id of this.peers.keys()) this.sendToPeer(id, packet); },
    };
    if (!admission) delete n.admission;
    n.db = new LiveUorMeshDatabase({ transport: n }); nodes.push(n); return n;
  };
  const connect = (a, b) => { a.peers.set(b.peerId, { node: b, route: {} }); b.peers.set(a.peerId, { node: a, route: {} }); };
  const disconnect = (a, b) => { a.peers.delete(b.peerId); b.peers.delete(a.peerId); };
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.all(nodes.map(n => n.db.flush())); };
  return { node, connect, disconnect, drain, sent, withheld, filter: f => { filter = f; } };
}
const shards = (n, from) => n.sent.filter(e => e.from === from && e.packet.type === 'uor_shard' && e.packet.purpose === 'placement');
const summary = (n, entry) => n.db.placementSummary(entry.addressHex);
const state = (n, entry) => n.db.placements.get(entry.addressHex);
const setup = async () => {
  const n = network(), writer = n.node('writer'), holders = [0, 1, 2].map(i => n.node(`h${i}`));
  for (const h of holders) n.connect(writer, h);
  const entry = await writer.db.put('exact retained object'); await n.drain();
  return { n, writer, holders, entry };
};

test('pre-join store and repeated store place retained bytes after peers join without fabricating writer shards', async () => {
  const n = network(), writer = n.node('writer');
  const entry = await writer.db.put('stored before joining');
  assert.equal(summary(writer, entry).committedFragments, 0);
  assert.equal(shards(n, 'writer').length, 0);
  const holders = [0, 1, 2].map(i => n.node(`h${i}`));
  for (const h of holders) n.connect(writer, h);
  assert.equal(await writer.db.put('stored before joining'), entry);
  await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 3);
  assert.deepEqual([...entry.heldIndices], []);
  assert.equal(shards(n, 'writer').length, 3);
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(shards(n, 'writer').length, 3, 'a complete repair is idempotent');
  await writer.db.clearLocal();
  const reader = n.node('reader'); n.connect(reader, holders[0]); n.connect(reader, holders[1]);
  await reader.db.syncFromNetwork(); await n.drain();
  assert.equal(reader.db.get(entry.addressHex).text, 'stored before joining');
});

test('partial placement fills only missing indices and holder loss retains unknown old copies until exact release', async () => {
  const n = network(), writer = n.node('writer'), h0 = n.node('h0'); n.connect(writer, h0);
  const entry = await writer.db.put('partial then churn'); await n.drain();
  const h1 = n.node('h1'), h2 = n.node('h2'); n.connect(writer, h1); n.connect(writer, h2);
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(shards(n, 'writer').length, 3); assert.equal(summary(writer, entry).committedFragments, 3);
  n.disconnect(writer, h0);
  assert.equal(summary(writer, entry).committedFragments, 2, 'a current lease is not current reachability');
  const replacement = n.node('replacement'); n.connect(writer, replacement);
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 3);
  assert.equal(summary(writer, entry).assertedCopies, 4, 'disconnection never proves deletion');
  assert.equal(state(writer, entry).copies.find(c => c.holder === 'h0').status, 'superseded');
  assert.deepEqual([...replacement.db.objects.get(entry.addressHex).heldIndices], [0]);
  n.connect(writer, h0);
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(summary(writer, entry).assertedCopies, 3);
  assert.deepEqual([...h0.db.objects.get(entry.addressHex).heldIndices], []);
  assert.equal(h0.db.objects.get(entry.addressHex).shards[0], null);
});

test('live migration keeps old custody through an unknown transfer and retires only after fresh receipt and exact release ACK', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const { n, writer, holders, entry } = await setup();
  const target = n.node('target'); n.connect(writer, target);
  writer.db.demoPlacementLeaseMs = 10;
  n.filter(e => !(e.from === 'target' && e.packet.type === 'uor_shard_ack'));
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
  const request = state(writer, entry).requests.at(-1);
  assert.equal(request.fromRequestId, state(writer, entry).copies.find(c => c.holder === 'h0').requestId);
  assert.equal(summary(writer, entry).committedFragments, 3);
  assert.equal(summary(writer, entry).requestedTransfers, 1);
  const before = shards(n, 'writer').length;
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
  assert.equal(shards(n, 'writer').length, before, 'no blind repeat of an unexpired unknown request');
  // Force only this transfer's lease observation to expire; original custody stays live.
  now = request.leaseExpiresAt;
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(state(writer, entry).requests.find(r => r.requestId === request.requestId).status, 'uncertain');
  assert.equal(summary(writer, entry).committedFragments, 3);
  n.filter(() => true); writer.db.demoPlacementLeaseMs = 60000;
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 3);
  assert.equal(summary(writer, entry).uncertainTransfers, 1);
  assert.equal(summary(writer, entry).assertedCopies, 3);
  assert.equal(state(writer, entry).copies.some(c => c.holder === 'h0'), false);
  assert.equal(holders[0].db.objects.get(entry.addressHex).shards[0], null);
});

test('all expired leases can renew at the same three holders, preserving assertions until fresh checks and not inflating copies', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const { n, writer, entry } = await setup();
  now += 60000;
  assert.equal(summary(writer, entry).committedFragments, 0);
  n.filter(e => e.packet.type !== 'uor_shard_ack');
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 0);
  assert.equal(summary(writer, entry).assertedCopies, 3, 'expired physical assertions stay accounted');
  assert.equal(summary(writer, entry).requestedTransfers, 3);
  n.filter(() => true);
  for (const e of n.withheld) await writer.db.handleMeshMessage(e.from, e.packet);
  await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 3);
  assert.equal(summary(writer, entry).assertedCopies, 3);
  assert.equal(state(writer, entry).requests.length, 6);
});

test('forged, stale, replayed and wrong-route receipts cannot establish custody or release the old source', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const n = network(), writer = n.node('writer'), holder = n.node('holder'); n.connect(writer, holder);
  n.filter(e => e.packet.type !== 'uor_shard_ack');
  const entry = await writer.db.put('receipts'); await n.drain();
  const ack = n.withheld[0].packet;
  for (const change of [{ holder: 'other' }, { manifestDigest: 'sha256:' + '0'.repeat(64) }, { fragmentDigest: 'sha256:' + '0'.repeat(64) },
    { index: 1 }, { requestId: 'unknown' }, { leaseExpiresAt: ack.leaseExpiresAt + 1 }]) {
    assert.equal(await writer.db.handleMeshMessage('holder', { ...ack, ...change }), false);
    assert.equal(summary(writer, entry).committedFragments, 0);
  }
  now = ack.leaseExpiresAt;
  assert.equal(await writer.db.handleMeshMessage('holder', ack), false);
  assert.equal(summary(writer, entry).uncertainTransfers, 1);
  n.filter(() => true);
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 1);
  assert.equal(await writer.db.handleMeshMessage('holder', ack), false);
  assert.equal(summary(writer, entry).committedFragments, 1);
  await holder.db.clearLocal(); n.connect(writer, holder); // same route ID, different data channel and empty RAM
  assert.equal(summary(writer, entry).committedFragments, 0);
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 1);
  assert.equal(summary(writer, entry).assertedCopies, 1);
});

test('epoch replacement cannot activate an old migration even when reservation IDs repeat, and charges remain retained', async () => {
  let clock = 0, active = new ResourceAdmission({ clock: () => clock, durationMs: 100 });
  const prior = active;
  const admission = { get state() { return active.state; }, reserve: (...args) => active.reserve(...args),
    reservationCurrent: (...args) => active.reservationCurrent(...args) };
  const n = network(), writer = n.node('writer', admission), holders = [0, 1, 2].map(i => n.node(`h${i}`));
  for (const h of holders) n.connect(writer, h);
  const entry = await writer.db.put('epoch bound migration'); await n.drain();
  const target = n.node('target'); n.connect(writer, target);
  n.filter(e => !(e.from === 'target' && e.packet.type === 'uor_shard_ack'));
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
  const old = n.withheld[0].packet, spent = prior.state.spent;
  active = new ResourceAdmission({ clock: () => clock, durationMs: 100 });
  assert.notEqual(active.state.epoch, prior.state.epoch);
  assert.equal(await writer.db.handleMeshMessage('target', old), false);
  assert.equal(summary(writer, entry).committedFragments, 3);
  assert.equal(summary(writer, entry).uncertainTransfers, 1);
  assert.equal(state(writer, entry).copies.find(c => c.holder === 'h0').status, 'committed');
  assert.deepEqual(prior.state.spent, spent);
  n.filter(() => true);
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
  assert.equal(summary(writer, entry).committedFragments, 3);
  assert.equal(state(writer, entry).copies.some(c => c.holder === 'h0'), false);
  clock = 100;
  await assert.rejects(writer.db.repairPlacement(entry.addressHex), e => e.code === 'epoch-expired');
});

test('lost release ACK retains superseded copies and exact retry never deletes a newer assignment', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const { n, writer, holders, entry } = await setup();
  const target = n.node('target'); n.connect(writer, target);
  writer.db.releaseAckTimeoutMs = 100;
  n.filter(e => e.packet.type !== 'uor_shard_release_ack');
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
  assert.equal(summary(writer, entry).assertedCopies, 4);
  assert.equal(summary(writer, entry).pendingReleases, 1);
  assert.equal(holders[0].db.objects.get(entry.addressHex).shards[0], null);
  const oldRelease = n.sent.find(e => e.packet.type === 'uor_shard_release').packet;
  // An exact lost-ACK release retry is safe and can establish known release.
  now += 100; n.filter(() => true);
  await writer.db.repairPlacement(entry.addressHex); await n.drain();
  assert.equal(summary(writer, entry).assertedCopies, 3);
  // Moving back creates a new exact assignment, so the earlier release is stale.
  writer.db.demoPlacementLeaseMs = 60000;
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'target' }); await n.drain();
  const held = holders[0].db.objects.get(entry.addressHex);
  assert.equal(held.heldIndices.has(0), true);
  assert.equal(await holders[0].db.handleMeshMessage('writer', oldRelease), false);
  assert.equal(held.heldIndices.has(0), true);
  assert.ok(held.shards[0]);
});

test('repair requires exact retained verified bytes and every source activation condition', async () => {
  const n = network(), writer = n.node('writer');
  const bundle = await createObject(new TextEncoder().encode('partial only'));
  await assert.rejects(writer.db.repairPlacement(bundle.manifest.object.contentDigest), e => e.code === 'MissingObject');
  const entry = await writer.db.put('original'); entry.bytes[0] ^= 1;
  await assert.rejects(writer.db.repairPlacement(entry.addressHex), e => e.code === 'ManifestDigestMismatch');
  await writer.db.put('original');
  assert.equal(writer.db.get(entry.addressHex).text, 'original', 'repeated Store restores a complete newly checked local copy');
  for (let mask = 0; mask < 16; mask++) {
    const flags = [0, 1, 2, 3].map(i => Boolean(mask & (1 << i)));
    assert.equal(model['Stitch.Custody.activationAllowed'](...flags), mask === 15);
  }
  for (let mask = 0; mask < 8; mask++) {
    const facts = experienceFacts({ placementObjectSelected: Boolean(mask & 1), peersReachable: Boolean(mask & 2), policyBlocked: Boolean(mask & 4) });
    assert.equal(experienceActionAllowed('repairPlacementBtn', facts), mask === 3);
  }
});

test('failed or ambiguous migration sends never replace old custody or refund their real reservation', async () => {
  for (const outcome of ['failed', 'uncertain']) {
    const { n, writer, entry } = await setup();
    const target = n.node('target'); n.connect(writer, target);
    const send = writer.sendToPeer.bind(writer);
    writer.sendToPeer = (id, packet) => {
      if (id !== 'target' || packet.purpose !== 'placement') return send(id, packet);
      if (outcome === 'uncertain') throw Error('unknown send outcome');
      return false;
    };
    const spent = writer.db.admission.state.spent;
    await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
    assert.equal(state(writer, entry).requests.at(-1).status, outcome);
    assert.equal(summary(writer, entry).committedFragments, 3);
    assert.equal(state(writer, entry).copies.find(c => c.holder === 'h0').status, 'committed');
    assert.ok(writer.db.admission.state.spent.storageBytes > spent.storageBytes);
    assert.ok(writer.db.admission.state.spent.requests >= spent.requests);
  }
});

test('mismatched or stale release ACKs cannot hide retained copies and old releases cannot remove another writer claim', async () => {
  const { n, writer, holders, entry } = await setup();
  const target = n.node('target'); n.connect(writer, target);
  n.filter(e => e.packet.type !== 'uor_shard_release_ack');
  await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
  const ack = n.withheld.find(e => e.packet.type === 'uor_shard_release_ack').packet;
  for (const change of [{ requestId: 'unrelated' }, { index: 1 }, { manifestDigest: 'sha256:' + '0'.repeat(64) }, { holder: 'other' }, { releaseId: 'unrelated' }]) {
    assert.equal(await writer.db.handleMeshMessage('h0', { ...ack, ...change }), false);
    assert.equal(summary(writer, entry).assertedCopies, 4);
  }
  assert.equal(await writer.db.handleMeshMessage('other', ack), false);
  // A second writer's assignment remains a live local fragment even after the
  // first writer's exact claim is released; physical absence is not inferred.
  const second = n.node('second'); n.connect(second, holders[0]); n.filter(() => true);
  await second.db.put('exact retained object'); await n.drain();
  const release = n.sent.find(e => e.packet.type === 'uor_shard_release').packet;
  assert.equal(await holders[0].db.handleMeshMessage('writer', release), true);
  await n.drain();
  assert.equal(holders[0].db.objects.get(entry.addressHex).heldIndices.has(0), true);
  assert.ok(holders[0].db.objects.get(entry.addressHex).shards[0]);
});

test('route and epoch changes while crypto awaits cannot publish tentative migration or retire its source', async t => {
  for (const phase of ['receipt-route', 'commit-epoch']) {
    const { n, writer, entry } = await setup();
    const target = n.node('target'); n.connect(writer, target);
    n.filter(e => !(e.from === 'target' && e.packet.type === 'uor_shard_ack'));
    await writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }); await n.drain();
    const ack = n.withheld[0].packet, priorAdmission = writer.db.admission, spent = priorAdmission.state.spent;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let entered, release, held = false;
    const atBoundary = new Promise(resolve => { entered = resolve; });
    const continueCrypto = new Promise(resolve => { release = resolve; });
    t.mock.method(crypto.subtle, 'digest', async (...args) => {
      const result = await digest(...args);
      const request = state(writer, entry).requests.find(r => r.requestId === ack.requestId);
      if (!held && (phase === 'receipt-route' || request.status === 'acknowledged')) {
        held = true; entered(); await continueCrypto;
      }
      return result;
    });
    const work = writer.db.handleMeshMessage('target', ack);
    await atBoundary;
    if (phase === 'receipt-route') n.connect(writer, target);
    else writer.db.admission = new ResourceAdmission();
    release();
    assert.equal(await work, false);
    t.mock.restoreAll(); await n.drain();
    assert.equal(summary(writer, entry).committedFragments, 3);
    assert.equal(state(writer, entry).copies.find(c => c.holder === 'h0').status, 'committed');
    assert.equal(state(writer, entry).requests.find(r => r.requestId === ack.requestId).status, 'uncertain');
    assert.equal(state(writer, entry).copies.find(c => c.holder === 'target').status, 'superseded');
    assert.equal(n.sent.some(e => e.packet.type === 'uor_shard_release'), false);
    assert.deepEqual(priorAdmission.state.spent, spent);
  }
});


test('placement clock regression refuses before dispatch and keeps original custody history', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const { n, writer, entry } = await setup();
  const target = n.node('target'); n.connect(writer, target);
  const history = state(writer, entry), sent = n.sent.length;
  now = 999;
  assert.throws(() => summary(writer, entry), e => e.code === 'ClockRegression');
  await assert.rejects(writer.db.repairPlacement(entry.addressHex, { replaceHolder: 'h0' }), e => e.code === 'ClockRegression');
  assert.deepEqual(state(writer, entry), history);
  assert.equal(n.sent.length, sent);
});
