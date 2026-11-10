/**
 * @file pointer.js
 * @description Browser-native DNS SRV/TXT pointer resolution over RFC 8484 DoH,
 * TTL cache-expiry inference, and pointer record formatting for stitch.
 */

const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/**
 * Parse a stitch TXT record string of the form:
 *   "v=stitch1;peer=<pubkey>;ep=<host:port>;ts=<unix_sec>;sig=<hex>"
 * @param {string} rawTxt
 * @returns {Record<string, string>}
 */
export function parsePointerTxt(rawTxt) {
  const cleaned = String(rawTxt).replace(/^"+|"+$/g, '').trim();
  const pairs = cleaned.split(';');
  const out = {};
  for (const part of pairs) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = v;
    }
  }
  return out;
}

/**
 * Serialize a stitch pointer record into a DNS TXT payload string.
 * @param {object} fields
 * @param {string} fields.peer - Peer public key or stitch handle.
 * @param {string} fields.ep - Rendezvous or direct endpoint.
 * @param {number} [fields.ts] - Unix timestamp in seconds.
 * @param {string} [fields.sig] - Optional hex signature over (peer|ep|ts).
 * @returns {string}
 */
export function formatPointerTxt({ peer, ep, ts = Math.floor(Date.now() / 1000), sig = '' }) {
  const parts = [`v=stitch1`, `peer=${peer}`, `ep=${ep}`, `ts=${ts}`];
  if (sig) {
    parts.push(`sig=${sig}`);
  }
  return parts.join(';');
}

/**
 * Parse a DNS SRV Answer `data` string ("priority weight port target").
 * @param {string} srvData
 * @returns {{priority: number, weight: number, port: number, target: string} | null}
 */
export function parseSrvData(srvData) {
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
 * Browser-compatible DNS-over-HTTPS pointer observer that tracks TTL decay
 * and infers cache hits vs. fresh authoritative resolutions.
 */
export class DnsPointerObserver {
  /**
   * @param {object} [options]
   * @param {string} [options.dohEndpoint]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.dohEndpoint = options.dohEndpoint ?? DEFAULT_DOH_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.history = [];
  }

  /**
   * Resolve a DNS record (`SRV` or `TXT`) via DoH and record survival telemetry.
   * @param {string} name - e.g. "_stitch._udp.example.net"
   * @param {'SRV' | 'TXT'} [type='SRV']
   */
  async resolve(name, type = 'SRV') {
    if (!this.fetchImpl) {
      throw new Error('No fetch implementation available for DoH resolution.');
    }

    const startMs = performance.now();
    const url = `${this.dohEndpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/dns-json' }
    });

    if (!response.ok) {
      throw new Error(`DoH query failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    const latencyMs = performance.now() - startMs;
    const resolvedAtMs = Date.now();

    const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
    const ttlSeconds = answers.length > 0
      ? Math.min(...answers.map(a => Number(a.TTL) || 30))
      : 30;

    const records = answers.map(a => {
      if (type === 'SRV') return parseSrvData(a.data);
      if (type === 'TXT') return parsePointerTxt(a.data);
      return a.data;
    }).filter(Boolean);

    const prev = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    let inferredCacheHit = false;
    if (prev && prev.name === name && prev.type === type && ttlSeconds < prev.ttlSeconds) {
      inferredCacheHit = true;
    }

    const entry = {
      name,
      type,
      status: payload.Status ?? 0,
      ttlSeconds,
      latencyMs: Math.round(latencyMs * 10) / 10,
      resolvedAtMs,
      records,
      inferredCacheHit
    };

    this.history.push(entry);
    return entry;
  }
}
