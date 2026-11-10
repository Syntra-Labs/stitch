import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticAuthorityStore } from './helpers/transactional-authority.js';
import { BrowserAuthorityStore } from '../src/layer1-uor/browser-authority.js';
import { generateAuthority, signPointer, PointerPublisher, pointerDnsText } from '../src/layer1-uor/pointer.js';
async function fixture() {
  const journal = new SyntheticAuthorityStore(), authority = await generateAuthority();
  const name = 'state.example.test', zoneId = 'a'.repeat(32);
  const candidate = await signPointer({ version: 1, name, authorityKey: authority.publicKey, revision: 0,
    previousDigest: null, objectRoot: `sha256:${'f'.repeat(64)}`, validFromMs: 0, validUntilMs: 100 }, authority.privateKey);
  let records = [], writes = 0, mode = 'lost';
  const resolver = {
    async listCloudflareRecords() { return structuredClone(records); },
    async writeCloudflareRecord(input) {
      writes++;
      const saved = await journal.readPublication(JSON.stringify([zoneId, name, authority.publicKey]));
      assert.deepEqual(saved.candidate, candidate); assert.equal(saved.outcome, 'unknown');
      if (mode !== 'absent') records = [{ ...input, id: 'record-1' }];
      if (mode !== 'success') throw Error('lost response');
      return { outcome: 'published', ok: true, id: 'record-1' };
    }
  };
  const args = { zoneId, name, trustedAuthorityKey: authority.publicKey, candidate, apiToken: 'never-save-this' };
  const publisher = () => new PointerPublisher({ resolver, journal: new SyntheticAuthorityStore(journal.state), clock: () => 5 });
  return { journal, authority, args, publisher, resolver, writes: () => writes, mode: value => mode = value,
    rows: value => records = value };
}
test('explicit setup persists nonextractable same authority; restore never creates or rotates', async () => {
  const store = new SyntheticAuthorityStore();
  assert.equal(await store.restoreAuthority(), null);
  const [a, b] = await Promise.all([store.setupAuthority(), store.setupAuthority()]);
  assert.equal(a.publicKey, b.publicKey); assert.equal(a.privateKey.extractable, false);
  assert.equal((await new SyntheticAuthorityStore(store.state).restoreAuthority()).publicKey, a.publicKey);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', a.privateKey));
  store.fail = true; await assert.rejects(store.setupAuthority()); store.fail = false;
  assert.equal((await store.restoreAuthority()).publicKey, a.publicKey);
});
test('unavailable or corrupt storage never substitutes a new signing authority', async () => {
  await assert.rejects(new BrowserAuthorityStore({ indexedDB: null }).restoreAuthority());
  const store = new SyntheticAuthorityStore(); store.state.records.set('authority', { version: 1 });
  await assert.rejects(store.setupAuthority()); assert.deepEqual(store.state.records.get('authority'), { version: 1 });
});
test('lost result survives restart and exact read reconciles with no repeated mutation', async () => {
  const f = await fixture(); assert.equal((await f.publisher().publish(f.args)).outcome, 'unknown');
  const restarted = f.publisher(); assert.deepEqual(await restarted.restore(f.args), f.args.candidate);
  assert.equal((await restarted.publish(f.args)).outcome, 'published'); assert.equal(f.writes(), 1);
  assert.equal(JSON.stringify([...f.journal.state.records]).includes('never-save-this'), false);
});
test('absent observation after interruption cannot authorize retry, even for a new candidate', async () => {
  const f = await fixture(); f.mode('absent'); await f.publisher().publish(f.args);
  const next = await signPointer({ ...Object.fromEntries(Object.entries(f.args.candidate).filter(([k]) => !['signature','pointerDigest'].includes(k))),
    revision: 1, previousDigest: f.args.candidate.pointerDigest }, f.authority.privateKey);
  assert.equal((await f.publisher().publish({ ...f.args, candidate: next })).outcome, 'unknown');
  assert.equal(f.writes(), 1);
});
test('concurrent tabs obtain one transactional mutation owner', async () => {
  const f = await fixture(); f.mode('absent');
  const results = await Promise.all([f.publisher().publish(f.args), f.publisher().publish(f.args)]);
  assert.deepEqual(results.map(x => x.outcome), ['unknown', 'unknown']); assert.equal(f.writes(), 1);
});
test('claim commit failure prevents all provider mutation and preserves prior bytes', async () => {
  const f = await fixture(); f.journal.fail = true;
  const publisher = new PointerPublisher({ resolver: f.resolver, journal: f.journal, clock: () => 5 });
  await assert.rejects(publisher.publish(f.args)); assert.equal(f.writes(), 0); assert.equal(f.journal.state.records.size, 0);
});
test('failure to commit exact post-read intent blocks dispatch and permits repaired explicit retry', async () => {
  const f = await fixture(); f.journal.fail = 2;
  const publisher = new PointerPublisher({ resolver: f.resolver, journal: f.journal, clock: () => 5 });
  await assert.rejects(publisher.publish(f.args), /quota/); assert.equal(f.writes(), 0);
  assert.equal(await f.publisher().restore(f.args), null);
  assert.equal((await f.publisher().publish(f.args)).outcome, 'unknown'); assert.equal(f.writes(), 1);
});
test('completion persistence failure retains unknown and later reads reconcile', async () => {
  const f = await fixture(); f.mode('success');
  // load prior, claim exact pending, adapter inspection read, then completion
  f.journal.fail = 4;
  const publisher = new PointerPublisher({ resolver: f.resolver, journal: f.journal, clock: () => 5 });
  assert.equal((await publisher.publish(f.args)).outcome, 'unknown');
  assert.equal((await f.publisher().publish(f.args)).outcome, 'published'); assert.equal(f.writes(), 1);
});
test('missing Web Locks refuses publication instead of unsafe cross-tab fallback', async () => {
  const f = await fixture();
  const store = new BrowserAuthorityStore({ locks: null });
  const publisher = new PointerPublisher({ resolver: f.resolver, journal: store });
  await assert.rejects(publisher.publish(f.args), /Web Locks/); assert.equal(f.writes(), 0);
});
test('a suspended live writer holds the lock until completion; another tab cannot reconcile past it', async () => {
  const f = await fixture(); let unblock, entered;
  const reached = new Promise(resolve => entered = resolve), gate = new Promise(resolve => unblock = resolve);
  const original = f.resolver.writeCloudflareRecord;
  f.resolver.writeCloudflareRecord = async input => { entered(); await gate; return original(input); };
  const first = f.publisher().publish(f.args); await reached;
  let secondDone = false;
  const second = f.publisher().publish(f.args).then(value => { secondDone = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(secondDone, false); assert.equal(f.writes(), 0);
  unblock(); await first; assert.equal((await second).outcome, 'published'); assert.equal(f.writes(), 1);
});
test('provider read failure leaves no unknown claim and repaired explicit retry writes once', async () => {
  const f = await fixture(); const original = f.resolver.listCloudflareRecords;
  f.resolver.listCloudflareRecords = async () => { throw Error('read unavailable'); };
  await assert.rejects(f.publisher().publish(f.args), /read unavailable/);
  assert.equal(await f.publisher().restore(f.args), null); assert.equal(f.writes(), 0);
  f.resolver.listCloudflareRecords = original;
  assert.equal((await f.publisher().publish(f.args)).outcome, 'unknown'); assert.equal(f.writes(), 1);
  assert.equal((await f.publisher().publish(f.args)).outcome, 'published'); assert.equal(f.writes(), 1);
});
test('exhausted admission before provider read does not wedge publication after renewal', async () => {
  const f = await fixture(); let exhausted = true, reads = 0;
  f.resolver.admission = { reserve() { if (exhausted) throw Error('resource epoch exhausted'); } };
  const original = f.resolver.listCloudflareRecords;
  f.resolver.listCloudflareRecords = async () => { reads++; return original(); };
  await assert.rejects(f.publisher().publish(f.args), /epoch exhausted/);
  assert.equal(reads, 0); assert.equal(f.writes(), 0); assert.equal(await f.publisher().restore(f.args), null);
  exhausted = false;
  await f.publisher().publish(f.args); assert.equal(f.writes(), 1);
  await f.publisher().publish(f.args); assert.equal(f.writes(), 1);
});
test('provably undispatched adapter refusal settles owned claim and permits explicit repair', async () => {
  const f = await fixture(); const original = f.resolver.writeCloudflareRecord;
  f.resolver.writeCloudflareRecord = async () => { throw Object.assign(Error('local adapter refusal'), { effectDispatched: false }); };
  await assert.rejects(f.publisher().publish(f.args), /local adapter refusal/);
  assert.equal(await f.publisher().restore(f.args), null); assert.equal(f.writes(), 0);
  assert.equal([...f.journal.state.records.values()][0].outcome, 'refused');
  f.resolver.writeCloudflareRecord = original;
  await f.publisher().publish(f.args); await f.publisher().publish(f.args); assert.equal(f.writes(), 1);
});
test('failure to save definite undispatched refusal remains conservatively unknown', async () => {
  const f = await fixture();
  f.resolver.writeCloudflareRecord = async () => { throw Object.assign(Error('local adapter refusal'), { effectDispatched: false }); };
  f.journal.fail = 3; // load, claim, then refusal settlement abort
  const publisher = new PointerPublisher({ resolver: f.resolver, journal: f.journal, clock: () => 5 });
  assert.equal((await publisher.publish(f.args)).outcome, 'unknown');
  assert.deepEqual(await f.publisher().restore(f.args), f.args.candidate);
  assert.equal((await f.publisher().publish(f.args)).outcome, 'unknown'); assert.equal(f.writes(), 0);
});
