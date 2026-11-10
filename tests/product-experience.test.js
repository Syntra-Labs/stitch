import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { model } from '../src/layer1-uor/generated-model.js';
import { operatorJourneys, operatorActions, experienceFacts, experienceView, experienceActionAllowed,
  createOperatorExperience, experienceProvenance } from '../src/product-experience.js';
const call = (name, ...args) => model[`Product.Experience.${name}`](...args);
const root = resolve(import.meta.dirname, '..');

function dom() {
  const elements = new Map();
  function element() {
    let text = '';
    return { attributes: {}, style: {}, listeners: {}, children: [], writes: 0,
      get textContent() { return text; }, set textContent(value) { text = value; this.writes++; },
      set innerHTML(_) { throw Error('Experience must use safe text nodes'); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      replaceChildren(...children) { this.children = children; },
      focus(options) { this.focused = options; }, scrollIntoView(options) { this.scrolled = options; } };
  }
  return { elements, createElement: element, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
  } };
}

test('actual browser controls, journey targets and source provenance cover projected Experience', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  assert.deepEqual(operatorJourneys.map(j => j.id), ['mesh', 'objects', 'compute', 'vm', 'pointers', 'resources']);
  assert.equal(new Set(operatorActions.map(a => a.code)).size, operatorActions.length);
  for (const journey of operatorJourneys) {
    for (const id of [journey.target, `${journey.id}Title`, `${journey.id}Evidence`]) assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const action of operatorActions) {
    assert.ok(html.includes(`id="${action.control}"`), action.control);
    const recoveryAdapter = readFileSync(resolve(root, 'src/recovery-ui.js'), 'utf8');
    assert.ok(html.includes(`bindModelAction('${action.control}',`) ||
      (recoveryAdapter.includes(`bind('${action.control}',`) && recoveryAdapter.includes('bindModelAction(id,')), action.control);
  }
  const digest = createHash('sha256').update(readFileSync(resolve(root, experienceProvenance.source))).digest('hex');
  assert.equal(experienceProvenance.sourceSha256, digest);
  assert.match(experienceProvenance.assurance, /not whole-host/);
});

test('model evidence separates local integrity, conditional placement, pure replay and host effects', () => {
  const facts = experienceFacts();
  assert.equal(experienceView('objects', facts).id, 'objectsEmpty');
  assert.equal(experienceView('objects', { ...facts, hasPartial: true }).id, 'objectsPartial');
  assert.equal(experienceView('objects', { ...facts, hasObject: true }).id, 'objectsLocal');
  assert.match(experienceView('objects', { ...facts, hasObject: true, recoverablePlacement: true }).detail, /truthful, reachable/);
  assert.equal(experienceView('compute', { ...facts, unfinishedJobs: true }).id, 'computeUnverified');
  assert.equal(experienceView('compute', { ...facts, unfinishedJobs: true, replayedJobs: true }).id, 'computeReplay');
  assert.match(experienceView('vm', { ...facts, vmReady: true }).detail, /not evidence/);
  assert.equal(experienceView('pointers', { ...facts, authorityPinned: true, publicationUnknown: true, headRetained: true, publicationPublished: true }).id, 'pointerUnknown');
});

test('all bounded gate combinations refuse unsafe actions without certifying host observations', () => {
  const fields = ['disclosureAccepted', 'policyBlocked', 'authorityPinned', 'hasObject', 'headRetained',
    'publicationBusy', 'publicationUnknown', 'dnsConfigured', 'vmReady', 'vmBooting', 'meshJoined', 'unfinishedJobs'];
  for (let mask = 0; mask < 2 ** fields.length; mask++) {
    const facts = experienceFacts(Object.fromEntries(fields.map((field, i) => [field, Boolean(mask & (1 << i))])));
    if (!facts.disclosureAccepted || facts.policyBlocked) assert.equal(experienceActionAllowed('reconnectBtn', facts), false);
    if (facts.publicationUnknown || facts.publicationBusy || facts.policyBlocked || !facts.authorityPinned) assert.equal(experienceActionAllowed('writeSignedDnsBtn', facts), false);
    if (!facts.publicationUnknown || facts.publicationBusy || facts.policyBlocked || !facts.dnsConfigured || !facts.authorityPinned) assert.equal(experienceActionAllowed('reconcilePointerBtn', facts), false);
    if (!facts.vmReady || facts.policyBlocked) assert.equal(experienceActionAllowed('runVmCmdBtn', facts), false);
    if (facts.vmBooting || facts.vmReady) assert.equal(experienceActionAllowed('bootVmBtn', facts), false);
    assert.equal(experienceActionAllowed('exportBudgetHistoryBtn', facts), true);
    assert.equal(experienceActionAllowed('renewBudgetBtn', facts), true);
  }
  assert.equal(experienceActionAllowed('unknownControl', experienceFacts()), false);
  assert.throws(() => experienceFacts({ policyBlocked: 0 }), /Bool/);
  assert.throws(() => experienceFacts({ inventedEvidence: true }), /exact model record/);
});

test('per-resource attention is not an invented global denial and local unfinished jobs can resume', () => {
  const facts = experienceFacts({ policyAttention: true, unfinishedJobs: true });
  assert.equal(experienceView('resources', facts).id, 'resourcesBlocked');
  for (const control of ['dbPutBtn', 'startJobBtn', 'takeoverJobsBtn']) assert.equal(experienceActionAllowed(control, facts), true);
  assert.equal(experienceActionAllowed('takeoverJobsBtn', { ...facts, policyBlocked: true }), false);
});

test('navigation is source-owned, keyboard-native, focus preserving and nonanimated without changing mesh hash', () => {
  const document = dom(); const refused = []; let observations = {};
  const experience = createOperatorExperience({ document, snapshot: () => observations, onRefused: x => refused.push(x) });
  const get = id => document.getElementById(id);
  assert.equal(get('operatorJourneyNav').attributes['aria-label'], call('navigationLabel'));
  assert.equal(get('meshPanel').hidden, false);
  assert.equal(get('objectsPanel').hidden, true);
  assert.equal(get('meshExplanationPanel').open, true);
  const nav = get('operatorJourneyNav').children;
  assert.equal(nav.length, operatorJourneys.length);
  assert.ok(nav.every(button => button.type === 'button' && !button.href));
  const input = get('pointerJsonInput'); input.value = 'retain edited operator input';
  nav[4].listeners.click(); nav[1].listeners.click(); nav[4].listeners.click();
  assert.equal(input.value, 'retain edited operator input');
  assert.deepEqual(get('pointersPanel').focused, { preventScroll: true });
  assert.deepEqual(get('pointersPanel').scrolled, { behavior: 'auto', block: 'start' });
  assert.equal(nav[4].attributes['aria-current'], 'location');
  assert.equal(get('pointersPanel').hidden, false);
  assert.ok(operatorJourneys.filter(j => j.id !== 'pointers').every(j => get(j.target).hidden));
  assert.equal(get('pointersExplanationPanel').open, false);
  get('pointersExplanationPanel').open = true; experience.render();
  assert.equal(get('pointersExplanationPanel').open, true, 'unchanged updates retain explicit user disclosure choice');
  assert.equal(get('pointersEvidence').attributes['aria-live'], 'polite');
  assert.equal(get('pointersEvidence').attributes['aria-atomic'], 'true');
  assert.equal(get('writeSignedDnsBtn').disabled, true);
  assert.equal(experience.allow('writeSignedDnsBtn'), false); assert.equal(refused.length, 1);
  const writes = get('pointersEvidence').writes; experience.render(); experience.render();
  assert.equal(get('pointersEvidence').writes, writes, 'unchanged observations must not repeat live announcements');
  observations = { authorityPinned: true, hasObject: true, dnsConfigured: true, publicationUnknown: true, headRetained: true };
  experience.render();
  assert.equal(get('writeSignedDnsBtn').hidden, true); assert.equal(get('reconcilePointerBtn').hidden, false);
  assert.equal(get('reconcilePointerBtn').disabled, false);
  assert.equal(get('pointersExplanationPanel').open, true);
  assert.equal(get('pointerPublicationSetup').open, true);
  assert.match(get('operatorNextActions').textContent, /Reconcile Unknown/);
  assert.doesNotMatch(get('operatorNextActions').textContent, /Admit Next/);
  assert.equal(get('experienceProvenance').attributes['data-model-source-sha256'], experienceProvenance.sourceSha256);
  observations = { policyAttention: true }; experience.render();
  assert.equal(get('pointersPanel').hidden, false, 'an asynchronous refusal does not steal navigation or focus');
  assert.equal(get('reviewResourcePolicyBtn').hidden, false);
  get('reviewResourcePolicyBtn').listeners.click();
  assert.equal(get('resourcesPanel').hidden, false);
  assert.equal(get('resourcesExplanationPanel').open, true);
  assert.throws(() => experience.navigate('invented'), /Unknown operator journey/);
});

test('named modeled evidence palette has readable contrast on the actual panel surface', () => {
  const luminance = hex => hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const bg = luminance('#111111');
  for (const style of call('evidenceStyles')) assert.ok((luminance(style.color) + 0.05) / (bg + 0.05) >= 4.5, style.id);
});

test('Experience source edits change the real generated semantic projection and stale edits fail closed', async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'stitch-experience-mutation-'));
  try {
    for (const file of ['app/src', 'app/language', 'src', 'scripts/check-model.mjs', 'package.json']) cpSync(resolve(root, file), resolve(temporary, file), { recursive: true });
    const source = resolve(temporary, 'app/src/Product/Experience.lex.tex');
    const before = readFileSync(source, 'utf8');
    writeFileSync(source, before.replace('title := "Join a mesh"', 'title := "Join an inspected mesh"')
      .replace('body: (disclosed && (not blocked))', 'body: false'));
    const check = spawnSync(process.execPath, ['scripts/check-model.mjs', '--check'], { cwd: temporary, encoding: 'utf8' });
    assert.notEqual(check.status, 0); assert.match(check.stderr, /stale source bindings/);
    const write = spawnSync(process.execPath, ['scripts/check-model.mjs', '--write'], { cwd: temporary, encoding: 'utf8' });
    assert.equal(write.status, 0, write.stderr);
    const changed = await import(pathToFileURL(resolve(temporary, 'src/layer1-uor/generated-model.js')));
    assert.equal(changed.model['Product.Experience.journeys']()[0].title, 'Join an inspected mesh');
    const facts = changed.model['Product.Experience.initialFacts'](); facts.disclosureAccepted = true;
    assert.equal(changed.model['Product.Experience.actionAllowed'](0, facts), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('recovery and guest administration context is source-owned and refuses inappropriate actions', () => {
  const base = experienceFacts();
  assert.equal(experienceView('recovery', base).id, 'recoveryEmpty');
  assert.equal(experienceView('recovery', { ...base, recoveryBusy: true }).id, 'recoveryChecking');
  assert.equal(experienceView('recovery', { ...base, recoveryHasEvidence: true }).id, 'recoveryChecked');
  assert.equal(experienceView('recovery', { ...base, recoveryAcceptedAnchor: true }).id, 'recoveryTrusted');
  assert.equal(experienceActionAllowed('importRecoveryBtn', base), false);
  assert.equal(experienceActionAllowed('importRecoveryBtn', { ...base, recoveryFileSelected: true }), true);
  assert.equal(experienceActionAllowed('importRecoveryBtn', { ...base, recoveryFileSelected: true, recoveryBusy: true }), false);
  assert.equal(experienceActionAllowed('acceptRecoveryAnchorBtn', { ...base, recoveryHasAnchors: true }), false);
  assert.equal(experienceActionAllowed('acceptRecoveryAnchorBtn', { ...base, recoveryHasAnchors: true, recoveryAnchorConsent: true }), true);
  assert.equal(experienceView('vm', { ...base, vmAdminBlocked: true }).id, 'vmQuarantined');
  assert.equal(experienceActionAllowed('stopVmBtn', { ...base, vmCanAdminister: true, vmAdminBlocked: true }), true);
  assert.equal(experienceActionAllowed('bootVmBtn', { ...base, vmAdminBlocked: true }), false);
  assert.equal(experienceActionAllowed('reconcileVmCommandBtn', { ...base, vmCanReconcileCommand: true }), true);
});
