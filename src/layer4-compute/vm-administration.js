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
export const ethernetAllowed = (node, current, frame) => call('ethernetAllowed', node.ethernetSharing, node.booted,
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
