/**
 * @file peer.js
 * @description Two-peer WebRTC DataChannel stitch runtime with zero-backend
 * cross-Internet signaling (ntfy.sh WebSocket rendezvous + BroadcastChannel +
 * portable SDP fallback), 5s liveness heartbeats, and ICE telemetry.
 */

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

/**
 * StitchPeer manages a WebRTC DataChannel ("stitch") and emits liveness heartbeats
 * and transport telemetry to drive the entropy refresh clock.
 */
export class StitchPeer {
  /**
   * @param {object} [options]
   * @param {string} [options.stitchKey='syntra-default-stitch']
   * @param {number} [options.heartbeatIntervalMs=5000]
   * @param {(event: object) => void} [options.onTelemetry]
   */
  constructor(options = {}) {
    this.peerId = 'peer-' + Math.random().toString(36).slice(2, 8);
    this.stitchKey = options.stitchKey ?? 'syntra-default-stitch';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.onTelemetry = options.onTelemetry ?? (() => {});

    this.pc = null;
    this.channel = null;
    this.bc = null;
    this.ws = null;
    this.heartbeatTimer = null;
    this.seq = 0;
    this.pendingPings = new Map();
    this.heartbeatTimestampsSec = [];
    this.connectedAtMs = null;
    this.remotePeerId = null;
  }

  emit(type, detail = {}) {
    this.onTelemetry({
      type,
      peerId: this.peerId,
      remotePeerId: this.remotePeerId,
      timestampMs: Date.now(),
      ...detail
    });
  }

  /**
   * Initialize RTCPeerConnection and attach ICE / connection state listeners.
   */
  initPeerConnection() {
    if (this.pc) {
      this.pc.close();
    }

    this.pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });

    this.pc.onicecandidate = e => {
      if (e.candidate) {
        const candStr = e.candidate.candidate || '';
        const candidateType = candStr.includes(' typ relay ')
          ? 'relay (TURN)'
          : candStr.includes(' typ srflx ')
          ? 'srflx (STUN)'
          : 'host';
        this.emit('ice_candidate', { candidateType, raw: candStr });
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

    this.pc.ondatachannel = e => {
      this.attachDataChannel(e.channel);
    };

    return this.pc;
  }

  /**
   * Bind data channel lifecycle and heartbeat protocol.
   * @param {RTCDataChannel} dc
   */
  attachDataChannel(dc) {
    this.channel = dc;

    dc.onopen = () => {
      this.connectedAtMs = Date.now();
      this.emit('channel_open', { label: dc.label });
      this.startHeartbeat();
    };

    dc.onclose = () => {
      this.emit('channel_close', { label: dc.label });
      this.stopHeartbeat();
    };

    dc.onerror = err => {
      this.emit('channel_error', { message: err?.message || 'DataChannel error' });
    };

    dc.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        this.handleChannelMessage(msg);
      } catch {
        this.emit('raw_message', { data: e.data });
      }
    };
  }

  handleChannelMessage(msg) {
    const nowMs = Date.now();
    if (msg.type === 'ping') {
      this.remotePeerId = msg.from || this.remotePeerId;
      if (this.channel?.readyState === 'open') {
        this.channel.send(
          JSON.stringify({
            type: 'pong',
            seq: msg.seq,
            sentAtMs: msg.sentAtMs,
            from: this.peerId
          })
        );
      }
      this.recordHeartbeat(nowMs, null);
    } else if (msg.type === 'pong') {
      this.remotePeerId = msg.from || this.remotePeerId;
      const rttMs = msg.sentAtMs ? nowMs - msg.sentAtMs : null;
      this.pendingPings.delete(msg.seq);
      this.recordHeartbeat(nowMs, rttMs);
    } else if (msg.type === 'chat') {
      this.emit('peer_message', { from: msg.from, text: msg.text });
    }
  }

  recordHeartbeat(nowMs, rttMs) {
    const nowSec = nowMs / 1000;
    this.heartbeatTimestampsSec.push(nowSec);
    if (this.heartbeatTimestampsSec.length > 64) {
      this.heartbeatTimestampsSec.shift();
    }
    this.emit('heartbeat', {
      seq: this.seq,
      rttMs,
      totalHeartbeats: this.heartbeatTimestampsSec.length,
      timestampSec: nowSec
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.sendPing();
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendPing() {
    if (!this.channel || this.channel.readyState !== 'open') return;
    this.seq += 1;
    const sentAtMs = Date.now();
    this.pendingPings.set(this.seq, sentAtMs);
    this.channel.send(
      JSON.stringify({
        type: 'ping',
        seq: this.seq,
        sentAtMs,
        from: this.peerId
      })
    );
  }

  sendMessage(text) {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    this.channel.send(
      JSON.stringify({
        type: 'chat',
        from: this.peerId,
        text
      })
    );
    return true;
  }

  getRendezvousTopic() {
    const clean = String(this.stitchKey).replace(/[^a-zA-Z0-9_-]/g, '-');
    return `syntra-stitch-${clean}`;
  }

  /**
   * Join zero-setup rendezvous across both local tabs (BroadcastChannel)
   * and across the Internet via public WebSocket relay (ntfy.sh).
   */
  async startAutoStitch(stitchKey = this.stitchKey) {
    this.stitchKey = stitchKey;
    if (this.bc) {
      this.bc.close();
      this.bc = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // 1. Local same-browser tab rendezvous
    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(`stitch:${this.stitchKey}`);
      this.bc.onmessage = async e => {
        const msg = e.data;
        if (!msg || msg.from === this.peerId) return;
        await this.handleSignal(msg);
      };
    }

    // 2. Cross-network zero-backend WebSocket rendezvous (ntfy.sh)
    if (typeof WebSocket !== 'undefined') {
      const topic = this.getRendezvousTopic();
      try {
        this.ws = new WebSocket(`wss://ntfy.sh/${topic}/ws`);
        this.ws.onopen = () => {
          this.emit('signaling_ready', {
            mode: 'WebSocket (ntfy.sh) + BroadcastChannel',
            topic,
            stitchKey: this.stitchKey
          });
          this.sendSignal({ kind: 'announce' });
        };
        this.ws.onmessage = async e => {
          try {
            const envelope = JSON.parse(e.data);
            if (envelope.event !== 'message' || !envelope.message) return;
            const msg = JSON.parse(envelope.message);
            if (!msg || msg.from === this.peerId) return;
            await this.handleSignal(msg);
          } catch {
            // Ignore non-JSON keepalives
          }
        };
      } catch {
        this.emit('signaling_ready', { mode: 'BroadcastChannel only', stitchKey: this.stitchKey });
        this.sendSignal({ kind: 'announce' });
      }
    } else {
      this.sendSignal({ kind: 'announce' });
    }
  }

  sendSignal(payload) {
    const message = { ...payload, from: this.peerId, stitchKey: this.stitchKey };
    if (this.bc) {
      this.bc.postMessage(message);
    }
    if (typeof fetch !== 'undefined') {
      const topic = this.getRendezvousTopic();
      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: JSON.stringify(message)
      }).catch(() => {});
    }
  }

  async handleSignal(msg) {
    if (this.channel && this.channel.readyState === 'open') {
      return; // Already stitched
    }
    this.remotePeerId = msg.from;

    if (msg.kind === 'announce') {
      if (!this.pc || this.pc.connectionState === 'closed' || this.pc.connectionState === 'failed') {
        await this.initiateOffer();
      }
    } else if (msg.kind === 'offer') {
      // Polite/impolite tie-breaker if both peers sent offers simultaneously
      if (this.pc && this.pc.signalingState === 'have-local-offer') {
        if (this.peerId < msg.from) {
          return; // Wait for remote peer to accept our offer
        }
      }
      this.initPeerConnection();
      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignal({ kind: 'answer', sdp: this.pc.localDescription });
      this.emit('signal_answer_sent', { to: msg.from });
    } else if (msg.kind === 'answer') {
      if (this.pc && this.pc.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        this.emit('signal_answer_received', { from: msg.from });
      }
    } else if (msg.kind === 'ice' && msg.candidate) {
      if (this.pc && this.pc.remoteDescription) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {
          // Ignore benign candidate races
        }
      }
    }
  }

  async initiateOffer() {
    this.initPeerConnection();
    const dc = this.pc.createDataChannel('stitch', { ordered: true });
    this.attachDataChannel(dc);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ kind: 'offer', sdp: this.pc.localDescription });
    this.emit('signal_offer_sent', { stitchKey: this.stitchKey });
  }

  /**
   * Generate a self-contained portable SDP bundle (with gathered ICE candidates)
   * for zero-server cross-network connection via copy/paste or DNS TXT pointer.
   * @param {'offer' | 'answer'} role
   * @param {string} [remoteBundleBase64]
   * @returns {Promise<string>} Base64-encoded SDP bundle.
   */
  async createPortableBundle(role = 'offer', remoteBundleBase64 = '') {
    if (role === 'offer') {
      this.initPeerConnection();
      const dc = this.pc.createDataChannel('stitch', { ordered: true });
      this.attachDataChannel(dc);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
    } else {
      this.initPeerConnection();
      const remoteDesc = JSON.parse(atob(remoteBundleBase64.trim()));
      await this.pc.setRemoteDescription(new RTCSessionDescription(remoteDesc));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
    }

    await new Promise(resolve => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timeout = setTimeout(resolve, 1500);
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    return btoa(JSON.stringify(this.pc.localDescription));
  }

  async acceptPortableAnswer(answerBundleBase64) {
    if (!this.pc) throw new Error('No active peer connection waiting for answer.');
    const remoteDesc = JSON.parse(atob(answerBundleBase64.trim()));
    await this.pc.setRemoteDescription(new RTCSessionDescription(remoteDesc));
    this.emit('portable_answer_accepted');
  }

  close() {
    this.stopHeartbeat();
    if (this.channel) this.channel.close();
    if (this.pc) this.pc.close();
    if (this.bc) this.bc.close();
    if (this.ws) this.ws.close();
  }
}
