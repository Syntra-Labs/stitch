import test from 'node:test';
import assert from 'node:assert/strict';
import { model } from '../src/layer1-uor/generated-model.js';
const call = (name, ...args) => model[`Stitch.VmAdministration.${name}`](...args);
test('source-derived VM admission predicates match independent finite grant and lifecycle oracles', () => {
  for (let mask = 0; mask < 64; mask++) {
    const [grant, ready, current, open, valid, blocked] = Array.from({ length: 6 }, (_, i) => !!(mask & (1 << i)));
    assert.equal(call('ethernetAllowed', grant, ready, current, open, valid, blocked), grant && ready && current && open && valid && !blocked);
    assert.equal(call('shareAllowed', grant, current, blocked), grant && current && !blocked);
    assert.equal(call('commandAllowed', ready, current, blocked, valid), ready && !current && !blocked && valid);
    assert.equal(call('administrationAllowed', ready, blocked), ready && !blocked);
    assert.equal(call('forgetAllowed', ready, valid, blocked), ready && valid && !blocked);
    for (const generation of [0, 1, 2]) for (const captured of [0, 1, 2]) {
      assert.equal(call('observationAllowed', generation, captured, current, ready, blocked), generation === captured && current && ready && !blocked);
    }
  }
});

import { installFilesystemControls, readBoundedVmFile, vmLimits } from '../src/layer4-compute/vm-administration.js';
import { filesystemFixture } from './helpers/vm-filesystem.js';

test('source-derived resource predicates cover exact boundaries and independent termination causes', () => {
  for (const limit of [0, 1, 3, 8]) for (let used = 0; used <= 10; used++) for (let request = 0; request <= 10; request++) {
    assert.equal(call('allocationAllowed', used, request, limit), used + request <= limit);
    assert.equal(call('metadataAllowed', used, limit), used < limit);
    for (const regular of [false, true]) assert.equal(call('resultReadAllowed', used, limit, regular), regular && used <= limit);
  }
  for (let mask = 0; mask < 8; mask++) {
    const args = [!!(mask & 1), !!(mask & 2), !!(mask & 4)];
    assert.equal(call('terminationRequired', ...args), args.some(Boolean));
  }
});

test('9p guard rejects oversized allocation before calling vendor allocator, and keeps a cumulative allowance', async () => {
  const fs = filesystemFixture(), violations = [];
  const usage = installFilesystemControls({ fs9p: fs }, error => violations.push(error));
  const id = fs.CreateFile('data', 0);
  for (let i = 0; i < 4; i++) await fs.ChangeSize(id, vmLimits.filesystemFileLimit);
  assert.equal(usage.allocatedBytes, vmLimits.filesystemAllocationLimit);
  const before = fs.allocations.length;
  assert.throws(() => fs.ChangeSize(id, 1), error => error.code === 'vm-filesystem-limit');
  assert.equal(fs.allocations.length, before);
  assert.equal(violations.length, 1);
  assert.throws(() => fs.CreateTextFile('bypass', 0, 'x'), /quarantined/);
  assert.equal(fs.allocations.length, before);
});

test('all local v86 allocation entrances and inode/link metadata are preflighted', async () => {
  for (const method of ['CreateBinaryFile', 'CreateTextFile']) {
    const fs = filesystemFixture(); installFilesystemControls({ fs9p: fs }, () => {});
    const body = method === 'CreateTextFile' ? 'x'.repeat(vmLimits.filesystemFileLimit + 1) : { length: vmLimits.filesystemFileLimit + 1 };
    assert.throws(() => fs[method]('large', 0, body), /before allocation/);
    assert.deepEqual(fs.allocations, []);
  }
  const fs = filesystemFixture(); const usage = installFilesystemControls({ fs9p: fs }, () => {});
  fs.CreateFile('entry', 0); fs.FillDirectory(0);
  assert.equal(usage.allocatedBytes, fs.allocations[0]);
  usage.linkedEntries = vmLimits.filesystemMetadataLimit;
  assert.throws(() => fs.link_under_dir(0, 1, 'another-link'), /directory-entry/);
  assert.equal(fs.inodes[0].direntries.has('another-link'), false);
  const other = filesystemFixture(); const otherUsage = installFilesystemControls({ fs9p: other }, () => {});
  otherUsage.createdInodes = vmLimits.filesystemMetadataLimit;
  assert.throws(() => other.CreateFile('inode', 0), /inode limit/);
  assert.equal(other.inodes.length, 1);
});

test('unsupported filesystem shape or mounts fail closed rather than falling back to unbounded APIs', () => {
  for (const fs9p of [null, {}, { ...filesystemFixture(), mounts: [{}] }, { ...filesystemFixture(), ChangeSize: null }]) {
    assert.throws(() => installFilesystemControls({ fs9p }, () => {}), error => error.code === 'vm-boundary-unavailable');
  }
});

test('bounded result reads inspect regular-file size before read and pass an exact bounded range', async () => {
  const fs = filesystemFixture(), vm = { fs9p: fs, read_file() { assert.fail('unbounded API must not be used'); } };
  assert.equal(await readBoundedVmFile(vm, 'missing', 4), null);
  const id = fs.setResult('output', Uint8Array.of(1, 2, 3));
  assert.deepEqual(await readBoundedVmFile(vm, 'output', 3), Uint8Array.of(1, 2, 3));
  assert.deepEqual(fs.reads, [{ id, offset: 0, length: 3 }]);
  fs.inodes[id].size = 4;
  await assert.rejects(readBoundedVmFile(vm, 'output', 3), error => error.code === 'vm-output-limit');
  assert.equal(fs.reads.length, 1);
  fs.inodes[id].size = 0; fs.inodes[id].mode = 0x4000;
  await assert.rejects(readBoundedVmFile(vm, 'output', 3), error => error.code === 'vm-output-limit');
  assert.equal(fs.reads.length, 1);
});

test('guest mutation while a read awaits never expands its range and invalid vendor responses fail closed', async () => {
  const fs = filesystemFixture(); const id = fs.setResult('output', Uint8Array.of(1)); let finish;
  fs.Read = async (inode, offset, size) => { assert.equal(size, 1); await new Promise(resolve => { finish = resolve; }); return Uint8Array.of(1); };
  const pending = readBoundedVmFile({ fs9p: fs }, 'output', 1);
  fs.inodes[id].size = 100000000; finish();
  assert.deepEqual(await pending, Uint8Array.of(1));
  fs.inodes[id].size = 1; fs.Read = async () => new Uint8Array(2);
  await assert.rejects(readBoundedVmFile({ fs9p: fs }, 'output', 1), error => error.code === 'vm-boundary-unavailable');
});
