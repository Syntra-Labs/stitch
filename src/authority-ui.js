/** Contextual origin-local administration. No network or automatic trust changes. */
import { model } from './layer1-uor/generated-model.js';
import { parseCanonicalJson } from './layer1-uor/custody.js';
const controls = { inspectAuthorityStorageBtn: 0, rotateAuthorityBtn: 1, revokeAuthorityBtn: 2,
  saveTrustedAnchorBtn: 3, restoreTrustedAnchorBtn: 4, migrateTrustedAnchorBtn: 5,
  revokeTrustedAnchorBtn: 6, persistAuthorityStorageBtn: 7, exportAuthorityJournalBtn: 8, compactAuthorityJournalBtn: 9 };
export function installAuthorityControls({ document, store, pointerObserver, onAuthorityChanged = () => {}, onChange = () => {},
  download = text => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'stitch-public-authority-journal.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } }) {
  const get = id => document.getElementById(id), panel = get('authorityLifecyclePanel');
  let busy = false, version = 0, status = null, trust = null;
  const scope = () => [get('dnsQueryInput').value.trim(), get('pointerAuthorityInput').value.trim()];
  const message = text => { get('authorityLifecycleStatus').textContent = text; onChange(); };
  function invalidate() { version++; get('authorityLifecycleConsent').checked = false; get('authorityAnchorConsent').checked = false; }
  for (const id of ['dnsQueryInput','pointerAuthorityInput','authorityExpectedKey','authorityAnchorKey','authorityAnchorDigest','pointerJsonInput']) get(id).addEventListener('input', invalidate);
  panel.addEventListener('toggle', () => { if (!panel.open) invalidate(); });
  function allowed(id) {
    let hasHead = false;
    try { hasHead = !!pointerObserver().head; } catch {}
    return model['Stitch.Authority.controlAllowed'](controls[id], busy, !!status, status?.status === 'active', hasHead, !!trust);
  }
  function render() {
    for (const id of Object.keys(controls)) get(id).disabled = !allowed(id);
    get('authoritySignerControls').hidden = !status;
    get('authorityTrustControls').hidden = !trust;
    panel.setAttribute('aria-busy', String(busy));
  }
  async function refresh() {
    const current = scope().join(':');
    status = await store.authorityStatus();
    const saved = scope()[0] ? await store.trustedAnchor(scope()[0]) : null;
    if (current === scope().join(':')) trust = saved;
    get('authoritySavedSummary').textContent = status
      ? `Saved signer ${status.publicKey}; generation ${status.generation}; ${status.status}. Rotation never transfers trust.` : 'No saved signer. Missing storage does not prove that an earlier provider effect never happened.';
    get('authorityTrustSummary').textContent = trust
      ? `Saved trust for ${trust.name}: ${trust.publicKey}, exact head ${trust.head.pointerDigest}; ${trust.status}.` : 'No saved trust anchor for this name. Independently confirm the current admitted head before saving it.';
    render();
  }
  async function run(id, work) {
    if (busy) return;
    if (!allowed(id)) { message('This action requires the current saved signer, admitted head or saved trust anchor. Inspect storage and the exact scope first.'); return; }
    busy = true; render();
    const start = ++version, captured = scope().join(':'), current = () => start === version && captured === scope().join(':') && panel.open;
    try { await work(current); }
    catch (error) { message(`Refused or interrupted: ${error.message}. Retained keys, anchors and unknown journals are not reset.`); }
    finally { busy = false; get('authorityLifecycleConsent').checked = false; get('authorityAnchorConsent').checked = false;
      try { await refresh(); } catch (error) { message(`Storage inspection failed: ${error.message}. Nothing was reset.`); } render(); }
  }
  function signerRequest(current) {
    return { expectedPublicKey: get('authorityExpectedKey').value.trim(), confirmed: get('authorityLifecycleConsent').checked, scopeStillCurrent: current };
  }
  const handlers = {
    inspectAuthorityStorageBtn: async () => {
      const result = await store.inspectStorage();
      message(`Origin storage: ${result.usageBytes ?? 'unknown'} bytes used / ${result.quotaBytes ?? 'unknown'} quota; persistent ${result.persistent ?? 'unknown'}; ${result.journalEntries} publication records, ${result.unknownEntries} unresolved. Estimates and persistence permission are not backups.`);
    },
    rotateAuthorityBtn: async current => {
      const next = await store.rotateAuthority(signerRequest(current));
      await onAuthorityChanged(next);
      message(`New saved signer ${next.publicKey}. The former key is retired locally. No trust pin or DNS record changed. Independently distribute and accept the new key before using it for a name.`);
    },
    revokeAuthorityBtn: async current => {
      const next = await store.revokeAuthority(signerRequest(current));
      await onAuthorityChanged(next);
      message(`Saved signer ${next.publicKey} revoked locally. Unknown publications remain reconcilable. This cannot revoke signatures, remote copies or key handles held by other origin scripts.`);
    },
    saveTrustedAnchorBtn: async current => {
      const observer = pointerObserver();
      await store.saveTrustedAnchor({ candidate: observer.head, expectedAuthorityKey: get('authorityAnchorKey').value.trim(),
        expectedPointerDigest: get('authorityAnchorDigest').value.trim(), confirmed: get('authorityAnchorConsent').checked, scopeStillCurrent: current });
      message('Exact current head and independently confirmed key saved locally. Later admitted successors update this saved head transactionally. Keep an independent recent anchor outside this origin.');
    },
    restoreTrustedAnchorBtn: async current => {
      const observer = pointerObserver(), saved = await store.trustedAnchor(observer.name);
      if (!saved) throw Error('No saved anchor for this name.');
      await observer.restoreFromTrustedAnchor({ expectedDigest: saved.head.pointerDigest, scopeStillCurrent: current });
      message('Saved exact head restored into this same pinned observer. A different retained head is never replaced. No DNS or signing effect occurred.');
    },
    migrateTrustedAnchorBtn: async current => {
      const [name] = scope(), prior = await store.trustedAnchor(name);
      if (!prior) throw Error('Save the independently accepted original anchor first.');
      await store.migrateTrustedAnchor({ name, expectedAuthorityKey: prior.publicKey, expectedPointerDigest: prior.head.pointerDigest,
        newAuthorityKey: get('authorityAnchorKey').value.trim(), newPointerDigest: get('authorityAnchorDigest').value.trim(),
        candidate: parseCanonicalJson(get('pointerJsonInput').value, { maxBytes: 4096 }), confirmed: get('authorityAnchorConsent').checked, scopeStillCurrent: current });
      message('Independently confirmed replacement anchor saved. The old live observer and visible pin are unchanged. Enter the replacement key above and explicitly restore the saved head. Old-scope unknown publications remain reconcilable.');
    },
    revokeTrustedAnchorBtn: async current => {
      const [name] = scope(), prior = await store.trustedAnchor(name);
      if (!prior || !current() || !get('authorityAnchorConsent').checked || get('authorityAnchorKey').value.trim() !== prior.publicKey
        || get('authorityAnchorDigest').value.trim() !== prior.head.pointerDigest) throw Error('Confirm the exact saved key and digest before revoking trust.');
      await store.revokeTrustedAnchor({ name, expectedAuthorityKey: prior.publicKey, expectedPointerDigest: prior.head.pointerDigest, confirmed: true, scopeStillCurrent: current });
      message('Saved trust revoked for this name. Admission and new publication with this pin are blocked. Migration needs an independently accepted replacement key. Existing unknown writes are retained.');
    },
    persistAuthorityStorageBtn: async () => {
      const granted = await store.requestPersistence({ confirmed: true });
      message(granted ? 'Browser granted origin persistence. Clearing, device loss and browser policy can still lose keys and journals; keep independent public evidence.' : 'Browser did not grant persistence. No data was deleted; save independent evidence and monitor available quota.');
    },
    exportAuthorityJournalBtn: async () => { download(await store.exportPublicJournal()); message('Public keys, exact anchors and publication journal exported. No private keys or tokens. This evidence has no automatic journal-import path; do not treat it as permission to repeat a write.'); },
    compactAuthorityJournalBtn: async current => {
      if (!get('authorityLifecycleConsent').checked) throw Error('Confirm removal of definitely refused, identity-free journal records.');
      message(`Removed ${await store.compactRefusedJournal({ confirmed: true, scopeStillCurrent: current })} definitely refused publication records without provider identities. Unknown records, published heads and key/trust history remain retained.`);
    },
  };
  for (const [id, handler] of Object.entries(handlers)) get(id).addEventListener('click', () => run(id, handler));
  for (const id of ['dnsQueryInput', 'pointerAuthorityInput']) get(id).addEventListener('input', () => {
    invalidate(); trust = null; render(); if (panel.open && !busy) refresh().catch(error => message(`Storage unavailable: ${error.message}. No data was reset.`));
  });
  panel.addEventListener('toggle', () => { if (panel.open && !busy) refresh().catch(error => message(`Storage unavailable: ${error.message}. No data was reset.`)); });
  return Object.freeze({ refresh, render });
}
