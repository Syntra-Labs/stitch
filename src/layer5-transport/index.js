import { SignalSession } from './signaling.js';
/**
 * @file src/layer5-transport/index.js
 * @description Layer 5: Live Multi-Peer WebRTC DataChannel Mesh, Warm Relay Ring-Buffer,
 * Layer-2 Ethernet Frame Bridge (for v86 Linux VMs), and RFC 8484 DoH + Lightweight DNS TXT Writer.
 */

import { ResourceAdmission, wireBytes } from '../layer2-schedulers/policy.js';
import { refuse } from '../layer1-uor/contracts.js';
import { parseCanonicalJson } from '../layer1-uor/custody.js';
import { queryDnsMessage } from './dns-wire.js';
import { captureTransport, transportCanSend, transportSessionCurrent, transportPeerCurrent, transportChannelCurrent,
  transportSignalAllowed, transportPeerAllocationAllowed, closeTransport, openTransport,
  observeC1Probe, c1ConnectionQualified, c1DirectSuccess, c1SampleQualified, c1SampleStructurallyValid } from '../layer1-uor/effects.js';

import { ChannelFlow, CHANNEL_PROTOCOL } from './channel-flow.js';

import { RELAY_EVENT_BYTES, RELAY_LIMITS, RelayReassembler, snapshotRelayMessage, frameRelayMessage,
  newRelaySession, relayCapacity, relayAdmissionAllowed, relayEffectAllowed } from './relay-framing.js';

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

// Snapshot a bounded, ordinary RTCIceServer list before asynchronous connection
// setup. An explicit empty list supports a host-only local mesh. Credentials are
// passed only to the browser's RTC implementation, never emitted as events.
function iceServerConfiguration(servers) {
  if (!Array.isArray(servers) || servers.length > 16) throw new TypeError('Invalid ICE server configuration');
  return servers.map(server => {
    if (!server || typeof server !== 'object' || Array.isArray(server)
      || Object.keys(server).some(key => !['urls', 'username', 'credential'].includes(key))) throw new TypeError('Invalid ICE server configuration');
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 16
      || urls.some(url => typeof url !== 'string' || url.length > 2048 || !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))) throw new TypeError('Invalid ICE server configuration');
    const result = { urls: [...urls] };
    for (const key of ['username', 'credential']) if (server[key] !== undefined) {
      if (typeof server[key] !== 'string' || server[key].length > 2048) throw new TypeError('Invalid ICE server configuration');
      result[key] = server[key];
    }
    return result;
  });
}

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

const DNS_TYPES = Object.freeze({ A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, DS: 43, RRSIG: 46, DNSKEY: 48, TLSA: 52, SVCB: 64, HTTPS: 65, ANY: 255, CAA: 257 });
const dnsName = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 254 || /[^A-Za-z0-9_.-]/.test(value)) refuse('dns-invalid-name');
  if (value === '.') return '.';
  const name = value.endsWith('.') ? value.slice(0, -1) : value;
  if (name.length > 253 || name.split('.').some(label => label.length === 0 || label.length > 63)) refuse('dns-invalid-name');
  return name.toLowerCase();
};
export function parseSrvRecord(srvData) {
  if (typeof srvData !== 'string') return null;
  const parts = srvData.trim().split(/\s+/);
  if (parts.length !== 4 || parts.slice(0, 3).some(part => !/^\d+$/.test(part) || Number(part) > 65535)) return null;
  let target;
  try { target = dnsName(parts[3]); } catch { return null; }
  // RFC2782 root target means the service is unavailable, not an empty host.
  if (target !== '.' && target.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return { priority: Number(parts[0]), weight: Number(parts[1]), port: Number(parts[2]), target };
}

/** Validate and associate the provider's JSON projection. This does not decode
 * RFC8484 DNS wire messages or establish DNSSEC authentication/cache semantics.
 */
export function associateDnsJson(body, name, typeCode) {
  const query = dnsName(name);
  if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.Status) || body.Status !== 0) refuse('dns-response-status');
  if (body.TC !== undefined && body.TC !== false) refuse('dns-response-truncated');
  if (body.Question !== undefined && (!Array.isArray(body.Question) || body.Question.length !== 1
    || dnsName(body.Question[0]?.name) !== query || body.Question[0]?.type !== typeCode)) refuse('dns-question-mismatch');
  if (body.Answer !== undefined && !Array.isArray(body.Answer)) refuse('dns-invalid-answer');
  const answers = body.Answer ?? [];
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object' || !Number.isSafeInteger(answer.type) || answer.type < 1 || answer.type > 65535
      || !Number.isSafeInteger(answer.TTL) || answer.TTL < 0 || answer.TTL > 2147483647 || typeof answer.data !== 'string'
      || (answer.class !== undefined && answer.class !== 1) || (answer.Class !== undefined && answer.Class !== 1)) refuse('dns-invalid-answer');
    dnsName(answer.name);
  }
  let terminal = query;
  const path = new Set([query]), chain = [];
  if (typeCode !== DNS_TYPES.CNAME) {
    for (;;) {
      const aliases = answers.filter(answer => answer.type === DNS_TYPES.CNAME && dnsName(answer.name) === terminal);
      if (aliases.length === 0) break;
      const targets = new Set(aliases.map(answer => dnsName(answer.data)));
      if (targets.size !== 1 || aliases.length !== 1) refuse('dns-cname-conflict');
      terminal = [...targets][0];
      if (path.has(terminal)) refuse('dns-cname-cycle');
      path.add(terminal); chain.push(aliases[0]);
    }
  }
  const selected = answers.filter(answer => dnsName(answer.name) === terminal && (typeCode === DNS_TYPES.ANY || answer.type === typeCode));
  // Do not turn unrelated owners/types or an alias/data conflict into evidence
  // of absence. Additional-section processing is a separate DNS wire concern.
  if (answers.some(answer => !chain.includes(answer) && !selected.includes(answer))) refuse('dns-answer-mismatch');
  return { selected, ttlSeconds: answers.length ? Math.min(...answers.map(answer => answer.TTL)) : 0 };
}

/**
 * RFC8484 DNS-message lookup + scoped Cloudflare TXT writer.
 * Explicit format:"json" retains the separate provider-specific legacy API.
 */
export class DohResolver {
  constructor(options = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_DOH_ENDPOINT;
    this.format = options.format ?? "wire";
    this.method = options.method ?? "POST";
    if (!["wire", "json"].includes(this.format)) refuse("dns-query-format");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.history = [];
    this.admission = options.admission ?? new ResourceAdmission();
    this.maxResponseBytes = 128 * 1024;
  }

  async resolve(name, type = 'SRV') {
    if (this.format === 'wire') {
      const result = await queryDnsMessage({ name, type, endpoint: this.endpoint,
        method: this.method, fetchImpl: this.fetchImpl, admission: this.admission });
      const record = { name, type, status: result.status, ttl_seconds: result.ttlSeconds,
        rtt_ms: result.rttMs, cache_hit_inferred: false, http_age_seconds: result.httpAgeSeconds,
        negative: result.negative, authenticated_data: result.authenticatedData,
        dnssec_validated_by_client: false,
        rawRecords: result.selected.map(r => r.text ?? r.data),
        records: result.selected.map(r => r.srv ?? (r.type === 16 ? parsePointerTxt(r.text ?? r.data) : r.data)) };
      this.history.push(record); if (this.history.length > 128) this.history.shift();
      return record;
    }
    if (!this.fetchImpl) {
      throw new Error('fetch is not available in this runtime');
    }
    const queryName = dnsName(name);
    const typeName = typeof type === 'string' ? type.toUpperCase() : type;
    const typeCode = DNS_TYPES[typeName] ?? (/^\d+$/.test(String(typeName)) ? Number(typeName) : 0);
    if (!Number.isSafeInteger(typeCode) || typeCode < 1 || typeCode > 65535) refuse('dns-query-type');
    const t0 = performance.now();
    const url = `${this.endpoint}?name=${encodeURIComponent(queryName)}&type=${encodeURIComponent(typeCode)}`;
    this.admission.reserve('retrieve', { requests: 1, transferBytes: wireBytes(url) + this.maxResponseBytes });
    const res = await this.fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = res.body?.getReader || res.text
      ? JSON.parse(await readBoundedText(res, this.maxResponseBytes)) : await res.json();
    const rttMs = Number((performance.now() - t0).toFixed(1));
    const { selected: answers, ttlSeconds } = associateDnsJson(body, queryName, typeCode);

    const prev = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    const cacheHitInferred = Boolean(
      prev && prev.name === name && prev.type === type && ttlSeconds > 0 && ttlSeconds < prev.ttlSeconds
    );

    const parsedRecords = answers.map(a => {
      if (typeCode === DNS_TYPES.SRV) { const record = parseSrvRecord(a.data); if (!record) refuse('dns-invalid-srv'); return record; }
      if (typeCode === DNS_TYPES.TXT) return parsePointerTxt(a.data);
      return a.data;
    }).filter(Boolean);

    const record = {
      name,
      type,
      status: body.Status,
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

  /** Exact scoped lookup. An incomplete listing is never evidence of absence. */
  async listCloudflareRecords({ zoneId, apiToken, name, apiBase = 'https://api.cloudflare.com/client/v4' }) {
    if (!this.fetchImpl) throw new Error('fetch unavailable');
    const url = `${apiBase}/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&name=${encodeURIComponent(name)}&match=all&page=1&per_page=100`;
    this.admission.reserve('retrieve', { requests: 1, transferBytes: wireBytes(url) + this.maxResponseBytes });
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${apiToken}` } });
    const json = JSON.parse(await readBoundedText(res, this.maxResponseBytes));
    if (!res.ok || json?.success !== true || !Array.isArray(json.result)) refuse('dns-lookup-failed');
    const info = json.result_info;
    if (!info || info.page !== 1 || !Number.isSafeInteger(info.total_count) || info.total_count < 0
      || !Number.isSafeInteger(info.total_pages) || info.total_pages < 0 || info.total_pages > 1
      || info.count !== json.result.length || info.total_count !== json.result.length) refuse('dns-listing-incomplete');
    if (json.result.length > 1) refuse('dns-record-conflict');
    for (const record of json.result) {
      if (record.type !== 'TXT' || record.name !== name || typeof record.content !== 'string'
        || typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)) refuse('dns-record-conflict');
    }
    return json.result.map(({ id, name, type, content }) => ({ id, name, type, content }));
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
    let url, body;
    try {
      if (!this.fetchImpl) throw new Error('fetch unavailable');
      url = recordId
        ? `${apiBase}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`
        : `${apiBase}/zones/${encodeURIComponent(zoneId)}/dns_records`;
      body = {
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
    } catch (cause) {
      const error = new Error(cause.message, { cause });
      error.code = cause.code;
      // A host adapter fact, set only before fetch invocation. No provider
      // failure, timeout or lost response is classified as definite non-dispatch.
      error.effectDispatched = false;
      throw error;
    }
    // Only pre-dispatch validation/admission errors throw. Once attempted, a lost
    // or malformed response is uncertainty, never evidence that no write occurred.
    try {
      const res = await this.fetchImpl(url, {
        method: recordId ? 'PUT' : 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = res.body?.getReader || res.text
        ? JSON.parse(await readBoundedText(res, this.maxResponseBytes)) : await res.json();
      if (json?.success === false && [400, 401, 403, 404, 422].includes(res.status)) return { ok: false, outcome: 'refused', errors: json.errors || [] };
      if (json?.success === false) return { ok: false, outcome: 'unknown' };
      if (!res.ok || json?.success !== true || typeof json?.result?.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(json.result.id)
        || (recordId && json.result.id !== recordId)) return { ok: false, outcome: 'unknown' };
      return { ok: true, outcome: 'published', id: json.result.id, name, type, ttl: body.ttl, errors: [] };
    } catch {
      return { ok: false, outcome: 'unknown' };
    }
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
  constructor({ contractVersion = '1.1.0' } = {}) {
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
    const rows = this.entries.filter(
      e => e.claim_id === 'C1' && e.contract_version === '1.1.0' && (!networkPairClass || e.network_pair_class === networkPairClass)
    );
    const c1 = rows.filter(c1SampleStructurallyValid), invalidSamples = rows.length - c1.length;
    if (c1.length === 0) {
      return { trials: 0, invalid_samples: invalidSamples, direct_success_rate: 0, median_ice_setup_sec: null,
        c1_status: invalidSamples ? 'INSUFFICIENT_EVIDENCE' : 'UNTESTED' };
    }
    const successes = c1.filter(e => e.success === true && c1SampleQualified(e)).length;
    const directSuccessRate = Number((successes / c1.length).toFixed(3));
    const sortedIce = c1.map(e => e.ice_setup_sec === null ? Infinity : e.ice_setup_sec).sort((a, b) => a - b);
    const middle = Math.floor(sortedIce.length / 2);
    const median = sortedIce.length % 2 ? sortedIce[middle] : (sortedIce[middle - 1] + sortedIce[middle]) / 2;
    const medianIce = Number.isFinite(median) ? Number(median.toFixed(2)) : null;
    const c1Status = c1.length < 30 ? invalidSamples ? 'INSUFFICIENT_EVIDENCE' : 'INCOMPLETE_N_LT_30'
      : (directSuccessRate >= 0.60 && medianIce !== null && medianIce <= 10.0 ? 'THRESHOLDS_MET' : 'THRESHOLDS_NOT_MET');
    return {
      trials: c1.length,
      invalid_samples: invalidSamples,
      direct_success_rate: directSuccessRate,
      median_ice_setup_sec: medianIce,
      c1_status: c1Status
    };
  }

  toJsonl() {
    return this.entries.map(e => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
  }
}

/** Local identities must fit the same strict JSON profile used on the wire.
 * Validate before closing a previous live session or allocating a provider.
 */
function validateTransportIdentity(peerId, channelKey) {
  if (typeof peerId !== 'string' || typeof channelKey !== 'string') throw new TypeError('Transport identities must be strings');
  if (peerId.length === 0 || peerId.length > 128) refuse('relay-peer-identity');
  snapshotRelayMessage({ kind: 'announce', from: peerId, channelKey });
}

/**
 * Multi-Peer WebRTC DataChannel Mesh + Warm Relay Cache (`ntfy.sh` ring buffer).
 * Supports N concurrent peers, binary/JSON replication, and raw Ethernet frame bridging for v86.
 */
export class WebRtcTransportNode {
  constructor(options = {}) {
    this.admission = options.admission ?? new ResourceAdmission();
    this.channelPool = { queued: 0, messages: 0, receiving: 0, assemblies: 0 };
    this.relayPending = new Map();
    this.relayVerificationPool = new Map();
    this.relaySession = null;
    this.signalAssembler = null;
    this.warmPollBusy = null;
    this.publicRelayConsent = options.publicRelayConsent ?? (() => true);
    if (typeof this.publicRelayConsent !== 'function') throw new TypeError('Relay consent must be a callback');
    this.maxRelayResponseBytes = 2 * 1024 * 1024;
    this.maxDataMessageBytes = 512 * 1024;
    this.maxPeers = 64;
    this.peerId = options.peerId || ('node-' + Math.random().toString(36).slice(2, 8));
    this.channelKey = options.channelKey ?? 'syntra-uor-bus-01';
    validateTransportIdentity(this.peerId, this.channelKey);
    this.signaling = new SignalSession(this.channelKey, { maxPeers: this.maxPeers });
    this.signalSigning = new Map();
    this.signalTail = Promise.resolve();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.iceServers = iceServerConfiguration(options.iceServers ?? DEFAULT_ICE_SERVERS);
    this.publicSignaling = options.publicSignaling ?? true;
    if (typeof this.publicSignaling !== 'boolean') throw new TypeError('Public signaling requires an explicit Boolean');
    this.networkPairClass = options.networkPairClass ?? 'declared-pair';
    this.trialLogger = options.trialLogger ?? null;
    this.onEvent = options.onEvent ?? (() => {});

    /** @type {Map<string, { pc: RTCPeerConnection, dc: RTCDataChannel | null, rttMs: number | null, lastSeenSec: number, startedAtMs: number, iceSetupSec: number | null, usedTurn: boolean, heartbeatsPassed: number, c1Logged: boolean }>} */
    this.peers = new Map();
    this.generation = 0;
    this.closed = false;
    this.bc = null;
    this.ws = null;
    this.hbTimer = null;
    this.seq = 0;
    this.heartbeatTimestampsSec = [];
    this.bytesSent = 0;
    this.bytesReceived = 0;
  }

  // Display labels are not authenticated routing identities.
  get routingPeerId() { return this.signaling.id ?? this.peerId; }

  get lifecycle() {
    return { generation: this.generation, closed: this.closed, canConnect: true, canSend: transportCanSend(this) };
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
    if (this.closed) refuse('transport-closed');
    let entry = this.peers.get(remoteId);
    if (entry && entry.pc && entry.pc.connectionState !== 'closed' && entry.pc.connectionState !== 'failed') {
      return entry;
    }

    if (!transportPeerAllocationAllowed(this)) refuse('peer-capacity');
    if (entry) {
      entry.flow?.dispose('peer-replaced');
      entry.dc?.close();
      if (entry.c1Deadline !== null) clearTimeout(entry.c1Deadline);
      if (entry.statsDeadline !== null) clearTimeout(entry.statsDeadline);
      entry.c1Logged = true;
    }
    this.admission.reserve('refresh', { requests: 1 });
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    entry = {
      pc,
      dc: null,
      rttMs: null,
      lastSeenSec: Date.now() / 1000,
      startedAtMs: performance.now(),
      iceSetupSec: null,
      usedTurn: false,
      heartbeatsPassed: 0,
      lastHeartbeatSeq: null,
      pendingHeartbeats: new Map(),
      c1Deadline: null,
      statsDeadline: null,
      c1Finalizing: false,
      c1Logged: false
    };
    this.peers.set(remoteId, entry);
    const callback = captureTransport(this, remoteId);
    const current = () => transportPeerCurrent(this, callback, remoteId, entry);
    entry.c1Deadline = setTimeout(() => {
      if (current()) this.finishConnectionTrial(remoteId, entry, performance.now(), false, false, 'heartbeat-deadline');
    }, 10000);
    entry.c1Deadline?.unref?.();

    pc.onicecandidate = e => {
      if (!current()) return;
      if (e.candidate) {
        const raw = e.candidate.candidate || '';
        const candidateType = raw.includes(' typ relay ')
          ? 'relay'
          : raw.includes(' typ srflx ')
          ? 'srflx'
          : 'host';
        if (candidateType === 'relay') entry.usedTurn = true;
        this.emit('ice_candidate', { remoteId, candidateType });
        if (!current()) return;
        this.sendSignal({ kind: 'ice', to: remoteId, candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (!current()) return;
      const state = pc.iceConnectionState || 'closed';
      this.emit('ice_state', { remoteId, state });
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.finishConnectionTrial(remoteId, entry, performance.now(), false, false, `ice_${state}`);
        entry.flow?.dispose(`ice_${state}`);
        entry.dc?.close();
        this.peers.delete(remoteId);
        this.emit('peer_disconnected', { remoteId, state });
      }
    };

    pc.ondatachannel = e => {
      if (!current()) { e.channel.close(); return; }
      this.bindDataChannel(remoteId, e.channel);
    };

    if (initiator) {
      const dc = pc.createDataChannel('uor-mesh', { ordered: true, protocol: CHANNEL_PROTOCOL });
      this.bindDataChannel(remoteId, dc);
    }

    return entry;
  }

  bindDataChannel(remoteId, channel) {
    const entry = this.peers.get(remoteId);
    if (!entry || this.closed) { channel.close(); return; }
    entry.flow?.dispose('channel-replaced');
    entry.dc = channel;
    entry.pendingHeartbeats ??= new Map();
    entry.pendingHeartbeats.clear();
    entry.lastHeartbeatSeq = null;
    entry.heartbeatsPassed = 0;
    const callback = captureTransport(this, remoteId);
    const current = () => transportChannelCurrent(this, callback, remoteId, entry, channel);
    const flow = new ChannelFlow({ channel, pc: entry.pc, current, admission: this.admission, pool: this.channelPool,
      onMessage: msg => { if (current()) this.handleDataMessage(remoteId, msg); },
      onSent: bytes => { this.bytesSent += bytes; },
      onResult: result => { this.emit('channel_send_result', { remoteId, generation: callback.generation, ...result }); } });
    entry.flow = flow;

    channel.onopen = () => {
      if (!current()) return;
      flow.drain();
      if (entry && entry.iceSetupSec === null) {
        entry.iceSetupSec = (performance.now() - entry.startedAtMs) / 1000;
      }
      this.emit('channel_open', { remoteId, label: channel.label, iceSetupSec: entry?.iceSetupSec ?? 0 });
      if (current()) this.startHeartbeat();
    };

    channel.onclose = () => {
      if (!current()) return;
      flow.dispose('channel-closed');
      this.finishConnectionTrial(remoteId, entry, performance.now(), false, false, 'channel-closed');
      this.peers.delete(remoteId);
      this.emit('channel_close', { remoteId });
    };

    channel.onerror = () => { if (current()) flow.fail('channel-error-unknown'); };

    channel.onmessage = e => {
      if (!current()) return;
      const rawLen = typeof e.data === 'string' ? wireBytes(e.data) : (e.data?.byteLength || 0);
      this.bytesReceived += rawLen;
      flow.receive(e.data);
    };
  }

  handleDataMessage(remoteId, msg) {
    const nowMs = Date.now();
    const entry = this.peers.get(remoteId);
    if (entry) entry.lastSeenSec = nowMs / 1000;

    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      if (msg.from !== remoteId || !Number.isSafeInteger(msg.seq) || msg.seq < 0 || !Number.isFinite(msg.sentAtMs)) return;
      this.sendToPeer(remoteId, { type: 'pong', seq: msg.seq, sentAtMs: msg.sentAtMs, from: this.routingPeerId });
      this.recordHeartbeat(remoteId, nowMs, null);
    } else if (msg.type === 'pong') {
      const probe = entry?.pendingHeartbeats.get(msg.seq), observedAt = performance.now();
      const correlated = !!probe && msg.from === remoteId && probe.sentAtMs === msg.sentAtMs
        && probe.generation === this.generation && probe.channel === entry.dc && probe.monotonicAt <= observedAt;
      if (probe) entry.pendingHeartbeats.delete(msg.seq);
      if (correlated) {
        const rttMs = observedAt - probe.monotonicAt;
        entry.rttMs = rttMs;
        observeC1Probe(entry, msg.seq, observedAt, true);
        this.recordHeartbeat(remoteId, nowMs, rttMs);
        if (!entry.c1Logged && !entry.c1Finalizing && c1ConnectionQualified(entry, observedAt)) {
          this.observeConnectionPath(remoteId, entry, observedAt);
        }
      }
    } else {
      this.emit('mesh_message', { from: remoteId, msg });
    }
  }

  recordHeartbeat(remoteId, nowMs, rttMs) {
    const nowSec = nowMs / 1000;
    this.heartbeatTimestampsSec.push(nowSec);
    if (this.heartbeatTimestampsSec.length > 64) this.heartbeatTimestampsSec.shift();
    this.emit('heartbeat', { remoteId, count: this.heartbeatTimestampsSec.length, rttMs, timestampSec: nowSec });
  }

  rememberHeartbeatProbe(entry, payload) {
    if (!(entry.pendingHeartbeats instanceof Map) || payload.type !== 'ping' || !Number.isSafeInteger(payload.seq) || payload.seq < 0 || !Number.isFinite(payload.sentAtMs)) return;
    entry.pendingHeartbeats.set(payload.seq, { sentAtMs: payload.sentAtMs, monotonicAt: performance.now(), generation: this.generation, channel: entry.dc });
    while (entry.pendingHeartbeats.size > 64) entry.pendingHeartbeats.delete(entry.pendingHeartbeats.keys().next().value);
  }

  finishConnectionTrial(remoteId, entry, observedAt, selectedPathObserved, usedRelay, reason) {
    if (entry.c1Logged) return;
    entry.c1Logged = true;
    if (entry.c1Deadline !== null) clearTimeout(entry.c1Deadline);
    if (entry.statsDeadline !== null) clearTimeout(entry.statsDeadline);
    entry.c1Deadline = entry.statsDeadline = null;
    const payload = { remote_peer: remoteId, network_pair_class: this.networkPairClass,
      success: c1DirectSuccess(entry, observedAt, selectedPathObserved, usedRelay),
      connection_qualified: c1ConnectionQualified(entry, observedAt), selected_path_observed: selectedPathObserved,
      ordered_channel: entry.dc?.ordered === true, used_turn: usedRelay,
      ice_setup_sec: entry.iceSetupSec,
      qualification_elapsed_sec: (observedAt - entry.startedAtMs) / 1000,
      heartbeats_passed: entry.heartbeatsPassed, reason };
    this.trialLogger?.logTrial('C1', payload);
    this.emit('c1_trial_complete', payload);
  }

  async observeConnectionPath(remoteId, entry, qualifiedAt) {
    entry.c1Finalizing = true;
    if (entry.c1Deadline !== null) clearTimeout(entry.c1Deadline);
    entry.c1Deadline = null;
    const callback = captureTransport(this, remoteId);
    const current = () => transportPeerCurrent(this, callback, remoteId, entry) && !entry.c1Logged;
    // Local RTC stats observation adds no traffic. A bounded missing observation
    // cannot turn an unobserved path into a direct-connect success.
    entry.statsDeadline = setTimeout(() => {
      if (current()) this.finishConnectionTrial(remoteId, entry, qualifiedAt, false, false, 'selected-path-unobserved');
    }, 1000);
    entry.statsDeadline?.unref?.();
    try {
      const reports = await entry.pc.getStats();
      if (!current()) return;
      const rows = [...reports.values()];
      const selected = new Set(rows.filter(row => row.type === 'transport' && typeof row.selectedCandidatePairId === 'string').map(row => row.selectedCandidatePairId));
      const pair = selected.size === 1 ? reports.get([...selected][0]) : null;
      const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
      const validType = value => ['host', 'srflx', 'prflx', 'relay'].includes(value);
      const observed = pair?.type === 'candidate-pair' && pair.state === 'succeeded'
        && local?.type === 'local-candidate' && remote?.type === 'remote-candidate'
        && validType(local.candidateType) && validType(remote.candidateType);
      const relay = observed && (local.candidateType === 'relay' || remote.candidateType === 'relay');
      this.finishConnectionTrial(remoteId, entry, qualifiedAt, observed, relay, observed ? relay ? 'relay-path-observed' : 'direct-path-observed' : 'selected-path-unobserved');
    } catch {
      if (current()) this.finishConnectionTrial(remoteId, entry, qualifiedAt, false, false, 'selected-path-unobserved');
    }
  }

  startHeartbeat() {
    if (this.closed || this.hbTimer) return;
    const callback = captureTransport(this);
    this.hbTimer = setInterval(() => {
      if (!transportSessionCurrent(this, callback)) return;
      this.seq++;
      const now = Date.now();
      this.broadcast({ type: 'ping', seq: this.seq, sentAtMs: now, from: this.routingPeerId });
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  sendToPeer(remoteId, payloadObj, options = {}) {
    const entry = this.peers.get(remoteId);
    if (!entry || !entry.dc || entry.dc.readyState !== 'open') return false;
    if (!entry.flow) this.bindDataChannel(remoteId, entry.dc);
    return entry.flow.enqueue(payloadObj, { ...options, onSubmitted: snapshot => this.rememberHeartbeatProbe(entry, snapshot) });
  }

  /** Count means accepted into bounded local queues, never delivered. */
  broadcast(payloadObj, options = {}) {
    let accepted = 0;
    for (const { remoteId } of this.openPeers()) {
      try { if (this.sendToPeer(remoteId, payloadObj, options)) accepted++; }
      catch (error) { this.emit('policy_refused', { remoteId, code: error.code || 'channel-send-refused' }); }
    }
    return accepted;
  }

  /** Queue is an in-flight memory bound, not a second resource ledger. */
  _queueRelay(snapshot, scope, consentCurrent, localBroadcast = null) {
    const callback = captureTransport(this);
    if (!transportSessionCurrent(this, callback) || !consentCurrent()) refuse('relay-not-authorized');
    const retained = [...this.relayPending.values()].reduce((sum, job) => sum + job.snapshot.byteLength, 0);
    if (!relayAdmissionAllowed(relayCapacity(this.relayPending.size, retained), snapshot.byteLength)) refuse('relay-outbound-capacity');
    this.relaySession ??= newRelaySession();
    const job = { snapshot, scope, callback, session: this.relaySession, channelKey: this.channelKey,
      consentCurrent, localBroadcast,
      fetchImpl: scope === 'signal' && !this.publicSignaling ? null : globalThis.fetch?.bind(globalThis),
      controller: new AbortController(), timedOut: false,
      url: `https://ntfy.sh/${scope === 'warm' ? this.warmCacheTopic() : this.signalTopic()}` };
    this.relayPending.set(job, job);
    job.deadline = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, RELAY_LIMITS.requestTimeout);
    job.deadline.unref?.();
    job.completion = this._dispatchRelay(job).finally(() => { clearTimeout(job.deadline); this.relayPending.delete(job); });
    return job.completion;
  }

  async _dispatchRelay(job) {
    const current = () => relayEffectAllowed(this, job.callback.generation,
      !job.controller.signal.aborted && this.relaySession === job.session && transportSessionCurrent(this, job.callback), job.consentCurrent());
    let planned = 0, attempted = 0, acknowledged = 0, httpStatus = null, outcome = 'cancelled';
    try {
      const framed = job.fetchImpl ? await frameRelayMessage(job.snapshot, {
        channelKey: job.channelKey, session: job.session, scope: job.scope }) : { frames: [], bytes: 0 };
      planned = framed.frames.length;
      if (!current()) { outcome = job.timedOut ? 'timeout' : 'cancelled'; return false; }
      const local = !!job.localBroadcast && this.bc === job.localBroadcast;
      // One atomic reservation includes every serialized frame's metadata and
      // every actual destination. A failed/partial batch never receives a refund.
      const requests = planned + (local ? 1 : 0);
      if (!requests) { outcome = 'unavailable'; return false; }
      this.admission.reserve(job.scope === 'warm' ? 'place' : 'refresh', { requests,
        transferBytes: framed.bytes + (local ? job.snapshot.byteLength : 0) });
      if (local && current() && this.bc === job.localBroadcast) {
        job.localBroadcast.postMessage(JSON.parse(job.snapshot.raw));
        this.bytesSent += job.snapshot.byteLength;
      }
      for (const body of framed.frames) {
        if (!current()) { outcome = acknowledged ? 'partial' : (job.timedOut ? 'timeout' : 'cancelled'); return false; }
        attempted++;
        this.bytesSent += wireBytes(body);
        let response;
        try {
          response = await job.fetchImpl(job.url, { method: 'POST', body, signal: job.controller.signal,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', Cache: job.scope === 'signal' ? 'no' : 'yes' } });
        } catch {
          outcome = acknowledged ? 'partial' : 'unknown'; return false;
        }
        httpStatus = response.status ?? null;
        if (!response.ok) { outcome = acknowledged ? 'partial' : 'refused'; return false; }
        acknowledged++;
      }
      if (!current()) { outcome = acknowledged ? 'partial' : (job.timedOut ? 'timeout' : 'cancelled'); return false; }
      outcome = planned ? 'acknowledged' : 'local-only';
      return planned > 0 && acknowledged === planned;
    } catch (error) {
      outcome = acknowledged ? 'partial' : 'refused';
      if (transportSessionCurrent(this, job.callback)) this.emit('policy_refused', { code: error.code || 'relay-failed' });
      return false;
    } finally {
      // HTTP acknowledgement is not recipient delivery or a retention receipt.
      if (transportSessionCurrent(this, job.callback)) this.emit('relay_publish_result', {
        scope: job.scope, outcome, planned, attempted, acknowledged, httpStatus, timedOut: job.timedOut });
    }
  }

  /** All frames must be HTTP-acknowledged. This is not a durability receipt. */
  async publishWarmEnvelope(envelopeObj, { publicData = false, consentCurrent = () => publicData } = {}) {
    if (publicData !== true || !consentCurrent() || !this.publicRelayConsent() || !transportCanSend(this) || typeof fetch === 'undefined') return false;
    try {
      const snapshot = snapshotRelayMessage({ ...envelopeObj, from: this.peerId, tsMs: Date.now() });
      return await this._queueRelay(snapshot, 'warm', () => publicData === true && consentCurrent() && this.publicRelayConsent());
    } catch (error) {
      this.emit('policy_refused', { code: error.code || 'relay-failed' });
      return false;
    }
  }

  /** One bounded poll snapshot. Incomplete messages are never exposed, and are
   * released at the end of this poll. A later poll may recover a complete copy.
   * The 30-minute application window does not promise provider retention.
   */
  async fetchWarmEnvelopes(sinceWindow = '30m', { publicData = false, consentCurrent = () => publicData } = {}) {
    if (publicData !== true || !consentCurrent() || !this.publicRelayConsent() || !transportCanSend(this) || typeof fetch === 'undefined') return [];
    if (this.warmPollBusy) { this.emit('policy_refused', { code: 'relay-poll-busy' }); return []; }
    const token = { controller: new AbortController() }, callback = captureTransport(this);
    const current = () => !token.controller.signal.aborted && transportSessionCurrent(this, callback) && publicData === true && consentCurrent() && this.publicRelayConsent();
    const assembler = new RelayReassembler({ channelKey: this.channelKey, scope: 'warm', admission: this.admission,
      current, consentCurrent, chargeIngress: false, verificationPool: this.relayVerificationPool });
    token.assembler = assembler;
    token.deadline = setTimeout(() => token.controller.abort(), RELAY_LIMITS.requestTimeout);
    token.deadline.unref?.();
    this.warmPollBusy = token;
    try {
      if (typeof sinceWindow !== 'string' || !/^(?:[1-9][0-9]{0,5}[smh]|all)$/.test(sinceWindow)) refuse('relay-poll-window');
      const url = `https://ntfy.sh/${this.warmCacheTopic()}/json?poll=1&since=${encodeURIComponent(sinceWindow)}`;
      this.admission.reserve('retrieve', { requests: 1, transferBytes: wireBytes(url) + this.maxRelayResponseBytes });
      if (!current()) return [];
      const res = await fetch(url, { signal: token.controller.signal });
      if (!current() || !res.ok) return [];
      const text = await readBoundedText(res, this.maxRelayResponseBytes);
      const envelopes = [];
      let offset = 0, refused = 0;
      while (offset < text.length && current()) {
        let end = text.indexOf('\n', offset);
        if (end < 0) end = text.length;
        const line = text.slice(offset, end); offset = end + 1;
        if (!line) continue;
        try {
          if (line.length > RELAY_EVENT_BYTES || wireBytes(line) > RELAY_EVENT_BYTES) refuse('relay-event-limit');
          const outer = JSON.parse(line);
          if (outer.event !== 'message' || typeof outer.message !== 'string' || outer.attachment) continue;
          const envelope = await assembler.accept(outer.message);
          if (envelope) envelopes.push(envelope);
        } catch { refused++; }
      }
      if (!current()) return [];
      this.emit('relay_poll_result', { completed: envelopes.length, refused, incomplete: assembler.state.entries });
      return envelopes;
    } catch (error) {
      if (transportSessionCurrent(this, callback)) this.emit('policy_refused', { code: error.code || 'relay-poll-failed' });
      return [];
    } finally {
      clearTimeout(token.deadline); assembler.dispose();
      if (this.warmPollBusy === token) this.warmPollBusy = null;
    }
  }

  connect(channelKey = this.channelKey) {
    validateTransportIdentity(this.peerId, channelKey);
    // Invalidate callbacks before closing: close events may run synchronously.
    // Rejoining the same topic is also a new signaling session.
    this.close();
    openTransport(this, channelKey);
    this.signaling = new SignalSession(channelKey, { maxPeers: this.maxPeers });
    const callback = captureTransport(this);
    const current = () => transportSessionCurrent(this, callback);
    this.signalAssembler = new RelayReassembler({ channelKey: this.channelKey, scope: 'signal',
      admission: this.admission, current, verificationPool: this.relayVerificationPool });
    const signalAssembler = this.signalAssembler;
    const receive = msg => {
      if (!current()) return;
      this.handleSignal(msg).catch(error => {
        if (current()) this.emit('signal_error', { code: error.code || 'signaling-failed' });
      });
    };

    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(`uor:${this.channelKey}`);
      this.bc.onmessage = e => {
        if (current() && e.data && e.data.from !== this.peerId) receive(e.data);
      };
      // Same-origin peers must not wait for the public signaling provider to
      // become reachable. Public discovery still announces when its socket opens.
      this.sendSignal({ kind: 'announce' });
    }

    if (this.publicSignaling && typeof WebSocket !== 'undefined') {
      const topic = this.signalTopic();
      try {
        this.admission.reserve('refresh', { requests: 1 });
        this.ws = new WebSocket(`wss://ntfy.sh/${topic}/ws`);
        this.ws.onopen = () => {
          if (!current()) return;
          this.emit('signaling_ready', { topic, channelKey: this.channelKey });
          if (!current()) return;
          this.sendSignal({ kind: 'announce' });
        };
        this.ws.onmessage = async e => {
          if (!current()) return;
          try {
            if (typeof e.data !== 'string' || e.data.length > RELAY_EVENT_BYTES || wireBytes(e.data) > RELAY_EVENT_BYTES) return;
            const env = JSON.parse(e.data);
            if (env.event !== 'message' || typeof env.message !== 'string' || env.attachment) return;
            const msg = await signalAssembler.accept(env.message);
            if (current() && msg && msg.from !== this.peerId) receive(msg);
          } catch (error) {
            if (current()) this.emit('relay_frame_refused', { scope: 'signal', code: error.code || 'relay-frame' });
          }
        };
      } catch {
        this.sendSignal({ kind: 'announce' });
      }
    } else if (!this.bc) {
      this.sendSignal({ kind: 'announce' });
    }
  }

  /** True means locally queued, not published or delivered. Result events
   * distinguish local-only, HTTP acknowledgements, partial and unknown batches.
   */
  sendSignal(payload) { return this.enqueueSignal(payload) !== null; }

  enqueueSignal(payload) {
    if (!transportCanSend(this)) return null;
    try {
      // Snapshot caller-owned browser records before asynchronous cryptography.
      const input = snapshotRelayMessage(payload);
      const retained = [...this.signalSigning.values()].reduce((n, job) => n + job.bytes, 0)
        + [...this.relayPending.values()].reduce((n, job) => n + job.snapshot.byteLength, 0);
      if (this.signalSigning.size + this.relayPending.size >= RELAY_LIMITS.entries
        || retained + input.byteLength > RELAY_LIMITS.retainedBytes) refuse('signal-queue-limit');
      if (!this.bc && typeof fetch === 'undefined') return null;
      const callback = captureTransport(this), session = this.signaling;
      const job = { bytes: input.byteLength, completion: null };
      this.signalSigning.set(job, job);
      job.completion = this.signalTail.then(async () => {
        const signed = await session.sign(JSON.parse(input.raw));
        if (!transportSessionCurrent(this, callback) || session !== this.signaling) return null;
        this.signalSigning.delete(job);
        return await this._queueRelay(snapshotRelayMessage(signed), 'signal', () => true, this.bc);
      }).catch(error => {
        if (transportSessionCurrent(this, callback)) this.emit('policy_refused', { code: error.code || error.message || 'signal-failed' });
        return null;
      }).finally(() => this.signalSigning.delete(job));
      this.signalTail = job.completion;
      return job.completion;
    } catch (error) {
      this.emit('policy_refused', { code: error.code || 'relay-failed' });
      return null;
    }
  }

  async handleSignal(msg) {
    const session = this.signaling, invocation = captureTransport(this);
    return session.receive(msg, async authenticated => {
    if (!authenticated || !transportSessionCurrent(this, invocation) || this.signaling !== session) return;
    if (authenticated.reply) await this.enqueueSignal(authenticated.reply);
    if (!transportSessionCurrent(this, invocation) || this.signaling !== session) return;
    if (!authenticated.message) return;
    msg = { ...authenticated.message, to: this.peerId };
    if (!msg || msg.channelKey !== this.channelKey || typeof msg.from !== 'string' || msg.from.length === 0 || msg.from.length > 128) return;
    try {
      parseCanonicalJson(JSON.stringify(msg.from), { maxBytes: 1024, maxDepth: 0, maxEntries: 1, maxStringLength: 128 });
      if (msg.to != null) parseCanonicalJson(JSON.stringify(msg.to), { maxBytes: 1024, maxDepth: 0, maxEntries: 1, maxStringLength: 128 });
    } catch { return; }
    if (!transportSignalAllowed(this, msg)) return;
    const remoteId = msg.from;
    const callback = captureTransport(this, remoteId);
    const current = entry => transportPeerCurrent(this, callback, remoteId, entry);

    const existing = this.peers.get(remoteId);
    if (existing && existing.dc && existing.dc.readyState === 'open') {
      return;
    }

    if (msg.kind === 'announce') {
      // Both authenticated handshake endpoints discover each other. Only one
      // key may offer/create the application channel: two crossing channels
      // make each ondatachannel replace the other's still-live receive flow.
      if (this.routingPeerId >= remoteId || existing?.pc.localDescription) return;
      const entry = this.getOrCreatePeer(remoteId, true);
      const offer = await entry.pc.createOffer();
      if (!current(entry)) return;
      await entry.pc.setLocalDescription(offer);
      if (!current(entry)) return;
      this.sendSignal({ kind: 'offer', to: remoteId, sdp: entry.pc.localDescription });
    } else if (msg.kind === 'offer') {
      if (existing && existing.pc.signalingState === 'have-local-offer' && (this.routingPeerId) < remoteId) {
        return; // Deterministic glare resolution
      }
      const entry = this.getOrCreatePeer(remoteId, false);
      await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      if (!current(entry)) return;
      const answer = await entry.pc.createAnswer();
      if (!current(entry)) return;
      await entry.pc.setLocalDescription(answer);
      if (!current(entry)) return;
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
    });
  }

  close() {
    closeTransport(this);
    this.signaling?.close();
    this.signalSigning?.clear();
    this.signalTail = Promise.resolve();
    this.relaySession = null;
    for (const job of this.relayPending.values()) job.controller.abort();
    this.warmPollBusy?.controller.abort();
    this.warmPollBusy?.assembler.dispose();
    this.signalAssembler?.dispose();
    this.signalAssembler = null;
    this.stopHeartbeat();
    const peers = [...this.peers.values()];
    this.peers.clear();
    for (const entry of peers) {
      const { dc, pc } = entry;
      entry.flow?.dispose('transport-closed');
      if (entry.c1Deadline !== null) clearTimeout(entry.c1Deadline);
      if (entry.statsDeadline !== null) clearTimeout(entry.statsDeadline);
      entry.c1Logged = true;
      if (dc) dc.close();
      if (pc) pc.close();
    }
    this.peers.clear();
    if (this.bc) this.bc.close();
    if (this.ws) this.ws.close();
    this.bc = null;
    this.ws = null;
  }
}
