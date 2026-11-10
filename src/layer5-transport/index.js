/**
 * @file src/layer5-transport/index.js
 * @description Layer 5: Live Multi-Peer WebRTC DataChannel Mesh, Warm Relay Ring-Buffer,
 * Layer-2 Ethernet Frame Bridge (for v86 Linux VMs), and RFC 8484 DoH + Lightweight DNS TXT Writer.
 */

import { ResourceAdmission, reserveNetwork, wireBytes } from '../layer2-schedulers/policy.js';
import { refuse } from '../layer1-uor/contracts.js';

/** Bounded application response body, not a bound on browser/network overhead. */
export async function readBoundedText(response, maxBytes) {
  const advertised = response.headers?.get?.('content-length');
  if (advertised && Number(advertised) > maxBytes) refuse('response-limit');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (wireBytes(text) > maxBytes) refuse('response-limit');
    return text;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let total = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) refuse('response-limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

export function parsePointerTxt(rawTxt) {
  const cleaned = String(rawTxt).replace(/^"+|"+$/g, '').trim();
  const out = {};
  for (const part of cleaned.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

export function formatPointerTxt({ peerId, endpoint, rootAddress, timestampSec = Math.floor(Date.now() / 1000), signatureB64Url = null }) {
  const base = `v=uor1;peer=${peerId};ep=${endpoint};root=${rootAddress || '0'};ts=${timestampSec}`;
  return signatureB64Url ? `${base};sig=${signatureB64Url}` : base;
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Claim C8 & C10: Generate an Ed25519 keypair via WebCrypto for verifiable DNS pointer records.
 */
export async function generatePointerKeyPair() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyB64Url: toBase64Url(rawPub)
  };
}

/**
 * Claim C8 & C10: Sign a DNS TXT pointer payload with Ed25519 and enforce <= 255 byte single-TXT bound.
 */
export async function signPointerTxt({ peerId, endpoint, rootAddress, timestampSec = Math.floor(Date.now() / 1000) }, privateKey) {
  const canonical = formatPointerTxt({ peerId, endpoint, rootAddress, timestampSec });
  const data = new TextEncoder().encode(canonical);
  const t0 = performance.now();
  const sigBuf = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data);
  const signLatencyMs = Number((performance.now() - t0).toFixed(3));
  const signatureB64Url = toBase64Url(new Uint8Array(sigBuf));
  const txt = formatPointerTxt({ peerId, endpoint, rootAddress, timestampSec, signatureB64Url });
  return {
    txt,
    byteLength: new TextEncoder().encode(txt).byteLength,
    signLatencyMs,
    c10_within_255b: txt.length <= 255
  };
}

/**
 * Claim C8: Verify an Ed25519-signed DNS TXT pointer record in-browser and measure verification latency.
 */
export async function verifyPointerTxt(rawTxt, publicKeyOrB64Url) {
  const t0 = performance.now();
  const parsed = parsePointerTxt(rawTxt);
  if (!parsed.sig) {
    return { ok: false, reason: 'missing_sig', verifyLatencyMs: 0, parsed };
  }
  const canonical = formatPointerTxt({
    peerId: parsed.peer,
    endpoint: parsed.ep,
    rootAddress: parsed.root,
    timestampSec: parsed.ts
  });
  let pubKey = publicKeyOrB64Url;
  if (typeof publicKeyOrB64Url === 'string') {
    pubKey = await globalThis.crypto.subtle.importKey(
      'raw',
      fromBase64Url(publicKeyOrB64Url),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
  }
  const valid = await globalThis.crypto.subtle.verify(
    { name: 'Ed25519' },
    pubKey,
    fromBase64Url(parsed.sig),
    new TextEncoder().encode(canonical)
  );
  const verifyLatencyMs = Number((performance.now() - t0).toFixed(3));
  return {
    ok: valid,
    verifyLatencyMs,
    byteLength: String(rawTxt).length,
    parsed
  };
}

export function parseSrvRecord(srvData) {
  const parts = String(srvData).trim().split(/\s+/);
  if (parts.length < 4) return null;
  return {
    priority: Number(parts[0]),
    weight: Number(parts[1]),
    port: Number(parts[2]),
    target: parts[3].replace(/\.$/, '')
  };
}

/**
 * RFC 8484 DNS-over-HTTPS Resolver + Lightweight Public Dynamic DNS TXT Writer.
 */
export class DohResolver {
  constructor(options = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_DOH_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.history = [];
    this.admission = options.admission ?? new ResourceAdmission();
    this.maxResponseBytes = 128 * 1024;
  }

  async resolve(name, type = 'SRV') {
    if (!this.fetchImpl) {
      throw new Error('fetch is not available in this runtime');
    }
    const t0 = performance.now();
    const url = `${this.endpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    this.admission.reserve('retrieve', { requests: 1, transferBytes: wireBytes(url) + this.maxResponseBytes });
    const res = await this.fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = res.body?.getReader || res.text
      ? JSON.parse(await readBoundedText(res, this.maxResponseBytes)) : await res.json();
    const rttMs = Number((performance.now() - t0).toFixed(1));
    const answers = Array.isArray(body.Answer) ? body.Answer : [];
    const ttlSeconds = answers.length > 0
      ? Math.min(...answers.map(a => Number(a.TTL) || 30))
      : 0;

    const prev = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    const cacheHitInferred = Boolean(
      prev && prev.name === name && prev.type === type && ttlSeconds > 0 && ttlSeconds < prev.ttlSeconds
    );

    const parsedRecords = answers.map(a => {
      if (type === 'SRV') return parseSrvRecord(a.data);
      if (type === 'TXT') return parsePointerTxt(a.data);
      return a.data;
    }).filter(Boolean);

    const record = {
      name,
      type,
      status: body.Status ?? 0,
      ttl_seconds: ttlSeconds,
      rtt_ms: rttMs,
      cache_hit_inferred: cacheHitInferred,
      rawRecords: answers.map(a => a.data),
      records: parsedRecords
    };
    this.history.push(record);
    if (this.history.length > 128) this.history.shift();
    return record;
  }

  /**
   * Lightweight Dynamic DNS TXT update via single HTTP GET (DuckDNS protocol).
   * Can use a public scoped subdomain token so any peer can update the TXT pointer.
   * @param {object} params
   * @param {string} params.subdomain - DuckDNS subdomain name (without .duckdns.org)
   * @param {string} params.token - Scoped token for that subdomain
   * @param {string} params.txtValue - Pointer string (<= 255 chars)
   */
  async writeDuckDnsTxt({ subdomain, token, txtValue }) {
    if (!this.fetchImpl) throw new Error('fetch unavailable');
    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(subdomain)}&token=${encodeURIComponent(token)}&txt=${encodeURIComponent(txtValue)}`;
    this.admission.reserve('refresh', { requests: 1, transferBytes: wireBytes(url) + this.maxResponseBytes });
    const res = await this.fetchImpl(url);
    const text = (await readBoundedText(res, this.maxResponseBytes)).trim();
    return { ok: text === 'OK', response: text, fqdn: `${subdomain}.duckdns.org` };
  }

  /**
   * Objective O2 & Claim C2: Publish or update a low-TTL Cloudflare DNS SRV or TXT record
   * (supports epoch-prefixed subdomains `<epoch>._stitch._udp.<zone>` to bypass local cache opacity).
   * @param {object} params
   * @param {string} params.zoneId - Cloudflare Zone ID
   * @param {string} params.apiToken - Scoped Cloudflare API Token (Zone:DNS:Edit)
   * @param {string} [params.recordId] - Optional existing record ID for PUT/PATCH (if omitted, POST creates a new record)
   * @param {'TXT'|'SRV'} [params.type='TXT']
   * @param {string} params.name - Full record name (e.g. `_stitch._udp.example.com` or `e104._stitch._udp.example.com`)
   * @param {string} [params.content] - Record content for TXT
   * @param {{priority:number, weight:number, port:number, target:string}} [params.srvData] - Structured data for SRV
   * @param {number} [params.ttl=60] - TTL in seconds (30-60s per C2 protocol)
   * @param {string} [params.apiBase='https://api.cloudflare.com/client/v4']
   */
  async writeCloudflareRecord({
    zoneId,
    apiToken,
    recordId = null,
    type = 'TXT',
    name,
    content = '',
    srvData = null,
    ttl = 60,
    apiBase = 'https://api.cloudflare.com/client/v4'
  }) {
    if (!this.fetchImpl) throw new Error('fetch unavailable');
    const url = recordId
      ? `${apiBase}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`
      : `${apiBase}/zones/${encodeURIComponent(zoneId)}/dns_records`;
    const body = {
      type,
      name,
      ttl: Math.max(30, Number(ttl) || 60)
    };
    if (type === 'SRV' && srvData) {
      body.data = {
        priority: Number(srvData.priority ?? 10),
        weight: Number(srvData.weight ?? 10),
        port: Number(srvData.port ?? 443),
        target: String(srvData.target)
      };
    } else {
      body.content = String(content);
    }
    this.admission.reserve('refresh', { requests: 1, transferBytes: wireBytes(url) + wireBytes(body) + this.maxResponseBytes });
    const res = await this.fetchImpl(url, {
      method: recordId ? 'PUT' : 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const json = res.body?.getReader || res.text
      ? JSON.parse(await readBoundedText(res, this.maxResponseBytes)) : await res.json();
    return {
      ok: Boolean(json?.success),
      id: json?.result?.id || recordId,
      name,
      type,
      ttl: body.ttl,
      errors: json?.errors || []
    };
  }

  /**
   * Claim C2: Measure how long it takes for a newly published SRV/TXT target to become visible via DoH,
   * testing the pre-registered falsifier (staleness > 2x TTL).
   */
  async measurePointerStaleness({
    name,
    type = 'TXT',
    expectedSubstring,
    ttlSeconds = 60,
    pollIntervalMs = 1000,
    maxWaitMs = 150000
  }) {
    const startMs = performance.now();
    let polls = 0;
    while (performance.now() - startMs <= maxWaitMs) {
      polls++;
      const res = await this.resolve(name, type);
      const rawJson = JSON.stringify(res.records);
      if (rawJson.includes(expectedSubstring)) {
        const stalenessSec = Number(((performance.now() - startMs) / 1000).toFixed(2));
        return {
          resolved: true,
          name,
          type,
          ttl_seconds: ttlSeconds,
          staleness_sec: stalenessSec,
          staleness_to_ttl_ratio: Number((stalenessSec / ttlSeconds).toFixed(3)),
          c2_within_2x_ttl: stalenessSec <= 2 * ttlSeconds,
          polls
        };
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    const stalenessSec = Number(((performance.now() - startMs) / 1000).toFixed(2));
    return {
      resolved: false,
      name,
      type,
      ttl_seconds: ttlSeconds,
      staleness_sec: stalenessSec,
      staleness_to_ttl_ratio: Number((stalenessSec / ttlSeconds).toFixed(3)),
      c2_within_2x_ttl: false,
      polls
    };
  }
}

/**
 * Objective O5: Pre-registered JSONL Experiment Trial Logger for C1-C8 falsification runs.
 */
export class ExperimentTrialLogger {
  constructor({ contractVersion = '1.0.0' } = {}) {
    this.contractVersion = contractVersion;
    this.entries = [];
  }

  logTrial(claimId, data) {
    const entry = {
      ts_iso: new Date().toISOString(),
      contract_version: this.contractVersion,
      claim_id: claimId,
      ...data
    };
    this.entries.push(entry);
    return entry;
  }

  summarizeC1(networkPairClass = null) {
    const c1 = this.entries.filter(
      e => e.claim_id === 'C1' && (!networkPairClass || e.network_pair_class === networkPairClass)
    );
    if (c1.length === 0) {
      return { trials: 0, direct_success_rate: 0, median_ice_setup_sec: 0, c1_status: 'UNTESTED' };
    }
    const successes = c1.filter(e => e.success && !e.used_turn).length;
    const directSuccessRate = Number((successes / c1.length).toFixed(3));
    const sortedIce = c1
      .filter(e => typeof e.ice_setup_sec === 'number')
      .map(e => e.ice_setup_sec)
      .sort((a, b) => a - b);
    const medianIce = sortedIce.length > 0 ? sortedIce[Math.floor(sortedIce.length / 2)] : 0;
    const c1Status = c1.length < 30
      ? 'INCOMPLETE_N_LT_30'
      : (directSuccessRate >= 0.60 && medianIce <= 10.0 ? 'VERIFIED' : 'REFUTED');
    return {
      trials: c1.length,
      direct_success_rate: directSuccessRate,
      median_ice_setup_sec: Number(medianIce.toFixed(2)),
      c1_status: c1Status
    };
  }

  toJsonl() {
    return this.entries.map(e => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
  }
}

/**
 * Multi-Peer WebRTC DataChannel Mesh + Warm Relay Cache (`ntfy.sh` ring buffer).
 * Supports N concurrent peers, binary/JSON replication, and raw Ethernet frame bridging for v86.
 */
export class WebRtcTransportNode {
  constructor(options = {}) {
    this.admission = options.admission ?? new ResourceAdmission();
    this.maxRelayResponseBytes = 2 * 1024 * 1024;
    this.maxDataMessageBytes = 512 * 1024;
    this.maxPeers = 64;
    this.peerId = options.peerId || ('node-' + Math.random().toString(36).slice(2, 8));
    this.channelKey = options.channelKey ?? 'syntra-uor-bus-01';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.networkPairClass = options.networkPairClass ?? 'declared-pair';
    this.trialLogger = options.trialLogger ?? null;
    this.onEvent = options.onEvent ?? (() => {});

    /** @type {Map<string, { pc: RTCPeerConnection, dc: RTCDataChannel | null, rttMs: number | null, lastSeenSec: number, startedAtMs: number, iceSetupSec: number | null, usedTurn: boolean, heartbeatsPassed: number, c1Logged: boolean }>} */
    this.peers = new Map();
    this.bc = null;
    this.ws = null;
    this.hbTimer = null;
    this.seq = 0;
    this.heartbeatTimestampsSec = [];
    this.bytesSent = 0;
    this.bytesReceived = 0;
  }

  emit(type, data = {}) {
    this.onEvent({
      type,
      peerId: this.peerId,
      connectedPeerCount: this.openPeers().length,
      tsMs: Date.now(),
      ...data
    });
  }

  signalTopic() {
    return 'syntra-sig-' + String(this.channelKey).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  warmCacheTopic() {
    return 'syntra-warm-' + String(this.channelKey).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  openPeers() {
    const out = [];
    for (const [remoteId, entry] of this.peers.entries()) {
      if (entry.dc && entry.dc.readyState === 'open') {
        out.push({ remoteId, ...entry });
      }
    }
    return out;
  }

  getOrCreatePeer(remoteId, initiator = false) {
    let entry = this.peers.get(remoteId);
    if (entry && entry.pc && entry.pc.connectionState !== 'closed' && entry.pc.connectionState !== 'failed') {
      return entry;
    }

    if (this.peers.size >= this.maxPeers) refuse('peer-capacity');
    this.admission.reserve('refresh', { requests: 1 });
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    entry = {
      pc,
      dc: null,
      rttMs: null,
      lastSeenSec: Date.now() / 1000,
      startedAtMs: performance.now(),
      iceSetupSec: null,
      usedTurn: false,
      heartbeatsPassed: 0,
      c1Logged: false
    };
    this.peers.set(remoteId, entry);

    pc.onicecandidate = e => {
      if (e.candidate) {
        const raw = e.candidate.candidate || '';
        const candidateType = raw.includes(' typ relay ')
          ? 'relay'
          : raw.includes(' typ srflx ')
          ? 'srflx'
          : 'host';
        if (candidateType === 'relay') entry.usedTurn = true;
        this.emit('ice_candidate', { remoteId, candidateType });
        this.sendSignal({ kind: 'ice', to: remoteId, candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState || 'closed';
      this.emit('ice_state', { remoteId, state });
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        if (!entry.c1Logged && this.trialLogger) {
          entry.c1Logged = true;
          this.trialLogger.logTrial('C1', {
            remote_peer: remoteId,
            network_pair_class: this.networkPairClass,
            success: false,
            used_turn: entry.usedTurn,
            ice_setup_sec: entry.iceSetupSec ?? Number(((performance.now() - entry.startedAtMs) / 1000).toFixed(2)),
            heartbeats_passed: entry.heartbeatsPassed,
            reason: `ice_${state}`
          });
        }
        this.peers.delete(remoteId);
        this.emit('peer_disconnected', { remoteId, state });
      }
    };

    pc.ondatachannel = e => {
      this.bindDataChannel(remoteId, e.channel);
    };

    if (initiator) {
      const dc = pc.createDataChannel('uor-mesh', { ordered: true });
      this.bindDataChannel(remoteId, dc);
    }

    return entry;
  }

  bindDataChannel(remoteId, channel) {
    const entry = this.peers.get(remoteId);
    if (entry) entry.dc = channel;

    channel.onopen = () => {
      if (entry && entry.iceSetupSec === null) {
        entry.iceSetupSec = Number(((performance.now() - entry.startedAtMs) / 1000).toFixed(2));
      }
      this.emit('channel_open', { remoteId, label: channel.label, iceSetupSec: entry?.iceSetupSec ?? 0 });
      this.startHeartbeat();
    };

    channel.onclose = () => {
      this.peers.delete(remoteId);
      this.emit('channel_close', { remoteId });
    };

    channel.onmessage = e => {
      const rawLen = typeof e.data === 'string' ? e.data.length : (e.data?.byteLength || 0);
      this.bytesReceived += rawLen;
      try {
        if (rawLen > this.maxDataMessageBytes) return;
        const msg = JSON.parse(e.data);
        this.handleDataMessage(remoteId, msg);
      } catch {
        // Ignore malformed frame
      }
    };
  }

  handleDataMessage(remoteId, msg) {
    const nowMs = Date.now();
    const entry = this.peers.get(remoteId);
    if (entry) entry.lastSeenSec = nowMs / 1000;

    if (msg.type === 'ping') {
      this.sendToPeer(remoteId, {
        type: 'pong',
        seq: msg.seq,
        sentAtMs: msg.sentAtMs,
        from: this.peerId
      });
      this.recordHeartbeat(remoteId, nowMs, null);
    } else if (msg.type === 'pong') {
      const rttMs = msg.sentAtMs ? nowMs - msg.sentAtMs : null;
      if (entry && rttMs !== null) entry.rttMs = rttMs;
      this.recordHeartbeat(remoteId, nowMs, rttMs);
    } else {
      // Forward application payload (uor_shard, uor_sync_req, compute_task, compute_ckpt, eth_frame)
      this.emit('mesh_message', { from: remoteId, msg });
    }
  }

  recordHeartbeat(remoteId, nowMs, rttMs) {
    const nowSec = nowMs / 1000;
    this.heartbeatTimestampsSec.push(nowSec);
    if (this.heartbeatTimestampsSec.length > 64) this.heartbeatTimestampsSec.shift();
    const entry = this.peers.get(remoteId);
    if (entry) {
      entry.heartbeatsPassed++;
      if (!entry.c1Logged && entry.heartbeatsPassed >= 10) {
        entry.c1Logged = true;
        const c1Payload = {
          remote_peer: remoteId,
          network_pair_class: this.networkPairClass,
          success: (entry.iceSetupSec ?? 0) <= 10.0 && !entry.usedTurn,
          used_turn: entry.usedTurn,
          ice_setup_sec: entry.iceSetupSec ?? 0,
          heartbeats_passed: entry.heartbeatsPassed
        };
        if (this.trialLogger) this.trialLogger.logTrial('C1', c1Payload);
        this.emit('c1_trial_complete', c1Payload);
      }
    }
    this.emit('heartbeat', {
      remoteId,
      count: this.heartbeatTimestampsSec.length,
      rttMs,
      timestampSec: nowSec
    });
  }

  startHeartbeat() {
    if (this.hbTimer) return;
    this.hbTimer = setInterval(() => {
      this.seq++;
      const now = Date.now();
      this.broadcast({ type: 'ping', seq: this.seq, sentAtMs: now, from: this.peerId });
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  sendToPeer(remoteId, payloadObj) {
    const entry = this.peers.get(remoteId);
    if (!entry || !entry.dc || entry.dc.readyState !== 'open') return false;
    const raw = JSON.stringify(payloadObj);
    reserveNetwork(this.admission, 'place', raw);
    entry.dc.send(raw);
    this.bytesSent += raw.length;
    return true;
  }

  broadcast(payloadObj) {
    const raw = JSON.stringify(payloadObj);
    let sentCount = 0;
    for (const { dc } of this.openPeers()) {
      try {
        reserveNetwork(this.admission, 'place', raw);
        dc.send(raw);
        this.bytesSent += raw.length;
        sentCount++;
      } catch {}
    }
    return sentCount;
  }

  /**
   * Publish a state/shard envelope into the public warm relay ring-buffer (`ntfy.sh`)
   * so newly opened browsers can recover state even after a 0-peer gap (all tabs closed).
   */
  async publishWarmEnvelope(envelopeObj) {
    if (typeof fetch === 'undefined') return false;
    try {
      const raw = JSON.stringify({ ...envelopeObj, from: this.peerId, tsMs: Date.now() });
      reserveNetwork(this.admission, 'place', raw);
      this.bytesSent += raw.length;
      const res = await fetch(`https://ntfy.sh/${this.warmCacheTopic()}`, {
        method: 'POST',
        body: raw
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Poll the warm relay ring-buffer (`?poll=1&since=30m`) to recover shards/checkpoints
   * that were published before all previous browsers closed.
   */
  async fetchWarmEnvelopes(sinceWindow = '30m') {
    if (typeof fetch === 'undefined') return [];
    try {
      const url = `https://ntfy.sh/${this.warmCacheTopic()}/json?poll=1&since=${encodeURIComponent(sinceWindow)}`;
      this.admission.reserve('retrieve', { requests: 1, transferBytes: wireBytes(url) + this.maxRelayResponseBytes });
      const res = await fetch(url);
      if (!res.ok) return [];
      const text = await readBoundedText(res, this.maxRelayResponseBytes);
      const lines = text.split('\n').filter(Boolean);
      const envelopes = [];
      for (const line of lines) {
        try {
          const outer = JSON.parse(line);
          if (outer.event === 'message' && outer.message) {
            const inner = JSON.parse(outer.message);
            envelopes.push(inner);
          }
        } catch {}
      }
      return envelopes;
    } catch {
      return [];
    }
  }

  connect(channelKey = this.channelKey) {
    if (channelKey !== this.channelKey) {
      // A new mesh must not keep sending object/VM bytes to the old mesh.
      for (const { pc, dc } of [...this.peers.values()]) { dc?.close(); pc?.close(); }
      this.peers.clear(); this.stopHeartbeat();
    }
    this.channelKey = channelKey;
    if (this.bc) this.bc.close();
    if (this.ws) this.ws.close();

    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(`uor:${this.channelKey}`);
      this.bc.onmessage = e => {
        if (e.data && e.data.from !== this.peerId) this.handleSignal(e.data);
      };
    }

    if (typeof WebSocket !== 'undefined') {
      const topic = this.signalTopic();
      try {
        this.admission.reserve('refresh', { requests: 1 });
        this.ws = new WebSocket(`wss://ntfy.sh/${topic}/ws`);
        this.ws.onopen = () => {
          this.emit('signaling_ready', { topic, channelKey: this.channelKey });
          this.sendSignal({ kind: 'announce' });
        };
        this.ws.onmessage = e => {
          try {
            if (typeof e.data !== 'string' || e.data.length > this.maxDataMessageBytes) return;
            const env = JSON.parse(e.data);
            if (env.event !== 'message' || !env.message) return;
            const msg = JSON.parse(env.message);
            if (msg && msg.from !== this.peerId) this.handleSignal(msg);
          } catch {}
        };
      } catch {
        this.sendSignal({ kind: 'announce' });
      }
    } else {
      this.sendSignal({ kind: 'announce' });
    }
  }

  sendSignal(payload) {
    const frame = { ...payload, from: this.peerId, channelKey: this.channelKey };
    try { reserveNetwork(this.admission, 'refresh', frame, (this.bc ? 1 : 0) + (typeof fetch !== 'undefined' ? 1 : 0)); }
    catch (error) { this.emit('policy_refused', { code: error.code || 'budget-exhausted' }); return false; }
    if (this.bc) this.bc.postMessage(frame);
    if (typeof fetch !== 'undefined') {
      fetch(`https://ntfy.sh/${this.signalTopic()}`, {
        method: 'POST',
        body: JSON.stringify(frame)
      }).catch(() => {});
    }
  }

  async handleSignal(msg) {
    if (msg.to && msg.to !== this.peerId) return;
    const remoteId = msg.from;
    if (!remoteId || remoteId === this.peerId) return;

    const existing = this.peers.get(remoteId);
    if (existing && existing.dc && existing.dc.readyState === 'open') {
      return;
    }

    if (msg.kind === 'announce') {
      const entry = this.getOrCreatePeer(remoteId, true);
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.sendSignal({ kind: 'offer', to: remoteId, sdp: entry.pc.localDescription });
    } else if (msg.kind === 'offer') {
      if (existing && existing.pc.signalingState === 'have-local-offer' && this.peerId < remoteId) {
        return; // Deterministic glare resolution
      }
      const entry = this.getOrCreatePeer(remoteId, false);
      await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      this.sendSignal({ kind: 'answer', to: remoteId, sdp: entry.pc.localDescription });
    } else if (msg.kind === 'answer') {
      if (existing && existing.pc.signalingState === 'have-local-offer') {
        await existing.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    } else if (msg.kind === 'ice' && msg.candidate) {
      if (existing && existing.pc.remoteDescription) {
        try {
          await existing.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {}
      }
    }
  }

  close() {
    this.stopHeartbeat();
    for (const { dc, pc } of this.peers.values()) {
      if (dc) dc.close();
      if (pc) pc.close();
    }
    this.peers.clear();
    if (this.bc) this.bc.close();
    if (this.ws) this.ws.close();
  }
}
