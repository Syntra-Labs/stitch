/** Finite refinement oracles and planted source defects, not compiler certification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { model, MODEL_SOURCE, modelExecutionDigest } from '../src/layer1-uor/generated-model.js';
import { dnsWriteState, dnsWriteOutcome, dnsLifecycle } from '../src/layer1-uor/effects.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = value => new TextEncoder().encode(value);
const tag = value => ({ tag: value, fields: [] });
const call = (name, ...args) => model[`Stitch.Effects.${name}`](...args);
const scope = { zoneId: bytes('zone'), name: bytes('name.example'), authorityKey: bytes('pinned-key') };
const candidate = { scope, pointerDigest: bytes('candidate'), previousDigest: bytes('previous'), hasPrevious: true,
  revision: 2, validFrom: 10, validUntil: 20 };
const publication = phase => ({ scope, phase: tag(phase), pointerDigest: bytes('candidate'), recordId: bytes('record-1'), hasRecordId: true });
const read = { scope, candidateDigest: candidate.pointerDigest, complete: true, authenticated: true, recordPresent: true,
  recordId: bytes('record-1'), pointerDigest: bytes('previous'), revision: 1 };

test('transport admissions exactly correlate current topic, local/remote identity, generation and live object facts', () => {
  for (const closed of [false, true]) for (let generation = 0; generation < 3; generation++)
    for (let callbackGeneration = 0; callbackGeneration < 3; callbackGeneration++)
      for (const topic of ['mesh', 'mesh-other']) for (const local of ['local', 'local-other'])
        for (const remote of ['remote', 'remote-other']) for (const entryCurrent of [false, true]) for (const channelCurrent of [false, true]) {
          const state = { generation, closed, channelKey: bytes('mesh'), localPeer: bytes('local') };
          const callback = { generation: callbackGeneration, channelKey: bytes(topic), localPeer: bytes(local), remotePeer: bytes(remote) };
          const current = !closed && generation === callbackGeneration && topic === 'mesh' && local === 'local';
          assert.equal(call('transportSessionMatches', state, callback), current);
          assert.equal(call('transportPeerCallbackAllowed', state, callback, bytes('remote'), entryCurrent), current && remote === 'remote' && entryCurrent);
          assert.equal(call('transportChannelCallbackAllowed', state, callback, bytes('remote'), entryCurrent, channelCurrent), current && remote === 'remote' && entryCurrent && channelCurrent);
          const reopened = call('transportOpen', call('transportClose', state), state.channelKey);
          assert.equal(reopened.generation, BigInt(generation + 1));
          assert.equal(call('transportSessionMatches', reopened, { ...callback, generation }), false);
        }
});

test('VM source reducers match an independent phase machine and never resurrect stale instances', () => {
  for (const phase of ['Idle', 'Booting', 'Ready', 'Failed']) for (let generation = 0; generation < 3; generation++)
    for (let observedGeneration = 0; observedGeneration < 3; observedGeneration++) for (const instanceCurrent of [false, true]) for (const ready of [false, true]) {
      const state = { generation, phase: tag(phase) }, canonical = { ...state, generation: BigInt(generation) };
      const canBoot = phase === 'Idle' || phase === 'Failed', booting = phase === 'Booting', executable = phase === 'Ready';
      assert.equal(call('vmCanBoot', state), canBoot);
      assert.equal(call('vmIsBooting', state), booting);
      assert.equal(call('vmCanExecute', state), executable);
      assert.deepEqual(call('vmStart', state), canBoot ? { generation: BigInt(generation + 1), phase: tag('Booting') } : canonical);
      assert.equal(call('vmCallbackAllowed', state, observedGeneration, instanceCurrent), generation === observedGeneration && instanceCurrent && (booting || executable));
      assert.deepEqual(call('vmFail', state, observedGeneration), generation === observedGeneration && booting ? { generation: BigInt(generation + 1), phase: tag('Failed') } : canonical);
      assert.deepEqual(call('vmObserveReady', state, observedGeneration, instanceCurrent, ready), generation === observedGeneration && booting && instanceCurrent && ready ? { generation: BigInt(generation), phase: tag('Ready') } : canonical);
    }
});

test('C1 source progress rejects duplicate/out-of-order/window-mismatched probes and requires exact frozen qualification', () => {
  for (let consecutive = 0; consecutive <= 12; consecutive++) for (const hasSequence of [false, true])
    for (let lastSequence = 0; lastSequence <= 2; lastSequence++) for (let sequence = 0; sequence <= 4; sequence++)
      for (const now of [0, 1, 10000000, 10000001]) for (const correlated of [false, true]) {
        const progress = { startedAt: 0, lastSequence, hasSequence, consecutive };
        const accepted = correlated && now <= 10000000 && (!hasSequence || lastSequence < sequence);
        assert.equal(call('c1ProbeAccepted', progress, sequence, now, correlated), accepted);
        const next = call('c1ObserveProbe', progress, sequence, now, correlated);
        const count = accepted ? hasSequence && lastSequence + 1 === sequence ? consecutive + 1 : 1 : consecutive;
        assert.equal(next.consecutive, BigInt(count));
        assert.equal(next.lastSequence, BigInt(accepted ? sequence : lastSequence));
        for (const ordered of [false, true]) for (const observed of [false, true]) for (const relay of [false, true]) {
          assert.equal(call('c1ConnectionQualified', progress, now, ordered), ordered && consecutive >= 10 && now <= 10000000);
          assert.equal(call('c1DirectSuccess', progress, now, ordered, observed, relay), ordered && consecutive >= 10 && now <= 10000000 && observed && !relay);
        }
      }
});

test('unresolved DNS reads never authorize create/update for any observation flag combination', () => {
  for (const phase of ['Idle', 'Published', 'Refused', 'Unknown']) for (let flags = 0; flags < 32; flags++) {
    const exact = !!(flags & 1), present = !!(flags & 2), predecessor = !!(flags & 4), bootstrap = !!(flags & 8), live = !!(flags & 16);
    const expected = exact ? 'Reconciled' : phase === 'Unknown' ? 'Wait'
      : !live ? 'Refuse' : present ? predecessor ? 'Update' : 'Refuse' : bootstrap ? 'Create' : 'Refuse';
    assert.equal(call('dnsSelectRead', tag(phase), exact, present, predecessor, bootstrap, live).tag, expected);
    if (phase === 'Unknown') assert.equal(call('dnsDecisionWrites', tag(expected)), false);
  }
  for (const phase of ['Idle', 'Published', 'Refused', 'Unknown']) {
    const state = publication(phase);
    assert.equal(call('dnsReadDecision', state, candidate, read, 15).tag, phase === 'Unknown' ? 'Wait' : 'Update');
    assert.equal(call('dnsReadDecision', state, candidate, { ...read, pointerDigest: candidate.pointerDigest }, 100).tag, 'Reconciled');
    for (const field of ['zoneId', 'name', 'authorityKey']) {
      const otherScope = { ...scope, [field]: bytes('wrong') };
      assert.equal(call('dnsRequestAllowed', { ...state, scope: otherScope }, candidate, false), false);
      assert.equal(call('dnsReadDecision', state, candidate, { ...read, scope: otherScope }, 15).tag, 'Refuse');
    }
    for (const observation of [{ ...read, complete: false }, { ...read, authenticated: false }, { ...read, recordId: bytes('record-2') }, { ...read, candidateDigest: bytes('another-candidate') }]) {
      assert.equal(call('dnsReadDecision', state, candidate, observation, 15).tag, 'Refuse');
    }
    assert.equal(call('dnsRequestAllowed', state, candidate, true), false);
  }
  assert.equal(call('dnsReadDecision', publication('Unknown'), { ...candidate, pointerDigest: bytes('different') }, read, 15).tag, 'Refuse');
  const initial = { ...publication('Idle'), hasRecordId: false, recordId: bytes('') };
  const absent = { ...read, recordPresent: false, authenticated: false, recordId: bytes('') };
  assert.equal(call('dnsReadDecision', initial, { ...candidate, hasPrevious: false, revision: 0 }, absent, 15).tag, 'Create');
  assert.equal(call('dnsReadDecision', initial, candidate, absent, 15).tag, 'Refuse');
  for (const now of [9, 20]) assert.equal(call('dnsReadDecision', publication('Published'), candidate, read, now).tag, 'Refuse');
});

test('DNS completion consumes only matching scope/candidate and exact retained provider record ID', () => {
  const state = publication('Unknown'), result = { scope, candidateDigest: candidate.pointerDigest, recordId: bytes('record-1'), recordIdValid: true, acknowledged: true, refused: false };
  assert.equal(call('dnsFinishWrite', state, result).phase.tag, 'Published');
  for (const field of ['zoneId', 'name', 'authorityKey']) {
    assert.equal(call('dnsFinishWrite', state, { ...result, scope: { ...scope, [field]: bytes('wrong') } }).phase.tag, 'Unknown');
  }
  for (const resultChange of [{ candidateDigest: bytes('wrong') }, { recordId: bytes('replacement-id') }, { recordIdValid: false }, { acknowledged: false }]) {
    assert.equal(call('dnsFinishWrite', state, { ...result, ...resultChange }).phase.tag, 'Unknown');
  }
  assert.equal(call('dnsFinishWrite', state, { ...result, acknowledged: false, refused: true }).phase.tag, 'Refused');
  assert.equal(call('dnsFinishWrite', state, { ...result, acknowledged: true, refused: true }).phase.tag, 'Unknown', 'contradictory observation must not enable a retry');
  assert.equal(call('dnsFinishWrite', publication('Published'), result).phase.tag, 'Published');
});

test('DNS adapter cannot turn a Wait reducer no-op into write admission', () => {
  const destination = { zoneId: 'zone', name: 'name.example', trustedAuthorityKey: 'key' };
  const pointer = { pointerDigest: 'candidate', previousDigest: null, revision: 0, validFromMs: 0, validUntilMs: 10 };
  const pending = { outcome: 'unknown', pointerDigest: 'candidate', recordId: null, candidate: pointer };
  assert.throws(() => dnsWriteState(destination, pending, pointer, null, null, 5), /refused DNS write admission/);
  const begun = dnsWriteState(destination, undefined, pointer, null, null, 5);
  assert.equal(begun.outcome, 'unknown');
  assert.equal(dnsWriteOutcome(destination, begun, { ok: true, outcome: 'published', id: 'new-record' }), 'published');
  assert.equal(dnsWriteOutcome(destination, { ...begun, recordId: 'old-record' }, { ok: true, outcome: 'published', id: 'new-record' }), 'unknown');
  assert.deepEqual(dnsLifecycle(pending), { outcome: 'unknown', recordId: null, pointerDigest: 'candidate', canPublish: false, canReconcile: true });
  assert.equal(dnsLifecycle(pending, true).canReconcile, false);
});

function mutatedRuntime(t, name, change, testFile) {
  const directory = mkdtempSync(join(tmpdir(), `stitch-effects-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['app/src', 'app/language', 'src', 'scripts/check-model.mjs', `tests/${testFile}`]) cpSync(resolve(root, path), resolve(directory, path), { recursive: true });
  writeFileSync(resolve(directory, 'package.json'), '{"type":"module"}');
  const source = resolve(directory, 'app/src/Stitch/Effects.lex.tex'), before = readFileSync(source, 'utf8'), after = change(before);
  assert.notEqual(after, before, name); writeFileSync(source, after);
  const generated = spawnSync(process.execPath, ['scripts/check-model.mjs', '--write', '--inventory'], { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr);
  const inventory = JSON.parse(generated.stdout);
  assert.equal(inventory.executionDigest, modelExecutionDigest, 'host lifecycle policy is outside replay execution semantics');
  assert.notEqual(inventory.sourceDigest, MODEL_SOURCE.sourceDigest);
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const arguments_ = ['--test', '--test-reporter=tap', ...(name === 'stale-vm' ? ['--test-name-pattern=boot deadline'] : []), `tests/${testFile}`];
  const run = spawnSync(process.execPath, arguments_, { cwd: directory, encoding: 'utf8', timeout: 10000, env: environment });
  assert.equal(run.error, undefined, run.error?.message);
  assert.notEqual(run.status, 0, `runtime regression suite survived source mutation ${name}\n${run.stdout}`);
  assert.match(run.stdout, /fail [1-9]/);
}
const replaceBody = (source, name, body) => {
  const start = source.indexOf(`  name: ${name},`), begin = source.indexOf('  body:', start), end = source.indexOf('\n}', begin);
  assert.ok(start >= 0 && begin > start && end > begin);
  return source.slice(0, begin) + `  body: ${body}` + source.slice(end);
};
for (const [name, change, testFile] of [
  ['stale-session', s => replaceBody(s, 'transportSessionMatches', 'true'), 'transport-generation.test.js'],
  ['channel-replacement', s => replaceBody(s, 'transportChannelCallbackAllowed', '(transportPeerCallbackAllowed state callback remotePeer entryCurrent)'), 'transport-generation.test.js'],
  ['concurrent-dns', s => replaceBody(s, 'dnsRequestAllowed', 'true'), 'dns-publication.test.js'],
  ['repeat-unknown-dns', s => s.replace('| DnsPhase.Unknown => false)', '| DnsPhase.Unknown => true)'), 'dns-publication.test.js'],
  ['stale-vm', s => replaceBody(s, 'vmCallbackAllowed', 'true'), 'vm-lifecycle.test.js'],
  ['duplicate-boot', s => replaceBody(s, 'vmCanBoot', 'true'), 'vm-lifecycle.test.js'],
  ['connection-window', s => replaceBody(s, 'c1ConnectionQualified', 'true'), 'connection-measurement.test.js']
]) test(`actual runtime regression rejects source defect: ${name}`, t => mutatedRuntime(t, name, change, testFile));
