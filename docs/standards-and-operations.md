# Standards and operational completion

Stitch's model must describe the delivered product, not merely its pure probe or a collection of claims. Referenced standards are implemented for the actual selected role, including applicable error, lifecycle and interoperability requirements. A runtime test, a source theorem and an external-provider observation answer different questions.

## Standards roles

| Reference | Stitch's role and evidence boundary |
|---|---|
| RFC8831 / RFC8825 | Browser WebRTC application. The browser supplies ICE, DTLS and SCTP; Stitch owns signaling, channel lifecycle, message framing, flow control and qualified connection evidence. No independent peer identity or NAT success is inferred from a channel event. |
| RFC8656 | TURN is an optional browser/provider dependency, not a Stitch TURN server. The frozen direct-connect experiment disallows TURN success; that experiment does not block ordinary connectivity. |
| RFC8484 | Real application/dns-message stub client, with HTTP/DNS response/error handling and bounded DNS decoding. See dns-client.md. Authoritative/recursive server and local DNSSEC-validation roles are not claimed. |
| RFC8032 | Ed25519 is delegated to WebCrypto, while Stitch owns signed bytes, exact field validation and trusted-authority/revision admission. No Ed448 or unused signature variant is claimed. |
| RFC8785 | JCS encoding and strict I-JSON input validation. See canonical-json.md. Application integer schema constraints are distinct from the complete binary64 codec. |
| RFC9162 | The original concept cited an optional Merkle-pattern inspiration. Stitch does not claim to operate a Certificate Transparency v2 log merely because that reference exists. |
| ntfy and Cloudflare API v4 | Provider protocols with explicit quotas, disclosure and outcome uncertainty. They are not interchangeable with an IETF standard or a permanent retention guarantee. |
| Prism/LexLean and the SDK standard lock | Exact selected compiler/profile/oracle obligations remain required. The 44 locked authorities and 18 SDK oracle entries are available toolchain metadata, not 44 application compliance certificates or a request to add unrelated Kubernetes/OIDC features. |

Primary sources: [RFC8831](https://www.rfc-editor.org/rfc/rfc8831.html), [RFC8825](https://www.rfc-editor.org/rfc/rfc8825.html), [RFC8656](https://www.rfc-editor.org/rfc/rfc8656.html), [RFC8484](https://www.rfc-editor.org/rfc/rfc8484.html), [RFC8032](https://www.rfc-editor.org/rfc/rfc8032.html), [RFC8785](https://www.rfc-editor.org/rfc/rfc8785.html), [RFC9162](https://www.rfc-editor.org/rfc/rfc9162.html), [ntfy publishing](https://docs.ntfy.sh/publish/), [Cloudflare DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/).

## Operational work still required

These are actual unfinished implementation/qualification items, not ceremonial gates or a declaration that the product is complete:

1. **Retain and restore the right information.** Validated object/job evidence export/import and explicit recent-anchor recovery are now implemented in the recovery journey. Explicit origin-local nonextractable signing-key setup/restoration and transactionally claimed unknown-write journals are now implemented. Their real supported-browser persistence, eviction and multi-tab qualification remains required; there is no private-key backup or cross-device recovery. A zero-disk peer remains possible, but recoverability cannot survive loss of every required byte, key and anchor. Browser storage needs quota/eviction/backup handling rather than a durability promise.
2. **Complete channel interoperability.** Negotiated DataChannel sizing, versioned fragmentation, bounded queues and backpressure are implemented. Ed25519 key-bound session signaling, replay rejection and arrival-ordered RTC admission are implemented; real supported-browser/physical-network qualification remains. Neither the DataChannel adapter nor ntfy framing certifies all SCTP/browser behavior.
3. **Qualify guest administration.** Explicit object/Ethernet grants, stop/destroy quarantine, instance-bound command handles, unknown-outcome reconciliation and resolved-evidence disposal are implemented. Actual browser/VM qualification remains. The browser cannot establish VM isolation from a Boolean model observation.
4. **Resolve distribution provenance.** The original guest image still lacks full kernel/Buildroot/package source materials. The four v86/BIOS assets have resolved origins and accompanying notice/source packages; preserve those materials in distributions. A pinned guest replacement recipe is prepared but not built or qualified. Do not substitute a successful boot for source/license evidence.
5. **Qualify the integrated product.** The exact source proof, runtime/independent vectors, native Prism artifact gate, browser journeys and relevant provider/VM trials must name the revision they tested. Do not rerun identical work redundantly or convert simulations into physical measurements.

See [recovery](recovery.md), [channel flow](channel-flow.md) and [VM administration](vm-administration.md) for implemented operational contracts and their limits.

Changes so far correct reproduced defects: DNS response association, C1 false success, truncated guest identity, excessive provider message size and partial canonical JSON. Their tests belong with the implementing code. This document does not defer the remaining product requirements; it keeps them visible until implemented and demonstrated.
