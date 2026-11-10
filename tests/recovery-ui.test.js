import test from 'node:test';
import assert from 'node:assert/strict';
import { installRecoveryControls } from '../src/recovery-ui.js';
import { exportRecoveryBundle, recoveryObject } from '../src/recovery.js';
import { demoProgram, createCheckpoint } from '../src/layer4-compute/replay.js';
function setup({ objects = new Map() } = {}) {
  const elements = new Map(), handlers = new Map();
  const element = () => ({ value: '', checked: false, files: [], children: [], listeners: {}, textContent: '', disabled: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    get selectedOptions() { return this.children.filter(child => child.selected); },
    addEventListener(event, handler) { this.listeners[event] = handler; },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; },
    querySelectorAll() { return []; }, click() {} });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const controls = installRecoveryControls({ document, liveDb: { objects }, computeCoord: { jobs: new Map() },
    pointerObservers: new Map(), bindModelAction: (id, handler) => handlers.set(id, handler) });
  return { document, controls, handlers, get: id => document.getElementById(id) };
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
