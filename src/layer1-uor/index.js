/**
 * @file src/layer1-uor/index.js
 * @description Layer 1: Universal Object Reference (UOR) Content Addressing,
 * Z/(2^n)Z Ring Arithmetic, Substrate-Agnostic Hasher Axis, and Trace Replay Verifier.
 * Follows https://github.com/UOR-Foundation/UOR-Framework (uor-foundation & uor-foundation-verify).
 * Zero upward dependencies.
 */

export const PrimitiveOp = Object.freeze({
  NEG: 0,
  BNOT: 1,
  SUCC: 2,
  PRED: 3,
  ADD: 4,
  SUB: 5,
  MUL: 6,
  XOR: 7,
  AND: 8,
  OR: 9,
  LE: 10,
  LT: 11,
  GE: 12,
  GT: 13,
  CONCAT: 14,
  DIV: 15,
  MOD: 16,
  POW: 17
});

export const CertificateKind = Object.freeze({
  GROUNDING: 1,
  TOWER_COMPLETENESS: 2,
  INCREMENTAL_COMPLETENESS: 3,
  INHABITANCE: 4,
  MULTIPLICATION: 5,
  EVALUATION: 15,
  SESSION: 16
});

/**
 * Witt-level ring element in Z/(2^bits)Z (bits in {8, 16, 32, 64, 128}).
 */
export class Datum {
  /**
   * @param {number} bits - Witt level bit width (e.g. 8, 16, 32, 64, 128).
   * @param {bigint | number} value - Unsigned integer value.
   */
  constructor(bits, value) {
    if (!Number.isInteger(bits) || bits < 8 || bits > 128 || bits % 8 !== 0) {
      throw new RangeError(`Invalid Witt level bit width: ${bits}`);
    }
    this.bits = bits;
    this.mask = (1n << BigInt(bits)) - 1n;
    this.value = BigInt(value) & this.mask;
  }

  static w8(v) { return new Datum(8, v); }
  static w16(v) { return new Datum(16, v); }
  static w32(v) { return new Datum(32, v); }
  static w64(v) { return new Datum(64, v); }

  /**
   * Little-endian canonical byte representation matching GroundedCoord in UOR-Framework.
   * @returns {Uint8Array}
   */
  toBytes() {
    const byteLen = this.bits >> 3;
    const out = new Uint8Array(byteLen);
    let tmp = this.value;
    for (let i = 0; i < byteLen; i++) {
      out[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    return out;
  }

  static fromBytes(bytes) {
    const bits = bytes.length * 8;
    let val = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
      val = (val << 8n) | BigInt(bytes[i]);
    }
    return new Datum(bits, val);
  }
}

/**
 * Execute a UOR PrimitiveOp on Datum operands in Z/(2^n)Z.
 * Preserves the algebraic identity: SUCC(x) === NEG(BNOT(x)) mod 2^n.
 *
 * @param {number} op - Discriminant from PrimitiveOp.
 * @param {Datum} a - Primary operand.
 * @param {Datum} [b] - Secondary operand for binary operations.
 * @returns {Datum}
 */
export function applyPrimitiveOp(op, a, b = null) {
  const { bits, mask, value: x } = a;
  const y = b ? (b.value & mask) : 0n;

  switch (op) {
    case PrimitiveOp.NEG:
      return new Datum(bits, (-x) & mask);
    case PrimitiveOp.BNOT:
      return new Datum(bits, (~x) & mask);
    case PrimitiveOp.SUCC:
      return new Datum(bits, (x + 1n) & mask);
    case PrimitiveOp.PRED:
      return new Datum(bits, (x - 1n) & mask);
    case PrimitiveOp.ADD:
      return new Datum(bits, (x + y) & mask);
    case PrimitiveOp.SUB:
      return new Datum(bits, (x - y) & mask);
    case PrimitiveOp.MUL:
      return new Datum(bits, (x * y) & mask);
    case PrimitiveOp.XOR:
      return new Datum(bits, (x ^ y) & mask);
    case PrimitiveOp.AND:
      return new Datum(bits, (x & y) & mask);
    case PrimitiveOp.OR:
      return new Datum(bits, (x | y) & mask);
    case PrimitiveOp.LE:
      return new Datum(bits, x <= y ? 1n : 0n);
    case PrimitiveOp.LT:
      return new Datum(bits, x < y ? 1n : 0n);
    case PrimitiveOp.GE:
      return new Datum(bits, x >= y ? 1n : 0n);
    case PrimitiveOp.GT:
      return new Datum(bits, x > y ? 1n : 0n);
    case PrimitiveOp.DIV:
      return new Datum(bits, y === 0n ? 0n : (x / y) & mask);
    case PrimitiveOp.MOD:
      return new Datum(bits, y === 0n ? 0n : (x % y) & mask);
    default:
      throw new Error(`Unsupported PrimitiveOp discriminant: ${op}`);
  }
}

/**
 * Multi-metric distance functions on Z/(2^n)Z.
 */
export function ringCyclicDistance(a, b) {
  if (a.bits !== b.bits) throw new Error('Witt level mismatch');
  const d1 = (a.value - b.value) & a.mask;
  const d2 = (b.value - a.value) & a.mask;
  return d1 < d2 ? d1 : d2;
}

export function hammingDistance(a, b) {
  if (a.bits !== b.bits) throw new Error('Witt level mismatch');
  let xor = (a.value ^ b.value) & a.mask;
  let count = 0;
  while (xor > 0n) {
    xor &= xor - 1n;
    count++;
  }
  return count;
}

/**
 * UOR ContentAddress (128-bit non-zero handle).
 */
export class ContentAddress {
  /**
   * @param {bigint} raw128
   */
  constructor(raw128) {
    this.raw = BigInt(raw128) & ((1n << 128n) - 1n);
  }

  static zero() {
    return new ContentAddress(0n);
  }

  /**
   * UOR Phase P.3 lift: right-pad a 64-bit fingerprint into the upper 64 bits of u128.
   * @param {bigint} fp64
   */
  static fromU64Fingerprint(fp64) {
    const clean = BigInt(fp64) & 0xffffffffffffffffn;
    return new ContentAddress(clean << 64n);
  }

  static fromBytes(bytes) {
    let raw = 0n;
    const len = Math.min(16, bytes.length);
    for (let i = 0; i < len; i++) {
      raw = (raw << 8n) | BigInt(bytes[i]);
    }
    if (len < 16) {
      raw <<= BigInt((16 - len) * 8);
    }
    return new ContentAddress(raw);
  }

  isZero() {
    return this.raw === 0n;
  }

  toHex() {
    return 'uor:ca:' + this.raw.toString(16).padStart(32, '0');
  }

  equals(other) {
    return other instanceof ContentAddress && this.raw === other.raw;
  }
}

/**
 * UOR ContentFingerprint (up to 32 bytes with explicit width tag).
 */
export class ContentFingerprint {
  /**
   * @param {Uint8Array} buffer32
   * @param {number} widthBytes
   */
  constructor(buffer32, widthBytes) {
    this.bytes = new Uint8Array(32);
    this.widthBytes = widthBytes;
    this.bytes.set(buffer32.subarray(0, Math.min(32, widthBytes)));
  }

  isZero() {
    return this.widthBytes === 0;
  }

  toContentAddress() {
    if (this.widthBytes === 8) {
      let fp64 = 0n;
      for (let i = 0; i < 8; i++) {
        fp64 = (fp64 << 8n) | BigInt(this.bytes[i]);
      }
      return ContentAddress.fromU64Fingerprint(fp64);
    }
    return ContentAddress.fromBytes(this.bytes.subarray(0, Math.min(16, this.widthBytes)));
  }

  toHex() {
    let out = '';
    for (let i = 0; i < this.widthBytes; i++) {
      out += this.bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }
}

// ============================================================================
// CANDIDATE HASHER IMPLEMENTATIONS (Substitution Axis 3: Hasher<FP_MAX=32>)
// ============================================================================

/**
 * Candidate 1: Fnv1aHasher16 (128-bit FNV-1a, OUTPUT_BYTES = 16).
 * Ported directly from UOR-Foundation/UOR-Framework `uor-foundation-test-helpers/src/lib.rs`.
 */
export class Fnv1aHasher16 {
  static OUTPUT_BYTES = 16;
  static NAME = 'UOR-Fnv1aHasher16';

  constructor() {
    this.state = 0x6c62272e07bb014262b821756295c58dn;
    this.prime = 0x0000000001000000000000000000013bn;
    this.mask = (1n << 128n) - 1n;
  }

  foldByte(b) {
    this.state = ((this.state ^ BigInt(b & 0xff)) * this.prime) & this.mask;
    return this;
  }

  foldBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.foldByte(bytes[i]);
    }
    return this;
  }

  finalize() {
    const out = new Uint8Array(32);
    let tmp = this.state === 0n ? 1n : this.state;
    for (let i = 15; i >= 0; i--) {
      out[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    return new ContentFingerprint(out, 16);
  }
}

/**
 * Candidate 2: Fnv1aHasher32 (Dual-lane 256-bit FNV-1a, OUTPUT_BYTES = 32).
 * Ported directly from UOR-Foundation/UOR-Framework `uor-foundation-test-helpers/src/lib.rs`.
 */
export class Fnv1aHasher32 {
  static OUTPUT_BYTES = 32;
  static NAME = 'UOR-Fnv1aHasher32';

  constructor() {
    this.lo = 0x6c62272e07bb014262b821756295c58dn;
    this.hi = 0x9e3779b97f4a7c15f39cc0605cedc834n;
    this.prime = 0x0000000001000000000000000000013bn;
    this.mask = (1n << 128n) - 1n;
  }

  foldByte(b) {
    const byteVal = BigInt(b & 0xff);
    this.lo = ((this.lo ^ byteVal) * this.prime) & this.mask;
    this.hi = ((this.hi ^ (byteVal ^ 0x55n)) * this.prime) & this.mask;
    return this;
  }

  foldBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.foldByte(bytes[i]);
    }
    return this;
  }

  finalize() {
    const out = new Uint8Array(32);
    let loTmp = this.lo === 0n ? 1n : this.lo;
    let hiTmp = this.hi;
    for (let i = 15; i >= 0; i--) {
      out[i] = Number(loTmp & 0xffn);
      loTmp >>= 8n;
      out[i + 16] = Number(hiTmp & 0xffn);
      hiTmp >>= 8n;
    }
    return new ContentFingerprint(out, 32);
  }
}

/**
 * Candidate 3: Sha256Hasher (Pure synchronous 256-bit SHA-256, OUTPUT_BYTES = 32).
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export class Sha256Hasher {
  static OUTPUT_BYTES = 32;
  static NAME = 'SHA-256';

  constructor() {
    this.chunks = [];
  }

  foldByte(b) {
    this.chunks.push(b & 0xff);
    return this;
  }

  foldBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.chunks.push(bytes[i] & 0xff);
    }
    return this;
  }

  finalize() {
    const msgLen = this.chunks.length;
    const bitLen = msgLen * 8;
    const padLen = ((msgLen + 9 + 63) & ~63);
    const buf = new Uint8Array(padLen);
    buf.set(this.chunks);
    buf[msgLen] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(padLen - 4, bitLen >>> 0, false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let offset = 0; offset < padLen; offset += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(offset + i * 4, false);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;

        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, idx) => {
      outView.setUint32(idx * 4, word, false);
    });
    return new ContentFingerprint(out, 32);
  }
}

/**
 * Compute UOR ContentFingerprint and ContentAddress for arbitrary bytes using the selected Hasher class.
 * @param {Uint8Array} bytes
 * @param {typeof Fnv1aHasher16 | typeof Fnv1aHasher32 | typeof Sha256Hasher} [HasherClass=Fnv1aHasher16]
 */
export function mintContentAddress(bytes, HasherClass = Fnv1aHasher16) {
  const hasher = new HasherClass();
  hasher.foldBytes(bytes);
  const fingerprint = hasher.finalize();
  const address = fingerprint.toContentAddress();
  return { address, fingerprint };
}

// ============================================================================
// TRACE & ZERO-HASH STRUCTURAL REPLAY VERIFIER (uor-foundation-verify)
// ============================================================================

export class TraceEvent {
  /**
   * @param {number} stepIndex
   * @param {number} op - Discriminant from PrimitiveOp
   * @param {ContentAddress} target - Resulting Datum ContentAddress
   */
  constructor(stepIndex, op, target) {
    this.stepIndex = stepIndex;
    this.op = op;
    this.target = target;
  }
}

export class Trace {
  /**
   * @param {TraceEvent[]} events
   * @param {ContentFingerprint} fingerprint
   * @param {number} wittLevelBits
   * @param {number} [certificateKind=CertificateKind.GROUNDING]
   */
  constructor(events, fingerprint, wittLevelBits, certificateKind = CertificateKind.GROUNDING) {
    this.events = events;
    this.fingerprint = fingerprint;
    this.wittLevelBits = wittLevelBits;
    this.certificateKind = certificateKind;
  }
}

/**
 * Re-derive a Certified GroundingCertificate from a Trace via structural validation
 * + fingerprint passthrough (matches `uor_foundation_verify::verify_trace`).
 *
 * @param {Trace} trace
 * @returns {{ ok: boolean, error?: string, certificate?: { fingerprint: ContentFingerprint, wittLevelBits: number, kind: number } }}
 */
export function verifyTrace(trace) {
  if (!trace || !Array.isArray(trace.events) || trace.events.length === 0) {
    return { ok: false, error: 'EmptyTrace' };
  }
  if (!trace.fingerprint || trace.fingerprint.isZero()) {
    return { ok: false, error: 'ZeroFingerprint' };
  }

  for (let i = 0; i < trace.events.length; i++) {
    const ev = trace.events[i];
    if (!ev) {
      return { ok: false, error: `MissingEventAt:${i}` };
    }
    if (i > 0 && ev.stepIndex <= trace.events[i - 1].stepIndex) {
      return { ok: false, error: `OutOfOrderEvent:${i}` };
    }
    if (ev.stepIndex !== i) {
      return { ok: false, error: `NonContiguousSteps:${i}` };
    }
    if (!ev.target || ev.target.isZero()) {
      return { ok: false, error: `ZeroTarget:${i}` };
    }
  }

  return {
    ok: true,
    certificate: {
      fingerprint: trace.fingerprint,
      wittLevelBits: trace.wittLevelBits,
      kind: trace.certificateKind
    }
  };
}

/**
 * Benchmark all 3 UOR Hasher candidates across `sampleCount` payloads.
 */
export function benchmarkUorHashers(sampleCount = 1000, payloadSizeBytes = 64) {
  const candidates = [Fnv1aHasher16, Fnv1aHasher32, Sha256Hasher];
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const buf = new Uint8Array(payloadSizeBytes);
    buf[0] = i & 0xff;
    buf[1] = (i >>> 8) & 0xff;
    buf[2] = (i >>> 16) & 0xff;
    buf[3] = (i >>> 24) & 0xff;
    for (let j = 4; j < payloadSizeBytes; j++) {
      buf[j] = (i * 31 + j * 17) & 0xff;
    }
    samples.push(buf);
  }

  return candidates.map(HasherClass => {
    const seen = new Set();
    let collisions = 0;
    const t0 = performance.now();
    for (let i = 0; i < sampleCount; i++) {
      const { address } = mintContentAddress(samples[i], HasherClass);
      const hex = address.toHex();
      if (seen.has(hex)) collisions++;
      else seen.add(hex);
    }
    const elapsedMs = Math.max(0.05, performance.now() - t0);
    const opsPerSec = Math.round((sampleCount / elapsedMs) * 1000);
    const mbPerSec = Number((((sampleCount * payloadSizeBytes) / (1024 * 1024)) / (elapsedMs / 1000)).toFixed(2));

    return {
      hasher: HasherClass.NAME,
      output_bytes: HasherClass.OUTPUT_BYTES,
      samples: sampleCount,
      collisions,
      elapsed_ms: Number(elapsedMs.toFixed(2)),
      ops_per_sec: opsPerSec,
      throughput_mb_s: mbPerSec
    };
  });
}
