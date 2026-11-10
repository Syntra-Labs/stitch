/** Shared runtime limits and closed-record validation. Limits are resource policy, not theorems. */
export class ContractError extends Error {
  constructor(code, message = code) { super(message); this.name = 'ContractError'; this.code = code; }
}
export const refuse = (code, message) => { throw new ContractError(code, message); };
export function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) refuse('invalid-record');
  return value;
}
export function natural(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) refuse('invalid-integer');
  return value;
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) refuse('invalid-identifier');
  return value;
}
export function digest(value) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) refuse('invalid-digest');
  return value;
}
export function hexValue(value, bits) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 34 ||
      BigInt(value) >= 1n << BigInt(bits)) refuse('invalid-ring-value');
  return value;
}
