/**
 * @file src/layer3-storage/index.js
 * @description Layer 3: Distributed Ephemeral UOR Content-Addressed Database.
 * Compares 3 storage & durability strategies across node churn and 100% cohort turnover:
 *   1. UnreplicatedUorStore (R = 1 baseline)
 *   2. ReactiveMirrorUorStore (R = 3 full replication, periodic reactive scrub)
 *   3. ProactiveParityUorStore (k=2 data + m=1 XOR parity shards, survival-guided repair)
 * Depends only on Layer 1 (UOR content addressing) and Layer 2 (schedulers).
 */

import { mintContentAddress, Fnv1aHasher16 } from '../layer1-uor/index.js';
import { computeSurvivalProbability } from '../layer2-schedulers/index.js';
import { ResourceAdmission, reserveNetwork } from '../layer2-schedulers/policy.js';
import { CustodyError, verifyManifest, verifyFragment, copyBytes, snapshotRecord, exactKeys } from '../layer1-uor/custody.js';
import { createObject, recoverObject, createPlacement, requestPlacement, acknowledgePlacement, commitPlacement, failPlacement, placementStatus } from './custody.js';

/**
 * Split a Uint8Array payload into k = 2 even-length data shards + 1 XOR parity shard (n = 3).
 * Any 2 out of 3 shards reconstruct the exact original byte array.
 * @param {Uint8Array} bytes
 * @returns {{ originalLength: number, shards: [Uint8Array, Uint8Array, Uint8Array] }}
 */
export function encodeXorShards2of3(bytes) {
  const originalLength = bytes.length;
  const shardLen = Math.ceil(originalLength / 2);
  const s0 = new Uint8Array(shardLen);
  const s1 = new Uint8Array(shardLen);
  const parity = new Uint8Array(shardLen);

  s0.set(bytes.subarray(0, Math.min(shardLen, originalLength)));
  if (originalLength > shardLen) {
    s1.set(bytes.subarray(shardLen, originalLength));
  }
  for (let i = 0; i < shardLen; i++) {
    parity[i] = s0[i] ^ s1[i];
  }

  return { originalLength, shards: [s0, s1, parity] };
}

/**
 * Reconstruct the original Uint8Array from any 2 of the 3 shards ([s0, s1, parity]).
 * @param {number} originalLength
 * @param {Array<Uint8Array | null>} shards - Array of length 3 where at most 1 element is null.
 * @returns {Uint8Array | null}
 */
export function decodeXorShards2of3(originalLength, shards) {
  let [s0, s1, p] = shards;
  const available = (s0 ? 1 : 0) + (s1 ? 1 : 0) + (p ? 1 : 0);
  if (available < 2) return null;

  const shardLen = (s0 || s1 || p).length;
  if (!s0) {
    s0 = new Uint8Array(shardLen);
    for (let i = 0; i < shardLen; i++) s0[i] = s1[i] ^ p[i];
  } else if (!s1) {
    s1 = new Uint8Array(shardLen);
    for (let i = 0; i < shardLen; i++) s1[i] = s0[i] ^ p[i];
  }

  const out = new Uint8Array(shardLen * 2);
  out.set(s0, 0);
  out.set(s1, shardLen);
  return out.subarray(0, originalLength);
}

/**
 * Ephemeral in-memory peer node holding key-value buffers in RAM only (zero disk).
 */
class EphemeralPeerNode {
  constructor(nodeId, joinedAtSec, lambdaEstimate = 0.02) {
    this.nodeId = nodeId;
    this.joinedAtSec = joinedAtSec;
    this.lambdaEstimate = lambdaEstimate;
    this.alive = true;
    this.storage = new Map();
  }

  ageSeconds(nowSec) {
    return Math.max(0, nowSec - this.joinedAtSec);
  }

  survivalProb(nowSec) {
    if (!this.alive) return 0;
    return computeSurvivalProbability(this.lambdaEstimate, this.ageSeconds(nowSec));
  }
}

/**
 * Cluster harness running one of the 3 candidate storage strategies:
 *   - 'unreplicated' (R = 1)
 *   - 'reactive_mirror_r3' (R = 3 full copies, periodic scrub)
 *   - 'proactive_parity_2of3' (2 data + 1 parity shard, survival-guided proactive migration)
 */
export class DistributedUorDatabase {
  /**
   * @param {object} [options]
   * @param {'unreplicated' | 'reactive_mirror_r3' | 'proactive_parity_2of3'} [options.strategy='proactive_parity_2of3']
   * @param {typeof SplitMix128Hasher} [options.HasherClass=SplitMix128Hasher]
   * @param {number} [options.proactiveSurvivalThreshold=0.65]
   */
  constructor(options = {}) {
    this.strategy = options.strategy ?? 'proactive_parity_2of3';
    this.HasherClass = options.HasherClass ?? Fnv1aHasher16;
    this.proactiveSurvivalThreshold = options.proactiveSurvivalThreshold ?? 0.65;

    this.nodes = new Map();
    this.catalog = new Map(); // hexAddress -> metadata
    this.networkBytesTransferred = 0;
    this.repairOperations = 0;
  }

  addNode(nodeId, nowSec = 0, lambdaEstimate = 0.02) {
    const node = new EphemeralPeerNode(nodeId, nowSec, lambdaEstimate);
    this.nodes.set(nodeId, node);
    return node;
  }

  killNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.alive = false;
      node.storage.clear();
    }
  }

  aliveNodes(nowSec = 0) {
    const list = [];
    for (const n of this.nodes.values()) {
      if (n.alive) list.push(n);
    }
    // Sort by highest survival probability first (freshest nodes first)
    list.sort((a, b) => b.survivalProb(nowSec) - a.survivalProb(nowSec));
    return list;
  }

  /**
   * Store a byte payload under its deterministic UOR ContentAddress.
   * @param {Uint8Array} payloadBytes
   * @param {number} [nowSec=0]
   * @returns {{ addressHex: string, fingerprintHex: string }}
   */
  put(payloadBytes, nowSec = 0) {
    const bytes = payloadBytes instanceof Uint8Array
      ? payloadBytes
      : new TextEncoder().encode(String(payloadBytes));

    const { address, fingerprint } = mintContentAddress(bytes, this.HasherClass);
    const key = address.toHex();
    const peers = this.aliveNodes(nowSec);
    if (peers.length === 0) {
      throw new Error('No alive peers in cluster to accept write.');
    }

    if (this.strategy === 'unreplicated') {
      const target = peers[0];
      target.storage.set(key, new Uint8Array(bytes));
      this.networkBytesTransferred += bytes.length;
      this.catalog.set(key, {
        originalLength: bytes.length,
        fingerprintHex: fingerprint.toHex(),
        holders: [target.nodeId]
      });
    } else if (this.strategy === 'reactive_mirror_r3') {
      const holders = [];
      const limit = Math.min(3, peers.length);
      for (let i = 0; i < limit; i++) {
        peers[i].storage.set(key, new Uint8Array(bytes));
        holders.push(peers[i].nodeId);
        this.networkBytesTransferred += bytes.length;
      }
      this.catalog.set(key, {
        originalLength: bytes.length,
        fingerprintHex: fingerprint.toHex(),
        holders
      });
    } else if (this.strategy === 'proactive_parity_2of3') {
      const { originalLength, shards } = encodeXorShards2of3(bytes);
      const shardHolders = [null, null, null];
      for (let sIdx = 0; sIdx < 3; sIdx++) {
        const peer = peers[sIdx % peers.length];
        peer.storage.set(`${key}:s${sIdx}`, shards[sIdx]);
        shardHolders[sIdx] = peer.nodeId;
        this.networkBytesTransferred += shards[sIdx].length;
      }
      this.catalog.set(key, {
        originalLength,
        fingerprintHex: fingerprint.toHex(),
        shardHolders
      });
    }

    return { addressHex: key, fingerprintHex: fingerprint.toHex() };
  }

  /**
   * Retrieve and cryptographically verify a UOR object by its ContentAddress hex.
   * @param {string} addressHex
   * @returns {{ ok: boolean, bytes: Uint8Array | null, verified: boolean }}
   */
  get(addressHex) {
    const meta = this.catalog.get(addressHex);
    if (!meta) return { ok: false, bytes: null, verified: false };

    let recovered = null;

    if (this.strategy === 'unreplicated' || this.strategy === 'reactive_mirror_r3') {
      for (const nodeId of meta.holders) {
        const node = this.nodes.get(nodeId);
        if (node && node.alive && node.storage.has(addressHex)) {
          recovered = new Uint8Array(node.storage.get(addressHex));
          break;
        }
      }
    } else if (this.strategy === 'proactive_parity_2of3') {
      const shards = [null, null, null];
      for (let sIdx = 0; sIdx < 3; sIdx++) {
        const nodeId = meta.shardHolders[sIdx];
        const node = this.nodes.get(nodeId);
        if (node && node.alive && node.storage.has(`${addressHex}:s${sIdx}`)) {
          shards[sIdx] = node.storage.get(`${addressHex}:s${sIdx}`);
        }
      }
      recovered = decodeXorShards2of3(meta.originalLength, shards);
    }

    if (!recovered) {
      return { ok: false, bytes: null, verified: false };
    }

    const { address, fingerprint } = mintContentAddress(recovered, this.HasherClass);
    const verified = address.toHex() === addressHex && fingerprint.toHex() === meta.fingerprintHex;
    return { ok: verified, bytes: recovered, verified };
  }

  /**
   * Run maintenance / repair cycle at `nowSec`.
   * - `reactive_mirror_r3`: only repairs replicas after a holder is already dead.
   * - `proactive_parity_2of3`: migrates shards before holder survival drops below threshold,
   *   and reconstructs missing shards using XOR parity.
   */
  maintainCluster(nowSec) {
    const peers = this.aliveNodes(nowSec);
    if (peers.length === 0) return;

    if (this.strategy === 'reactive_mirror_r3') {
      for (const [key, meta] of this.catalog.entries()) {
        const liveHolders = meta.holders.filter(id => {
          const n = this.nodes.get(id);
          return n && n.alive && n.storage.has(key);
        });
        if (liveHolders.length === 0) continue; // Object permanently lost
        const sampleBytes = this.nodes.get(liveHolders[0]).storage.get(key);

        for (const peer of peers) {
          if (liveHolders.length >= 3) break;
          if (!liveHolders.includes(peer.nodeId)) {
            peer.storage.set(key, new Uint8Array(sampleBytes));
            liveHolders.push(peer.nodeId);
            this.networkBytesTransferred += sampleBytes.length;
            this.repairOperations++;
          }
        }
        meta.holders = liveHolders;
      }
    } else if (this.strategy === 'proactive_parity_2of3') {
      for (const [key, meta] of this.catalog.entries()) {
        const shards = [null, null, null];
        for (let i = 0; i < 3; i++) {
          const n = this.nodes.get(meta.shardHolders[i]);
          if (n && n.alive && n.storage.has(`${key}:s${i}`)) {
            shards[i] = n.storage.get(`${key}:s${i}`);
          }
        }

        const reconstructed = decodeXorShards2of3(meta.originalLength, shards);
        if (!reconstructed) continue; // Permanently lost
        const fullShards = encodeXorShards2of3(reconstructed).shards;

        for (let i = 0; i < 3; i++) {
          const currentHolder = this.nodes.get(meta.shardHolders[i]);
          const holderDead = !currentHolder || !currentHolder.alive || !currentHolder.storage.has(`${key}:s${i}`);
          const holderAgingOut = currentHolder && currentHolder.survivalProb(nowSec) < this.proactiveSurvivalThreshold;

          if (holderDead || holderAgingOut) {
            const candidate = peers.find(
              p => !meta.shardHolders.includes(p.nodeId) && p.survivalProb(nowSec) >= this.proactiveSurvivalThreshold
            ) || peers.find(p => !meta.shardHolders.includes(p.nodeId));

            if (candidate) {
              if (currentHolder && currentHolder.alive) {
                currentHolder.storage.delete(`${key}:s${i}`);
              }
              candidate.storage.set(`${key}:s${i}`, fullShards[i]);
              meta.shardHolders[i] = candidate.nodeId;
              this.networkBytesTransferred += fullShards[i].length;
              this.repairOperations++;
            }
          }
        }
      }
    }
  }

  totalStoredBytes() {
    let sum = 0;
    for (const node of this.nodes.values()) {
      if (!node.alive) continue;
      for (const buf of node.storage.values()) {
        sum += buf.length;
      }
    }
    return sum;
  }
}

/**
 * Run the strict "100% Cohort Turnover (Zero-Peer-Overlap)" benchmark across all 3 storage strategies.
 * Proves data persistence when 100% of initial nodes are killed over `generations` waves of churn.
 */
export function benchmarkStorageStrategies({
  objectCount = 24,
  objectSizeBytes = 256,
  initialNodes = 5,
  generations = 8
} = {}) {
  const strategies = [
    { id: 'unreplicated', label: 'Unreplicated (R=1)' },
    { id: 'reactive_mirror_r3', label: 'Reactive Mirror (R=3)' },
    { id: 'proactive_parity_2of3', label: 'Proactive XOR Parity (2-of-3 + Survival)' }
  ];

  const payloads = [];
  for (let i = 0; i < objectCount; i++) {
    const buf = new Uint8Array(objectSizeBytes);
    for (let j = 0; j < objectSizeBytes; j++) {
      buf[j] = (i * 73 + j * 19 + 7) & 0xff;
    }
    payloads.push(buf);
  }

  const logicalBytes = objectCount * objectSizeBytes;

  return strategies.map(({ id, label }) => {
    const db = new DistributedUorDatabase({
      strategy: id,
      proactiveSurvivalThreshold: 0.72
    });

    // Generation 0: spawn initial cohort
    const gen0Ids = [];
    for (let n = 0; n < initialNodes; n++) {
      const nodeId = `gen0-node${n}`;
      db.addNode(nodeId, 0, 0.025);
      gen0Ids.push(nodeId);
    }

    // Write all objects at t = 0
    const addresses = payloads.map(p => db.put(p, 0).addressHex);
    const initialStoredBytes = db.totalStoredBytes();
    const storageAmplification = Number((initialStoredBytes / logicalBytes).toFixed(2));

    // Step through generations: each generation ages existing nodes, adds 2 fresh nodes,
    // runs proactive maintenance, then kills 2 oldest nodes simultaneously (dual-failure spike).
    const activeQueue = [...gen0Ids];
    let nowSec = 0;

    for (let g = 1; g <= generations; g++) {
      nowSec += 15;
      const freshA = `gen${g}-nodeA`;
      const freshB = `gen${g}-nodeB`;
      db.addNode(freshA, nowSec, 0.025);
      db.addNode(freshB, nowSec, 0.025);
      activeQueue.push(freshA, freshB);

      // Proactive parity migrates shards off aging nodes BEFORE simultaneous dual kill;
      // Reactive mirror only repairs already-dead nodes, so a 2-node kill before reactive scrub
      // or during churn stresses reactive vs proactive.
      if (id === 'proactive_parity_2of3') {
        db.maintainCluster(nowSec);
      }

      // Kill the 2 oldest nodes
      const victim1 = activeQueue.shift();
      const victim2 = activeQueue.shift();
      db.killNode(victim1);
      db.killNode(victim2);

      // Reactive repair runs after every second generation (periodic scrub)
      if (id === 'reactive_mirror_r3' && g % 2 === 0) {
        db.maintainCluster(nowSec);
      }
    }

    // Verify that 0 initial (Gen-0) nodes are still alive
    const gen0Alive = gen0Ids.filter(nid => db.nodes.get(nid)?.alive).length;

    // Read & verify all UOR objects
    let survivingObjects = 0;
    for (let i = 0; i < addresses.length; i++) {
      const res = db.get(addresses[i]);
      if (res.ok && res.verified) {
        survivingObjects++;
      }
    }

    return {
      strategy: label,
      initial_nodes_remaining: gen0Alive,
      objects_written: objectCount,
      objects_recovered: survivingObjects,
      retention_rate: Number((survivingObjects / objectCount).toFixed(4)),
      storage_amplification: storageAmplification,
      network_bytes_transferred: db.networkBytesTransferred,
      repair_ops: db.repairOperations
    };
  });
}

/**
 * Live SHA-256-bound object adapter. Distinct fragment placement is explicit;
 * retrieval is separate and only returns fragments actually assigned here.
 * Receipts are peer assertions, not authenticated retention guarantees. Local
 * writer/recovery caches and an opted-in public relay are additional copies.
 */
export class LiveUorMeshDatabase {
  constructor({ transport, scheduler = null, onUpdate = () => {}, vmBridge = null, admission = transport?.admission ?? new ResourceAdmission() }) {
    this.transport = transport;
    this.scheduler = scheduler;
    this.admission = admission;
    this.onUpdate = onUpdate;
    this.vmBridge = vmBridge;
    this.objects = new Map();
    this.placements = new Map();
    this.pendingTransfers = new Map();
    this.replicationsSent = 0;
    this.replicationsReceived = 0;
    this.warmRecoveries = 0;
    this._sequence = 0;
    this._mailbox = Promise.resolve();
    this._pendingWork = 0;
    this.maxPendingWork = 256;
    this.maxWireObjectBytes = 128 * 1024;
    this.maxCachedBytes = 16 * 1024 * 1024;
    this.maxObjects = 128;
    this.demoPlacementLeaseMs = 60000; // declared host policy, not a retention guarantee
    this.maxAcceptedLeaseMs = 120000; // bounded host policy for incoming assertions
  }

  _enqueue(work) {
    if (this._pendingWork >= this.maxPendingWork) return Promise.reject(new CustodyError('CapacityLimit', 'Ingress mailbox is full'));
    this._pendingWork++;
    const result = this._mailbox.then(work).finally(() => { this._pendingWork--; });
    this._mailbox = result.catch(() => {});
    return result;
  }

  /** Useful to await all messages accepted by a fake transport in tests. */
  async flush() { await this._mailbox; }

  _reject(reason) {
    this.onUpdate({ type: 'custody_rejected', reason: reason?.code || String(reason) });
    return false;
  }

  _checkCapacity(key, addedBytes) {
    if (!this.objects.has(key) && this.objects.size >= this.maxObjects) throw new CustodyError('CapacityLimit', 'Object cache is full');
    let stored = 0;
    for (const pending of this.pendingTransfers.values()) stored += pending.bytes.length;
    for (const e of this.objects.values()) {
      stored += e.bytes?.length || 0;
      for (const shard of e.shards) stored += shard?.length || 0;
    }
    if (stored + addedBytes > this.maxCachedBytes) throw new CustodyError('CapacityLimit', 'Object byte cache is full');
  }

  _send(holder, packet) {
    if (this.transport.admission !== this.admission) reserveNetwork(this.admission, 'place', packet);
    return this.transport.sendToPeer(holder, packet);
  }

  _broadcast(packet) {
    if (this.transport.admission !== this.admission) reserveNetwork(this.admission, 'retrieve', packet, (this.transport.openPeers?.() || []).length);
    return this.transport.broadcast(packet);
  }

  _publish(packet) {
    if (this.transport.admission !== this.admission) reserveNetwork(this.admission, 'place', { ...packet, from: this.transport.peerId, tsMs: Date.now() });
    return this.transport.publishWarmEnvelope(packet, { publicData: true });
  }

  _fetch(sinceWindow) {
    if (this.transport.admission !== this.admission) this.admission.reserve('retrieve', { requests: 1, transferBytes: 2 * 1024 * 1024 });
    return this.transport.fetchWarmEnvelopes(sinceWindow, { publicData: true });
  }

  clearLocal() {
    return this._enqueue(() => {
      this.objects.clear(); this.placements.clear(); this.pendingTransfers.clear();
      // A wipe does not refund unknown remote effects or reset policy.
    });
  }

  _label(label) {
    if (typeof label !== 'string' || label.length > 256 || /[\u0000-\u001f\u007f/\\]/.test(label)) {
      throw new CustodyError('InvalidSchema', 'Label must be bounded plain text without path separators');
    }
    return label;
  }

  _packet(entry, index, bytes, { purpose = 'recovery', requestId = null, holder = null, leaseExpiresAt = 0 } = {}) {
    return {
      type: 'uor_shard', version: 1, manifest: entry.manifest, label: entry.label,
      shardIndex: index, shardBytes: Array.from(bytes), purpose, requestId, holder, leaseExpiresAt,
    };
  }

  _readPacket(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(env))) throw new CustodyError('InvalidSchema');
    const d = Object.getOwnPropertyDescriptors(env);
    const keys = ['type', 'version', 'manifest', 'label', 'shardIndex', 'shardBytes', 'purpose', 'requestId', 'holder', 'leaseExpiresAt'];
    if (Reflect.ownKeys(env).length !== keys.length || keys.some(k => !d[k]?.enumerable || !Object.hasOwn(d[k], 'value'))) {
      throw new CustodyError('InvalidSchema', 'Legacy or malformed fragment envelope');
    }
    const p = snapshotRecord(Object.fromEntries(keys.filter(k => k !== 'shardBytes').map(k => [k, d[k].value])));
    if (p.type !== 'uor_shard' || p.version !== 1 || !['placement', 'recovery', 'public-relay'].includes(p.purpose)
      || !Number.isInteger(p.shardIndex) || p.shardIndex < 0 || p.shardIndex > 2
      || !Number.isSafeInteger(p.leaseExpiresAt) || p.leaseExpiresAt < 0) throw new CustodyError('InvalidSchema');
    this._label(p.label);
    const a = d.shardBytes.value;
    if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype || a.length > this.maxWireObjectBytes / 2
      || Reflect.ownKeys(a).length !== a.length + 1) throw new CustodyError('SizeLimit', 'Invalid or oversized fragment bytes');
    const bytes = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const byte = Object.getOwnPropertyDescriptor(a, String(i));
      if (!byte || !Object.hasOwn(byte, 'value') || !Number.isInteger(byte.value) || byte.value < 0 || byte.value > 255) {
        throw new CustodyError('InvalidBytes', 'Wire bytes must be integers from zero through 255');
      }
      bytes[i] = byte.value;
    }
    if (p.purpose === 'placement') {
      if (typeof p.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(p.requestId)
        || p.holder !== this.transport.peerId || p.leaseExpiresAt <= Date.now()
        || p.leaseExpiresAt > Date.now() + this.maxAcceptedLeaseMs) throw new CustodyError('InvalidSchema', 'Wrong holder or invalid lease claim');
    } else if (p.requestId !== null || p.leaseExpiresAt !== 0
      || (p.purpose === 'public-relay' ? p.holder !== 'public-relay' : p.holder !== null)) {
      throw new CustodyError('InvalidSchema', 'Invalid retrieval metadata');
    }
    return { ...p, bytes };
  }

  _snapshotEnvelope(env, publicData = false) {
    // ntfy transport appends these two unauthenticated delivery metadata fields.
    // They are never part of an object's commitment or used as peer authority.
    if (publicData && env && (Object.hasOwn(env, 'from') || Object.hasOwn(env, 'tsMs'))) {
      const d = Object.getOwnPropertyDescriptors(env);
      if (!d.from?.enumerable || !d.tsMs?.enumerable || !Object.hasOwn(d.from, 'value') || !Object.hasOwn(d.tsMs, 'value')
        || typeof d.from.value !== 'string' || d.from.value.length > 128
        || !Number.isSafeInteger(d.tsMs.value) || d.tsMs.value < 0) throw new CustodyError('InvalidSchema', 'Invalid relay metadata');
      const keys = Reflect.ownKeys(env).filter(k => k !== 'from' && k !== 'tsMs');
      if (keys.some(k => typeof k !== 'string' || !d[k].enumerable || !Object.hasOwn(d[k], 'value'))) throw new CustodyError('InvalidSchema');
      env = Object.fromEntries(keys.map(k => [k, d[k].value]));
    }
    const p = this._readPacket(env);
    return this._packet(p, p.shardIndex, p.bytes, p);
  }

  async _ingest(env, sourceTag, fromPeerId = null, publicData = false) {
    const p = this._readPacket(env);
    if (p.purpose === 'public-relay' && !publicData) throw new CustodyError('PublicDataRequired', 'Public relay access requires opt-in');
    if (p.purpose === 'placement' && !fromPeerId) throw new CustodyError('InvalidSchema', 'Placement must arrive through a peer channel');
    const manifest = await verifyManifest(p.manifest);
    if (manifest.object.byteLength > this.maxWireObjectBytes) throw new CustodyError('SizeLimit', 'Object exceeds live wire limit');
    const f = await verifyFragment(manifest, { index: p.shardIndex, bytes: p.bytes });
    const key = manifest.object.contentDigest;
    let entry = this.objects.get(key);
    if (entry && entry.manifest.manifestDigest !== manifest.manifestDigest) throw new CustodyError('ManifestDigestMismatch', 'Conflicting manifest for object');
    const added = entry?.shards[f.index] ? 0 : f.bytes.length;
    this._checkCapacity(key, added);
    if (!entry) {
      entry = {
        addressHex: key, fingerprintHex: key, manifest, originalLength: manifest.object.byteLength,
        label: p.label, createdAtSec: Math.floor(Date.now() / 1000), shards: [null, null, null],
        heldIndices: new Set(), bytes: null, verified: false, source: sourceTag,
      };
    }
    if (!entry.shards[f.index]) {
      this.admission.reserve('place', { storageBytes: f.bytes.length });
      this.objects.set(key, entry);
      entry.shards[f.index] = f.bytes;
      this.replicationsReceived++;
    }
    if (p.purpose === 'placement') {
      entry.heldIndices.add(f.index);
      // The return channel associates the assertion with this connected peer;
      // no application-authority or persistent-storage authentication is claimed.
      this._send(fromPeerId, {
        type: 'uor_shard_ack', version: 1, requestId: p.requestId, index: f.index,
        holder: this.transport.peerId, manifestDigest: manifest.manifestDigest,
        fragmentDigest: manifest.fragments.digests[f.index], leaseExpiresAt: p.leaseExpiresAt,
      });
    }
    let newlyVerified = false;
    if (!entry.verified && entry.shards.filter(Boolean).length >= 2) {
      const available = entry.shards.flatMap((bytes, index) => bytes ? [{ index, bytes }] : []);
      this.admission.reserve('retrieve', { storageBytes: manifest.object.byteLength });
      const recovered = await recoverObject(manifest, available);
      this._checkCapacity(key, recovered.length);
      entry.bytes = recovered;
      entry.verified = true;
      entry.source = sourceTag;
      newlyVerified = true;
      if (this.vmBridge) await this.vmBridge.mountUorObject(key, new Uint8Array(recovered), entry.label);
      this.onUpdate({ type: 'object_verified', entry });
    }
    this.onUpdate({ type: 'shard_ingested', addressHex: key, shardIndex: f.index, sourceTag });
    return newlyVerified;
  }

  ingestShardEnvelope(env, sourceTag = 'remote', { publicData = false } = {}) {
    try { env = this._snapshotEnvelope(env, publicData); }
    catch (error) { return Promise.resolve(this._reject(error)); }
    return this._enqueue(async () => {
      try { return await this._ingest(env, sourceTag, null, publicData); }
      catch (error) { return this._reject(error); }
    });
  }

  handleMeshMessage(fromPeerId, msg) {
    try {
      const type = Object.getOwnPropertyDescriptor(msg ?? {}, 'type')?.value;
      msg = type === 'uor_shard' ? this._snapshotEnvelope(msg) : snapshotRecord(msg);
    } catch (error) { return Promise.resolve(this._reject(error)); }
    return this._enqueue(async () => {
      try {
        if (!msg || typeof msg !== 'object') return false;
        if (msg.type === 'uor_shard') return await this._ingest(msg, `webrtc:${fromPeerId}`, fromPeerId);
        if (msg.type === 'uor_shard_ack') return await this._acknowledge(fromPeerId, msg);
        if (msg.type === 'uor_sync_req') {
          const p = snapshotRecord(msg);
          exactKeys(p, ['type', 'version']);
          if (p.version !== 1) throw new CustodyError('InvalidSchema');
          for (const entry of this.objects.values()) {
            // Retrieval returns assigned fragments only, never regenerates and
            // broadcasts all 3 fragments from a writer's full-object cache.
            for (const index of entry.heldIndices) {
              if (entry.shards[index] && this._send(fromPeerId, this._packet(entry, index, entry.shards[index]))) this.replicationsSent++;
            }
          }
          return true;
        }
        return false;
      } catch (error) { return this._reject(error); }
    });
  }

  async _acknowledge(fromPeerId, message) {
    const ack = snapshotRecord(message);
    exactKeys(ack, ['type', 'version', 'requestId', 'index', 'holder', 'manifestDigest', 'fragmentDigest', 'leaseExpiresAt']);
    if (ack.version !== 1 || ack.holder !== fromPeerId) throw new CustodyError('ReceiptMismatch');
    const pending = this.pendingTransfers.get(ack.requestId);
    if (!pending || pending.holder !== fromPeerId) throw new CustodyError('ReceiptMismatch', 'Unknown or replayed acknowledgement');
    let state = this.placements.get(pending.addressHex);
    const { type, version, ...receipt } = ack;
    state = await acknowledgePlacement(state, { ...receipt, bytes: pending.bytes }, Date.now());
    this.placements.set(pending.addressHex, state);
    state = await commitPlacement(state, ack.requestId, Date.now());
    this.placements.set(pending.addressHex, state);
    this.pendingTransfers.delete(ack.requestId);
    const entry = this.objects.get(pending.addressHex);
    entry.placementStatus = placementStatus(state, Date.now());
    this.onUpdate({ type: 'placement_committed', entry, holder: fromPeerId, shardIndex: ack.index });
    return true;
  }

  /** Defaults never transmit bytes to a public relay. */
  put(payload, { label = 'data', persistWarm = false, publicData = false } = {}) {
    // Snapshot caller-owned bytes before queueing or yielding.
    try {
      if (typeof payload === 'string' && payload.length > this.maxWireObjectBytes) throw new CustodyError('SizeLimit');
      if (payload instanceof Uint8Array) payload = copyBytes(payload, this.maxWireObjectBytes);
    }
    catch (error) { return Promise.reject(error); }
    return this._enqueue(async () => {
      if (persistWarm && !publicData) throw new CustodyError('PublicDataRequired', 'Public warm relay needs explicit publicData:true');
      this._label(label);
      if (typeof persistWarm !== 'boolean' || typeof publicData !== 'boolean') throw new CustodyError('InvalidSchema', 'Relay options must be explicit booleans');
      if (typeof payload === 'string' && payload.length > this.maxWireObjectBytes) throw new CustodyError('SizeLimit', 'Payload exceeds live wire limit');
      const bytes = payload instanceof Uint8Array ? copyBytes(payload, this.maxWireObjectBytes)
        : typeof payload === 'string' ? new TextEncoder().encode(payload) : null;
      if (!bytes) throw new CustodyError('InvalidBytes', 'Payload must be bytes or text');
      if (bytes.length > this.maxWireObjectBytes) throw new CustodyError('SizeLimit', 'Payload exceeds live wire limit');
      // Reserve the new local bytes and conservative fragment allocation ceiling
      // before encoding or any placement/relay/VM effect.
      this.admission.reserve('place', { storageBytes: bytes.length + 3 * Math.ceil(bytes.length / 2) });
      const { manifest, fragments } = await createObject(bytes);
      const key = manifest.object.contentDigest;
      const existing = this.objects.get(key);
      if (existing && existing.manifest.manifestDigest !== manifest.manifestDigest) {
        throw new CustodyError('ManifestDigestMismatch', 'Conflicting cached manifest for object');
      }
      if (existing?.verified && this.placements.has(key)) {
        if (persistWarm) {
          for (const f of fragments.slice(0, 2)) {
            if (await this._publish(this._packet(existing, f.index, f.bytes, { purpose: 'public-relay', holder: 'public-relay' }))) existing.warmPublished = (existing.warmPublished || 0) + 1;
          }
        }
        return existing;
      }
      this._checkCapacity(key, existing?.bytes ? 0 : bytes.length);
      const entry = existing || {
        addressHex: key, fingerprintHex: key, manifest, originalLength: bytes.length, label,
        createdAtSec: Math.floor(Date.now() / 1000), shards: [null, null, null], heldIndices: new Set(),
        bytes, verified: true, source: `local:${this.transport.peerId}`, warmPublished: 0,
      };
      // A caller supplying complete bytes may promote a prior fragment/read
      // cache. Preserve actually assigned fragments and begin explicit placement.
      entry.bytes = bytes;
      entry.verified = true;
      entry.source = `local:${this.transport.peerId}`;
      entry.warmPublished ??= 0;
      this.objects.set(key, entry);
      let state = await createPlacement(manifest);
      this.placements.set(key, state);
      const peers = [...new Set((this.transport.openPeers?.() || []).map(p => p.remoteId))]
        .filter(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(id) && id !== this.transport.peerId).sort().slice(0, 3);
      for (let index = 0; index < peers.length; index++) {
        const holder = peers[index];
        const requestId = `placement-${++this._sequence}`;
        const leaseExpiresAt = Date.now() + this.demoPlacementLeaseMs;
        state = await requestPlacement(state, { requestId, index, holder, leaseExpiresAt });
        this.placements.set(key, state);
        this.pendingTransfers.set(requestId, { addressHex: key, holder, bytes: fragments[index].bytes });
        let sent = false, outcome = 'failed';
        try { sent = this._send(holder, this._packet(entry, index, fragments[index].bytes, { purpose: 'placement', requestId, holder, leaseExpiresAt })); }
        catch { outcome = 'uncertain'; }
        if (sent) this.replicationsSent++;
        else {
          state = await failPlacement(state, requestId, outcome);
          this.placements.set(key, state);
          this.pendingTransfers.delete(requestId);
        }
      }
      if (persistWarm) {
        for (const f of fragments.slice(0, 2)) {
          if (await this._publish(this._packet(entry, f.index, f.bytes, { purpose: 'public-relay', holder: 'public-relay' }))) entry.warmPublished++;
        }
      }
      entry.placementStatus = placementStatus(state, Date.now());
      if (this.vmBridge) await this.vmBridge.mountUorObject(key, new Uint8Array(bytes), label);
      // Storage writes are not discovery refreshes and do not advance its clock.
      this.onUpdate({ type: 'object_put', entry });
      return entry;
    });
  }

  get(addressHex) {
    const entry = this.objects.get(addressHex);
    if (!entry || !entry.verified || !entry.bytes) return { ok: false, bytes: null, text: null, entry: null };
    const bytes = new Uint8Array(entry.bytes);
    return { ok: true, bytes, text: new TextDecoder().decode(bytes), entry };
  }

  /** Explicit retrieval may create read caches; placement state is separate. */
  syncFromNetwork(sinceWindow = '30m', { publicData = false } = {}) {
    return this._enqueue(async () => {
      this._broadcast({ type: 'uor_sync_req', version: 1 });
      if (!publicData) return 0;
      const envelopes = await this._fetch(sinceWindow);
      if (!Array.isArray(envelopes) || envelopes.length > this.maxObjects * 3) throw new CustodyError('CapacityLimit', 'Oversized relay result');
      let recovered = 0;
      for (const env of envelopes) {
        try {
          if (env?.type === 'uor_shard' && await this._ingest(this._snapshotEnvelope(env, true), 'warm-relay:public', null, true)) {
            this.warmRecoveries++; recovered++;
          }
        } catch (error) { this._reject(error); }
      }
      return recovered;
    });
  }
}
