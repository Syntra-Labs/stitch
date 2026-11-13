# Bounded ntfy application framing

Stitch uses ntfy's HTTP publish, WebSocket text notifications and newline-delimited JSON poll APIs. The provider documents a 4096-byte message limit; a longer publish body may become an attachment. Stitch therefore frames logical messages itself. It never follows attachment URLs, and it rejects old unframed ntfy packets. All peers sharing a topic must use this framing version. BroadcastChannel remains a local logical-message transport.

The application policy and admission/assembly transitions are defined in `app/src/Stitch/Relay.lex.tex` and consumed through the existing generated model projection by `src/layer5-transport/relay-framing.js`. The projection is not a new compiler or verification receipt. Parsing, SHA-256, clocks, allocation and browser/provider effects remain explicit host facts. Source theorem acceptance requires the project's pinned SDK checks.

## Wire format

Each ntfy message is a JSON object with exactly these fields:

- `v`: `stitch/1`.
- `p`: `signal` or `warm`. The two purposes cannot be concatenated.
- `c`: domain-separated SHA-256 of the JSON-encoded exact channel-key string. The channel and peer identity strings must be valid I-JSON Unicode; malformed local identities are refused before an existing session is closed. JSON-encoded hashing preserves exact code-unit distinctions without normalization.
- `s`: a 128-bit cryptographically random sender-session identifier, lowercase hexadecimal. Reconnect replaces the session.
- `m`: domain-separated SHA-256 of the complete logical message's original UTF-8 bytes.
- `t`: sender creation time, integer milliseconds. It is an untrusted freshness hint, not authority.
- `b`: complete UTF-8 byte length.
- `n`: chunk count.
- `i`: zero-based chunk index.
- `x`: unpadded RFC4648 base64url chunk bytes. Noncanonical padding, alphabet and nonzero pad bits are rejected.

The existing `sha256Bytes` domain framing is used with domains `relay-channel` and `relay-message`. This framing preserves the enclosed manifest, object, program and checkpoint identities. It does not replace their validation or authenticate the sender.

A chunk contains 2700 bytes except for the last chunk, which has the exact remaining length. The count must be exactly the ceiling of `b / 2700`. Every serialized provider body, including all framing metadata, is checked against the 4096-byte UTF-8 limit. UTF-8 characters may span binary chunks; strict decoding occurs only after complete reassembly and digest verification. The strict shared JSON parser rejects duplicate names, invalid Unicode, nonfinite values and malformed syntax before an application envelope is admitted.

## Resource and retention policy

- The complete logical JSON limit is 512 KiB, matching the existing application message ceiling. The obsolete2048-byte public-object demonstration cap is removed: the full128KiB live-object range fits the512KiB logical envelope ceiling, including worst-case decimal byte-array encoding. JSON entry capacity derives from the byte ceiling rather than an independent limit that rejects a valid maximum-sized fragment.
- At most 256 frames are declared per message. Actual 512 KiB messages require at most 195 frames.
- An assembler admits at most 16 active messages and reserves their full declared lengths before allocating a payload buffer, with a total 2 MiB retained-payload ceiling. Independent pending input work is limited to 256 frames of at most 4096 bytes each. Decoded chunks, bounded parser objects, digest copies and browser/runtime overhead are additional bounded application work, not measurements of total browser memory.
- Completed, rejected and expired identities are kept in at most 256 tombstones. Active entries also reserve a future tombstone slot. Saturation refuses new work instead of evicting unrelated data or weakening duplicate suppression.
- An incomplete assembly has a 30-second local monotonic deadline from its first accepted frame. Receiving duplicates never extends it. One cleanup timer releases expired buffers even with no further traffic. Closing/rejoining cancels live assemblies and fences pending verification. If a host digest still owns its input buffer, that buffer remains charged until the digest settles; cancellation cannot pretend it has been freed. A transport-shared verification pool also counts such buffers from older generations in new-message admission. At most16 pending verification buffers and 2 MiB of their payload bytes can be held, independently of additional bounded digest copies.
- Signaling accepts sender timestamps within a 60-second application lifetime; warm messages use 30 minutes. A timestamp more than 5 seconds in the future is refused. Local retention never exceeds its own receive-time horizon, even if the sender supplies a future timestamp. Clock regression refuses work.
- A warm poll has a 2 MiB provider-body limit, 16 KiB per notification envelope and one in-flight poll per transport. Only complete messages from that snapshot are returned. Incomplete buffers are discarded when the poll finishes. A later poll can retrieve a complete copy. This is an application window, not a promise about ntfy retention.
- Outbound work shares at most 16 pending batches and 2 MiB snapshotted logical bytes across reconnects. Source-derived 30-second abort deadlines cover outbound batches and warm polls. Browser fetch cancellation is best effort; it cannot establish that a publisher-side effect did not occur.

The existing ResourceAdmission ledger is reused. Before the first external effect, one batch reservation charges the actual serialized frame count and UTF-8 body bytes, including framing overhead, plus any local broadcast destination. Local reassembly separately charges declared storage bytes and conservative validation work. Ingress WebSocket bytes are charged; a poll already reserves its bounded response ceiling. Expiring or completing an assembly releases its resident payload buffer, but does not refund the cumulative resource budget or unknown network effects.

## Tested host representation relation

The adapter maintains these relations between concrete browser state and the source projection:

- Capacity entries equal the active map size; retained bytes equal the sum of active declared `header.b`; tombstones equal the retired-key map size. Cancelled entries with a pending digest remain in the map and retain their charge until settlement. New-message admission additionally includes retained verification entries from other generations sharing the transport pool.
- An active buffer has exactly `header.b` bytes. Its bitmap has exactly `header.n` slots. A seen slot stores the received chunk at `i * chunkBytes` with the exact model-admitted length. Peer identities are limited to 128 code units by the transport adapter.
- Assembly received-frame count equals the bitmap population count; received-byte count equals the sum of exact chunk lengths for those seen indices. Only unseen indices advance either counter. An existing slot is a duplicate, and a conflicting byte is refused and retires that exact assembly.
- Identity agreement includes purpose, exact channel digest, sender session, message digest, creation time, count and declared length. Different sessions never share a buffer.
- Delivery requires complete counters, whole-buffer domain-separated SHA-256 verification, strict UTF-8 and JSON validation, the matching current transport generation, and current payload consent.

These are adapter representation relations exercised by independent runtime tests. The source does not contain an indexed byte-buffer implementation, a formal SHA-256 or UTF-8 implementation, or a kernel proof that handwritten host operations refine that representation relation. It owns admission, identity correlation, counters, effect fencing and completion gates. Browser allocation, byte placement, parsing, hashing and effects remain named host boundaries.

## Consent, sessions and outcomes

`publishWarmEnvelope(value, { publicData: true, consentCurrent })` and `fetchWarmEnvelopes(window, { publicData: true, consentCurrent })` require explicit action-scoped opt-in. The optional live callback and transport-level `publicRelayConsent` callback are checked before every external payload frame and before exposing recovered data. The browser binds the transport callback to its current disclosure checkbox. Withdrawn consent prevents remaining frames but cannot recall frames already posted. Compute also supplies its current relay permission. Private object/job bytes are never published by default.

`sendSignal` returns a synchronous boolean indicating whether local bounded work was queued. It does not report publication or recipient delivery. Every asynchronous operation captures exact transport generation, channel, sender session and consent, then rechecks them before each effect. Reconnect, Close and replacement callbacks cannot dispatch old-session continuations.

`relay_publish_result` reports planned, attempted and HTTP-acknowledged frame counts, HTTP status, timeout state and outcome. `acknowledged` means all provider POSTs returned success. `partial`, `refused`, `unknown`, `cancelled`, `timeout`, `unavailable` and `local-only` distinguish incomplete or unavailable publication. A transport generation that is no longer current cannot emit a stale completion into the new session. The warm boolean is true only if all frames were acknowledged and the captured session/consent is still current. Neither result promises durable cache storage or delivery to another peer.

There is no automatic retry, attachment fallback or background publication. A non-success status, including 429, stops the batch. Earlier acknowledgements and every reservation remain accounted for. ntfy's public quotas and rate limits can make a multi-frame message fail; operators should inspect outcomes, keep public workloads small, and use a suitably provisioned provider for larger workloads. A retained complete copy and subsequent full object/checkpoint validation are still required for recovery.

## Verification

`tests/relay-framing.test.js` uses only synthetic fixtures and mocked provider effects. It covers both the original2048-byte all-255 object and a maximum128KiB all-255 object through the real cold database recovery path, large SDP through the actual WebSocket receive path, a full 512 KiB message, UTF-8 splits, reordered/duplicate/conflicting/corrupt/mixed/expired/incomplete messages, malformed JSON and base64url, resource saturation, consent withdrawal, reconnect during digest work, stalled verification across expiry/disposal with shared admission, exact batch charges, 429 and partial outcomes. No real ntfy requests or user payloads are used.

Provider reference: https://docs.ntfy.sh/publish/ (Limitations and caching), https://docs.ntfy.sh/subscribe/api/ (JSON/WebSocket subscriptions). These are provider contracts, not substitutes for the referenced IETF protocol standards.
