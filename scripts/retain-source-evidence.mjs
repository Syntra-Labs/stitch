#!/usr/bin/env node
/** Retain actual source-verifier records. Never runs or replaces a native gate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSourceInputs, validateSourceEvidence } from './check-source-evidence.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Inputs are the unmodified files emitted by the actual pinned verifier. */
export function retainSourceEvidence(attestationPath, manifestPath, root = projectRoot) {
  function readRecord(path) {
    assert.ok(lstatSync(path).isFile(), `evidence is not a nonsymlink file: ${path}`);
    return readFileSync(path);
  }
  const attestationBytes = readRecord(attestationPath), manifestBytes = readRecord(manifestPath);
  const attestation = JSON.parse(attestationBytes), manifest = JSON.parse(manifestBytes);
  const sources = discoverSourceInputs(root, manifest);
  const counts = {};
  for (const process of attestation.processes) counts[process.tool] = (counts[process.tool] ?? 0) + 1;
  const summary = {
    format: 'Stitch exact-source verification summary',
    version: 1,
    assurance: 'Summary of actual pinned LexLean/Lean/leanchecker/axiom verification; not a native Prism artifact certificate or whole-host guarantee',
    attestation_id: attestation.attestation_id,
    attestation_sha256: hash(attestationBytes),
    source_id: attestation.source_id,
    semantic_id: attestation.semantic_id,
    build_id: attestation.build_id,
    status: attestation.status,
    module_count: manifest.modules.length,
    declaration_audits: attestation.declarations.length,
    successful_processes: attestation.processes.length,
    processes_by_tool: counts,
    sources,
    not_covered: [
      'Native Prism/Holo and guest artifact build',
      'Browser/provider/VM correctness and physical network trials',
      'Licensing and release qualification',
      'Handwritten host-code representation correspondence beyond named runtime tests',
    ],
    attestation_path: 'product/source-attestation.json',
    build_manifest_path: 'product/source-build-manifest.json',
  };
  // Validate everything before touching any destination, including on first use
  // when there is no previous summary. Retention does not establish provenance
  // of arbitrary supplied JSON; use only records from the real verifier run.
  validateSourceEvidence(root, summary, attestationBytes, manifestBytes);
  const product = resolve(root, 'product');
  assert.ok(lstatSync(product).isDirectory(), 'product is not a nonsymlink directory');
  const records = [
    ['source-attestation.json', attestationBytes],
    ['source-build-manifest.json', manifestBytes],
    ['source-verification.json', Buffer.from(`${JSON.stringify(summary, null, 2)}\n`)],
  ];
  for (const [name] of records) {
    const existing = lstatSync(join(product, name), { throwIfNoEntry: false });
    assert.ok(!existing || existing.isFile(), `destination is not a nonsymlink file: product/${name}`);
  }
  const stage = mkdtempSync(join(product, '.source-evidence-'));
  try {
    for (const [name, bytes] of records) writeFileSync(join(stage, name), bytes, { flag: 'wx' });
    // Detect a changed source or SDK pin while preparing the files. Replace the
    // summary last: an interrupted multi-file replacement must fail closed.
    validateSourceEvidence(root, summary, attestationBytes, manifestBytes);
    for (const [name] of records) renameSync(join(stage, name), join(product, name));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some(arg => arg.startsWith('--'))) {
    console.error('usage: node scripts/retain-source-evidence.mjs <attestation.json> <build-manifest.json>');
    process.exitCode = 64;
  } else {
    const summary = retainSourceEvidence(resolve(args[0]), resolve(args[1]));
    console.log(`Retained actual source evidence for ${summary.module_count} modules. Native Prism acceptance remains separate.`);
  }
}
