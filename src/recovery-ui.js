/** Explicit local recovery journey. Never invokes a mesh, VM or DNS adapter. */
import { RecoveryVault, RECOVERY_LIMITS, recoveryObject, exportRecoveryBundle } from './recovery.js';
import { resumeProgram } from './layer4-compute/replay.js';
export function installRecoveryControls({ document, liveDb, computeCoord, pointerObservers, bindModelAction, onChange = () => {} }) {
  const get = id => document.getElementById(id);
  const vault = new RecoveryVault();
  let busy = false;
  const status = message => { get('recoveryStatus').textContent = message; };
  const download = (bytes, name, type) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  function render() {
    const snapshot = vault.snapshot();
    get('recoveryObjects').replaceChildren(...snapshot.bundle.objects.map(o => {
      const option = document.createElement('option'); option.value = o.manifest.object.contentDigest;
      option.textContent = `${o.manifest.object.byteLength} bytes · ${option.value}`; return option;
    }));
    get('recoveryJobs').replaceChildren(...snapshot.bundle.jobs.map(j => {
      const option = document.createElement('option'); option.value = j.checkpoint.jobId;
      option.textContent = `${j.checkpoint.stepIndex}/${j.program.instructions.length} steps · ${option.value}`; return option;
    }));
    get('recoveryAnchors').replaceChildren(...snapshot.bundle.anchors.map(a => {
      const option = document.createElement('option'); option.value = a.name;
      option.textContent = `${a.name} · revision ${a.revision} · ${snapshot.acceptedAnchors.some(x => x.pointerDigest === a.pointerDigest) ? 'operator-accepted' : 'untrusted supplied evidence'}`;
      return option;
    }));
  }
  function bind(id, action) {
    bindModelAction(id, async () => {
      if (busy) return;
      busy = true; onChange();
      const controls = [...get('recoveryControls').querySelectorAll('button')]; controls.forEach(c => { c.disabled = true; });
      try { await action(); render(); }
      catch (error) { status(`Refused; retained recovery evidence unchanged: ${error.code || error.message}`); }
      finally { busy = false; onChange(); }
    });
  }
  const options = () => ({ wireBytes: Number(get('recoveryByteLimit').value), replaySteps: Number(get('recoveryStepLimit').value) });
  get('recoveryByteLimit').value = RECOVERY_LIMITS.wireBytes;
  get('recoveryStepLimit').value = RECOVERY_LIMITS.replaySteps;
  function refreshExportSelection() {
    const rows = [
      ...[...liveDb.objects.entries()].filter(([, e]) => e.verified && e.bytes).map(([key, e]) => ({ key: `object:${key}`, label: `Object ${e.label || key} (${e.bytes.length} bytes)` })),
      ...[...computeCoord.jobs.entries()].map(([key, j]) => ({ key: `job:${key}`, label: `Job ${key} (${j.stepIndex}/${j.totalSteps})` })),
      ...[...pointerObservers.entries()].filter(([, o]) => o.head).map(([key, o]) => ({ key: `anchor:${key}`, label: `Pointer ${o.head.name} revision ${o.head.revision}` })),
    ];
    get('recoveryExportSelection').replaceChildren(...rows.map(row => {
      const option = document.createElement('option'); option.value = row.key; option.textContent = row.label;
      option.selected = rows.length <= RECOVERY_LIMITS.entries; return option;
    }));
  }
  get('recoveryControls').addEventListener('toggle', () => {
    if (get('recoveryControls').open && !busy) refreshExportSelection();
  });
  bind('exportRecoveryBtn', async () => {
    const selected = new Set([...get('recoveryExportSelection').selectedOptions].map(o => o.value));
    if (selected.size === 0 || selected.size > RECOVERY_LIMITS.entries) throw Error('Choose between 1 and 32 live evidence entries.');
    const objects = [...liveDb.objects.entries()].filter(([key]) => selected.delete(`object:${key}`)).map(([, e]) => {
      if (!e.verified || !e.bytes) throw Error('Selected object no longer complete. Reopen the recovery panel.');
      return new Uint8Array(e.bytes);
    });
    const jobs = [...computeCoord.jobs.entries()].filter(([key]) => selected.delete(`job:${key}`))
      .map(([, j]) => structuredClone({ program: j.program, checkpoint: j.checkpoint }));
    const anchors = [...pointerObservers.entries()].filter(([key]) => selected.delete(`anchor:${key}`)).map(([, o]) => {
      if (!o.head) throw Error('Selected observer head is no longer retained.'); return o.head;
    });
    if (selected.size) throw Error('Selected evidence changed. Reopen the recovery panel and select again.');
    const bundle = { version: 1, objects: [], jobs, anchors };
    for (const bytes of objects) bundle.objects.push(await recoveryObject(bytes));
    const wire = await exportRecoveryBundle(bundle, options());
    download(wire, 'stitch-recovery.json', 'application/json');
    status('Verified evidence exported. Store the downloaded file independently. No private keys, trust decisions, grants or pending writes are included.');
  });
  bind('importRecoveryBtn', async () => {
    const file = get('recoveryFile').files[0]; const bounds = options();
    if (!file) throw Error('Choose a recovery file first.');
    if (!Number.isSafeInteger(bounds.wireBytes) || file.size > bounds.wireBytes || file.size > RECOVERY_LIMITS.wireBytes) throw Error('File exceeds chosen wire allowance.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    await vault.import(bytes, bounds);
    status('Object integrity and pure checkpoints checked. Evidence restored to this session-only recovery vault; supplied anchors remain untrusted. No mesh, VM or DNS effects ran.');
  });
  bind('exportRecoveredBtn', async () => {
    download(await vault.export(), 'stitch-recovered-evidence.json', 'application/json');
    status('Recovery evidence exported. Operator trust decisions are not transferable through this file.');
  });
  bind('downloadRecoveredObjectBtn', async () => {
    const root = get('recoveryObjects').value;
    download(await vault.objectBytes(root), `${root.replace(':', '-')}.bin`, 'application/octet-stream');
    status('Verified object downloaded locally. It was not mounted in the VM or published to peers.');
  });
  bind('resumeRecoveredJobBtn', async () => {
    const job = vault.snapshot().bundle.jobs.find(j => j.checkpoint.jobId === get('recoveryJobs').value);
    if (!job) throw Error('Choose an imported job.');
    const limit = options().replaySteps;
    if (!Number.isSafeInteger(limit) || limit < job.program.instructions.length || limit > RECOVERY_LIMITS.replaySteps) throw Error('Replay allowance is too small or invalid.');
    const result = await resumeProgram(job.program, job.checkpoint);
    status(`Pure local replay finished at step ${result.stepIndex}: ${result.stateHex}. No external effects ran; result remains volatile.`);
  });
  bind('acceptRecoveryAnchorBtn', async () => {
    await vault.acceptRecentAnchor({ name: get('recoveryAnchors').value, authorityKey: get('recoveryAuthority').value.trim(),
      expectedDigest: get('recoveryDigest').value.trim(), nowMs: Date.now(), operatorAccepted: get('recoveryAnchorConsent').checked });
    get('recoveryAnchorConsent').checked = false;
    status('Exact recent anchor accepted for this recovery vault only. Existing DNS observer heads are unchanged. This does not establish a globally latest pointer.');
  });
  render();
  const facts = () => {
    const state = vault.snapshot();
    return { recoveryBusy: busy, recoveryFileSelected: Boolean(get('recoveryFile').files[0]),
      recoveryHasEvidence: state.entries > 0, recoveryHasObjects: state.bundle.objects.length > 0,
      recoveryHasJobs: state.bundle.jobs.length > 0, recoveryHasAnchors: state.bundle.anchors.length > 0,
      recoveryAnchorConsent: get('recoveryAnchorConsent').checked, recoveryAcceptedAnchor: state.acceptedAnchors.length > 0 };
  };
  get('recoveryFile').addEventListener('change', onChange);
  get('recoveryAnchorConsent').addEventListener('change', onChange);
  return { facts };
}
