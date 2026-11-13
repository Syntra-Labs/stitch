# DNS-over-HTTPS client

The default `DohResolver` now sends RFC8484 `application/dns-message`, rather than presenting Cloudflare's JSON API as that protocol. The latter remains available explicitly as `format: 'json'`. Cloudflare record administration is a separate API and retains its scoped unknown-write reconciliation.

## Application role and implementation

`src/layer5-transport/dns-wire.js` owns query bytes, bounded response parsing and association. It supports POST (default) and GET, unpadded base64url GET data, configured HTTPS URLs and the single `dns` variable in configured URI templates. The API queries Internet-class records and accepts numeric RR type codes; unknown RR data remains opaque RFC3597-style bytes instead of being reinterpreted as TXT. This is a stub client, not an authoritative or recursive DNS server.

- Requests use ID0 for cache reuse, recursion desired, exact question/type/class, explicit DNS-message media negotiation, no browser credentials or referring-page URL. Redirects are rejected by the configured privacy policy rather than silently sending a query to a different provider.
- DNS responses are bounded to65535 bytes and structurally validated. Header, question, QR/opcode, truncation, compression offsets/cycles, expanded names, lengths, sections and supported RR encodings are checked before use. TXT bytes preserve every character-string; the pointer application joins those bytes before UTF8 decoding. SRV targets reject compression and preserve root-target service unavailability.
- CNAME answers must associate with the query; the terminal answer or negative result is returned. Unknown additional RRs remain data. A/AAAA, names, MX, SOA, TXT, SRV and OPT are decoded; opaque types remain transportable without a false semantic interpretation.
- NXDOMAIN is an explicit negative result, not a successful positive answer. Other DNS errors and HTTP errors remain distinct. Negative lifetime includes both SOA TTL/minimum and any alias chain. Positive lifetime includes the alias chain. RFC2181 high-bit TTLs act as zero.
- HTTP Age is subtracted from remaining DNS lifetime. A CORS response whose Age is unobservable has effectiveTTL0, while its answers remain usable for the current request. A missing exposed Age header is never evidence that a cross-origin cached response is fresh. No response is called a cache hit merely because its TTL fell. Browser fetch owns HTTP storage, HTTP version negotiation and TLS; the app does not duplicate that cache.
- AD is reported as a resolver assertion. Stitch does not claim local DNSSEC validation from the bit, authenticated authority from DNS alone, or global pointer freshness from one resolver. Signed pointers still require independently pinned authority and observer-local succession checks.

Default encrypted-provider traffic still discloses the query to that provider. No live DNS query is sent by the test suite. The browser must support the required secure context, fetch/CORS and media handling. Real configured-provider and browser interoperability remains a distinct qualification stage.

## Contract-to-evidence map

| Obligation | Source and evidence |
|---|---|
| RFC8484 sections3–4.1: configured HTTPS endpoint, GET/POST encoding, query association | `queryDnsMessage`, `encodeDnsQuery`; exact question-byte and both-method/URI-template tests |
| Sections4.2,5.4,6: HTTP/DNS errors, DNS-message response, maximum message, media type | `queryDnsMessage`, `readBoundedDnsBytes`, `decodeDnsResponse`; invalid media/status/size tests |
| Section5.1, RFC2308 negative lifetime, RFC2181 TTL | Age and SOA/alias lifetime tests, including hidden CORS Age and TTL expiry |
| RFC1035 sections4.1.2–4.1.4: names, compression, questions, resource records | compressed owner, every truncated prefix, pointer/header/question/RDATA negative tests |
| RFC2782: SRV shape and uncompressed target | UInt16/root target tests and compressed-target rejection |
| RFC3597: unknown RR types | opaque byte-preserving type65000 vector |
| Actual browser adapter uses standards path | `DohResolver` default-wire test; vendor-JSON tests opt in explicitly |

These are implementation and deterministic fake-provider tests, not a declaration that all browser, DNSSEC, resolver, HTTP or physical-network behavior has been certified. Final release evidence must bind the integrated source and add relevant real-browser/provider trials. The Prism model owns surrounding authority, observation, effect and resource transitions; the handwritten wire codec remains a declared host implementation boundary.

Primary sources: [RFC8484](https://www.rfc-editor.org/rfc/rfc8484.html), [RFC1035](https://www.rfc-editor.org/rfc/rfc1035.html), [RFC2181](https://www.rfc-editor.org/rfc/rfc2181.html), [RFC2308](https://www.rfc-editor.org/rfc/rfc2308.html), [RFC2782](https://www.rfc-editor.org/rfc/rfc2782.html), [RFC3597](https://www.rfc-editor.org/rfc/rfc3597.html).
