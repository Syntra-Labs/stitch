/** Origin-local persistence, not a backup. No credentials or exportable key bytes. */
import { generateAuthority } from './pointer.js';
import { model } from './generated-model.js';
const policy = (name, ...args) => model[`Stitch.Effects.${name}`](...args);
export class BrowserAuthorityStore {
  constructor({ indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks, database = 'stitch-authority-v1' } = {}) {
    this.indexedDB = indexedDB; this.database = database; this.locks = locks;
  }
  exclusivePublication(scope, work) {
    if (!this.locks?.request) throw Error('Web Locks unavailable; safe cross-tab publication is blocked.');
    // Browser releases this lock when the owner context terminates. There is no
    // timer takeover. The persistent unknown record still forbids another write.
    return this.locks.request(`stitch-dns:${this.database}:${scope}`, { mode: 'exclusive' }, work);
  }
  async open() {
    if (!this.indexedDB) throw Error('Browser storage unavailable; no persistent authority or publication was created.');
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.database, 1); let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(Error('Browser storage upgrade blocked; close other Stitch tabs.')); };
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    });
  }
  async transaction(key, change) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite', { durability: 'strict' });
        const store = tx.objectStore('records'); let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || Error('Browser storage transaction aborted; prior data retained.'));
        tx.onerror = () => {}; // Abort is the commit boundary, not request success.
        const read = store.get(key);
        read.onsuccess = () => {
          try {
            const update = change(read.result);
            result = update.result;
            if (update.write !== undefined) store.put(update.write, key);
          } catch (error) { tx.abort(); reject(error); }
        };
      });
    } finally { db.close(); }
  }
  read(key) { return this.transaction(key, value => ({ result: value ?? null })); }
  async restoreAuthority() {
    const value = await this.read('authority');
    if (!value) return null;
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.publicKey) || value.privateKey?.type !== 'private'
      || value.privateKey.extractable || value.privateKey.algorithm?.name !== 'Ed25519'
      || !value.privateKey.usages.includes('sign')) throw Error('Stored authority invalid; it was not replaced.');
    // Verify that stored public and private keys belong together, without exporting the private key.
    const challenge = new TextEncoder().encode('stitch/authority-storage-check/v1');
    const publicKey = await crypto.subtle.importKey('raw', Uint8Array.from(value.publicKey.match(/../g), x => parseInt(x, 16)), 'Ed25519', false, ['verify']);
    const signature = await crypto.subtle.sign('Ed25519', value.privateKey, challenge);
    if (!await crypto.subtle.verify('Ed25519', publicKey, signature, challenge)) throw Error('Stored authority key mismatch; it was not replaced.');
    return value;
  }
  async setupAuthority() {
    const existing = await this.restoreAuthority();
    if (!policy('authorityMayCreate', !!existing, true)) return existing;
    const created = { version: 1, ...await generateAuthority() };
    // Concurrent setup never replaces the authority that won the transaction.
    await this.transaction('authority', value => ({ result: null, write: value ?? created }));
    return this.restoreAuthority();
  }
  readPublication(scope) { return this.read(`dns:${scope}`); }
  claimPublication(scope, pending) {
    return this.transaction(`dns:${scope}`, prior => {
      const mayWrite = policy('journalMayClaim', prior?.outcome === 'unknown');
      if (!mayWrite) return { result: { prior, writer: false } };
      const owner = crypto.randomUUID();
      const write = { ...pending, owner };
      if (write.outcome !== 'unknown' || !write.candidate || write.pointerDigest !== write.candidate.pointerDigest) throw Error('Invalid write-ahead intent.');
      return { write, result: { prior, writer: true, owner } };
    });
  }
  finishPublication(scope, expectedDigest, owner, next) {
    return this.transaction(`dns:${scope}`, prior => {
      const allowed = policy('journalMayFinish', prior?.pointerDigest === expectedDigest,
        prior?.owner === owner, next.outcome === 'published');
      if (prior?.outcome === 'published' && next.outcome !== 'published') throw Error('Published journal cannot be downgraded by an older observation.');
      if (!allowed) throw Error('Publication journal changed; refresh and reconcile the retained candidate.');
      return { write: { ...next, owner: prior.owner }, result: null };
    });
  }
}
