import test from 'node:test';
import assert from 'node:assert/strict';
import { installAuthorityControls } from '../src/authority-ui.js';
import { SyntheticAuthorityStore } from './helpers/transactional-authority.js';
import { generateAuthority, signPointer, PointerObserver } from '../src/layer1-uor/pointer.js';
const name = 'state.example.test';
async function pointer(authority) { return signPointer({ version:1, name, authorityKey: authority.publicKey, revision:0, previousDigest:null,
  objectRoot:`sha256:${'d'.repeat(64)}`, validFromMs:0, validUntilMs:Number.MAX_SAFE_INTEGER }, authority.privateKey); }
async function setup() {
  const store = new SyntheticAuthorityStore(), authority = await store.setupAuthority(), head = await pointer(authority);
  const elements = new Map(), pins = new Map(), changed = [], downloads = [];
  function element() { return { value:'', checked:false, open:true, textContent:'', hidden:false, disabled:false, attributes:{}, listeners:{},
    setAttribute(key,value) { this.attributes[key] = value; }, addEventListener(type,handler) { (this.listeners[type] ??= []).push(handler); },
    async emit(type) { for (const handler of this.listeners[type] ?? []) await handler(); } }; }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id,element()); return elements.get(id); } };
  const get = id => document.getElementById(id);
  get('dnsQueryInput').value = name; get('pointerAuthorityInput').value = authority.publicKey;
  const observer = () => {
    const key = `${get('dnsQueryInput').value}:${get('pointerAuthorityInput').value}`;
    if (!pins.has(key)) pins.set(key,new PointerObserver({ name:get('dnsQueryInput').value, trustedAuthorityKey:get('pointerAuthorityInput').value, clock:()=>5, trustStore:store }));
    return pins.get(key);
  };
  await observer().admit(head);
  const ui = installAuthorityControls({ document, store, pointerObserver:observer, onAuthorityChanged:status=>changed.push(status), download:text=>downloads.push(text) });
  await ui.refresh();
  return { store, authority, head, ui, observer, get, changed, downloads, click:id=>get(id).emit('click') };
}
test('rotation is contextual, exact-key confirmed and leaves visible pin and observer unchanged', async () => {
  const t = await setup(), old = t.observer();
  await t.click('rotateAuthorityBtn'); assert.equal((await t.store.authorityStatus()).publicKey,t.authority.publicKey);
  t.get('authorityExpectedKey').value = t.authority.publicKey; t.get('authorityLifecycleConsent').checked = true;
  await t.click('rotateAuthorityBtn');
  assert.equal(t.changed.length,1); assert.notEqual(t.changed[0].publicKey,t.authority.publicKey);
  assert.equal(t.get('pointerAuthorityInput').value,t.authority.publicKey); assert.equal(old.head.pointerDigest,t.head.pointerDigest);
  assert.equal(t.get('authorityLifecycleConsent').checked,false); assert.match(t.get('authorityLifecycleStatus').textContent,/No trust pin or DNS record changed/);
});
test('closing a pending lifecycle operation cancels commit; repeated click cannot repeat it', async () => {
  const t = await setup(); let release, reached;
  const gate = new Promise(r=>release=r), entered = new Promise(r=>reached=r);
  const rotate = t.store.rotateAuthority.bind(t.store); let calls = 0;
  t.store.rotateAuthority = async args => { calls++; reached(); await gate; return rotate(args); };
  t.get('authorityExpectedKey').value = t.authority.publicKey; t.get('authorityLifecycleConsent').checked = true;
  const operation = t.click('rotateAuthorityBtn'); await entered;
  assert.equal(t.get('authorityLifecyclePanel').attributes['aria-busy'],'true');
  await t.click('rotateAuthorityBtn'); assert.equal(calls,1);
  t.get('authorityLifecyclePanel').open = false; await t.get('authorityLifecyclePanel').emit('toggle');
  release(); await operation;
  assert.equal(t.get('authorityLifecyclePanel').attributes['aria-busy'],'false');
  assert.equal((await t.store.authorityStatus()).publicKey,t.authority.publicKey);
  assert.match(t.get('authorityLifecycleStatus').textContent,/Refused or interrupted/);
  t.get('authorityLifecyclePanel').open=true; await t.get('authorityLifecyclePanel').emit('toggle');
  assert.equal(calls,1);
});
test('saving, migrating and restoring trust are separate explicit actions', async () => {
  const t = await setup();
  t.get('authorityAnchorKey').value=t.authority.publicKey; t.get('authorityAnchorDigest').value=t.head.pointerDigest; t.get('authorityAnchorConsent').checked=true;
  await t.click('saveTrustedAnchorBtn'); assert.equal((await t.store.trustedAnchor(name)).publicKey,t.authority.publicKey);
  const replacement = await generateAuthority(), next = await pointer(replacement);
  t.get('authorityAnchorKey').value=replacement.publicKey; t.get('authorityAnchorDigest').value=next.pointerDigest;
  t.get('pointerJsonInput').value=JSON.stringify(next); t.get('authorityAnchorConsent').checked=true;
  await t.click('migrateTrustedAnchorBtn');
  assert.equal((await t.store.trustedAnchor(name)).publicKey,replacement.publicKey);
  assert.equal(t.get('pointerAuthorityInput').value,t.authority.publicKey); assert.equal(t.observer().head.pointerDigest,t.head.pointerDigest);
  t.get('pointerAuthorityInput').value=replacement.publicKey; await t.get('pointerAuthorityInput').emit('input');
  await t.ui.refresh(); assert.equal(t.observer().head,null);
  await t.click('restoreTrustedAnchorBtn'); assert.equal(t.observer().head.pointerDigest,next.pointerDigest);
});
test('changing scope or anchor input clears consent, failed storage does not reset evidence, journal export is public', async () => {
  const t = await setup();
  for (const id of ['dnsQueryInput','pointerAuthorityInput','authorityExpectedKey','authorityAnchorKey','authorityAnchorDigest','pointerJsonInput']) {
    t.get('authorityAnchorConsent').checked=true; t.get('authorityLifecycleConsent').checked=true;
    await t.get(id).emit('input'); assert.equal(t.get('authorityAnchorConsent').checked,false); assert.equal(t.get('authorityLifecycleConsent').checked,false);
  }
  await t.click('exportAuthorityJournalBtn'); assert.equal(t.downloads.length,1); assert.equal(t.downloads[0].includes('privateKey'),false);
  t.store.fail = true; await t.click('inspectAuthorityStorageBtn'); t.store.fail = false;
  assert.equal((await t.store.authorityStatus()).publicKey,t.authority.publicKey);
  assert.match(t.get('authorityLifecycleStatus').textContent,/Nothing was reset|not reset/);
});
