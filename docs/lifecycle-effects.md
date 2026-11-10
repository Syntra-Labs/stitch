# Model-owned host lifecycles

`app/src/Stitch/Effects.lex.tex` supplies the transition admissions used by the
live transport, DNS publisher and VM. `src/layer1-uor/effects.js` projects their
existing state into source-derived bindings. It does not keep a second effect
journal, allocate substitute identities, infer provider success, or refund
resource charges.

## State and effect correspondence

| Runtime | Existing state projected | Source-owned decision | Host observation that remains external |
| --- | --- | --- | --- |
| `WebRtcTransportNode` | Session generation, closed flag, actual topic and local/remote peer IDs | Close/open generation updates, signal admission, peer capacity and callback continuation | Browser peer-entry and DataChannel object identity, RTC events and networking |
| `PointerPublisher` | Scoped retained outcome, exact pointer digest and provider record ID | Candidate/read correlation, create/update/reconcile/wait/refuse, uncertain write completion | Complete provider listing, TXT shape, cryptographic verification and provider response |
| `LinuxVmNode` | Boot generation and one phase: idle, booting, ready or failed | Explicit boot/retry, current-instance callbacks, failure invalidation and readiness transition | Asset loading, emulator instance identity, observed guest prompt and guest execution |

Identifiers are encoded as exact UTF-16 code units for equality. UTF-8 encoding
would collapse distinct JavaScript strings containing lone surrogates. No
sanitized relay topic, truncated digest, object display name or invented token
substitutes for the identities used by a particular runtime operation.

## Transport

Every captured callback binds its generation, topic and local peer. Peer and
channel callbacks additionally bind the remote peer and the captured live object.
The source consumes explicit object-identity facts computed at the adapter
boundary; it cannot inspect or authenticate a browser object itself. A reconnect
increments generation even when joining the same topic. Cleanup invalidates the
session before closing browser objects, which can synchronously invoke callbacks.
Pending offer/answer continuations recheck admission after each asynchronous step.

These rules do not authenticate a remote peer, implement a signaling standard,
or establish delivery. Peer limits and message/timer bounds are operating policy.

## DNS

Publication is scoped by zone, DNS name and independently pinned authority key.
A retained unknown write permits only a read for the same candidate. A complete,
verified read of that exact candidate can reconcile it even after its validity
window. An absent or still-predecessor record never proves that an earlier write
was not applied. New mutations require a current validity window and either a
bootstrap pointer or an exact predecessor with the next revision. A retained
provider record ID cannot silently change.

The publisher enters unknown before calling the write adapter. The built-in
adapter marks a thrown validation/admission refusal `effectDispatched = false`
only before invoking `fetch`. Such a definite local refusal permits a later
explicit retry without refunding already charged work. An unclassified exception,
lost response, malformed response or mismatched provider ID remains unknown.
Contradictory acknowledged/refused observations also remain unknown in the model.
No write is automatically retried. Provider rejection allows an explicit retry.

The resolver adapter must establish listing completeness and record shape before
supplying read facts. The pointer verifier must authenticate full pointer bytes
against the pinned authority. Source contracts do neither. The optional session-local publisher is not restart-safe. The browser binds the
origin-local journal described below; neither mode establishes atomic provider CAS,
cross-device serialization, durable retention, DNS propagation, or global order.

## VM

A boot or explicit retry increments generation. Missing assets, constructor
failure, download failure and the configured readiness deadline move booting to
failed and invalidate listeners before cleanup. Another boot cannot begin while
booting or ready. Readiness and failure callbacks require the current generation;
readiness also requires the current emulator instance and an observed guest
prompt. Failed generations cannot resurrect readiness. Object mirrors recheck
the same instance after asynchronous writes.

The deadline bounds the host's readiness wait, not guest initialization or
correctness. A shell-command timeout reports unknown completion and does not
claim to cancel the guest command. A separate 1–300s whole-VM runtime allowance
continues after observation ends. Explicit cancellation after dispatch, filesystem
quota rejection or result-size refusal requests a whole-VM stop, revokes bridges
and retains unknown prior effects. Guarded local-9p allocation and bounded result
reads are installed before emulator run; see [VM administration](vm-administration.md).
The lifecycle is separate from the deterministic
ring replay model; changing only lifecycle policy preserves that replay execution
identity while changing exact source provenance.

## Verification boundary

The source includes universal stale-session, stale-VM and unknown-DNS policy
obligations. Only actual pinned LexLean/Lean verification establishes their proof
status. Generated JavaScript bindings and mutation tests are implementation
conformance evidence, not a compiler or whole-browser proof.

`tests/effects-model.test.js` checks independent finite lifecycle oracles and
plants source defects, regenerates bindings, and runs the real transport, DNS and
VM regression suites. The planted defects cover stale sessions, replaced channels,
repeating unknown DNS writes, stale VM callbacks and duplicate boot admission.
The existing lifecycle tests cover interrupted continuations, explicit retries,
cleanup reentrancy, exact provider IDs, local refusals and unknown outcomes.

## Frozen C1 measurement

The diagnostic connection trial uses the existing frozen contract version 1.1.0:
an ordered channel and ten consecutive heartbeat completions within ten seconds
from connection-attempt start. Source progress tracks only locally issued probes
whose echo matches the current generation, peer entry, channel, sequence, timestamp
and monotonic issue order. Incoming pings, duplicate pongs, old sequences and
after-deadline responses cannot contribute. A sequence gap starts a new run.

The ordinary five-second heartbeat cadence is unchanged and will normally fail
this diagnostic criterion. The diagnostic deadline records failure without
closing the channel or restricting normal operation. No benchmark traffic is
added. Direct-path success additionally requires observed selected-candidate-pair
stats covering both local and remote candidate types. Missing stats or a relay at
either end is not direct-path success. The local stats wait has a one-second
operating bound; it does not extend the ten-second heartbeat window.

The logger checks coherent ordered/count/window/setup/path evidence instead of
trusting a success Boolean. Threshold satisfaction is labeled `THRESHOLDS_MET`,
not verified WebRTC conformance. Physical network-pair classification and browser
stats correctness remain external observations. These tests do not establish the
frozen contract's required live trial corpus.

VM canonical filenames now retain all 64 hex digits of the SHA-256 object root.
Optional human label aliases use a disjoint prefix and also retain the full root,
so shortened root prefixes or sanitized labels cannot overwrite a different
object. Guest file writes snapshot bytes before asynchronous calls. This is not
a proof of guest isolation or a change to the VM's opt-in controls.

## Origin-local signing authority and publication journal

The browser now uses `BrowserAuthorityStore` and an IndexedDB `records` store.
Saved authority setup is explicit. The private Ed25519 `CryptoKey` is
nonextractable and stored using the browser's structured-clone algorithm, never
serialized as secret bytes. Restoration validates the key type, usages and
public/private correspondence. Missing or invalid storage never creates or
rotates a key. Concurrent setup transactions keep the first committed authority.
Session-only key creation remains an explicit alternative. There is no private-key
export, import, rotation or backup flow; ordinary recovery bundles exclude keys.
Changing trust anchors remains an independent administrative decision.

DNS publication in the browser requires this journal even with a session-only
signing key. The prior exact zone/name/pinned-key record is loaded under the Web Lock.
Provider reads, signature/record validation and local resource admission occur
before any unknown claim. Immediately before invoking the write adapter, one
transaction commits the signed candidate, observed provider record ID, owner and
unknown outcome. Failed reads, exhausted admission and aborted intent commits
therefore do not invent an uncertain external write or prevent a repaired explicit
retry. A provably undispatched adapter refusal is settled by its owned transaction;
if saving that refusal fails, the committed intent remains unknown. A scoped browser Web Lock spans each provider operation and journal settlement,
so a live suspended writer cannot be mistaken for an interrupted owner. The browser
releases that lock on context termination; if Web Locks is unavailable publication
is blocked. A competing tab then sees unknown and can only reconcile the retained exact
candidate, not claim a new mutation. No lease timeout or owner-tab interruption
allows another write. A definitive owner result may settle the claim; any tab may
settle an authenticated exact-candidate read. A prior published record cannot be
downgraded by a late refusal. Failure to save completion keeps the earlier unknown
intent. A crash after the write-ahead commit but before dispatch is conservatively
unknown too: absence is not proof that an earlier operation did not execute.

The setup panel explicitly loads a scoped saved publication after restart. This
allows read-only reconciliation without possession of the private signing key or
live object bytes. It does not automatically import a retained observer head or
assert that a provider record is globally current. Credentials are call-local;
neither tokens nor private keys enter the DNS journal.

`authorityMayCreate`, `journalMayClaim`, and `journalMayFinish` in
`Stitch.Effects` are bound directly by this runtime; `Product.Experience` owns the
explicit setup/load action descriptions. The transaction adapter and cryptographic
checks are external host observations, not consequences of those Boolean proofs.

IndexedDB success is origin-local retention, not a durability promise. Quota,
private browsing, eviction, clearing storage, device loss and untrusted same-origin
scripts remain risks. Storage failures block new publication rather than silently
falling back to session-only mutation. Clearing a journal is not reconciliation.
There is no application control to delete unresolved intent. This is not atomic
provider CAS, cross-device coordination, exactly-once provider execution, global
DNS ordering, or a substitute for a recent independently trusted pointer anchor.

`tests/browser-authority.test.js` uses an isolated synthetic serialized transaction
adapter for crashes, failed commits, concurrent callers and key restoration. It
is not a real browser IndexedDB or quota/eviction qualification. Supported-browser
storage behavior and provider trials remain required before release claims.
