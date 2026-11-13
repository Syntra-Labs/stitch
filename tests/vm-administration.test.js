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

import { ethernetAllowed, validateStaticNetwork, networkChangeAllowed, networkSharingAllowed } from '../src/layer4-compute/vm-administration.js';

test('static IPv4 parser rejects malformed and non-host addresses without arbitrary host-octet limits', () => {
  for (const address of ['', '----', '1.2.3', '1.2.3.4.5', '01.2.3.4', '256.2.3.4', '1.2.3.-1', '1.2.3.4;reboot', ' 1.2.3.4', '1.2.3.4\n',
    '0.1.2.3', '127.0.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '10.42.0.0', '10.42.0.255'])
    assert.throws(() => validateStaticNetwork(address, 24), error => error.code === 'vm-network-invalid', address);
  for (const prefix of [-1, 33, NaN, Infinity, 24.5, '24', null])
    assert.throws(() => validateStaticNetwork('10.42.0.2', prefix), error => error.code === 'vm-network-invalid');
  for (const [address, prefix, mask] of [
    ['10.42.0.255', 23, '255.255.254.0'], ['10.42.1.0', 23, '255.255.254.0'],
    ['10.42.0.0', 31, '255.255.255.254'], ['10.42.0.1', 31, '255.255.255.254'],
    ['10.42.0.0', 32, '255.255.255.255'], ['10.42.0.1', 0, '0.0.0.0']])
    assert.equal(validateStaticNetwork(address, prefix).netmask, mask);
});

test('source-owned address and configuration predicates match subnet and lifecycle semantics', () => {
  for (let first = 0; first < 256; first++)
    for (let prefix = 0; prefix <= 33; prefix++)
      for (const host of [0, 1, 255])
        assert.equal(call('staticAddressAllowed', first, prefix, host, 255),
          first > 0 && first < 224 && first !== 127 && prefix <= 32 && (prefix >= 31 || host > 0 && host < 255));
  for (const instance of [false, true]) for (const busy of [false, true]) for (const booting of [false, true])
    assert.equal(networkChangeAllowed({ v86: instance, adminBusy: busy, booting }), !instance && !busy && !booting);
  for (const granted of [false, true]) for (const configured of [false, true])
    assert.equal(networkSharingAllowed(granted, configured), !granted || configured);
});

test('Ethernet host admission refuses absent configuration and configuration changes respect unknown administration', () => {
  const node = { ethernetSharing: true, booted: true, transport: {}, adminBlocked: false };
  const frame = new Uint8Array(14);
  for (const configuration of [undefined, null]) {
    node.networkConfiguration = configuration;
    assert.equal(ethernetAllowed(node, true, frame), false);
  }
  node.networkConfiguration = validateStaticNetwork('10.42.0.2', 24);
  assert.equal(ethernetAllowed(node, true, frame), true);
  assert.equal(networkChangeAllowed({ v86: null, adminBusy: false, adminBlocked: true, booting: false }), false);
});
