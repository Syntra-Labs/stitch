# Signaling identity and session contract

The ntfy topic and same-origin BroadcastChannel are discovery transports, not trusted identity providers. Every accepted signal uses `stitch.signal/1`: canonical JSON signed with Ed25519, binding the channel, sender public key, its SHA-256 key identifier, fresh connection session, monotonically increasing sequence, destination key and destination session, and complete payload (including SDP or ICE). Signatures are verified before RTC allocation or description changes. Unsigned legacy signaling is rejected.

A random 192-bit session is generated on each connection. Keys are ephemeral to that connection. Public announcements may prompt a signed hello addressed to the announced session, but cannot allocate an RTC peer. A hello/ready exchange proves participation in the current receiving session before negotiation. SDP and ICE require the bound sender session and current destination session. Verification completion rechecks lifecycle and replay state; concurrent copies cannot both be admitted. One key's bound incarnation cannot be replaced within a live session. Reconnect explicitly starts fresh discovery and invalidates pending cryptography, queued sends, and old envelopes.

The sender orders signing and relay publication. The receiver refuses repeated or nonincreasing sequences rather than pretending the discovery relay supplies reliable ordered delivery. Provider loss, reordering, or incomplete negotiation can require reconnect. Authentication does not guarantee delivery, availability, or successful ICE negotiation.

Discovery and replay state share the transport's 64-peer bound and are never evicted to accept an unbounded attacker. Incoming signals use a FIFO bounded to eight queued/active messages and 2 MiB of snapshotted bytes. The queue covers verification and RTC consumption, so asynchronous crypto and description installation cannot reorder arriving signals. Pending outbound signing shares the relay's entry and retained-byte admission limits, and signed envelopes use its 512 KiB logical-message bound and framed publication. Queue admission is not a delivery receipt. Public discovery remains susceptible to resource exhaustion by distinct real keys; a full discovery table requires reconnect, not silent replay-state eviction.

## What a key proves

A peer identifier names possession of an ephemeral signing key. It is **not** a trusted person, organization, independently authorized storage holder, or persistent operator identity. Display labels are not the routing identity. Binding a trusted human or durable holder requires a separate trusted channel or authority contract; this implementation does not invent that binding from self-signatures. SDP signatures bind the negotiated WebRTC fingerprint under the browser's WebRTC implementation assumptions. This is not a whole-browser cryptographic proof.

Signatures do not encrypt the public signaling topic. The existing explicit join/disclosure decision remains necessary. ntfy can observe metadata and traffic, suppress messages, and deny service, but cannot alter a signed description or impersonate another existing key without that key's private material (under Ed25519/SHA-256 assumptions).

## Model and evidence

`Stitch.Signaling.admissionAllowed` owns the host-observation admission predicate. Its `unverifiedCannotAdmit` theorem states that a false signature-verification observation cannot admit. WebCrypto, RNG quality, canonical serialization, fingerprint enforcement, and network behavior remain host assumptions tested at their boundaries, not claims established by that theorem.

`tests/authenticated-signaling.test.js` tests challenge-before-SDP, key substitution, altered signed fields, concurrent replay, reconnect invalidation, bounded discovery, unsigned live-transport refusal, and two-node authenticated negotiation. Lifecycle tests mock this boundary deliberately to isolate callback fencing; they do not stand in for the real-signature tests.
