/** Origin-local authority operations. Not a key backup or global revocation service. */
import { generateAuthority, signPointer, verifyPointer, admitPointer } from './pointer.js';
import { canonicalBytes } from './custody.js';
import { identifier, natural, digest } from './contracts.js';
import { model } from './generated-model.js';
const policy = (name, ...args) => model[`Stitch.Effects.${name}`](...args);
const lifecycle = (name, ...args) => model[`Stitch.Authority.${name}`](...args);
const keyValid = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const insist = (condition, message) => { if (!condition) throw Error(message); };
const generation = value => value?.version === 1 ? 0 : value?.generation;
const active = value => value?.version === 1 || value?.status === 'active';
const authorityState = value => ({ generation: value ? generation(value) : 0, present: !!value, revoked: !!value && !active(value) });
function validateAuthority(value) {
  if (value == null) return null;
  insist((value.version === 1 || value.version === 2) && keyValid(value.publicKey), 'Stored authority invalid; it was not replaced.');
  if (value.version === 2) {
    natural(value.generation); natural(value.updatedAtMs);
    insist(['active', 'revoked'].includes(value.status) && Array.isArray(value.history) && value.history.length <= 64,
      'Stored authority lifecycle invalid; it was not replaced.');
    const seen = new Set([value.publicKey]);
    value.history.forEach((entry, index) => {
      insist(keyValid(entry.publicKey) && !seen.has(entry.publicKey) && entry.generation === index,
        'Stored authority history invalid; it was not replaced.');
      seen.add(entry.publicKey); natural(entry.revokedAtMs);
    });
    insist(value.generation === value.history.length, 'Stored authority generation invalid.');
  }
  if (active(value)) insist(value.privateKey?.type === 'private' && value.privateKey.extractable === false
    && value.privateKey.algorithm?.name === 'Ed25519' && value.privateKey.usages.includes('sign'), 'Stored signing key invalid; it was not replaced.');
  else insist(value.privateKey === null, 'Revoked authority retains an unexpected key.');
  return value;
}
function validateTrust(value) {
  if (value == null) return null;
  insist(value.version === 1 && ['active', 'revoked'].includes(value.status) && keyValid(value.publicKey)
    && value.head?.authorityKey === value.publicKey && value.head?.name === value.name, 'Stored trust anchor invalid; it was not replaced.');
  identifier(value.name); natural(value.generation); digest(value.head.pointerDigest);
  insist(Array.isArray(value.history) && value.history.length === value.generation && value.generation <= 64, 'Stored trust history invalid.');
  for (const entry of value.history) { insist(keyValid(entry.publicKey) && ['active','revoked'].includes(entry.status), 'Stored trust history invalid.'); digest(entry.pointerDigest); }
  return value;
}
export class BrowserAuthorityStore {
  constructor({ indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks,
    storage = globalThis.navigator?.storage, clock = Date.now, database = 'stitch-authority-v1' } = {}) {
    this.indexedDB = indexedDB; this.database = database; this.locks = locks; this.storage = storage; this.clock = clock;
  }
  exclusiveAuthority(work) {
    if (!this.locks?.request) throw Error('Web Locks unavailable; safe cross-tab authority operations are blocked.');
    return this.locks.request(`stitch-authority:${this.database}`, { mode: 'exclusive' }, work);
  }
  exclusivePublication(scope, work) {
    // One origin lifecycle lock excludes revoke/rotate while a dispatch is in
    // flight. No timer takeover. Unknown intent survives owner termination.
    return this.exclusiveAuthority(() => this.locks.request(`stitch-dns:${this.database}:${scope}`, { mode: 'exclusive' }, work));
  }
  async open() {
    if (!this.indexedDB) throw Error('Browser storage unavailable; no persistent authority or publication was created.');
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.database, 1); let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(Error('Browser storage upgrade blocked; close other Stitch tabs.')); };
      request.onsuccess = () => { if (blocked) request.result.close(); else { request.result.onversionchange = () => request.result.close(); resolve(request.result); } };
    });
  }
  async transactionMany(keys, change) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite', { durability: 'strict' });
        const store = tx.objectStore('records'), values = new Map(); let result, remaining = keys.length;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || Error('Browser storage transaction aborted; prior data retained.'));
        tx.onerror = () => {}; // Abort is the commit boundary, not request success.
        for (const key of keys) {
          const read = store.get(key);
          read.onsuccess = () => {
            values.set(key, read.result);
            if (--remaining) return;
            try {
              const update = change(values); result = update.result;
              for (const [key, value] of update.writes ?? []) { insist(keys.includes(key), 'Unscoped browser transaction.'); store.put(value, key); }
              for (const key of update.deletes ?? []) { insist(keys.includes(key), 'Unscoped browser transaction.'); store.delete(key); }
            } catch (error) { tx.abort(); reject(error); }
          };
        }
      });
    } finally { db.close(); }
  }
  transaction(key, change) {
    return this.transactionMany([key], values => {
      const update = change(values.get(key));
      return { result: update.result, writes: update.write === undefined ? [] : [[key, update.write]], deletes: update.delete ? [key] : [] };
    });
  }
  async records() {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readonly'), values = [];
        tx.oncomplete = () => resolve(values); tx.onabort = () => reject(tx.error || Error('Browser storage scan aborted.')); tx.onerror = () => {};
        const cursor = tx.objectStore('records').openCursor();
        cursor.onsuccess = () => { if (cursor.result) { values.push([cursor.result.key, cursor.result.value]); cursor.result.continue(); } };
      });
    } finally { db.close(); }
  }
  read(key) { return this.transaction(key, value => ({ result: value ?? null })); }
  async authorityStatus() {
    const value = validateAuthority(await this.read('authority'));
    return value ? { publicKey: value.publicKey, generation: generation(value), status: active(value) ? 'active' : 'revoked', history: (value.history ?? []).map(entry => ({ publicKey: entry.publicKey, generation: entry.generation, revokedAtMs: entry.revokedAtMs })) } : null;
  }
  async restoreAuthority() {
    const value = validateAuthority(await this.read('authority'));
    if (!value) return null;
    insist(active(value), 'Saved authority revoked locally. Explicit rotation is required; setup cannot replace it.');
    const challenge = new TextEncoder().encode('stitch/authority-storage-check/v1');
    const publicKey = await crypto.subtle.importKey('raw', Uint8Array.from(value.publicKey.match(/../g), x => parseInt(x, 16)), 'Ed25519', false, ['verify']);
    const signature = await crypto.subtle.sign('Ed25519', value.privateKey, challenge);
    insist(await crypto.subtle.verify('Ed25519', publicKey, signature, challenge), 'Stored authority key mismatch; it was not replaced.');
    return value;
  }
  async setupAuthority() {
    return this.exclusiveAuthority(async () => {
      const existing = await this.restoreAuthority();
      if (!policy('authorityMayCreate', !!existing, true)) return existing;
      const created = { version: 1, ...await generateAuthority() };
      await this.transaction('authority', value => ({ result: null, write: value ?? created }));
      return this.restoreAuthority();
    });
  }
  async signPointer(body, expectedPublicKey) {
    body = structuredClone(body);
    return this.exclusiveAuthority(async () => {
      const authority = await this.restoreAuthority();
      insist(lifecycle('maySign', authorityState(authority), authority?.publicKey === expectedPublicKey,
        body.authorityKey === expectedPublicKey), 'Saved authority changed, missing or revoked; no pointer signed.');
      return signPointer(body, authority.privateKey);
    });
  }
  rotateAuthority({ expectedPublicKey, confirmed = false, scopeStillCurrent = () => true, nowMs = Date.now() }) {
    return this.exclusiveAuthority(async () => {
      natural(nowMs);
      // Generation happens only for an explicit operation. Commit CAS still
      // preserves the prior key on quota/abort and never changes a trust pin.
      insist(confirmed === true && keyValid(expectedPublicKey), 'Confirm the exact authority to rotate.');
      const pair = await generateAuthority();
      await this.transaction('authority', prior => {
        validateAuthority(prior);
        insist(lifecycle('rotationAllowed', confirmed && scopeStillCurrent() === true, !!prior, prior?.publicKey === expectedPublicKey,
          (prior?.history?.length ?? 0) < 64), 'Authority changed or lifecycle history full; rotation refused.');
        const next = lifecycle('rotate', authorityState(prior), confirmed, true, true);
        const history = [...(prior.history ?? []), { publicKey: prior.publicKey, generation: generation(prior), revokedAtMs: nowMs }];
        return { result: null, write: { version: 2, ...pair, status: next.revoked ? 'revoked' : 'active', generation: Number(next.generation), history, updatedAtMs: nowMs } };
      });
      return this.authorityStatus();
    });
  }
  revokeAuthority({ expectedPublicKey, confirmed = false, scopeStillCurrent = () => true, nowMs = Date.now() }) {
    return this.exclusiveAuthority(() => this.transaction('authority', prior => {
      validateAuthority(prior); natural(nowMs);
      insist(lifecycle('revocationAllowed', confirmed === true && scopeStillCurrent() === true, !!prior, prior?.publicKey === expectedPublicKey), 'Confirm the exact saved authority to revoke.');
      const next = lifecycle('revoke', authorityState(prior), confirmed, true);
      const write = { ...prior, version: 2, status: next.revoked ? 'revoked' : 'active', generation: Number(next.generation), privateKey: null,
        history: prior.history ?? [], updatedAtMs: nowMs };
      return { write, result: { publicKey: write.publicKey, status: write.status, generation: write.generation } };
    }));
  }
  async trustedAnchor(name) { identifier(name); return validateTrust(await this.read(`trust:${name}`)); }
  async assertTrustedAuthority(name, publicKey) {
    const trust = await this.trustedAnchor(name);
    insist(!trust || trust.status === 'active' && trust.publicKey === publicKey, 'This name has a different or revoked saved trust anchor; explicit migration is required.');
    return trust;
  }
  async saveTrustedAnchor({ candidate, expectedAuthorityKey, expectedPointerDigest, confirmed = false, scopeStillCurrent = () => true, nowMs }) {
    return this.exclusiveAuthority(async () => {
      candidate = structuredClone(candidate); if (nowMs !== undefined) natural(nowMs); digest(expectedPointerDigest);
      insist(confirmed === true && keyValid(expectedAuthorityKey), 'Independently confirm the exact anchor key and digest.');
      await verifyPointer(candidate, expectedAuthorityKey);
      insist(candidate.pointerDigest === expectedPointerDigest && candidate.validFromMs <= (nowMs ?? this.clock()) && (nowMs ?? this.clock()) < candidate.validUntilMs,
        'Trust anchor digest or validity mismatch.');
      const key = `trust:${candidate.name}`;
      return this.transaction(key, prior => {
        validateTrust(prior);
        const now = nowMs ?? this.clock(); natural(now);
        insist(candidate.validFromMs <= now && now < candidate.validUntilMs, 'Trust anchor expired before storage commit.');
        insist(lifecycle('anchorSaveAllowed', confirmed, scopeStillCurrent() === true, !prior,
          prior?.status === 'active' && prior?.publicKey === expectedAuthorityKey && prior?.head.pointerDigest === expectedPointerDigest), 'A different saved anchor exists; explicit migration is required.');
        const write = prior ?? { version: 1, name: candidate.name, publicKey: expectedAuthorityKey, head: candidate, status: 'active', generation: 0, history: [] };
        return { write, result: write };
      });
    });
  }
  async migrateTrustedAnchor({ name, expectedAuthorityKey, expectedPointerDigest, newAuthorityKey, newPointerDigest,
    candidate, confirmed = false, scopeStillCurrent = () => true, nowMs }) {
    return this.exclusiveAuthority(async () => {
      identifier(name); if (nowMs !== undefined) natural(nowMs); digest(expectedPointerDigest); digest(newPointerDigest); candidate = structuredClone(candidate);
      insist(confirmed === true && keyValid(newAuthorityKey), 'Independently confirm the replacement authority and exact anchor.');
      await verifyPointer(candidate, newAuthorityKey);
      insist(candidate.name === name && candidate.pointerDigest === newPointerDigest && candidate.validFromMs <= (nowMs ?? this.clock()) && (nowMs ?? this.clock()) < candidate.validUntilMs,
        'Replacement anchor scope, digest or validity mismatch.');
      return this.transaction(`trust:${name}`, prior => {
        validateTrust(prior);
        const now = nowMs ?? this.clock(); natural(now);
        insist(candidate.validFromMs <= now && now < candidate.validUntilMs, 'Replacement anchor expired before storage commit.');
        insist(lifecycle('migrationAllowed', confirmed, scopeStillCurrent() === true, !!prior,
          prior?.publicKey === expectedAuthorityKey && prior?.head.pointerDigest === expectedPointerDigest,
          (prior?.history?.length ?? 0) < 64), 'Trust anchor changed or history full; migration refused.');
        insist(lifecycle('anchorChronologyAllowed', prior.publicKey === newAuthorityKey, candidate.revision < prior.head.revision,
          candidate.revision === prior.head.revision, candidate.pointerDigest === prior.head.pointerDigest,
          candidate.revision === prior.head.revision + 1, candidate.previousDigest === prior.head.pointerDigest),
          'Same-key anchor rollback, fork or wrong adjacent predecessor refused.');
        insist(!prior.history.some(entry => entry.publicKey === newAuthorityKey && entry.publicKey !== prior.publicKey) && !(prior.status === 'revoked' && prior.publicKey === newAuthorityKey), 'A retired trust key cannot be reactivated; use an independently accepted new key.');
        const next = lifecycle('migrate', { generation: prior.generation, present: true, revoked: prior.status === 'revoked' }, confirmed, true, true, true);
        const write = { version: 1, name, publicKey: newAuthorityKey, head: candidate, status: next.revoked ? 'revoked' : 'active', generation: Number(next.generation),
          history: [...prior.history, { publicKey: prior.publicKey, pointerDigest: prior.head.pointerDigest, status: prior.status }] };
        return { write, result: write };
      });
    });
  }
  async retainTrustedHead({ name, expectedPointerDigest, candidate, nowMs = Date.now() }) {
    return this.exclusiveAuthority(async () => {
      candidate = structuredClone(candidate);
      const prior = await this.trustedAnchor(name);
      insist(prior?.status === 'active', 'Saved trust anchor missing or revoked.');
      await verifyPointer(candidate, prior.publicKey);
      if (candidate.pointerDigest !== prior.head.pointerDigest) await admitPointer(prior.head, candidate, {
        name, trustedAuthorityKey: prior.publicKey, nowMs });
      return this.transaction(`trust:${name}`, current => {
        validateTrust(current);
        insist(current?.status === 'active' && current.publicKey === prior.publicKey
          && current.head.pointerDigest === prior.head.pointerDigest
          && (current.head.pointerDigest === expectedPointerDigest || current.head.pointerDigest === candidate.pointerDigest),
          'Saved trust head changed; restore its exact anchor before succession.');
        const write = { ...current, head: candidate }; return { write, result: write };
      });
    });
  }
  async revokeTrustedAnchor({ name, expectedAuthorityKey, expectedPointerDigest, confirmed = false, scopeStillCurrent = () => true }) {
    identifier(name);
    return this.exclusiveAuthority(() => this.transaction(`trust:${name}`, prior => {
      validateTrust(prior);
      insist(lifecycle('revocationAllowed', confirmed === true && scopeStillCurrent() === true, !!prior,
        prior?.publicKey === expectedAuthorityKey && prior?.head.pointerDigest === expectedPointerDigest), 'Saved anchor changed; revocation refused.');
      const write = { ...prior, status: 'revoked' }; return { write, result: write };
    }));
  }
  readPublication(scope) { return this.read(`dns:${scope}`); }
  claimPublication(scope, pending) {
    return this.transactionMany([`dns:${scope}`, 'authority', `trust:${pending.candidate?.name}`], values => {
      const prior = values.get(`dns:${scope}`), authority = validateAuthority(values.get('authority'));
      const trust = validateTrust(values.get(`trust:${pending.candidate?.name}`));
      if (!policy('journalMayClaim', prior?.outcome === 'unknown')) return { result: { prior, writer: false } };
      const publicKey = pending.candidate?.authorityKey;
      const retired = authority && ((!active(authority) && authority.publicKey === publicKey) || authority.history?.some(x => x.publicKey === publicKey));
      insist(lifecycle('publicationAllowed', !!retired, !trust || trust.status === 'active' && trust.publicKey === publicKey), 'Writer key or saved trust revoked/changed; only existing unknown reconciliation is allowed.');
      const owner = crypto.randomUUID(), write = { ...pending, owner };
      insist(write.outcome === 'unknown' && write.candidate && write.pointerDigest === write.candidate.pointerDigest, 'Invalid write-ahead intent.');
      return { writes: [[`dns:${scope}`, write]], result: { prior, writer: true, owner } };
    });
  }
  finishPublication(scope, expectedDigest, owner, next) {
    return this.transaction(`dns:${scope}`, prior => {
      const allowed = policy('journalMayFinish', prior?.pointerDigest === expectedDigest, prior?.owner === owner, next.outcome === 'published');
      if (prior?.outcome === 'published' && next.outcome !== 'published') throw Error('Published journal cannot be downgraded by an older observation.');
      insist(allowed, 'Publication journal changed; refresh and reconcile the retained candidate.');
      return { write: { ...next, owner: prior.owner }, result: null };
    });
  }
  async inspectStorage() {
    const [estimate, persistent, rows] = await Promise.all([this.storage?.estimate?.() ?? {}, this.storage?.persisted?.() ?? null, this.records()]);
    return { usageBytes: Number.isFinite(estimate.usage) ? estimate.usage : null, quotaBytes: Number.isFinite(estimate.quota) ? estimate.quota : null,
      persistent, journalEntries: rows.filter(([key]) => key.startsWith('dns:')).length,
      unknownEntries: rows.filter(([key, value]) => key.startsWith('dns:') && value?.outcome === 'unknown').length,
      assurance: 'Origin-wide estimates and persistence permission do not guarantee retention or provide a backup.' };
  }
  async requestPersistence({ confirmed = false } = {}) {
    insist(confirmed === true, 'Explicit storage persistence request required.');
    insist(this.storage?.persist, 'Browser storage persistence request unavailable.');
    return this.storage.persist();
  }
  async exportPublicJournal() {
    const rows = await this.records(), publications = [], anchors = [];
    let authority = null;
    for (const [key, value] of rows) {
      if (key === 'authority') { validateAuthority(value); authority = { publicKey: value.publicKey, generation: generation(value), status: active(value) ? 'active' : 'revoked', history: (value.history ?? []).map(entry => ({ publicKey: entry.publicKey, generation: entry.generation, revokedAtMs: entry.revokedAtMs })) }; }
      if (key.startsWith('trust:')) { validateTrust(value); await verifyPointer(value.head, value.publicKey); anchors.push({ version: 1, name: value.name, publicKey: value.publicKey, head: value.head, status: value.status, generation: value.generation, history: value.history.map(entry => ({ publicKey: entry.publicKey, pointerDigest: entry.pointerDigest, status: entry.status })) }); }
      if (key.startsWith('dns:')) {
        const scope = JSON.parse(key.slice(4));
        insist(Array.isArray(scope) && /^[a-f0-9]{32}$/.test(scope[0]) && keyValid(scope[2]), 'Invalid journal scope.'); identifier(scope[1]); digest(value.pointerDigest);
        insist(value.recordId == null || typeof value.recordId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.recordId), 'Invalid provider identity.');
        insist(scope.length === 3 && ['unknown','published','refused'].includes(value.outcome), 'Corrupt publication journal; export refused.');
        const entry = { scope, outcome: value.outcome, pointerDigest: value.pointerDigest, recordId: value.recordId ?? null };
        if (value.outcome === 'unknown') { await verifyPointer(value.candidate, scope[2]); entry.candidate = value.candidate; }
        publications.push(entry);
      }
    }
    return new TextDecoder().decode(canonicalBytes({ version: 1, kind: 'stitch-public-authority-journal', authority, anchors, publications,
      warning: 'Public evidence only. No signing keys, tokens or automatic journal import. Preserve unknown candidates and provider identities independently before clearing browser data.' }));
  }
  async compactRefusedJournal({ confirmed = false, scopeStillCurrent = () => true } = {}) {
    insist(confirmed === true, 'Explicit refused-journal cleanup required.');
    return this.exclusiveAuthority(async () => {
      let removed = 0;
      for (const [key] of await this.records()) {
        if (!key.startsWith('dns:')) continue;
        removed += await this.transaction(key, prior => {
          const allowed = lifecycle('journalRemovalAllowed', confirmed && scopeStillCurrent() === true, prior?.outcome === 'refused', prior?.recordId == null);
          return { delete: allowed, result: allowed ? 1 : 0 };
        });
      }
      return removed;
    });
  }
}
