import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function build(t, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stitch-execution-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['scripts/check-model.mjs', 'app/src', 'app/language', 'src/layer1-uor', 'src/layer4-compute/replay.js']) {
    cpSync(resolve(root, path), resolve(dir, path), { recursive: true });
  }
  writeFileSync(resolve(dir, 'package.json'), '{"type":"module"}');
  mutate((path, change) => {
    const target = resolve(dir, path), before = readFileSync(target, 'utf8'), after = change(before);
    assert.notEqual(after, before, `mutation must change ${path}`); writeFileSync(target, after);
  });
  const result = spawnSync(process.execPath, ['scripts/check-model.mjs', '--write', '--inventory'], { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const check = spawnSync(process.execPath, ['scripts/check-model.mjs', '--check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  return { dir, inventory: JSON.parse(result.stdout), runtime: () => import(pathToFileURL(resolve(dir, 'src/layer4-compute/replay.js')).href) };
}
const program = { version: 1, bits: 8, initialValueHex: '0x0', instructions: [{ op: 2 }] };

test('execution closure identifies actual ring and checkpoint roots, interpreter and transitive adapters', t => {
  const { inventory } = build(t);
  assert.match(inventory.executionDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(inventory.executionDigest, inventory.sourceDigest);
  assert.deepEqual(inventory.executionIdentity.roots, ['Stitch.Compute.checkpointLinkAllowed', 'Stitch.Compute.ringStep']);
  assert.deepEqual(Object.keys(inventory.executionIdentity.definitions), [
    'Stitch.Compute.checkpointLinkAllowed', 'Stitch.Compute.natBitwise', 'Stitch.Compute.normalize', 'Stitch.Compute.ringStep'
  ]);
  assert.deepEqual(Object.keys(inventory.executionIdentity.types), ['Stitch.Compute.Instruction']);
  assert.deepEqual(inventory.executionIdentity.adapterSources.map(s => s.path), [
    'src/layer1-uor/contracts.js', 'src/layer1-uor/custody.js', 'src/layer1-uor/index.js', 'src/layer4-compute/replay.js'
  ]);
});

test('source formatting, proof-only and unrelated product changes preserve replay compatibility but not provenance', async t => {
  const base = build(t), baseline = await base.runtime(), checkpoint = await baseline.createCheckpoint(program, 1);
  for (const mutate of [
    edit => edit('app/src/Stitch/Compute.lex.tex', s => s.replace('  name: ringStep,', '    name:    ringStep,')),
    edit => edit('app/src/Stitch/Compute.lex.tex', s => s.replace('proof: reflexivity{}', 'proof: simplify{definitions: [checkpointLinkAllowed]}')),
    edit => edit('app/src/Product/Architecture.lex.tex', s => s.replace('Conditional recovery and honest assurance', 'Recovery and precise assurance')),
    edit => edit('app/src/Stitch/Budget.lex.tex', s => s.replace('(reserved + cost)', '(reserved + (cost + 1))'))
  ]) {
    const changed = build(t, mutate);
    assert.notEqual(changed.inventory.sourceDigest, base.inventory.sourceDigest);
    assert.equal(changed.inventory.executionDigest, base.inventory.executionDigest);
    const runtime = await changed.runtime();
    assert.equal((await runtime.verifyCheckpoint(program, checkpoint)).execution, 'replayed');
    assert.equal((await runtime.createCheckpoint(program, 1)).checkpointDigest, checkpoint.checkpointDigest);
  }
});

test('reachable operation, normalization, interpreter primitive and adapter changes invalidate the execution root', async t => {
  const base = build(t), baseline = await base.runtime(), checkpoint = await baseline.createCheckpoint(program, 1);
  for (const mutate of [
    edit => edit('app/src/Stitch/Compute.lex.tex', s => s.replace('then (x + 1)', 'then (x + 2)')),
    edit => edit('app/src/Stitch/Compute.lex.tex', s => s.replace('body: (prim remainder value modulus 0 : Nat)', 'body: (prim quotient value modulus 0 : Nat)')),
    edit => edit('scripts/check-model.mjs', s => s.replace("case 'subtract':return a[0]>=a[1]?a[0]-a[1]:0n", "case 'subtract':return a[0]>=a[1]?a[0]+a[1]:0n")),
    edit => edit('src/layer1-uor/contracts.js', s => s.replace('value.length > 34', 'value.length > 35')),
    edit => edit('src/layer1-uor/index.js', s => s.replace('SUCC: 2,', 'SUCC: 20,'))
  ]) {
    const changed = build(t, mutate);
    assert.notEqual(changed.inventory.executionDigest, base.inventory.executionDigest);
    const runtime = await changed.runtime();
    await assert.rejects(runtime.verifyCheckpoint(program, checkpoint), error => ['checkpoint-model', 'unsupported-operation'].includes(error.code));
  }
});

test('legacy whole-source roots and arbitrary execution roots are not implicitly trusted', async t => {
  const base = build(t), runtime = await base.runtime(), checkpoint = await runtime.createCheckpoint(program, 1);
  for (const modelDigest of [base.inventory.sourceDigest, 'sha256:' + '0'.repeat(64)]) {
    await assert.rejects(runtime.verifyCheckpoint(program, { ...checkpoint, modelDigest }), error => error.code === 'checkpoint-model');
  }
});
