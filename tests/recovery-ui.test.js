import test from 'node:test';
import assert from 'node:assert/strict';
import { installRecoveryControls } from '../src/recovery-ui.js';
import { exportRecoveryBundle, recoveryObject } from '../src/recovery.js';
import { generateAuthority, signPointer, PointerObserver } from '../src/layer1-uor/pointer.js';
import { demoProgram, createCheckpoint } from '../src/layer4-compute/replay.js';
function setup({ objects = new Map(), observerFactory = options => new PointerObserver(options) } = {}) {
  const elements = new Map(), handlers = new Map();
  const element = () => ({ value: '', checked: false, files: [], children: [], listeners: {}, textContent: '', disabled: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    get selectedOptions() { return this.children.filter(child => child.selected); },
    addEventListener(event, handler) { this.listeners[event] = handler; },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; },
    querySelectorAll() { return []; }, click() {} });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const pointerObservers = new Map();
  const pointerObserver = () => {
    const name = document.getElementById('dnsQueryInput').value.trim(), trustedAuthorityKey = document.getElementById('pointerAuthorityInput').value.trim();
    const key = `${name}:${trustedAuthorityKey}`;
    if (!pointerObservers.has(key)) pointerObservers.set(key, observerFactory({ name, trustedAuthorityKey }));
    return pointerObservers.get(key);
  };
  const controls = installRecoveryControls({ document, liveDb: { objects }, computeCoord: { jobs: new Map() },
    pointerObservers, pointerObserver, bindModelAction: (id, handler) => handlers.set(id, handler) });
  return { document, controls, handlers, pointerObservers, pointerObserver, get: id => document.getElementById(id) };
}
test('recovery UI checks chosen file, restores local evidence and explicitly completes only pure jobs', async () => {
  const ui = setup(); const program = demoProgram(5);
  const wire = await exportRecoveryBundle({ version: 1, objects: [await recoveryObject(new Uint8Array([1, 2]))],
    jobs: [{ program, checkpoint: await createCheckpoint(program, 2) }], anchors: [] });
  const bytes = new TextEncoder().encode(wire);
  ui.get('recoveryFile').files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  ui.get('recoveryAnchorConsent').checked = true;
  await ui.handlers.get('importRecoveryBtn')();
  assert.equal(ui.get('recoveryAnchorConsent').checked, false);
  assert.equal(ui.controls.facts().recoveryHasEvidence, true);
  assert.equal(ui.controls.facts().recoveryHasObjects, true);
  assert.equal(ui.controls.facts().recoveryHasJobs, true);
  assert.match(ui.get('recoveryStatus').textContent, /No mesh, VM or DNS effects/);
  await ui.handlers.get('resumeRecoveredJobBtn')();
  assert.match(ui.get('recoveryStatus').textContent, /Pure local replay finished at step 5/);
  ui.get('recoveryFile').files = [{ size: 4, arrayBuffer: async () => new TextEncoder().encode('null').buffer }];
  await ui.handlers.get('importRecoveryBtn')();
  assert.match(ui.get('recoveryStatus').textContent, /Refused/);
  assert.equal(ui.controls.facts().recoveryHasEvidence, true);
});
test('oversize file refuses before reading, pending duplicate clicks do not repeat import', async () => {
  const ui = setup(); let reads = 0, resolve;
  ui.get('recoveryByteLimit').value = '0';
  ui.get('recoveryFile').files = [{ size: 1, arrayBuffer: async () => { reads++; } }];
  await ui.handlers.get('importRecoveryBtn')(); assert.equal(reads, 0);
  ui.get('recoveryByteLimit').value = '1000';
  const bytes = new TextEncoder().encode(await exportRecoveryBundle({ version: 1, objects: [], jobs: [], anchors: [] }));
  ui.get('recoveryFile').files = [{ size: bytes.length, arrayBuffer: () => { reads++; return new Promise(r => { resolve = r; }); } }];
  const pending = ui.handlers.get('importRecoveryBtn')();
  assert.equal(ui.controls.facts().recoveryBusy, true);
  assert.equal(ui.get('recoveryControls').attributes['aria-busy'], 'true');
  await ui.handlers.get('importRecoveryBtn')(); assert.equal(reads, 1);
  resolve(bytes.buffer); await pending; assert.equal(ui.controls.facts().recoveryBusy, false);
  assert.equal(ui.get('recoveryControls').attributes['aria-busy'], 'false');
});


test('recovery keeps export choices across reopening and clears stale anchor consent when its scope changes', async () => {
  const objects = new Map([['a', { verified: true, bytes: Uint8Array.of(1) }], ['b', { verified: true, bytes: Uint8Array.of(2) }]]);
  const ui = setup({ objects }); const panel = ui.get('recoveryControls');
  panel.open = true; panel.listeners.toggle();
  const control = ui.get('recoveryExportSelection');
  control.children[1].selected = false;
  panel.listeners.toggle();
  assert.deepEqual(control.selectedOptions.map(option => option.value), ['object:a']);
  objects.set('c', { verified: true, bytes: Uint8Array.of(3) });
  panel.listeners.toggle();
  assert.deepEqual(control.selectedOptions.map(option => option.value), ['object:a']);
  for (const [id, event] of [['recoveryAnchors', 'change'], ['recoveryAuthority', 'input'], ['recoveryDigest', 'input']]) {
    ui.get('recoveryAnchorConsent').checked = true; ui.get(id).listeners[event]();
    assert.equal(ui.get('recoveryAnchorConsent').checked, false);
  }
  assert.equal(ui.get('recoveryObjects').children[0].textContent, 'No objects imported');
});

test('recovered typed jobs require priced work allowance before explicit continuation', async () => {
  const { programWork } = await import('../src/layer4-compute/replay.js');
  const ui = setup();
  const program = { version: 2, bits: 8, capacityBits: 8, initialValueHex: '0x3',
    instructions: [{ op: 17, argBits: 8, argHex: '0x7' }] };
  const wire = await exportRecoveryBundle({ version: 1, objects: [], jobs: [{ program, checkpoint: await createCheckpoint(program, 0) }], anchors: [] });
  const bytes = new TextEncoder().encode(wire);
  ui.get('recoveryFile').files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  await ui.handlers.get('importRecoveryBtn')();
  ui.get('recoveryStepLimit').value = program.instructions.length;
  await ui.handlers.get('resumeRecoveredJobBtn')();
  assert.match(ui.get('recoveryStatus').textContent, /Refused.*work allowance/);
  ui.get('recoveryStepLimit').value = programWork(program);
  await ui.handlers.get('resumeRecoveredJobBtn')();
  assert.match(ui.get('recoveryStatus').textContent, /Pure local replay finished at step 1/);
});

async function importAnchor(ui) {
  const authority = await generateAuthority(), now = Date.now();
  const anchor = await signPointer({ version: 1, name: 'state.example', authorityKey: authority.publicKey, revision: 7,
    previousDigest: 'sha256:' + 'a'.repeat(64), objectRoot: 'sha256:' + 'b'.repeat(64), validFromMs: now - 1000, validUntilMs: now + 100000 }, authority.privateKey);
  const bytes = new TextEncoder().encode(await exportRecoveryBundle({ version: 1, objects: [], jobs: [], anchors: [anchor] }));
  ui.get('recoveryFile').files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  await ui.handlers.get('importRecoveryBtn')();
  ui.get('recoveryAuthority').value = authority.publicKey; ui.get('recoveryDigest').value = anchor.pointerDigest;
  return { authority, anchor };
}
async function acceptAnchor(ui) {
  ui.get('recoveryAnchorConsent').checked = true; await ui.handlers.get('acceptRecoveryAnchorBtn')();
}

test('UI requires separate import, exact acceptance, matching independent live pin and explicit restoration', async () => {
  const ui = setup(), { authority, anchor } = await importAnchor(ui);
  assert.equal(ui.controls.facts().recoveryCanRestoreAnchor, false);
  await ui.handlers.get('restoreRecoveryAnchorBtn')(); assert.equal(ui.pointerObservers.size, 0);
  await acceptAnchor(ui); assert.equal(ui.pointerObservers.size, 0);
  ui.get('dnsQueryInput').value = anchor.name;
  assert.equal(ui.controls.facts().recoveryCanRestoreAnchor, false);
  ui.get('pointerAuthorityInput').value = authority.publicKey;
  assert.equal(ui.controls.facts().recoveryCanRestoreAnchor, true);
  await ui.handlers.get('restoreRecoveryAnchorBtn')();
  assert.deepEqual(ui.pointerObserver().head, anchor);
  assert.equal(ui.controls.facts().recoveryRestoredAnchor, true);
  assert.match(ui.get('recoveryStatus').textContent, /No DNS write, mesh or VM effect/);
  assert.match(ui.get('recoveryLiveScope').textContent, /Retained revision 7/);
  ui.get('recoveryDigest').value = 'sha256:' + 'c'.repeat(64); ui.get('recoveryDigest').listeners.input();
  assert.equal(ui.controls.facts().recoveryCanRestoreAnchor, false);
  assert.deepEqual(ui.pointerObserver().head, anchor);
});

test('UI ignores duplicate restore and close or changed scope cancels a pending commit without replay on reopen', async () => {
  let release, reached, calls = 0;
  const ui = setup({ observerFactory: options => {
    const observer = new PointerObserver(options), restore = observer.restoreFromRecovery.bind(observer);
    observer.restoreFromRecovery = async (...args) => {
      calls++; reached(); await new Promise(resolve => { release = resolve; }); return restore(...args);
    };
    return observer;
  } });
  const { authority, anchor } = await importAnchor(ui); await acceptAnchor(ui);
  ui.get('dnsQueryInput').value = anchor.name; ui.get('pointerAuthorityInput').value = authority.publicKey;
  for (const cancel of [() => { ui.get('recoveryControls').open = false; ui.get('recoveryControls').listeners.toggle(); },
    () => { ui.get('pointerAuthorityInput').listeners.input(); }]) {
    let entered; const started = new Promise(resolve => { entered = resolve; }); reached = entered;
    const pending = ui.handlers.get('restoreRecoveryAnchorBtn')(); await started;
    const before = calls; await ui.handlers.get('restoreRecoveryAnchorBtn')(); assert.equal(calls, before);
    cancel(); release(); await pending;
    assert.equal(ui.pointerObserver().head, null);
    assert.match(ui.get('recoveryStatus').textContent, /Refused/);
    ui.get('recoveryControls').open = true; ui.get('recoveryControls').listeners.toggle();
    assert.equal(calls, before); assert.equal(ui.pointerObserver().head, null);
  }
});
