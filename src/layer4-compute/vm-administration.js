/** Source-derived policy, with host identity/byte observations supplied explicitly. */
import { model } from '../layer1-uor/generated-model.js';
const call = (name, ...args) => model[`Stitch.VmAdministration.${name}`](...args);
export const shareAllowed = (node, current) => call('shareAllowed', node.objectSharing, current, node.adminBlocked);
export function validEthernet(frame) {
  if (!(Array.isArray(frame) || frame instanceof Uint8Array) || frame.length < 14 || frame.length > 1518) return false;
  for (let index = 0; index < frame.length; index++) {
    const byte = frame[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return false;
  }
  return true;
}
export const ethernetAllowed = (node, current, frame) => call('ethernetAllowed', node.ethernetSharing && networkSharingAllowed(true, Boolean(node.networkConfiguration)), node.booted,
  current, !!node.transport && node.transport.closed !== true, validEthernet(frame), node.adminBlocked);
export const commandAllowed = node => call('commandAllowed', node.booted, node.commandBusy, node.adminBlocked, node.commands.size < 128);
export const observationAllowed = (node, command) => call('observationAllowed', node.bootGeneration, command.generation,
  node.v86 === command.vm, command.dispatched, node.adminBlocked);
export const administrationAllowed = node => call('administrationAllowed', !!node.v86, node.adminBusy);
export function validateCommand(command, timeout) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || new TextEncoder().encode(command).length > 16384)
    throw Error('VM command must be nonempty, contain no NUL, and fit 16384 UTF-8 bytes.');
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 300000) throw Error('Invalid VM command observation timeout (0–300000ms).');
}

export const forgetAllowed = (node, command) => call('forgetAllowed', !!command, ['completed', 'failed-before-dispatch', 'cancelled-before-dispatch'].includes(command?.outcome), node.commandBusy);

export class VmBoundaryError extends Error {
  constructor(code, message) { super(message); this.name = 'VmBoundaryError'; this.code = code; }
}
export const vmLimits = Object.freeze(Object.fromEntries([
  'filesystemAllocationLimit', 'filesystemFileLimit', 'filesystemMetadataLimit', 'outputLimit', 'retainedOutputLimit', 'runtimeLimitMs'
].map(name => [name, Number(call(name))])));
export const allocationAllowed = (used, requested, limit) => call('allocationAllowed', used, requested, limit);
export const terminationRequired = (cancelled, expired, exceeded) => call('terminationRequired', cancelled, expired, exceeded);

/**
 * Adapter for the bundled v86 local 9p implementation, not a generic sandbox.
 * It is installed before the emulator starts. Cumulative allocation charging is
 * intentionally conservative: shrinking/unlinking never refunds the instance.
 * In particular fs.total_size is only statfs information and is NOT a quota.
 */
export function installFilesystemControls(vm, onViolation) {
  const fs = vm.fs9p;
  const methods = ['SearchPath', 'GetInode', 'Read', 'ChangeSize', 'CreateBinaryFile', 'CreateTextFile',
    'CreateInode', 'FillDirectory', 'link_under_dir'];
  if (!fs || !Array.isArray(fs.inodes) || !fs.inodedata || !Array.isArray(fs.mounts) || fs.mounts.length ||
      methods.some(name => typeof fs[name] !== 'function')) {
    throw new VmBoundaryError('vm-boundary-unavailable', 'Required bundled v86 filesystem controls are unavailable; guest execution refused.');
  }
  const state = { allocatedBytes: 0, createdInodes: fs.inodes.length, linkedEntries: 0, exceeded: false };
  const violate = message => {
    const error = new VmBoundaryError('vm-filesystem-limit', message);
    if (!state.exceeded) { state.exceeded = true; onViolation(error); }
    throw error;
  };
  const validSize = size => Number.isSafeInteger(size) && size >= 0;
  const reserve = size => {
    if (state.exceeded) violate('Guest filesystem is quarantined after a resource limit.');
    if (!validSize(size) || size > vmLimits.filesystemFileLimit ||
        !allocationAllowed(state.allocatedBytes, size, vmLimits.filesystemAllocationLimit)) {
      violate('Guest 9p allocation refused before allocation: 16 MiB per buffer, 64 MiB cumulative per VM. Stop requested; guest effects remain unknown.');
    }
    state.allocatedBytes += size;
  };
  for (const data of Object.values(fs.inodedata)) reserve(data.byteLength);
  for (const name of ['ChangeSize', 'CreateBinaryFile', 'CreateTextFile']) {
    const original = fs[name];
    fs[name] = function (...args) {
      reserve(name === 'ChangeSize' ? args[1] : args[2]?.length);
      return original.apply(this, args);
    };
  }
  const createInode = fs.CreateInode;
  fs.CreateInode = function (...args) {
    if (state.exceeded || !call('metadataAllowed', state.createdInodes, vmLimits.filesystemMetadataLimit))
      violate('Guest 9p inode limit reached. Stop requested; guest effects remain unknown.');
    state.createdInodes++;
    return createInode.apply(this, args);
  };
  const link = fs.link_under_dir;
  fs.link_under_dir = function (...args) {
    if (state.exceeded || typeof args[2] !== 'string' || new TextEncoder().encode(args[2]).length > 255 ||
        !call('metadataAllowed', state.linkedEntries, vmLimits.filesystemMetadataLimit))
      violate('Guest 9p directory-entry limit reached. Stop requested; guest effects remain unknown.');
    state.linkedEntries++;
    return link.apply(this, args);
  };
  const fillDirectory = fs.FillDirectory;
  fs.FillDirectory = function (id) {
    const inode = this.GetInode(id);
    let size = 0;
    for (const name of inode.direntries.keys()) size += 24 + new TextEncoder().encode(name).length;
    reserve(size);
    return fillDirectory.call(this, id);
  };
  // This value makes the guest's statfs report match the configured allowance,
  // but the wrappers above, rather than statfs, enforce allocation admission.
  fs.total_size = vmLimits.filesystemAllocationLimit;
  return state;
}

/** Never ask read_file() to allocate a guest-selected file length. */
export async function readBoundedVmFile(vm, name, limit) {
  const fs = vm.fs9p;
  if (!fs || ['SearchPath', 'GetInode', 'Read'].some(key => typeof fs[key] !== 'function'))
    throw new VmBoundaryError('vm-boundary-unavailable', 'Bounded v86 file reads are unavailable.');
  const path = fs.SearchPath(name);
  if (path.id === -1) return null;
  const inode = fs.GetInode(path.id), size = inode?.size;
  if (!Number.isSafeInteger(size) || size < 0 ||
      !call('resultReadAllowed', size, limit, (inode?.mode & 0xf000) === 0x8000))
    throw new VmBoundaryError('vm-output-limit', `Guest result must be a regular file of at most ${limit} bytes; unbounded read refused.`);
  // Capture a bounded range even if the guest changes its file while Read awaits.
  const bytes = await fs.Read(path.id, 0, size);
  if (bytes !== null && bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.length > size))
    throw new VmBoundaryError('vm-boundary-unavailable', 'v86 returned an invalid bounded file range.');
  return bytes ? bytes.slice() : new Uint8Array(0);
}

// Parsing and subnet arithmetic are host observations; admission is source-owned.
// Canonical decimal input avoids shell syntax, ambiguous octal, NaN and coercion.
export function validateStaticNetwork(address, prefixLength) {
  if (typeof address !== 'string' || !/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(address) ||
      !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32)
    throw new VmBoundaryError('vm-network-invalid', 'Enter a canonical IPv4 host address and prefix length 0–32.');
  const octets = address.split('.').map(Number);
  if (octets.some(value => value > 255))
    throw new VmBoundaryError('vm-network-invalid', 'IPv4 octets must be 0–255.');
  const numeric = octets.reduce((value, octet) => value * 256 + octet, 0);
  const size = 2 ** (32 - prefixLength), hostPart = numeric % size;
  if (!call('staticAddressAllowed', octets[0], prefixLength, hostPart, size - 1))
    throw new VmBoundaryError('vm-network-invalid', 'Use a unicast host address, not unspecified, loopback, multicast, reserved, or the subnet network/broadcast address.');
  const mask = 2 ** 32 - size;
  const netmask = [24, 16, 8, 0].map(shift => Math.floor(mask / 2 ** shift) % 256).join('.');
  return Object.freeze({ address, prefixLength, netmask, cidr: `${address}/${prefixLength}` });
}
export const networkChangeAllowed = node => call('networkChangeAllowed', !!node.v86, Boolean(node.adminBusy || node.adminBlocked), node.booting);
export const networkSharingAllowed = (granted, configured) => call('networkSharingAllowed', granted, configured);
