# Stitch

Recover exact objects and resume deterministic computation while the available peers change.

Stitch retains its five layers: object/ring operations, scheduling, storage, compute, and transport. A Prism/LexLean model defines the state and acceptance rules across those layers. The browser applies model-derived admission predicates and independently checks bytes and execution before accepting them.

## What changed

- **Objects have full cryptographic commitments.** Canonical manifests bind raw encoding, byte lengths, indexed XOR fragments and every required dependency. Legacy FNV addresses remain in regression/conformance simulations.
- **Placement is explicit.** Requested transfers are not stored copies. Acknowledgments bind checked fragment bytes to a request and holder. Committed placement, superseded copies and expiry are accounted separately. Different peer IDs do not prove independent failure domains.
- **Jobs carry their program and input.** Every checkpoint is digest-checked and semantically replayed through model-derived ring operations. A well-formed but impossible state is refused. This does not certify arbitrary Linux VM effects.
- **Pointers have a single-writer contract.** A separately pinned Ed25519 authority, full object root, exact revision/predecessor and validity interval are required. Observer-local admission is not consensus.
- **Policies propose; admission enforces limits.** Multidimensional budgets reserve before effects. Ambiguous effects remain charged. The live refresh scheduler uses elapsed monotonic time and enforces its own cap.
- **Host failures have explicit recovery paths.** Mesh generations reject stale callbacks, DNS publication reconciles unknown writes before another mutation, and failed VM startup can be explicitly retried.
- **The operator interface follows modeled journeys.** Only relevant controls and evidence appear for the current journey; uncertain publication has a distinct reconciliation action.
- **Internet formats are implemented at the byte boundary.** JCS input/encoding, DNS-message DoH and bounded ntfy framing replace the earlier partial formats. Concrete interoperability tests remain distinct from browser/provider qualification.
- **The public relay is opt-in.** Publishing sufficient fragments or a checkpoint discloses its content. A channel name is not a privacy control.

See the [operator journeys](docs/operator-experience.md), [lifecycle bindings](docs/lifecycle-effects.md), [JCS codec](docs/canonical-json.md), [DNS client](docs/dns-client.md), and [relay framing](docs/relay-framing.md).

Read the [model contract and evidence boundaries](docs/prism-model.md), the [product projection and host contracts](docs/product-projection.md), and the [vendor provenance findings](docs/vendor-provenance.md). [Historical benchmarks](docs/legacy-benchmarks.md) remain available with their limitations. The existing [falsification contract](CONTRACT.json) is retained rather than relabeling simulation as network proof.

## Run and test

Node.js 22 or later:

```sh
npm ci --ignore-scripts
npm test
python3 scripts/verify-custody.py
make serve
```

Open `http://localhost:8080`. Join a mesh to exchange data with peers. Enable the public relay only for intentionally public demonstration data. Fewer than three eligible remote peers means partial placement, not fabricated redundancy.

The original Rust UOR conformance check is `cargo test --locked`. Both the Node/Python runtime checks and Rust conformance passed in [the initial fork CI run](https://github.com/afflom/stitch/actions/runs/42797265770); that historical formal SDK stage did not pass. The expanded 23-module source has now passed actual pinned LexLean/Lean/leanchecker/axiom verification, recorded in [the exact-source summary](product/source-verification.json) and [actual verifier attestation](product/source-attestation.json); native Prism artifacts and real-host qualification remain separate pending stages. This is still an unqualified development checkpoint. `make test` runs Node and Rust checks. JavaScript tests use deterministic in-process transports, not physical WebRTC/NAT trials.

## Model and verification

- `app/src/Stitch/`: typed domain models and theorem obligations.
- `app/src/Product/`: complete component/flow, capability, deployment and dependency contracts, projected through the official architecture facet.
- `product/contracts.json`: source-bound project-owned contract/asset inventory, not a certificate.
- `app/language/`: versioned project vocabulary using LexLean extensibility.
- `src/layer1-uor/generated-model.js`: pure behavior extracted from the model with exact source binding. It is an application adapter, not a replacement Prism compiler or proof certificate.
- `scripts/check-model.mjs`: validates/regenerates the adapter and detects drift.
- `prismpm.lock`, `standards.lock`: exact SDK/standards pins from the official Prism template.
- `.github/workflows/prism.yml`: runtime conformance and SDK model verification on the submitted revision.

```sh
node scripts/check-model.mjs
sh scripts/check-model-sdk.sh
```

The second command requires the pinned SDK environment. It must run real LexLean/Lean and PrismPM gates; extraction or runtime tests alone do not establish that theorems compiled. No externally hosted verifier is required. Formal acceptance is reported only from an actual successful SDK run.

## Nonclaims

SHA-256 and Ed25519 establish integrity and signature validity under their security assumptions, not retention or honest peer identity. DNS is discovery, not globally ordered state. The browser VM, STUN, WebRTC, DNS, signaling, relay availability and clocks remain modeled host boundaries.

This implementation does not claim private relay storage, persistence after total information loss, exclusive job ownership during partitions, exactly-once effects, multi-writer consistency, optimal scheduling, or storage inside internet routers. New encodings, policies and transports must preserve admission obligations and disclose dependencies.

## License

Project source: MIT © [Syntra Labs](https://github.com/Syntra-Labs). Bundled third-party assets retain their respective licenses; see the [provenance and packaging status](docs/vendor-provenance.md) before redistribution.
