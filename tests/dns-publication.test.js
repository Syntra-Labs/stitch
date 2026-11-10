import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAuthority, signPointer, PointerPublisher, pointerDnsText } from '../src/layer1-uor/pointer.js';
import { DohResolver } from '../src/layer5-transport/index.js';
import { ResourceAdmission } from '../src/layer2-schedulers/policy.js';

const zoneId = 'a'.repeat(32), name = 'state.example.test';
const code = expected => error => error.code === expected;
async function fixture() {
  const authority = await generateAuthority();
  const make = (revision = 0, previousDigest = null, other = {}) => signPointer({ version: 1, name,
    authorityKey: authority.publicKey, revision, previousDigest, objectRoot: 'sha256:' + 'f'.repeat(64),
    validFromMs: 0, validUntilMs: 100, ...other }, authority.privateKey);
  const first = await make();
  const calls = []; let rows = [], mode = 'success', listing = null;
  const admission = new ResourceAdmission({ clock: () => 0 });
  const resolver = new DohResolver({ admission, fetchImpl: async (url, options) => {
    const method = options.method ?? 'GET'; calls.push({ url, method, options });
    if (method === 'GET') {
      if (mode === 'read-fails') throw Error('unavailable');
      return Response.json(listing ?? { success: true, result: rows,
        result_info: { page: 1, count: rows.length, total_count: rows.length, total_pages: 1 } });
    }
    if (mode === 'refused') return Response.json({ success: false, errors: [{ message: 'rejected' }] }, { status: 403 });
    if (mode === 'malformed') return new Response('broken');
    if (mode !== 'lost-not-created') rows = [{ id: 'record-1', ...JSON.parse(options.body) }];
    if (mode.startsWith('lost-')) throw Error('lost response');
    return Response.json({ success: true, result: { id: 'record-1' } });
  } });
  const publisher = new PointerPublisher({ resolver, clock: () => 5 });
  const args = candidate => ({ zoneId, apiToken: 'secret-token', name, trustedAuthorityKey: authority.publicKey, candidate });
  return { authority, make, first, calls, admission, resolver, publisher, args,
    setMode(value) { mode = value; }, setRows(value) { rows = value; }, setListing(value) { listing = value; } };
}

test('lost POST response is reconciled by exact signed read without a duplicate write', async () => {
  const f = await fixture(); f.setMode('lost-created');
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'unknown');
  assert.deepEqual(f.publisher.pending(f.args(f.first)), f.first);
  assert.equal(JSON.stringify(f.publisher.pending(f.args(f.first))).includes('secret-token'), false);
  const result = await f.publisher.publish(f.args(f.first));
  assert.equal(result.outcome, 'published'); assert.equal(result.reconciled, true);
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'POST', 'GET']);
  assert.equal(f.publisher.pending(f.args(f.first)), null);
});

test('unknown create with no visible record stays unknown across reads and zone case changes', async () => {
  const f = await fixture(); f.setMode('lost-not-created');
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'unknown');
  assert.equal((await f.publisher.publish({ ...f.args(f.first), zoneId: zoneId.toUpperCase() })).outcome, 'unknown');
  f.setMode('read-fails');
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'unknown');
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'POST', 'GET', 'GET']);
  const next = await f.make(1, f.first.pointerDigest);
  assert.equal((await f.publisher.publish(f.args(next))).outcome, 'unknown');
  assert.equal(f.calls.length, 4);
});

test('successor publication reads exact predecessor and reuses provider ID for PUT', async () => {
  const f = await fixture();
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'published');
  const next = await f.make(1, f.first.pointerDigest);
  assert.equal((await f.publisher.publish(f.args(next))).outcome, 'published');
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'POST', 'GET', 'PUT']);
  assert.ok(f.calls.at(-1).url.endsWith('/record-1'));
  f.setRows([]);
  await assert.rejects(f.publisher.publish(f.args(await f.make(2, next.pointerDigest))), code('dns-record-missing'));
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 2);
});

test('foreign, forged, and conflicting DNS records never authorize overwrite', async () => {
  const f = await fixture();
  const foreign = await generateAuthority();
  const wrong = await signPointer({ version: 1, name, authorityKey: foreign.publicKey, revision: 0, previousDigest: null,
    objectRoot: 'sha256:' + 'a'.repeat(64), validFromMs: 0, validUntilMs: 100 }, foreign.privateKey);
  const conflict = await f.make(0, null, { objectRoot: 'sha256:' + 'b'.repeat(64) });
  for (const candidate of [wrong, { ...f.first, signature: '0'.repeat(128) }, conflict]) {
    f.setRows([{ id: 'record-1', name, type: 'TXT', content: pointerDnsText(candidate) }]);
    await assert.rejects(f.publisher.publish(f.args(f.first)));
  }
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('incomplete, paginated, multiple, and wrong-name provider listings refuse before mutation', async () => {
  const f = await fixture();
  const row = { id: 'record-1', name, type: 'TXT', content: pointerDnsText(f.first) };
  for (const listing of [
    { success: true, result: [] },
    { success: true, result: [], result_info: { page: 1, count: 0, total_count: 1, total_pages: 2 } },
    { success: true, result: [row, row], result_info: { page: 1, count: 2, total_count: 2, total_pages: 1 } },
    { success: true, result: [{ ...row, name: 'other.test' }], result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }
  ]) { f.setListing(listing); await assert.rejects(f.publisher.publish(f.args(f.first))); }
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('provider rejection permits a later explicit retry; malformed mutation response remains unknown', async () => {
  const f = await fixture(); f.setMode('refused');
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'refused');
  f.setMode('malformed');
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'unknown');
  f.setMode('success');
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'unknown');
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'POST', 'GET', 'POST', 'GET']);
});

test('concurrent calls refuse and candidate/credentials are snapshotted before async work', async () => {
  const f = await fixture();
  const args = f.args(structuredClone(f.first));
  const work = f.publisher.publish(args);
  args.apiToken = 'replacement-token'; args.zoneId = 'b'.repeat(32); args.candidate.objectRoot = 'sha256:' + '0'.repeat(64);
  await assert.rejects(f.publisher.publish(f.args(f.first)), code('dns-publication-in-flight'));
  assert.equal((await work).outcome, 'published');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  for (const call of f.calls) {
    assert.ok(call.url.includes(zoneId));
    assert.equal(call.options.headers.authorization, 'Bearer secret-token');
  }
});

test('DNS lookup reserves its bounded response before the GET and failed work retains charges', async () => {
  let calls = 0;
  const admission = new ResourceAdmission({ clock: () => 0,
    limit: { requests: 1, transferBytes: 1000000, storageBytes: 0, computeSteps: 0 } });
  const resolver = new DohResolver({ admission, fetchImpl: async () => { calls++; throw Error('network'); } });
  await assert.rejects(resolver.listCloudflareRecords({ zoneId, apiToken: 'secret-token', name }), /network/);
  assert.equal(admission.state.spent.requests, 1);
  assert.ok(admission.state.spent.transferBytes >= resolver.maxResponseBytes);
  await assert.rejects(resolver.listCloudflareRecords({ zoneId, apiToken: 'secret-token', name }), code('budget-exhausted'));
  assert.equal(calls, 1);
});

test('uncertain PUT does not repeat against a still-visible predecessor', async () => {
  const f = await fixture();
  await f.publisher.publish(f.args(f.first));
  const next = await f.make(1, f.first.pointerDigest);
  f.setMode('lost-not-created');
  assert.equal((await f.publisher.publish(f.args(next))).outcome, 'unknown');
  assert.equal((await f.publisher.publish(f.args(next))).outcome, 'unknown');
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'POST', 'GET', 'PUT', 'GET']);
});

test('expired unresolved candidate can still reconcile its earlier provider write', async () => {
  const f = await fixture(); f.setMode('lost-created');
  await f.publisher.publish(f.args(f.first));
  f.publisher.clock = () => 200;
  assert.equal((await f.publisher.publish(f.args(f.first))).outcome, 'published');
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'POST', 'GET']);
});

test('publication-state capacity is reserved before provider I/O', async () => {
  const f = await fixture();
  f.resolver.admission = new ResourceAdmission({ clock: () => 0,
    limit: { requests: 10, transferBytes: 1000000, storageBytes: 0, computeSteps: 0 } });
  await assert.rejects(f.publisher.publish(f.args(f.first)), code('budget-exhausted'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.publisher.pending(f.args(f.first)), null);
});
