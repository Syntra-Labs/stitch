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
