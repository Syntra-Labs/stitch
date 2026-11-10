/** Bounded recovery evidence, never a transport, key backup or effect journal.
 * Imported anchors remain supplied evidence until separately accepted against an
 * independently obtained exact digest. All state lives only in this session.
 */
import { canonicalBytes, parseCanonicalJson, exactKeys, deepFreeze, sha256Bytes } from './layer1-uor/custody.js';
import { createObject, recoverObject } from './layer3-storage/custody.js';
import { verifyCheckpoint, programWork } from './layer4-compute/replay.js';
import { verifyPointer } from './layer1-uor/pointer.js';
import { model } from './layer1-uor/generated-model.js';
const project = (name, ...args) => model[`Stitch.Recovery.${name}`](...args);
export const RECOVERY_LIMITS = Object.freeze({ wireBytes: 32 * (2 * 131072 + 65536), entries: 32, objectBytes: 131072, replaySteps: 32 * 1024 });
const reject = reason => { throw new Error(`recovery-${reason}`); };
const text = bytes => new TextDecoder().decode(bytes);
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
function limits(options = {}) {
  const result = { ...RECOVERY_LIMITS, ...options };
  exactKeys(result, Object.keys(RECOVERY_LIMITS), 'recovery limits');
  for (const key of Object.keys(result)) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > RECOVERY_LIMITS[key]) reject('limit-policy');
  }
  return result;
}
const codec = bounds => ({ maxBytes: bounds.wireBytes, maxEntries: 32 * 8192, maxDepth: 16, maxStringLength: 131072 });
const encode = (value, bounds = RECOVERY_LIMITS) => canonicalBytes(value, codec(bounds));
const empty = () => ({ version: 1, objects: [], jobs: [], anchors: [] });
function decodeHex(value) {
  if (typeof value !== 'string' || value.length > RECOVERY_LIMITS.objectBytes || value.length % 2 || !/^[0-9a-f]*$/.test(value)) reject('fragment-hex');
  return Uint8Array.from(value.match(/../g) ?? [], b => parseInt(b, 16));
}
function unique(rows, key) {
  const seen = new Set();
  for (const row of rows) { const id = key(row); if (seen.has(id)) reject('duplicate'); seen.add(id); }
}
/** Canonical wire input only, rejecting alternate encodings and duplicate fields. */
export async function verifyRecoveryBundle(wire, options = {}) {
  const bounds = limits(options);
  const bundle = parseCanonicalJson(wire, codec(bounds));
  const encoded = encode(bundle, bounds);
  const original = typeof wire === 'string' ? wire : text(wire);
  if (text(encoded) !== original) reject('noncanonical');
  exactKeys(bundle, ['version', 'objects', 'jobs', 'anchors'], 'recovery bundle');
  if (bundle.version !== 1 || ![bundle.objects, bundle.jobs, bundle.anchors].every(Array.isArray)) reject('schema');
  const entries = bundle.objects.length + bundle.jobs.length + bundle.anchors.length;
  if (entries > bounds.entries) reject('entry-limit');
  let replaySteps = 0;
  // Preflight aggregate replay before hashing or executing any program.
  for (const job of bundle.jobs) {
    exactKeys(job, ['program', 'checkpoint'], 'recovery job');
    if (!Number.isSafeInteger(job.checkpoint?.stepIndex) || job.checkpoint.stepIndex < 0) reject('step');
    replaySteps += programWork(job.program, 0, job.checkpoint.stepIndex);
    if (replaySteps > bounds.replaySteps) reject('replay-limit');
  }
  const objects = [];
  for (const object of bundle.objects) {
    exactKeys(object, ['manifest', 'fragments'], 'recovery object');
    if (!Array.isArray(object.fragments) || object.fragments.length < 2 || object.fragments.length > 3) reject('partial-object');
    if (object.manifest?.object?.byteLength > bounds.objectBytes) reject('object-limit');
    const fragments = object.fragments.map(fragment => {
      exactKeys(fragment, ['index', 'hex'], 'recovery fragment');
      return { index: fragment.index, bytes: decodeHex(fragment.hex) };
    });
    const bytes = await recoverObject(object.manifest, fragments);
    objects.push({ root: object.manifest.object.contentDigest, bytes });
  }
  for (const job of bundle.jobs) await verifyCheckpoint(job.program, job.checkpoint);
  for (const anchor of bundle.anchors) {
    // This verifies only internal signature consistency, NOT trusted authority.
    await verifyPointer(anchor, anchor.authorityKey);
  }
  unique(bundle.objects, o => o.manifest.object.contentDigest);
  unique(bundle.jobs, j => j.checkpoint.jobId);
  unique(bundle.anchors, a => a.name);
  return { bundle: deepFreeze(bundle), objects, cost: { wireBytes: encoded.length, entries, replaySteps } };
}
/** Snapshot caller-owned evidence before any await. Keys and unknown fields fail. */
export async function exportRecoveryBundle(evidence, options = {}) {
  const wire = text(encode(evidence, limits(options)));
  await verifyRecoveryBundle(wire, options);
  return wire;
}
export async function recoveryObject(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > RECOVERY_LIMITS.objectBytes) reject('object-limit');
  const object = await createObject(bytes);
  return { manifest: object.manifest, fragments: object.fragments.slice(0, 2).map(f => ({ index: f.index, hex: hex(f.bytes) })) };
}
/** A separately held evidence vault, not a live mesh/VM adapter. Merge validates
 * the entire candidate before one synchronous assignment. A concurrent anchor
 * acceptance invalidates an in-flight import rather than losing that decision.
 */
export class RecoveryVault {
  #state = { root: new Uint8Array(), generation: 0, wireBytes: 0, entries: 0, replaySteps: 0 };
  #bundle = empty();
  #accepted = new Map();
  #limits;
  constructor(options = {}) { this.#limits = limits(options); }
  snapshot() { return { bundle: structuredClone(this.#bundle), acceptedAnchors: [...this.#accepted.values()].map(a => structuredClone(a)), ...structuredClone(this.#state), durability: 'session-only', effects: [] }; }
  async import(wire, options = this.#limits) {
    const bounds = limits(options);
    for (const key of Object.keys(bounds)) bounds[key] = Math.min(bounds[key], this.#limits[key]);
    // Copy wire before awaiting any verification.
    if (wire instanceof Uint8Array) wire = new Uint8Array(wire);
    const generation = this.#state.generation;
    if (!Number.isSafeInteger(generation + 1)) reject('generation-limit');
    const incoming = await verifyRecoveryBundle(wire, bounds);
    const merged = structuredClone(this.#bundle);
    for (const [field, key] of [['objects', o => o.manifest.object.contentDigest], ['jobs', j => j.checkpoint.jobId], ['anchors', a => a.name]]) {
      const retained = new Map(merged[field].map(row => [key(row), row]));
      for (const row of incoming.bundle[field]) {
        const old = retained.get(key(row));
        if (old && text(encode(old)) !== text(encode(row))) {
          if (field === 'objects') reject('conflict');
          if (field === 'jobs') {
            const before = old.checkpoint, after = row.checkpoint;
            if (!project('progressAllowed', before.stepIndex, after.stepIndex,
              text(encode(old.program)) === text(encode(row.program)),
              after.stepIndex !== before.stepIndex + 1 || after.previousDigest === before.checkpointDigest)) reject('conflict-or-rollback');
          } else {
            if (!project('progressAllowed', old.revision, row.revision, old.authorityKey === row.authorityKey,
              row.revision !== old.revision + 1 || row.previousDigest === old.pointerDigest)) reject('conflict-or-rollback');
          }
          merged[field][merged[field].indexOf(old)] = row;
          retained.set(key(row), row);
        }
        if (!old) { merged[field].push(row); retained.set(key(row), row); }
      }
    }
    // Prior immutable entries were already checked. Do not replay all history.
    const encoded = encode(merged, bounds);
    const cost = { wireBytes: encoded.length, entries: merged.objects.length + merged.jobs.length + merged.anchors.length,
      replaySteps: merged.jobs.reduce((n, j) => n + programWork(j.program, 0, j.checkpoint.stepIndex), 0) };
    const candidate = { ...cost, generation, root: new TextEncoder().encode(await sha256Bytes(encoded, 'recovery')) };
    const next = project('commit', bounds, this.#state, candidate, true);
    if (Number(next.generation) === this.#state.generation) reject('stale-or-capacity');
    this.#bundle = deepFreeze(merged);
    this.#state = { root: next.root, generation: Number(next.generation), wireBytes: Number(next.wireBytes), entries: Number(next.entries), replaySteps: Number(next.replaySteps) };
    return this.snapshot();
  }
  async export() { return exportRecoveryBundle(this.#bundle, this.#limits); }
  async objectBytes(root) {
    const object = this.#bundle.objects.find(o => o.manifest.object.contentDigest === root);
    if (!object) reject('missing-object');
    return recoverObject(object.manifest, object.fragments.map(f => ({ index: f.index, bytes: decodeHex(f.hex) })));
  }
  /** The expected digest/key MUST come from a source the operator trusts as
   * recent, separately from this bundle. No supplied timestamp proves recency.
   */
  async acceptRecentAnchor({ name, authorityKey, expectedDigest, nowMs, operatorAccepted }) {
    const generation = this.#state.generation;
    if (!Number.isSafeInteger(generation + 1)) reject('generation-limit');
    const anchor = this.#bundle.anchors.find(a => a.name === name);
    if (!anchor || operatorAccepted !== true || !Number.isSafeInteger(nowMs) || nowMs < 0) reject('anchor-consent');
    await verifyPointer(anchor, authorityKey);
    const retained = this.#accepted.get(name);
    if (!project('anchorAllowed', new TextEncoder().encode(anchor.pointerDigest), new TextEncoder().encode(expectedDigest), anchor.validFromMs, anchor.validUntilMs, nowMs,
      retained?.revision ?? 0, anchor.revision, retained ? (retained.authorityKey === anchor.authorityKey &&
        (retained.pointerDigest === anchor.pointerDigest || (anchor.revision > retained.revision && (anchor.revision !== retained.revision + 1 || anchor.previousDigest === retained.pointerDigest)))) : true)) reject('anchor-stale-or-untrusted');
    if (generation !== this.#state.generation) reject('stale-operation');
    this.#accepted.set(name, structuredClone(anchor));
    this.#state = { ...this.#state, generation: generation + 1 };
    return structuredClone(anchor);
  }
}
