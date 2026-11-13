import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticAuthorityStore } from './helpers/transactional-authority.js';
import { BrowserAuthorityStore } from '../src/layer1-uor/browser-authority.js';
import { generateAuthority, signPointer, PointerObserver, PointerPublisher } from '../src/layer1-uor/pointer.js';
import { model } from '../src/layer1-uor/generated-model.js';
const name = 'state.example.test', zoneId = 'b'.repeat(32), objectRoot = `sha256:${'a'.repeat(64)}`;
async function pointer(authority, revision = 0, previousDigest = null) {
  return signPointer({ version: 1, name, authorityKey: authority.publicKey, revision, previousDigest,
    objectRoot, validFromMs: 0, validUntilMs: 100 }, authority.privateKey);
}
async function save(store, candidate) {
  return store.saveTrustedAnchor({ candidate, expectedAuthorityKey: candidate.authorityKey, expectedPointerDigest: candidate.pointerDigest, confirmed: true, nowMs: 5 });
}
function observer(store, publicKey) { return new PointerObserver({ name, trustedAuthorityKey: publicKey, clock: () => 5, trustStore: store }); }
function pending(candidate, recordId = null) { return { outcome: 'unknown', candidate, pointerDigest: candidate.pointerDigest, recordId }; }
function scope(candidate) { return JSON.stringify([zoneId, candidate.name, candidate.authorityKey]); }

test('model refuses absent/changed/unconfirmed lifecycle decisions and any uncertain journal removal', () => {
  const rule = (name, ...args) => model[`Stitch.Authority.${name}`](...args);
  for (const op of ['rotationAllowed','revocationAllowed','migrationAllowed']) {
    const count = op === 'rotationAllowed' ? 4 : op === 'migrationAllowed' ? 5 : 3;
    assert.equal(rule(op, ...Array(count).fill(true)), true);
    for (let n = 0; n < count; n++) { const args = Array(count).fill(true); args[n] = false; assert.equal(rule(op, ...args), false); }
  }
  assert.equal(rule('publicationAllowed', true, true), false);
  assert.equal(rule('publicationAllowed', false, false), false);
  for (const confirmed of [true, false]) for (const noIdentity of [true, false]) assert.equal(rule('journalRemovalAllowed', confirmed, false, noIdentity), false);
});
test('explicit rotation retains tombstones, all journals and saved trust, never repins', async () => {
  const store = new SyntheticAuthorityStore(), first = await store.setupAuthority(), p = await pointer(first);
  await save(store, p); await store.claimPublication(scope(p), pending(p));
  const next = await store.rotateAuthority({ expectedPublicKey: first.publicKey, confirmed: true, nowMs: 10 });
  assert.notEqual(next.publicKey, first.publicKey); assert.equal(next.generation, 1);
  assert.deepEqual(next.history, [{ publicKey: first.publicKey, generation: 0, revokedAtMs: 10 }]);
  assert.equal((await store.restoreAuthority()).privateKey.extractable, false);
  assert.equal((await store.setupAuthority()).publicKey, next.publicKey);
  assert.equal((await store.trustedAnchor(name)).publicKey, first.publicKey);
  assert.deepEqual((await store.readPublication(scope(p))).candidate, p);
  const otherName = { ...p, name: 'other.example.test' };
  await assert.rejects(store.claimPublication(scope(otherName), pending(otherName)), /revoked\/changed/);
  await assert.rejects(store.signPointer({ ...p }, first.publicKey), /changed/);
});
test('revocation survives restart and refuses setup and saved signing without pretending to retract signatures', async () => {
  const store = new SyntheticAuthorityStore(), first = await store.setupAuthority(), candidate = await pointer(first);
  await store.revokeAuthority({ expectedPublicKey: first.publicKey, confirmed: true, nowMs: 10 });
  const restart = new SyntheticAuthorityStore(store.state);
  assert.equal((await restart.authorityStatus()).status, 'revoked');
  await assert.rejects(restart.restoreAuthority(), /revoked/); await assert.rejects(restart.setupAuthority(), /revoked/);
  await assert.rejects(restart.signPointer(candidate, first.publicKey), /revoked/);
  assert.equal(store.state.records.get('authority').privateKey, null);
  // Local revocation is intentionally not cryptographic erasure of old handles.
  const { verifyPointer } = await import('../src/layer1-uor/pointer.js');
  await verifyPointer(candidate, first.publicKey);
  const next = await restart.rotateAuthority({ expectedPublicKey: first.publicKey, confirmed: true });
  assert.notEqual(next.publicKey, first.publicKey);
});
test('wrong exact key, no consent, stale UI and commit failure preserve authority and journals', async () => {
  const store = new SyntheticAuthorityStore(), first = await store.setupAuthority(), candidate = await pointer(first);
  await store.claimPublication(scope(candidate), pending(candidate));
  const before = structuredClone([...store.state.records]);
  for (const args of [{ expectedPublicKey: first.publicKey }, { expectedPublicKey: 'f'.repeat(64), confirmed: true },
    { expectedPublicKey: first.publicKey, confirmed: true, scopeStillCurrent: () => false }]) {
    await assert.rejects(store.rotateAuthority(args));
    await assert.rejects(store.revokeAuthority(args));
  }
  store.fail = true;
  await assert.rejects(store.rotateAuthority({ expectedPublicKey: first.publicKey, confirmed: true }), /quota/);
  await assert.rejects(store.revokeAuthority({ expectedPublicKey: first.publicKey, confirmed: true }), /quota/);
  store.fail = false; assert.deepEqual([...store.state.records], before);
});
test('origin lock waits for dispatch, revocation then blocks new old-key writes but permits exact reconciliation', async () => {
  const store = new SyntheticAuthorityStore(), authority = await store.setupAuthority(), candidate = await pointer(authority);
  let release, entered; const gate = new Promise(r => release = r), reached = new Promise(r => entered = r);
  let records = [], writes = 0;
  const resolver = { async listCloudflareRecords() { return records; }, async writeCloudflareRecord(input) {
    writes++; entered(); await gate; records = [{ ...input, id: 'record-one' }]; throw Error('lost acknowledgement');
  } };
  const publisher = () => new PointerPublisher({ journal: new SyntheticAuthorityStore(store.state), resolver, clock: () => 5 });
  const request = { zoneId, name, apiToken: 'not-exportable', trustedAuthorityKey: authority.publicKey, candidate };
  const first = publisher().publish(request); await reached;
  let revoked = false;
  const revocation = store.revokeAuthority({ expectedPublicKey: authority.publicKey, confirmed: true }).then(() => revoked = true);
  await new Promise(r => setTimeout(r, 10)); assert.equal(revoked, false);
  release(); assert.equal((await first).outcome, 'unknown'); await revocation;
  assert.equal((await publisher().publish(request)).outcome, 'published'); assert.equal(writes, 1);
  const next = await pointer(authority, 1, candidate.pointerDigest);
  await assert.rejects(publisher().publish({ ...request, candidate: next }), /revoked\/changed/);
  assert.equal(writes, 1);
});
test('saved exact heads restore explicitly, advance transactionally and reject stale reload bootstrap', async () => {
  const store = new SyntheticAuthorityStore(), authority = await generateAuthority(), first = await pointer(authority);
  await save(store, first);
  const live = observer(store, authority.publicKey);
  assert.equal(live.head, null);
  await live.restoreFromTrustedAnchor({ expectedDigest: first.pointerDigest });
  const next = await pointer(authority, 1, first.pointerDigest);
  store.fail = true; await assert.rejects(live.admit(next)); store.fail = false;
  assert.equal(live.head.pointerDigest, first.pointerDigest);
  await live.admit(next); assert.equal((await store.trustedAnchor(name)).head.pointerDigest, next.pointerDigest);
  const reloaded = observer(new SyntheticAuthorityStore(store.state), authority.publicKey);
  await assert.rejects(reloaded.admit(first), /pointer-conflict|restore/); assert.equal(reloaded.head, null);
  await assert.rejects(reloaded.restoreFromTrustedAnchor({ expectedDigest: first.pointerDigest }), /changed/);
  await reloaded.restoreFromTrustedAnchor({ expectedDigest: next.pointerDigest });
  assert.equal(reloaded.head.pointerDigest, next.pointerDigest);
});
test('migration requires exact independently accepted scope, refuses stale/canceled acceptance, never changes old observer', async () => {
  const store = new SyntheticAuthorityStore(), old = await generateAuthority(), replacement = await generateAuthority();
  const a = await pointer(old), b = await pointer(replacement, 7, objectRoot); await save(store, a);
  const live = observer(store, old.publicKey); await live.restoreFromTrustedAnchor({ expectedDigest: a.pointerDigest });
  const migration = { name, expectedAuthorityKey: old.publicKey, expectedPointerDigest: a.pointerDigest,
    newAuthorityKey: replacement.publicKey, newPointerDigest: b.pointerDigest, candidate: b, confirmed: true, nowMs: 5 };
  for (const patch of [{ confirmed: false }, { newPointerDigest: objectRoot }, { expectedPointerDigest: objectRoot },
    { newAuthorityKey: old.publicKey }, { scopeStillCurrent: () => false }, { nowMs: 100 }]) await assert.rejects(store.migrateTrustedAnchor({ ...migration, ...patch }));
  await store.migrateTrustedAnchor(migration);
  assert.equal(live.trustedAuthorityKey, old.publicKey); assert.equal(live.head.pointerDigest, a.pointerDigest);
  await assert.rejects(live.admit(await pointer(old, 1, a.pointerDigest)), /different or revoked/);
  const newLive = observer(store, replacement.publicKey);
  await assert.rejects(newLive.admit(b), /bootstrap/);
  await newLive.restoreFromTrustedAnchor({ expectedDigest: b.pointerDigest });
  await newLive.admit(await pointer(replacement, 8, b.pointerDigest));
  await assert.rejects(store.migrateTrustedAnchor(migration), /changed/);
});
test('local trust revocation blocks admission and new claims while retaining head, journal and migration path', async () => {
  const store = new SyntheticAuthorityStore(), authority = await generateAuthority(), p = await pointer(authority); await save(store, p);
  const live = observer(store, authority.publicKey); await live.restoreFromTrustedAnchor({ expectedDigest: p.pointerDigest });
  await store.claimPublication(scope(p), pending(p));
  await store.revokeTrustedAnchor({ name, expectedAuthorityKey: authority.publicKey, expectedPointerDigest: p.pointerDigest, confirmed: true });
  await assert.rejects(live.admit(await pointer(authority, 1, p.pointerDigest)), /revoked/);
  await assert.rejects(observer(store, authority.publicKey).restoreFromTrustedAnchor({ expectedDigest: p.pointerDigest }), /revoked/);
  const replacement = await generateAuthority(), next = await pointer(replacement);
  await assert.rejects(store.migrateTrustedAnchor({ name, expectedAuthorityKey: authority.publicKey, expectedPointerDigest: p.pointerDigest,
    newAuthorityKey: authority.publicKey, newPointerDigest: p.pointerDigest, candidate: p, confirmed: true, nowMs: 5 }), /retired/);
  await store.migrateTrustedAnchor({ name, expectedAuthorityKey: authority.publicKey, expectedPointerDigest: p.pointerDigest,
    newAuthorityKey: replacement.publicKey, newPointerDigest: next.pointerDigest, candidate: next, confirmed: true, nowMs: 5 });
  assert.deepEqual((await store.readPublication(scope(p))).candidate, p);
});
test('anchor validity and UI scope are checked at transaction commit after crypto', async () => {
  const store = new SyntheticAuthorityStore(), authority = await generateAuthority(), p = await pointer(authority);
  let now = 5; store.clock = () => now;
  const original = store.transaction.bind(store);
  store.transaction = (key, work) => { if (key.startsWith('trust:')) now = 100; return original(key, work); };
  await assert.rejects(store.saveTrustedAnchor({ candidate: p, expectedAuthorityKey: authority.publicKey, expectedPointerDigest: p.pointerDigest, confirmed: true }), /expired/);
  assert.equal(await store.trustedAnchor(name), null);
});
test('quota inspection, explicit persistence and public export do not leak keys, tokens or mutation ownership', async () => {
  const store = new SyntheticAuthorityStore(), a = await store.setupAuthority(), p = await pointer(a); await save(store, p);
  await store.claimPublication(scope(p), pending(p));
  let asks = 0; store.storage = { estimate: async () => ({ usage: 100, quota: 900 }), persisted: async () => false, persist: async () => { asks++; return false; } };
  assert.deepEqual(await store.inspectStorage(), { usageBytes: 100, quotaBytes: 900, persistent: false, journalEntries: 1, unknownEntries: 1,
    assurance: 'Origin-wide estimates and persistence permission do not guarantee retention or provide a backup.' });
  await assert.rejects(store.requestPersistence()); assert.equal(asks, 0);
  assert.equal(await store.requestPersistence({ confirmed: true }), false); assert.equal(asks, 1);
  const wire = await store.exportPublicJournal(), data = JSON.parse(wire);
  assert.deepEqual(data.publications[0].candidate, p); assert.equal(data.authority.publicKey, a.publicKey);
  for (const secret of ['privateKey','owner','not-exportable']) assert.equal(wire.includes(secret), false);
  assert.equal(await new BrowserAuthorityStore({ indexedDB: null }).requestPersistence({ confirmed: true }).catch(() => 'unsupported'), 'unsupported');
});
test('compaction never removes unknown writes, published heads, provider identities or trust/key tombstones', async () => {
  const store = new SyntheticAuthorityStore(), a = await store.setupAuthority(), p = await pointer(a); await save(store, p);
  for (const [suffix, state] of [['unknown', pending(p)], ['published',{ outcome:'published', pointerDigest:p.pointerDigest, recordId:'record-one' }],
    ['refused-update',{ outcome:'refused', pointerDigest:p.pointerDigest, recordId:'record-one' }], ['refused-create',{ outcome:'refused', pointerDigest:p.pointerDigest, recordId:null }]]) store.state.records.set(`dns:${suffix}`, state);
  await assert.rejects(store.compactRefusedJournal());
  assert.equal(await store.compactRefusedJournal({ confirmed:true }), 1);
  assert.equal(store.state.records.has('dns:refused-create'), false);
  for (const key of ['authority',`trust:${name}`,'dns:unknown','dns:published','dns:refused-update']) assert.equal(store.state.records.has(key), true);
});

test('same-key reanchoring refuses rollback and forks and does not pretend missing intermediate links were checked', async () => {
  const store = new SyntheticAuthorityStore(), authority = await generateAuthority(), first = await pointer(authority); await save(store, first);
  const jump = await pointer(authority, 9, objectRoot);
  const request = { name, expectedAuthorityKey:authority.publicKey, expectedPointerDigest:first.pointerDigest,
    newAuthorityKey:authority.publicKey, newPointerDigest:jump.pointerDigest, candidate:jump, confirmed:true, nowMs:5 };
  await store.migrateTrustedAnchor(request);
  assert.equal((await store.trustedAnchor(name)).head.pointerDigest,jump.pointerDigest);
  await assert.rejects(store.migrateTrustedAnchor({ ...request, expectedPointerDigest:jump.pointerDigest, newPointerDigest:first.pointerDigest, candidate:first }), /rollback/);
  const fork = await pointer(authority,9,first.pointerDigest);
  await assert.rejects(store.migrateTrustedAnchor({ ...request, expectedPointerDigest:jump.pointerDigest, newPointerDigest:fork.pointerDigest, candidate:fork }), /fork/);
  const adjacent = await pointer(authority,10,first.pointerDigest);
  await assert.rejects(store.migrateTrustedAnchor({ ...request, expectedPointerDigest:jump.pointerDigest, newPointerDigest:adjacent.pointerDigest, candidate:adjacent }), /predecessor/);
  await assert.rejects(store.retainTrustedHead({ name, expectedPointerDigest:jump.pointerDigest, candidate:{ ...jump, revision:0 }, nowMs:5 }), /integrity/);
});

test('saved trust revocation waits for a provider dispatch and never discards its unresolved candidate', async () => {
  const store = new SyntheticAuthorityStore(), authority = await generateAuthority(), p = await pointer(authority); await save(store, p);
  let reached, release, writes = 0; const entered = new Promise(r=>reached=r), gate = new Promise(r=>release=r);
  const resolver = { async listCloudflareRecords() { return []; }, async writeCloudflareRecord() { writes++; reached(); await gate; throw Error('interrupted'); } };
  const publisher = new PointerPublisher({ journal:store, resolver, clock:()=>5 });
  const publication = publisher.publish({ zoneId, name, trustedAuthorityKey:authority.publicKey, candidate:p, apiToken:'never-export' });
  await entered;
  let finished = false;
  const revoke = store.revokeTrustedAnchor({ name, expectedAuthorityKey:authority.publicKey, expectedPointerDigest:p.pointerDigest, confirmed:true }).then(()=>finished=true);
  await new Promise(r=>setTimeout(r,10)); assert.equal(finished,false);
  release(); assert.equal((await publication).outcome,'unknown'); await revoke;
  assert.deepEqual((await store.readPublication(scope(p))).candidate,p); assert.equal(writes,1);
  assert.equal((await publisher.publish({ zoneId, name, trustedAuthorityKey:authority.publicKey, candidate:p, apiToken:'never-export' })).outcome,'unknown');
  assert.equal(writes,1);
});
