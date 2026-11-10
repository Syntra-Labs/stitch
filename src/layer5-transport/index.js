/**
 * @file src/layer5-transport/index.js
 * @description Layer 5: Live Multi-Peer WebRTC DataChannel Mesh, Warm Relay Ring-Buffer,
 * Layer-2 Ethernet Frame Bridge (for v86 Linux VMs), and RFC 8484 DoH + Lightweight DNS TXT Writer.
 */

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

export function formatPointerTxt({ peerId, endpoint, rootAddress, timestampSec = Math.floor(Date.now() / 1000) }) {
  return `v=uor1;peer=${peerId};ep=${endpoint};root=${rootAddress || '0'};ts=${timestampSec}`;
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
  }

  async resolve(name, type = 'SRV') {
    if (!this.fetchImpl) {
      throw new Error('fetch is not available in this runtime');
    }
    const t0 = performance.now();
    const url = `${this.endpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
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
      records: parsedRecords
    };
    this.history.push(record);
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
    const res = await this.fetchImpl(url);
    const text = (await res.text()).trim();
    return { ok: text === 'OK', response: text, fqdn: `${subdomain}.duckdns.org` };
  }
}

/**
 * Multi-Peer WebRTC DataChannel Mesh + Warm Relay Cache (`ntfy.sh` ring buffer).
 * Supports N concurrent peers, binary/JSON replication, and raw Ethernet frame bridging for v86.
 */
export class WebRtcTransportNode {
  constructor(options = {}) {
    this.peerId = options.peerId || ('node-' + Math.random().toString(36).slice(2, 8));
    this.channelKey = options.channelKey ?? 'syntra-uor-bus-01';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.onEvent = options.onEvent ?? (() => {});

    /** @type {Map<string, { pc: RTCPeerConnection, dc: RTCDataChannel | null, rttMs: number | null, lastSeenSec: number }>} */
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

    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    entry = { pc, dc: null, rttMs: null, lastSeenSec: Date.now() / 1000 };
    this.peers.set(remoteId, entry);

    pc.onicecandidate = e => {
      if (e.candidate) {
        const raw = e.candidate.candidate || '';
        const candidateType = raw.includes(' typ relay ')
          ? 'relay'
          : raw.includes(' typ srflx ')
          ? 'srflx'
          : 'host';
        this.emit('ice_candidate', { remoteId, candidateType });
        this.sendSignal({ kind: 'ice', to: remoteId, candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState || 'closed';
      this.emit('ice_state', { remoteId, state });
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
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
      this.emit('channel_open', { remoteId, label: channel.label });
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
    entry.dc.send(raw);
    this.bytesSent += raw.length;
    return true;
  }

  broadcast(payloadObj) {
    const raw = JSON.stringify(payloadObj);
    let sentCount = 0;
    for (const { dc } of this.openPeers()) {
      try {
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
      const res = await fetch(`https://ntfy.sh/${this.warmCacheTopic()}/json?poll=1&since=${encodeURIComponent(sinceWindow)}`);
      if (!res.ok) return [];
      const text = await res.text();
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
        this.ws = new WebSocket(`wss://ntfy.sh/${topic}/ws`);
        this.ws.onopen = () => {
          this.emit('signaling_ready', { topic, channelKey: this.channelKey });
          this.sendSignal({ kind: 'announce' });
        };
        this.ws.onmessage = e => {
          try {
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
