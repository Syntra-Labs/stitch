#!/usr/bin/env node
/** Check retained proof inputs, not the proof or the native acceptance gate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Discover current compiler inputs, including additions outside an old summary. */
export function discoverSourceInputs(root, manifest) {
  // LexLean discovers .lex.tex modules; a lexicon reads lexicon.toml and entries/.
  assert.ok(lstatSync(resolve(root, 'app')).isDirectory(), 'app is not a nonsymlink directory');
  const inputs = ['app/lake-manifest.json', 'app/lakefile.toml', 'app/lean-toolchain', 'app/lexlean.lock', 'app/lexlean.toml', 'app/prism.toml', 'app/prismpm.toml'];
  function walk(path, includes = () => true) {
    assert.ok(lstatSync(resolve(root, path)).isDirectory(), `input root is not a nonsymlink directory: ${path}`);
    for (const name of readdirSync(resolve(root, path)).sort()) {
      const child = `${path}/${name}`, stat = lstatSync(resolve(root, child));
      assert.ok(!stat.isSymbolicLink(), `source input is a symlink: ${child}`);
      if (stat.isDirectory()) walk(child, includes);
      else if (includes(child)) { assert.ok(stat.isFile(), `source input is not a file: ${child}`); inputs.push(child); }
    }
  }
  walk('app/src', path => path.endsWith('.lex.tex'));
  for (const input of manifest.inputs.filter(input => input.kind === 'lexicon' && input.path !== 'embedded')) {
    assert.ok(/^language\/[A-Za-z0-9_./-]+$/.test(input.path) && input.path.split('/').every(part => part && part !== '.' && part !== '..'), 'invalid lexicon input path');
    // Reject a symlink in any lexicon directory component, not just its files.
    const parts = `app/${input.path}`.split('/');
    for (let i = 1; i <= parts.length; i++) {
      assert.ok(lstatSync(resolve(root, ...parts.slice(0, i))).isDirectory(), 'lexicon root is not a nonsymlink directory');
    }
    inputs.push(`app/${input.path}/lexicon.toml`);
    if (lstatSync(resolve(root, `app/${input.path}/entries`), { throwIfNoEntry: false })) walk(`app/${input.path}/entries`);
  }
  return inputs.sort().map(path => {
    assert.ok(lstatSync(resolve(root, path)).isFile(), `input is not a nonsymlink file: ${path}`);
    return { path, sha256: hash(readFileSync(resolve(root, path))) };
  });
}

/** Validate supplied records before retention, or check the retained files. */
export function validateSourceEvidence(root, summary, attestationBytes, manifestBytes) {
  const read = path => readFileSync(resolve(root, path));
  const json = path => JSON.parse(read(path));
  const attestation = JSON.parse(attestationBytes), manifest = JSON.parse(manifestBytes);
  assert.equal(summary.version, 1, 'unsupported source summary');
  assert.equal(attestation.spec, 'lexlean/attestation/2', 'unsupported attestation');
  assert.equal(manifest.spec, 'lexlean/build-manifest/1', 'unsupported build manifest');
  assert.equal(summary.attestation_path, 'product/source-attestation.json');
  assert.equal(summary.build_manifest_path, 'product/source-build-manifest.json');
  assert.equal(hash(attestationBytes), summary.attestation_sha256, 'attestation bytes differ');
  assert.deepEqual({ byte_length: manifestBytes.length, sha256: hash(manifestBytes) }, attestation.build_manifest, 'build manifest bytes differ');
  assert.equal(summary.status, 'verified', 'source summary is not verified');
  assert.equal(attestation.status, 'verified', 'attestation is not verified');
  for (const key of ['attestation_id', 'source_id', 'semantic_id', 'build_id']) {
    assert.match(summary[key], /^[0-9a-f]{64}$/, `invalid ${key}`);
    assert.equal(summary[key], attestation[key], `${key} differs`);
    if (key !== 'attestation_id') assert.equal(summary[key], manifest[key], `${key} differs from manifest`);
  }

  const current = discoverSourceInputs(root, manifest);
  assert.deepEqual(summary.sources, current, 'retained source evidence is stale or incomplete');
  const inputPaths = new Set(current.map(input => input.path));
  const sourceInputs = manifest.inputs.filter(input => input.kind === 'source');
  const modules = current.filter(input => input.path.startsWith('app/src/') && input.path.endsWith('.lex.tex')).map(input => input.path);
  assert.deepEqual(sourceInputs.map(input => `app/${input.path}`).sort(), modules, 'manifest source closure differs');
  assert.deepEqual(manifest.modules.map(module => `app/${module.source_path}`).sort(), modules, 'manifest module closure differs');
  for (const input of manifest.inputs.filter(input => ['source', 'lock', 'project-config'].includes(input.kind))) {
    assert.ok(inputPaths.has(`app/${input.path}`), `undeclared manifest input: ${input.path}`);
    const bytes = read(`app/${input.path}`);
    assert.equal(hash(bytes), input.sha256, `manifest input differs: ${input.path}`);
    assert.equal(bytes.length, input.byte_length, `manifest length differs: ${input.path}`);
  }
  // LexLean tree-digest v1: domain + NUL, then bytewise-sorted framed paths
  // and file bytes. Do not trust a freshly generated summary to bind old proof
  // to a changed lexicon: the manifest itself must bind its current tree.
  for (const input of manifest.inputs.filter(input => input.kind === 'lexicon' && input.path !== 'embedded')) {
    const prefix = `app/${input.path}/`;
    const files = current.map(input => input.path).filter(path => path.startsWith(prefix))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const digest = createHash('sha256').update('lexlean-tree-v1\0');
    let byteLength = 0;
    for (const path of files) {
      const name = Buffer.from(path.slice(prefix.length)), bytes = read(path);
      const pathLength = Buffer.alloc(4), size = Buffer.alloc(8);
      pathLength.writeUInt32BE(name.length);
      size.writeBigUInt64BE(BigInt(bytes.length));
      digest.update(pathLength).update(name).update(size).update(bytes);
      byteLength += bytes.length;
    }
    assert.equal(digest.digest('hex'), input.sha256, `manifest lexicon differs: ${input.path}`);
    assert.equal(byteLength, input.byte_length, `manifest lexicon length differs: ${input.path}`);
  }
  assert.deepEqual(manifest.inputs.filter(input => input.kind === 'lock').map(input => input.path), ['lexlean.lock'], 'manifest lock closure differs');
  assert.deepEqual(manifest.inputs.filter(input => input.kind === 'project-config').map(input => input.path), ['lexlean.toml'], 'manifest config closure differs');
  assert.ok(manifest.inputs.every(input => ['source', 'lock', 'project-config', 'lexicon'].includes(input.kind)), 'unsupported manifest input kind');
  for (const input of attestation.lake_workspace) {
    assert.ok(inputPaths.has(`app/${input.path}`), `undeclared workspace input: ${input.path}`);
    assert.equal(hash(read(`app/${input.path}`)), input.sha256, `workspace input differs: ${input.path}`);
  }
  assert.deepEqual(attestation.lake_workspace.map(input => input.path).sort(), ['lake-manifest.json', 'lakefile.toml', 'lean-toolchain'], 'workspace input closure differs');
  assert.ok(modules.length > 0 && attestation.declarations.length > 0 && attestation.processes.length > 0, 'empty proof evidence');
  assert.equal(summary.module_count, modules.length);
  assert.equal(summary.declaration_audits, attestation.declarations.length);
  assert.equal(summary.successful_processes, attestation.processes.length);
  for (const declaration of attestation.declarations) assert.equal(declaration.result, 'ok', `failed declaration: ${declaration.name}`);
  const counts = {};
  for (const process of attestation.processes) {
    assert.equal(process.exit_code, 0, `failed process: ${process.module}`);
    assert.ok(['lean', 'leanchecker'].includes(process.tool), 'unexpected proof process');
    assert.equal(hash(process.stdout), process.stdout_sha256, 'stdout digest differs');
    assert.equal(hash(process.stderr), process.stderr_sha256, 'stderr digest differs');
    assert.equal(process.executable_sha256, attestation.toolchain[process.tool].executable_sha256, 'process tool identity differs');
    counts[process.tool] = (counts[process.tool] ?? 0) + 1;
  }
  assert.deepEqual(summary.processes_by_tool, counts);
  assert.ok(counts.lean > 0 && counts.leanchecker > 0, 'both proof tools are required');

  const lock = json('prismpm.lock');
  const architecture = { x86_64: 'amd64', aarch64: 'arm64' }[attestation.host.arch];
  assert.ok(architecture && attestation.host.os === 'linux', 'unsupported evidence host');
  const platform = lock.platforms.find(platform => platform.platform === `linux/${architecture}`);
  assert.ok(platform, 'evidence platform absent from pinned SDK');
  for (const [id, identity] of [['lexlean', attestation.lexlean], ['lean', attestation.toolchain.lean], ['leanchecker', attestation.toolchain.leanchecker]]) {
    assert.equal(platform.inventory.find(item => item.id === id)?.digest, `sha256:${identity.executable_sha256}`, `proof tool differs from pinned SDK: ${id}`);
  }
  assert.equal(manifest.compiler.semantics_id, attestation.lexlean.compiler_semantics);
  assert.equal(manifest.compiler.version, attestation.lexlean.version);
  return summary;
}

export function checkSourceEvidence(root = projectRoot) {
  const read = path => readFileSync(resolve(root, path));
  return validateSourceEvidence(root, JSON.parse(read('product/source-verification.json')),
    read('product/source-attestation.json'), read('product/source-build-manifest.json'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = checkSourceEvidence();
  console.log(`Retained source evidence matches ${summary.module_count} modules and pinned proof tools. Native Prism acceptance remains separate.`);
}
