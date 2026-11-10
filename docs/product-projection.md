# Complete Stitch product projection

## What is represented

`app/src/Product/Model.lex.tex` is the project-owned typed product graph. Its
`product` value contains 18 components, 14 capability contracts, 11 named
external assumptions, 11 dependencies, two deployment descriptions and 21
artifact declarations. `valid` checks identity uniqueness, component-to-asset
closure, capability ownership and assumption closure, dependency consumers and
deployment capability references. `productGraphIsClosed` states the concrete
structural acceptance obligation. These counts describe the current graph;
they are not policy scores, reliability measurements or limits on extension.

The graph covers all five Stitch layers and the actual browser product:

- Canonical objects, encodings, XOR fragments, local cache, conditional peer
  custody, migrations and recovery.
- Experimental scheduling proposals under independent resource admission.
- Deterministic programs, checkpoint replay, transfer and resumption.
- Independently pinned pointer authority, full pointer DNS serialization,
  DoH reads and scoped DNS writes.
- Browser DOM, WebCrypto, elapsed and wall clocks, session RAM, WebRTC,
  same-origin BroadcastChannel and public signaling.
- Separately enabled public payload relay and its disclosure boundary.
- v86, WebAssembly, BIOS, Linux guest image, 9p object-file mirroring, shell
  output and Ethernet forwarding.
- Same-origin static publication and every currently loaded local asset.
- Historical simulation/Rust conformance, distinguished from the live product.
- Native Linux routing as an explicitly unsupported browser boundary.

`Product.Host` defines typed requests, destination/content/session-bound grants,
pending effects and matching terminal host observations. Admission reserves the
existing action-ID budget ledger before appending a pending request. Pending
requests do not create observations. Observation binding checks the action ID,
capability, subject, destination, session and non-regressing observation time.
Repeated or wrong-session completions are refused; recording a success, failure
or unknown outcome never refunds the ledger. These are pure contracts, not a
new browser driver or a claim the handwritten runtime already implements this
entire journal. Domain acceptance remains necessary after a host response.

The host contract does not accept an arbitrary boolean as proof of storage,
cryptography, propagation, guest execution or retention. Its authorization flag
is an externally supplied grant observation with an explicit exact scope. The
host is responsible for obtaining that grant, serializing transitions and
retaining its journal. A source theorem cannot authenticate a host assertion.

## Tested host-transition correspondence

The implementation uses existing component state rather than a second generic
budget or journal. Focused interruption tests now exercise these refinements:

- Transport fences signaling, ICE, sockets, peer replacement and data-channel
  callbacks with exact channel and generation identity. Switching or reconnecting
  a mesh invalidates old asynchronous work before cleanup.
- DNS publication retains destination/pinned-authority-scoped candidates and
  provider record identity. Bounded exact reads precede writes. An uncertain
  create or update permits reconciliation reads, not a blind repeat; signed
  matching content confirms the observed result. Tokens are not retained in
  publication state. Provider acknowledgement is neither DNS propagation nor
  atomic compare-and-swap.
- VM startup has constructor/download/readiness failure transitions and a
  configurable finite deadline (60 seconds by default). Cleanup permits explicit
  retry, and generation identity fences old callbacks. Cleanup is best-effort,
  not proof that host downloads stopped. A command timeout means its completion
  is unknown, not that the command was cancelled.
- Serialized storage/compute ingress, immutable reservations, retained pointer
  heads and explicit resource-epoch renewal implement their corresponding local
  admission boundaries. Unknown effects do not refund previous charges.

`tests/transport-generation.test.js`, `tests/dns-publication.test.js`,
`tests/vm-lifecycle.test.js` and the browser-script harness in
`tests/runtime-admission.test.js` cover these concrete paths. They do not prove
universal runtime refinement of `Product.Host`, physical browser/NAT behavior,
or the host's cryptographic/grant attestations. The full contract's typed grant
roots and complete terminal-observation journal remain specification boundaries,
not claims about mechanisms absent from the runtime.

## Official Prism representation and the supported route

The official `Foundation.Arch` facet represents the complete component and flow
view through `app/src/Product/Architecture.lex.tex`: 18 components, 31 directed
flows, an operator, a recoverability concern, a viewpoint and its view. All
indexes are derived contiguous positions in sorted declaration-identifier order.
There are no invented quality scores, thresholds or measured availability rows.

The type-only `app/src/Foundation/Arch.lex.tex` subset comes from the official
[PrismPM Foundation.Arch source](https://github.com/UOR-Foundation/PrismPM/blob/fe5b8b73a94134c316329a8d1b09ebc97b555c5f/stdlib/src/Foundation/Arch.lex.tex).
The complete original source is 8,959 bytes with SHA-256
`9a79e4912d33b1736d7451ab726ed0a83d958b8d9c70091a749fbc70acd48cdc`.
Only the architecture record/enumeration types through `View` are retained;
SDK demonstration values, classes, instances and later design-view types are
omitted. The title uses the existing local glossary. This preserves the
qualified type names the official projection registry recognizes and does not
modify the SDK projection mapping. The upstream project offers MIT OR Apache-2.0. This subset is used under MIT;
its original notice is retained in `product/PRISMPM-LICENSE-MIT.txt`.
The application continues using its existing digest-pinned SDK; this reference
inspection does not upgrade or replace `prismpm.lock`.

The official
[specification sections 2 and 11](https://github.com/UOR-Foundation/PrismPM/blob/fe5b8b73a94134c316329a8d1b09ebc97b555c5f/SPEC.md)
explain the limit of the currently supported containing-system profiles:

- `prismpm/system-model/2` is a static generated DOM/WebAssembly browser
  application with **no persistent storage and no external application
  services**. The specification explicitly says empty Holo capabilities do not
  admit browser-effect requirements. It cannot truthfully contain full Stitch.
- `system-model/1` is the transactional production-service profile, not an
  arbitrary browser product graph.
- `system-model/3` is a separate host-effect server service with loopback-only
  Linux/Compose deployment. It is not a WebRTC browser profile and does not
  automatically supply whole-product release/replay or deployment acceptance.

Accordingly, the supported implementation is the project-owned complete typed
product contract plus the official architecture facet projection, with the
existing pure `StitchApp` as the selected TextApplication conformance probe.
No field claims a browser capability grant, and no custom `system-model` JSON
or fabricated product release is introduced. The probe's kernel/artifact
acceptance, when actually obtained, covers that selected pure core and its
stated source obligations, **not the complete live browser implementation**.

## Exact local assets, dependencies and unresolved provenance

`product/contracts.json` is an application-owned contract register, not an
SDK input schema, Holo, signed attestation, build receipt or certificate.
`scripts/check-product.mjs` reads closed literal rows from the model and binds
all formal source, local vocabulary/configuration, SDK and npm locks, and the
exact byte length/SHA-256 of every declared local product asset. It checks
cross-reference closure and refuses omitted browser assets. It does not compile
LexLean or prove the runtime implements a contract.

The inventory records existing v86 JavaScript/Wasm, SeaBIOS, VGA BIOS and Linux
image bytes. [The provenance review](vendor-provenance.md) establishes both BIOS
Git blobs against a pinned v86 tree and identifies SeaBIOS LGPLv3 source notices.
The exact v86 JS/Wasm build and complete Linux image source remain unidentified.
Notice/corresponding-source packaging is still unresolved, so all five remain
`redistributionCleared = false`.
`vendorRedistributionRemainsBlocked` states that concrete unresolved condition.
An asset digest proves identity of the inventoried local bytes, not ownership,
license, security or that a remote static host served those bytes. The current
browser does not verify every dependency against this inventory at load time.
A production redistribution release needs the original source/license notices
and provenance review for each vendor artifact.

External dependencies are API/host trust boundaries rather than fictional
immutable hashes: browser APIs, Cloudflare DoH/API, Google/Cloudflare STUN,
public ntfy signaling and optional cache, and the selected static origin.
Cloudflare tokens are secret references only; no token value belongs in the
model, inventory, evidence or repository. A provider's current availability,
API policy, DNS propagation or peer retention needs independent observation.

## Deployment and lifecycle contracts

The browser deployment is an ordinary same-origin static product, with the
complete local asset set and explicitly enabled network functions. A valid
static publication is not a successful browser readiness test. Probe-only
publication cannot replace the multi-panel Stitch UI. Rollback retains an
entire prior asset set; reloading a tab can lose RAM, local trusted anchors,
budget state and journals. The current product makes no crash-recovery or
persistent custody guarantee.

VM memory sizes and request ceilings already in the implementation are host
configuration, not derived kernel guarantees. VM boot/shell/Ethernet operations
are outside deterministic ring-job semantics and its compute-work accounting.
DNS provider acknowledgement is not resolver-wide freshness. A timeout is a
local observation, not peer death. Different peer identifiers are not evidence
of independent failure domains. Public signaling/relay topics are not access
controls, and sufficient relayed fragments reveal the object.

## Reproduce and evaluate

After an intentional model, runtime or configuration edit:

```sh
node scripts/check-product.mjs --write
node scripts/check-product.mjs --check
node --test tests/product-model.test.js
```

Review register diffs alongside the source changes. The checks cover stale
source/asset hashes, unknown capability owners and assumptions, missing assets,
unknown deployment capabilities, dangling architecture flows, noncanonical
indexes, relay opt-in removal, unsupported browser routing claims, literal
substitution and changed vendor bytes. Mutation tests do not establish network,
VM, browser or cryptographic correctness.

The sorted LexLean entrypoints `src/Product/Architecture.lex.tex` and
`src/Product/Model.lex.tex` are included in the same source graph as the domain and probe.
Run canonical formatting, source locking, LexLean check, Lean/leanchecker with
actual exact observed axiom policies, and the pinned PrismPM gate. Report each
stage separately. Neither the generated register nor `lexlean check` is a Lean
proof result; real kernel acceptance is distinct from full Prism artifact and
oracle acceptance. No external hosted verifier upload is required or authorized
by this documentation.
