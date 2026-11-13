import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSourceEvidence } from '../scripts/check-source-evidence.mjs';
import { retainSourceEvidence } from '../scripts/retain-source-evidence.mjs';

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

// Retention uses actual committed verifier bytes as fixtures. Mutations below
// are refusal cases only; none are presented as new verifier evidence.
function incoming(path) {
  const dir = join(path, 'incoming');
  mkdirSync(dir);
  for (const name of ['source-attestation.json', 'source-build-manifest.json']) {
    cpSync(join(root, 'product', name), join(dir, name));
  }
  return [join(dir, 'source-attestation.json'), join(dir, 'source-build-manifest.json')];
}
const retainedNames = ['source-attestation.json', 'source-build-manifest.json', 'source-verification.json'];
const retainedBytes = path => retainedNames.map(name => readFileSync(join(path, 'product', name)));
function refusal(change, pattern = assert.AssertionError) {
  fixture(path => {
    const records = incoming(path), before = retainedBytes(path);
    change(path);
    assert.throws(() => retainSourceEvidence(...records, path), pattern);
    assert.deepEqual(retainedBytes(path), before, 'refused evidence must not change any retained file');
    assert.deepEqual(readdirSync(join(path, 'product')).sort(), [...retainedNames].sort(), 'no staging files left behind');
  });
}

test('retention reproduces the existing summary and preserves actual verifier bytes exactly', () => fixture(path => {
  const records = incoming(path), before = retainedBytes(path);
  const summary = retainSourceEvidence(...records, path);
  assert.deepEqual(summary, JSON.parse(before[2]));
  assert.deepEqual(retainedBytes(path), before);
  assert.deepEqual(checkSourceEvidence(path), summary);
  retainSourceEvidence(...records, path);
  assert.deepEqual(retainedBytes(path), before, 'repeated retention is byte-for-byte reproducible');
  assert.deepEqual(readdirSync(join(path, 'product')).sort(), [...retainedNames].sort());
}));

test('retention works without an old summary and hashes original attestation whitespace', () => fixture(path => {
  const records = incoming(path);
  const attestationBytes = Buffer.concat([readFileSync(records[0]), Buffer.from('\n\t\n')]);
  writeFileSync(records[0], attestationBytes);
  for (const name of retainedNames) rmSync(join(path, 'product', name));
  const summary = retainSourceEvidence(...records, path);
  assert.equal(summary.attestation_sha256, hash(attestationBytes));
  assert.deepEqual(readFileSync(join(path, 'product/source-attestation.json')), attestationBytes);
  assert.deepEqual(readFileSync(join(path, 'product/source-build-manifest.json')), readFileSync(records[1]));
  assert.deepEqual(checkSourceEvidence(path), summary);
}));

test('retention derives identities, counts and scope from records, not the old summary', () => fixture(path => {
  const records = incoming(path);
  writeFileSync(join(path, 'product/source-verification.json'), '{not JSON');
  const summary = retainSourceEvidence(...records, path);
  assert.deepEqual(summary, JSON.parse(readFileSync(join(root, 'product/source-verification.json'))));
  assert.match(summary.assurance, /not a native Prism artifact certificate/);
  assert.ok(summary.not_covered.includes('Native Prism/Holo and guest artifact build'));
}));

test('retention rejects changed source, config, lock and workspace before replacing output', () => {
  for (const name of ['app/src/Stitch/Custody.lex.tex', 'app/lexlean.toml', 'app/lexlean.lock', 'app/lakefile.toml', 'app/lake-manifest.json', 'app/lean-toolchain']) {
    refusal(path => {
      const file = join(path, name);
      writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n')]));
    }, /manifest input differs|workspace input differs/);
  }
  refusal(path => writeFileSync(join(path, 'app/src/Stitch/Unverified.lex.tex'), 'unverified'), /manifest source closure differs/);
  refusal(path => rmSync(join(path, 'app/src/Stitch/Custody.lex.tex')), /manifest source closure differs/);
});

test('retention cannot launder stale lexicon evidence through a new current-source summary', () => {
  for (const name of ['app/language/stitch.domain/lexicon.toml', 'app/language/stitch.domain/entries/stitch-placement.toml']) {
    refusal(path => {
      const file = join(path, name);
      writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n')]));
    }, /manifest lexicon differs/);
  }
  for (const name of ['extra.toml', 'README.md']) {
    refusal(path => writeFileSync(join(path, `app/language/stitch.domain/entries/${name}`), 'unverified'), /manifest lexicon differs/);
  }
  refusal(path => rmSync(join(path, 'app/language/stitch.domain/entries/stitch-placement.toml')), /manifest lexicon differs/);
});

test('retention rejects invalid record bytes, failed proofs and mismatched tool or content identities', () => {
  refusal(path => writeFileSync(join(path, 'incoming/source-attestation.json'), '{not JSON'), SyntaxError);
  refusal(path => writeFileSync(join(path, 'incoming/source-build-manifest.json'), '{not JSON'), SyntaxError);
  refusal(path => edit(path, 'incoming/source-build-manifest.json', data => { data.build_id = '0'.repeat(64); }), /build manifest bytes differ/);
  for (const change of [
    data => { data.spec = 'lexlean/attestation/unknown'; },
    data => { data.status = 'failed'; },
    data => { data.attestation_id = 'invalid'; },
    data => { data.build_id = '0'.repeat(64); },
    data => { data.declarations = []; },
    data => { data.declarations[0].result = 'failed'; },
    data => { data.processes = []; },
    data => { data.processes = data.processes.filter(process => process.tool !== 'leanchecker'); },
    data => { data.processes[0].exit_code = 1; },
    data => { data.processes[0].tool = 'unknown'; },
    data => { data.processes[0].stdout += 'tampered'; },
    data => { data.processes[0].stderr += 'tampered'; },
    data => { data.processes[0].executable_sha256 = '0'.repeat(64); },
    data => { data.lexlean.executable_sha256 = '0'.repeat(64); },
    data => { data.lexlean.compiler_semantics = '0'.repeat(64); },
    data => { data.lexlean.version = 'unknown'; },
    data => { data.lake_workspace.pop(); },
    data => { data.lake_workspace.push(data.lake_workspace[0]); },
    data => { data.lake_workspace[0].path = '../../outside-project'; },
    data => { data.host.os = 'unknown'; },
  ]) refusal(path => edit(path, 'incoming/source-attestation.json', change));
  refusal(path => edit(path, 'prismpm.lock', data => {
    for (const platform of data.platforms) platform.inventory.find(item => item.id === 'lexlean').digest = `sha256:${'0'.repeat(64)}`;
  }), /proof tool differs from pinned SDK/);
});

function rebindIncomingManifest(path) {
  const bytes = readFileSync(join(path, 'incoming/source-build-manifest.json'));
  edit(path, 'incoming/source-attestation.json', data => { data.build_manifest = { byte_length: bytes.length, sha256: hash(bytes) }; });
}

test('retention rejects incomplete manifest coverage even when its byte binding is updated', () => {
  for (const change of [
    data => { data.inputs = data.inputs.filter(input => input.kind !== 'lock'); },
    data => { data.inputs = data.inputs.filter(input => input.kind !== 'project-config'); },
    data => { data.inputs.find(input => input.kind === 'source').byte_length++; },
    data => { data.inputs.push({ kind: 'unhandled-input', path: 'unknown' }); },
    data => { data.inputs.find(input => input.kind === 'lexicon' && input.path !== 'embedded').path = 'language/../../outside'; },
    data => { data.inputs.find(input => input.kind === 'lexicon' && input.path !== 'embedded').byte_length++; },
    data => { data.modules.pop(); },
  ]) refusal(path => {
    edit(path, 'incoming/source-build-manifest.json', change);
    rebindIncomingManifest(path);
  });
});

test('retention rejects symlinked sources, evidence and destinations', () => {
  for (const name of ['app/src/Stitch/Custody.lex.tex', 'app/language/stitch.domain/lexicon.toml', 'incoming/source-attestation.json']) {
    refusal(path => {
      const original = join(path, name), copy = `${original}.original`;
      cpSync(original, copy); rmSync(original); symlinkSync(copy, original);
    }, /symlink/);
  }
  fixture(path => {
    const records = incoming(path), outside = join(path, 'outside.json');
    writeFileSync(outside, 'untouched');
    rmSync(join(path, 'product/source-attestation.json'));
    symlinkSync(outside, join(path, 'product/source-attestation.json'));
    assert.throws(() => retainSourceEvidence(...records, path), /destination is not a nonsymlink file/);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  });
});


test('retention CLI requires an explicit pair and reports the separate native gate', () => fixture(path => {
  const records = incoming(path), before = retainedBytes(path);
  mkdirSync(join(path, 'scripts'));
  for (const name of ['check-source-evidence.mjs', 'retain-source-evidence.mjs']) {
    cpSync(join(root, 'scripts', name), join(path, 'scripts', name));
  }
  const script = join(path, 'scripts/retain-source-evidence.mjs');
  for (const args of [[], [records[0]], [...records, '--force']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: path });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /usage:/);
    assert.deepEqual(retainedBytes(path), before);
  }
  const result = spawnSync(process.execPath, [script, ...records], { encoding: 'utf8', cwd: path });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Native Prism acceptance remains separate/);
  assert.deepEqual(retainedBytes(path), before);
}));
