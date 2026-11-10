/**
 * @file src/layer5-transport/index.js
 * @description Layer 5: Network & DNS Control-Plane Adapters.
 * Isolates RFC 8484 DNS-over-HTTPS (SRV/TXT) resolution and WebRTC DataChannel peer transport.
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
}

export class WebRtcTransportNode {
  constructor(options = {}) {
    this.peerId = 'node-' + Math.random().toString(36).slice(2, 8);
    this.channelKey = options.channelKey ?? 'syntra-uor-bus';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.onEvent = options.onEvent ?? (() => {});

    this.pc = null;
    this.dc = null;
    this.bc = null;
    this.ws = null;
    this.hbTimer = null;
    this.seq = 0;
    this.remotePeerId = null;
    this.heartbeatTimestampsSec = [];
  }

  emit(type, data = {}) {
    this.onEvent({ type, peerId: this.peerId, remotePeerId: this.remotePeerId, tsMs: Date.now(), ...data });
  }

  topicName() {
    return 'syntra-uor-' + String(this.channelKey).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  initPeerConnection() {
    if (this.pc) this.pc.close();
    this.pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });

    this.pc.onicecandidate = e => {
      if (e.candidate) {
        const raw = e.candidate.candidate || '';
        const candidateType = raw.includes(' typ relay ')
          ? 'relay'
          : raw.includes(' typ srflx ')
          ? 'srflx'
          : 'host';
        this.emit('ice_candidate', { candidateType });
        this.sendSignal({ kind: 'ice', candidate: e.candidate });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState || 'closed';
      this.emit('ice_state', { state });
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.stopHeartbeat();
      }
    };

    this.pc.ondatachannel = e => this.bindDataChannel(e.channel);
    return this.pc;
  }

  bindDataChannel(channel) {
    this.dc = channel;
    channel.onopen = () => {
      this.emit('channel_open', { label: channel.label });
      this.startHeartbeat();
    };
    channel.onclose = () => {
      this.emit('channel_close');
      this.stopHeartbeat();
    };
    channel.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        this.handleDataMessage(msg);
      } catch {
        // Ignore malformed frame
      }
    };
  }

  handleDataMessage(msg) {
    const nowMs = Date.now();
    if (msg.type === 'ping') {
      this.remotePeerId = msg.from || this.remotePeerId;
      if (this.dc?.readyState === 'open') {
        this.dc.send(JSON.stringify({ type: 'pong', seq: msg.seq, sentAtMs: msg.sentAtMs, from: this.peerId }));
      }
      this.recordHeartbeat(nowMs, null);
    } else if (msg.type === 'pong') {
      this.remotePeerId = msg.from || this.remotePeerId;
      const rttMs = msg.sentAtMs ? nowMs - msg.sentAtMs : null;
      this.recordHeartbeat(nowMs, rttMs);
    } else if (msg.type === 'uor_replicate') {
      this.emit('uor_replicate', { from: msg.from, addressHex: msg.addressHex, bytes: new Uint8Array(msg.bytes) });
    }
  }

  recordHeartbeat(nowMs, rttMs) {
    const nowSec = nowMs / 1000;
    this.heartbeatTimestampsSec.push(nowSec);
    if (this.heartbeatTimestampsSec.length > 64) this.heartbeatTimestampsSec.shift();
    this.emit('heartbeat', {
      count: this.heartbeatTimestampsSec.length,
      rttMs,
      timestampSec: nowSec
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.sendPing();
    this.hbTimer = setInterval(() => this.sendPing(), this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  sendPing() {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.seq++;
    this.dc.send(JSON.stringify({ type: 'ping', seq: this.seq, sentAtMs: Date.now(), from: this.peerId }));
  }

  replicateUorObject(addressHex, uint8Bytes) {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    this.dc.send(JSON.stringify({
      type: 'uor_replicate',
      from: this.peerId,
      addressHex,
      bytes: Array.from(uint8Bytes)
    }));
    return true;
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
      const topic = this.topicName();
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
      fetch(`https://ntfy.sh/${this.topicName()}`, {
        method: 'POST',
        body: JSON.stringify(frame)
      }).catch(() => {});
    }
  }

  async handleSignal(msg) {
    if (this.dc && this.dc.readyState === 'open') return;
    this.remotePeerId = msg.from;

    if (msg.kind === 'announce') {
      if (!this.pc || this.pc.connectionState === 'closed' || this.pc.connectionState === 'failed') {
        this.initPeerConnection();
        const dc = this.pc.createDataChannel('uor-data', { ordered: true });
        this.bindDataChannel(dc);
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.sendSignal({ kind: 'offer', sdp: this.pc.localDescription });
      }
    } else if (msg.kind === 'offer') {
      if (this.pc && this.pc.signalingState === 'have-local-offer' && this.peerId < msg.from) {
        return;
      }
      this.initPeerConnection();
      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignal({ kind: 'answer', sdp: this.pc.localDescription });
    } else if (msg.kind === 'answer') {
      if (this.pc && this.pc.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    } else if (msg.kind === 'ice' && msg.candidate) {
      if (this.pc && this.pc.remoteDescription) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {}
      }
    }
  }

  close() {
    this.stopHeartbeat();
    if (this.dc) this.dc.close();
    if (this.pc) this.pc.close();
    if (this.bc) this.bc.close();
    if (this.ws) this.ws.close();
  }
}
