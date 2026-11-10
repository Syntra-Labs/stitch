import test from 'node:test';
import assert from 'node:assert/strict';
import { installRecoveryControls } from '../src/recovery-ui.js';
import { exportRecoveryBundle, recoveryObject } from '../src/recovery.js';
import { demoProgram, createCheckpoint } from '../src/layer4-compute/replay.js';
function setup() {
  const elements = new Map(), handlers = new Map();
  const element = () => ({ value: '', checked: false, files: [], children: [], listeners: {}, textContent: '', disabled: false,
    addEventListener(event, handler) { this.listeners[event] = handler; },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; },
    querySelectorAll() { return []; }, click() {} });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const controls = installRecoveryControls({ document, liveDb: { objects: new Map() }, computeCoord: { jobs: new Map() },
    pointerObservers: new Map(), bindModelAction: (id, handler) => handlers.set(id, handler) });
  return { document, controls, handlers, get: id => document.getElementById(id) };
}
test('recovery UI checks chosen file, restores local evidence and explicitly completes only pure jobs', async () => {
  const ui = setup(); const program = demoProgram(5);
  const wire = await exportRecoveryBundle({ version: 1, objects: [await recoveryObject(new Uint8Array([1, 2]))],
    jobs: [{ program, checkpoint: await createCheckpoint(program, 2) }], anchors: [] });
  const bytes = new TextEncoder().encode(wire);
  ui.get('recoveryFile').files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  await ui.handlers.get('importRecoveryBtn')();
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
  await ui.handlers.get('importRecoveryBtn')(); assert.equal(reads, 1);
  resolve(bytes.buffer); await pending; assert.equal(ui.controls.facts().recoveryBusy, false);
});
