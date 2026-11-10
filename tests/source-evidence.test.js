import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSourceEvidence } from '../scripts/check-source-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(run) {
  const path = mkdtempSync(join(tmpdir(), 'stitch-proof-inputs-'));
  try {
    // Never copy potentially large ignored compiler/build output into fixtures.
    const names = [...JSON.parse(readFileSync(join(root, 'product/source-verification.json'))).sources.map(input => input.path),
      'product/source-verification.json', 'product/source-attestation.json', 'product/source-build-manifest.json', 'prismpm.lock'];
    for (const name of names) { mkdirSync(dirname(join(path, name)), { recursive: true }); cpSync(join(root, name), join(path, name)); }
    run(path);
  } finally { rmSync(path, { recursive: true, force: true }); }
}
function edit(path, name, change) {
  const file = join(path, name), data = JSON.parse(readFileSync(file));
  change(data); writeFileSync(file, JSON.stringify(data));
}
function rebindAttestation(path) {
  edit(path, 'product/source-verification.json', data => { data.attestation_sha256 = hash(readFileSync(join(path, 'product/source-attestation.json'))); });
}

test('retained actual proof evidence matches the complete current source and pinned tool identities', () => {
  assert.equal(checkSourceEvidence(root).status, 'verified');
});

test('host-only changes do not invalidate unchanged retained source evidence', () => fixture(path => {
  writeFileSync(join(path, 'index.html'), 'Changed host, requiring its own runtime/browser checks.');
  assert.equal(checkSourceEvidence(path).status, 'verified');
}));

test('non-input documentation in source and lexicon directories does not invalidate proof', () => fixture(path => {
  for (const name of ['app/src/README.md', 'app/src/Stitch/README.md', 'app/src/Notes.tex', 'app/src/module.lex.tex.md', 'app/language/README.md', 'app/language/stitch.domain/README.md']) {
    writeFileSync(join(path, name), 'Documentation outside the compiler input set.');
  }
  assert.equal(checkSourceEvidence(path).status, 'verified');
}));

test('changed source, vocabulary, configuration or source lock refuses stale retained proof', () => {
  for (const name of ['app/src/Stitch/Custody.lex.tex', 'app/language/stitch.domain/lexicon.toml', 'app/lexlean.toml', 'app/lexlean.lock', 'app/lakefile.toml']) fixture(path => {
    const file = join(path, name);
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n')]));
    assert.throws(() => checkSourceEvidence(path), /stale or incomplete/, name);
  });
});

test('an added or omitted source input cannot hide outside the old inventory', () => {
  fixture(path => {
    writeFileSync(join(path, 'app/src/Stitch/Unverified.lex.tex'), 'Unverified source.');
    assert.throws(() => checkSourceEvidence(path), /stale or incomplete/);
  });
  fixture(path => {
    edit(path, 'product/source-verification.json', data => { data.sources.pop(); });
    assert.throws(() => checkSourceEvidence(path), /stale or incomplete/);
  });
  fixture(path => {
    rmSync(join(path, 'app/src/Stitch/Custody.lex.tex'));
    assert.throws(() => checkSourceEvidence(path), /stale or incomplete/);
  });
});

test('added and removed lexicon entries invalidate retained proof', () => {
  for (const name of ['new-entry.toml', 'README.md']) fixture(path => {
    writeFileSync(join(path, `app/language/stitch.domain/entries/${name}`), 'Unverified vocabulary input, including invalid entry filenames.');
    assert.throws(() => checkSourceEvidence(path), /stale or incomplete/);
  });
  fixture(path => {
    rmSync(join(path, 'app/language/stitch.domain/entries/stitch-placement.toml'));
    assert.throws(() => checkSourceEvidence(path), /stale or incomplete/);
  });
});

test('changed attestation and manifest bytes fail their existing digest bindings', () => {
  fixture(path => {
    edit(path, 'product/source-attestation.json', data => { data.status = 'failed'; });
    assert.throws(() => checkSourceEvidence(path), /attestation bytes differ/);
  });
  fixture(path => {
    edit(path, 'product/source-build-manifest.json', data => { data.build_id = '0'.repeat(64); });
    assert.throws(() => checkSourceEvidence(path), /build manifest bytes differ/);
  });
});

test('inconsistent summary identities, statuses and counts fail even with readable artifacts', () => {
  for (const key of ['attestation_id', 'source_id', 'semantic_id', 'build_id']) fixture(path => {
    edit(path, 'product/source-verification.json', data => { data[key] = '0'.repeat(64); });
    assert.throws(() => checkSourceEvidence(path), /differs/, key);
  });
  for (const key of ['module_count', 'declaration_audits', 'successful_processes']) fixture(path => {
    edit(path, 'product/source-verification.json', data => { data[key]--; });
    assert.throws(() => checkSourceEvidence(path), assert.AssertionError, key);
  });
  fixture(path => {
    edit(path, 'product/source-verification.json', data => { data.status = 'failed'; });
    assert.throws(() => checkSourceEvidence(path), /not verified/);
  });
  fixture(path => {
    edit(path, 'product/source-verification.json', data => { data.processes_by_tool.lean--; });
    assert.throws(() => checkSourceEvidence(path), assert.AssertionError);
  });
});

test('a rebound digest cannot hide a mismatched manifest identity or an undeclared path', () => {
  fixture(path => {
    edit(path, 'product/source-build-manifest.json', data => { data.build_id = '0'.repeat(64); });
    const bytes = readFileSync(join(path, 'product/source-build-manifest.json'));
    edit(path, 'product/source-attestation.json', data => { data.build_manifest = { byte_length: bytes.length, sha256: hash(bytes) }; });
    rebindAttestation(path);
    assert.throws(() => checkSourceEvidence(path), /build_id differs from manifest/);
  });
  fixture(path => {
    edit(path, 'product/source-attestation.json', data => { data.lake_workspace[0].path = '../../outside-project'; });
    rebindAttestation(path);
    assert.throws(() => checkSourceEvidence(path), /undeclared workspace input/);
  });
});

test('reported failure and mismatched upstream tools cannot become passing retained evidence', () => {
  for (const change of [
    data => { data.status = 'failed'; },
    data => { data.declarations[0].result = 'failed'; },
    data => { data.processes[0].exit_code = 1; },
    data => { data.lexlean.executable_sha256 = '0'.repeat(64); },
  ]) fixture(path => {
    edit(path, 'product/source-attestation.json', change);
    rebindAttestation(path);
    assert.throws(() => checkSourceEvidence(path), assert.AssertionError);
  });
});
