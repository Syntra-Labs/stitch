/**
 * Layer 1 object custody commitments. Browser-compatible, dependency-free WebCrypto.
 *
 * This is a reference realization, not a proof of browser or network behavior.
 * Digests establish byte integrity under SHA-256's security assumptions; they do
 * not establish authorization, confidentiality, availability, or retention.
 *
 * Hash frame (all lengths unsigned, big endian):
 *   UTF8("stitch/" + domain + "/v1\0") || uint64(payload.length) || payload
 * Fragment payload: raw32(encodingDigest) || uint32(index) || fragmentBytes.
 * Manifest payload: canonicalBytes(manifest without manifestDigest).
 * Canonical JSON follows RFC 8785: sorted UTF-16 keys, ECMAScript finite
 * binary64 serialization, unchanged Unicode strings, and UTF-8 output.
 * Application schemas and explicit resource budgets remain separate contracts.
 */

export const CUSTODY_LIMITS = Object.freeze({
  maxObjectBytes: 16 * 1024 * 1024,
  maxManifestBytes: 16 * 1024,
  maxCanonicalBytes: 64 * 1024,
  maxDepth: 16,
  maxEntries: 4096,
  maxStringLength: 4096,
  maxRequests: 256,
  maxCopies: 64,
});

export class CustodyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CustodyError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new CustodyError(code, message); };
const utf8 = new TextEncoder();
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Snapshot caller-owned bytes before any asynchronous operation. */
export function copyBytes(value, maxBytes = CUSTODY_LIMITS.maxObjectBytes) {
  if (!(value instanceof Uint8Array)) fail('InvalidBytes', 'Expected Uint8Array');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || value.byteLength > maxBytes) {
    fail('SizeLimit', 'Byte sequence exceeds its size limit');
  }
  return new Uint8Array(value);
}

function validString(value, maxLength = CUSTODY_LIMITS.maxStringLength) {
  if (value.length > maxLength) fail('SizeLimit', 'String too long');
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // RFC 7493 §2.1 (the JCS input domain) also excludes Unicode noncharacters.
    if ((c >= 0xfdd0 && c <= 0xfdef) || c === 0xfffe || c === 0xffff) {
      fail('InvalidCanonicalValue', 'Unicode noncharacter');
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('InvalidCanonicalValue', 'Lone surrogate');
      const point = 0x10000 + ((c - 0xd800) << 10) + next - 0xdc00;
      if ((point & 0xffff) >= 0xfffe) fail('InvalidCanonicalValue', 'Unicode noncharacter');
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      fail('InvalidCanonicalValue', 'Lone surrogate');
    }
  }
}

/**
 * Canonical UTF-8 bytes. Rejects cycles, getters, symbols, sparse/extended arrays,
 * nonfinite numbers, hidden properties, and non-JSON prototypes before coercion.
 * Number serialization is the ECMAScript algorithm required by RFC 8785 §3.2.2.3.
 * The caller must supply an already valid value; use parseCanonicalJson on wire JSON
 * so duplicate properties are rejected before a normal JSON parser can erase them.
 */
export function canonicalBytes(value, {
  maxBytes = CUSTODY_LIMITS.maxCanonicalBytes,
  maxDepth = CUSTODY_LIMITS.maxDepth,
  maxEntries = CUSTODY_LIMITS.maxEntries,
  maxStringLength = CUSTODY_LIMITS.maxStringLength,
} = {}) {
  for (const limit of [maxBytes, maxDepth, maxEntries, maxStringLength]) {
    if (!Number.isSafeInteger(limit) || limit < 0) fail('SizeLimit', 'Invalid JSON resource bound');
  }
  const seen = new Set();
  let entries = 0;
  let outputLength = 0;
  const append = value => {
    outputLength += value.length;
    if (outputLength > maxBytes) fail('SizeLimit', 'Canonical record too large');
    return value;
  };
  function encode(v, depth) {
    if (depth > maxDepth) fail('SizeLimit', 'Canonical record too deep');
    if (++entries > maxEntries) fail('SizeLimit', 'Too many canonical values');
    if (v === null) return append('null');
    if (typeof v === 'boolean') return append(v ? 'true' : 'false');
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('InvalidCanonicalValue', 'Expected finite IEEE 754 number');
      return append(JSON.stringify(v));
    }
    if (typeof v === 'string') {
      validString(v, maxStringLength);
      return append(JSON.stringify(v));
    }
    if (typeof v !== 'object' || seen.has(v)) fail('InvalidCanonicalValue', 'Non-JSON value or cycle');
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      fail('InvalidCanonicalValue', 'Expected a plain JSON value');
    }
    const keys = Reflect.ownKeys(v);
    // Check count before enumerating or allocating any output for a large array.
    if (keys.length > maxEntries + (array ? 1 : 0)) fail('SizeLimit', 'Too many keys');
    if (keys.some(k => typeof k !== 'string')) fail('InvalidCanonicalValue', 'Symbol key');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of keys) {
      const d = descriptors[key];
      if (!Object.hasOwn(d, 'value') || (!d.enumerable && !(array && key === 'length'))) {
        fail('InvalidCanonicalValue', 'Accessors and hidden fields are not canonical');
      }
    }
    seen.add(v);
    let result;
    if (array) {
      if (v.length > maxEntries || keys.length !== v.length + 1) {
        fail('InvalidCanonicalValue', 'Sparse or extended array');
      }
      const items = [];
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(descriptors, String(i))) fail('InvalidCanonicalValue', 'Sparse array');
        items.push(encode(descriptors[String(i)].value, depth + 1));
      }
      result = append('[') + items.join(',') + append(']');
      append(','.repeat(Math.max(0, items.length - 1)));
    } else {
      const items = [];
      for (const key of keys.sort()) {
        validString(key, maxStringLength);
        const name = append(JSON.stringify(key));
        items.push(name + append(':') + encode(descriptors[key].value, depth + 1));
      }
      result = append('{') + items.join(',') + append('}');
      append(','.repeat(Math.max(0, items.length - 1)));
    }
    seen.delete(v);
    return result;
  }
  const result = utf8.encode(encode(value, 0));
  if (result.length > maxBytes) fail('SizeLimit', 'Canonical UTF-8 record too large');
  return result;
}

/**
 * Parse JSON without losing duplicate names, including escape-equivalent names.
 * RFC 8785 §3.1 and §5 require validation before signature processing. This
 * parser preserves strings without normalization, rejects nonfinite numbers and
 * malformed UTF-8, and creates only data properties (including __proto__).
 * Limits are deployment resource policies, not changes to the JCS data model.
 */
export function parseCanonicalJson(input, {
  maxBytes = CUSTODY_LIMITS.maxCanonicalBytes,
  maxDepth = CUSTODY_LIMITS.maxDepth,
  maxEntries = CUSTODY_LIMITS.maxEntries,
  maxStringLength = CUSTODY_LIMITS.maxStringLength,
} = {}) {
  for (const value of [maxBytes, maxDepth, maxEntries, maxStringLength]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('SizeLimit', 'Invalid JSON resource bound');
  }
  let text;
  if (input instanceof Uint8Array) {
    if (input.byteLength > maxBytes) fail('SizeLimit', 'JSON input too large');
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { fail('InvalidCanonicalValue', 'Malformed JSON UTF-8'); }
  } else if (typeof input === 'string') {
    // Check code units before allocating UTF-8; its byte count is at least this.
    if (input.length > maxBytes || utf8.encode(input).length > maxBytes) fail('SizeLimit', 'JSON input too large');
    text = input;
  } else fail('InvalidCanonicalValue', 'Expected JSON text or UTF-8 bytes');
  let at = 0, entries = 0;
  const invalid = () => fail('InvalidCanonicalValue', `Invalid JSON at offset ${at}`);
  const ws = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text.charCodeAt(at++);
      if (c === 34) {
        let value;
        try { value = JSON.parse(text.slice(start, at)); } catch { invalid(); }
        validString(value, maxStringLength);
        return value;
      }
      if (c < 32) invalid();
      if (c === 92) {
        const escape = text[at++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) invalid();
          at += 4;
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) invalid();
      }
    }
    invalid();
  }
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function value(depth) {
    if (depth > maxDepth || ++entries > maxEntries) fail('SizeLimit', 'JSON structure exceeds resource bound');
    ws();
    const token = text[at];
    if (token === '"') return string();
    if (token === '{' || token === '[') {
      at++; ws();
      const array = token === '[', close = array ? ']' : '}', result = array ? [] : Object.create(null);
      const names = new Set();
      if (text[at] === close) { at++; return result; }
      for (;;) {
        ws();
        if (array) result.push(value(depth + 1));
        else {
          if (text[at] !== '"') invalid();
          const key = string();
          if (names.has(key)) fail('InvalidCanonicalValue', 'Duplicate JSON property');
          names.add(key); ws();
          if (text[at++] !== ':') invalid();
          result[key] = value(depth + 1);
        }
        ws();
        if (text[at] === close) { at++; return result; }
        if (text[at++] !== ',') invalid();
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return parsed; }
    }
    number.lastIndex = at;
    const match = number.exec(text);
    if (!match) invalid();
    at = number.lastIndex;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) fail('InvalidCanonicalValue', 'Expected finite IEEE 754 number');
    return parsed;
  }
  const result = value(0);
  ws();
  if (at !== text.length) invalid();
  return result;
}

function uint64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

/** Domain-separated digest. Domain must be a short lowercase ASCII name. */
export async function sha256Bytes(bytes, domain) {
  if (typeof domain !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(domain)) {
    fail('InvalidSchema', 'Invalid digest domain');
  }
  const payload = copyBytes(bytes, CUSTODY_LIMITS.maxObjectBytes + 36);
  if (!globalThis.crypto?.subtle) fail('CryptoUnavailable', 'WebCrypto requires a supported secure context');
  const prefix = utf8.encode(`stitch/${domain}/v1\0`);
  const framed = new Uint8Array(prefix.length + 8 + payload.length);
  framed.set(prefix);
  framed.set(uint64(payload.length), prefix.length);
  framed.set(payload, prefix.length + 8);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', framed));
  return 'sha256:' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export function assertDigest(value) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('InvalidDigest', 'Expected full lowercase SHA-256 digest');
  return value;
}

export async function commitObject(bytes) {
  const snapshot = copyBytes(bytes);
  return Object.freeze({
    digestAlgorithm: 'sha256',
    contentDigest: await sha256Bytes(snapshot, 'object'),
    byteLength: snapshot.length,
  });
}

export async function fragmentDigest(encodingDigest, index, bytes) {
  assertDigest(encodingDigest);
  if (!Number.isInteger(index) || index < 0 || index > 2) fail('InvalidSchema', 'Invalid fragment index');
  const snapshot = copyBytes(bytes, Math.ceil(CUSTODY_LIMITS.maxObjectBytes / 2));
  const payload = new Uint8Array(36 + snapshot.length);
  for (let i = 0; i < 32; i++) payload[i] = parseInt(encodingDigest.slice(7 + i * 2, 9 + i * 2), 16);
  new DataView(payload.buffer).setUint32(32, index, false);
  payload.set(snapshot, 36);
  return sha256Bytes(payload, 'fragment');
}

export function exactKeys(value, expected, name = 'record') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('InvalidSchema', `${name} must be a record`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    fail('InvalidSchema', `${name} has missing or unknown fields`);
  }
}

export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot strict records without executing accessors. */
export function snapshotRecord(record, maxBytes = CUSTODY_LIMITS.maxCanonicalBytes) {
  const bytes = canonicalBytes(record);
  if (bytes.length > maxBytes) fail('SizeLimit', 'Record exceeds its size limit');
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function manifestBody(manifest) {
  return { version: manifest.version, object: manifest.object, encoding: manifest.encoding, fragments: manifest.fragments };
}

/**
 * Verify schema and complete manifest commitment; returns an immutable snapshot.
 * This alone does not prove that its declared fragments encode its object.
 * recoverObject establishes that relationship from actual fragment bytes.
 */
export async function verifyManifest(manifest) {
  const m = snapshotRecord(manifest, CUSTODY_LIMITS.maxManifestBytes);
  exactKeys(m, ['version', 'object', 'encoding', 'fragments', 'manifestDigest'], 'manifest');
  exactKeys(m.object, ['digestAlgorithm', 'contentDigest', 'byteLength'], 'object');
  exactKeys(m.encoding, ['format', 'encodingDigest', 'byteLength', 'dependencies'], 'encoding');
  exactKeys(m.fragments, ['scheme', 'threshold', 'count', 'byteLength', 'digests'], 'fragments');
  if (m.version !== 1 || m.object.digestAlgorithm !== 'sha256' || m.encoding.format !== 'raw'
    || m.fragments.scheme !== 'xor-2-of-3' || m.fragments.threshold !== 2 || m.fragments.count !== 3) {
    fail('InvalidSchema', 'Unsupported custody version or encoding');
  }
  const length = m.object.byteLength;
  if (!Number.isSafeInteger(length) || length < 0 || length > CUSTODY_LIMITS.maxObjectBytes) {
    fail('SizeLimit', 'Invalid object length');
  }
  if (m.encoding.byteLength !== length || m.fragments.byteLength !== Math.ceil(length / 2)) {
    fail('InvalidSchema', 'Inconsistent encoding or fragment lengths');
  }
  if (!Array.isArray(m.encoding.dependencies) || m.encoding.dependencies.length !== 0) {
    fail('InvalidSchema', 'Raw encoding must be self-contained');
  }
  if (!Array.isArray(m.fragments.digests) || m.fragments.digests.length !== 3) {
    fail('InvalidSchema', 'Expected exactly three fragment digests');
  }
  [m.object.contentDigest, m.encoding.encodingDigest, m.manifestDigest, ...m.fragments.digests].forEach(assertDigest);
  const actual = await sha256Bytes(canonicalBytes(manifestBody(m)), 'manifest');
  if (actual !== m.manifestDigest) fail('ManifestDigestMismatch', 'Manifest commitment does not match');
  return deepFreeze(m);
}

/** Verify one fragment's full binding; does not establish coding consistency. */
export async function verifyFragment(manifest, fragment) {
  // Read descriptors first so untrusted accessor fields are not executed.
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(fragment))) fail('InvalidSchema', 'Invalid fragment');
  const descriptors = Object.getOwnPropertyDescriptors(fragment);
  if (Reflect.ownKeys(fragment).length !== 2 || !descriptors.index?.enumerable || !descriptors.bytes?.enumerable
    || !Object.hasOwn(descriptors.index, 'value') || !Object.hasOwn(descriptors.bytes, 'value')) {
    fail('InvalidSchema', 'Fragment requires only index and bytes');
  }
  const index = descriptors.index.value;
  if (!Number.isInteger(index) || index < 0 || index > 2) fail('InvalidSchema', 'Invalid fragment index');
  const bytes = copyBytes(descriptors.bytes.value, Math.ceil(CUSTODY_LIMITS.maxObjectBytes / 2));
  const m = await verifyManifest(manifest);
  if (bytes.length !== m.fragments.byteLength) fail('InvalidSchema', 'Incorrect fragment length');
  if (await fragmentDigest(m.encoding.encodingDigest, index, bytes) !== m.fragments.digests[index]) {
    fail('FragmentDigestMismatch', 'Fragment is not committed by this manifest');
  }
  return { index, bytes };
}
