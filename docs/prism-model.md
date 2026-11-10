# Stitch model and implementation contract

## Authority and scope

The project-owned LexLean modules under `app/src/Stitch/` define pure domain semantics. A project vocabulary extension names the domain; Foundation byte/application modules supply Prism interfaces. This is not a fixed-choice classifier. Integrity, authority, reconstructibility, execution, resources, evidence and observed availability are distinct.

The modeled surface covers objects, encodings, fragments, custody, observations, resource admission, pointer succession, pure computation, checkpoint linkage, evidence and their composition. Completeness means coverage of these contracts and explicit boundaries, not a proof of the internet or browser/VM implementation.

The official skill was discovered through https://uor.foundation/agents.md and its skill index. The website snapshot describes 0.2.0; this repository pins published `prism-code` 0.7.2 and uses its current bundled skill/API. The SDK is separately digest-pinned. `afflom/verdant-resonance` informed modeling depth, without importing garden-specific constants, controllers or Rule 30 mechanisms into a network protocol.

## Domain map

| Domain | Invariant / boundary |
|---|---|
| Identity | Distinct immutable object/encoding/manifest commitments; SHA-256 collision resistance is assumed |
| Encoding | Exact decoding and indexed compatible 2-of-3 XOR fragments; every external basis must be declared |
| Custody | Requested/acknowledged/committed/failed/superseded copies; a peer retention assertion is not a storage oracle |
| Observation | Time-bounded observer evidence; timeout means reachability loss, not death or an omniscient global view |
| Budget | Independent resource bounds, reservation before effects, no refund for unknown outcomes |
| Pointer | Pinned writer, exact successor/predecessor, half-open validity interval; retained observer head is required |
| Compute | Identified program/input/model, bounded step, semantic replay and checkpoint links; no VM effects |
| Evidence | Evidence reuse binds model/artifact/subject roots, exact claims, assumptions, ordered dependencies, permitted effects and finite observation horizons |
| System | Composition preserves admission conditions and never treats an attempted effect as completed |

## Object wire contract

`src/layer1-uor/custody.js` implements RFC 8785 JCS canonicalization over finite IEEE 754 binary64 numbers, Unicode scalar strings and UTF-16-sorted object names, with UTF-8 output. Negative zero serializes as zero; NaN and infinities are refused. `parseCanonicalJson` rejects duplicate names (including escape-equivalent names) before signature processing. Accessors, custom prototypes, hidden fields, invalid Unicode and explicit resource-budget excess are refused. Application schemas independently reject unknown fields, fractional revisions and malformed digests. See [canonical JSON](canonical-json.md) for standard coverage, compatibility and evidence boundaries.

Each hash frames a versioned ASCII domain, unsigned 64-bit big-endian payload length and exact bytes. Object, encoding, fragment and manifest domains differ. A fragment binds its encoding digest and unsigned index. A manifest never hashes its own digest field. Initial encoding is raw, self-contained bytes; unsupported dependencies/encodings fail closed.

XOR splits bytes into two equal-sized halves, padding only the last half, with their XOR as the third fragment. Recovery validates two different compatible indices and full fragment commitments, reconstructs the declared length, then checks object and encoding digests. Empty/odd-length inputs and every pair are covered independently in Node/Python vectors.

The sender may retain the full original while remote peers hold distinct fragments. Thus 1.5× is a nominal coding ratio, not total physical storage. A placement carries a typed receipt per copy. Recovery is evaluated at the stated time from live, authenticated, exact-manifest/exact-fragment receipts on distinct holders, not a caller-supplied committed flag. Migration activation requires its still-live current-epoch ledger reservation and the exact request root. Superseded copies remain accounted until release. Retrieval copies and public-relay copies are additional. Peer IDs do not prove physical failure-domain independence.

## Mutable pointers

The v1 body contains `version`, `name`, `authorityKey`, `revision`, `previousDigest`, `objectRoot`, `validFromMs` and `validUntilMs`. Signature bytes cover a domain label and canonical body. The pointer digest covers body and signature. Bootstrap requires revision zero, no predecessor and an independently supplied trusted authority. A successor is exactly current revision plus one and binds the retained pointer digest. Validity is `from <= now < until`.

Conflicts/stale updates are refused. A client that loses its trusted head needs a separate independently trusted exact recent anchor to prevent rollback. Import and acceptance alone never change a live head. Explicit local restoration reads only the accepted vault anchor, rechecks signature/validity and exact pinned name/key/digest, and restores only an empty or identical head. Restoration shares ordinary admission's serialized CAS; any different retained head refuses, even a newer accepted anchor. Normal exact successor admission then resumes. Key rotation/revocation and multi-writer rules are not implicit extensions. The DNS UI requires explicit authority pinning, keeps an observer head for strict successor checks, and uses multipart Cloudflare TXT records for full pointers. The local key and trusted head are session-only; a durable deployment requires persistent trusted anchors. The legacy single-255-byte DuckDNS path is refused for full pointers. Publication retains provider record identity and reconciles uncertain writes by bounded exact reads. An unresolved create/update is not repeated blindly; an exact signed match resolves uncertainty. Successors update the existing record. This is not provider-atomic compare-and-swap or global ordering.

## Pure jobs and checkpoints

Version 1 programs specify width (8/16/32/64/128), exact input and all instructions. Values use canonical lowercase unsigned hex. The full-width ring operations include modular POW. Version 1 DIV/MOD by zero yield zero, preserving the legacy interpreter. Version 2 adds explicitly capacity-bound, width-tracked byte-sequence CONCAT, all byte-aligned result widths, empty sequences, mixed-width arithmetic and 8-bit comparisons. Version 2 DIV/MOD by zero are refused. Source semantics, upstream profile differences and exact versioned records are documented in [UOR primitives](uor-primitives.md).

Local policy bounds programs to 1,024 instructions and 1,000,000 abstract work units. Version 2 terms additionally have a tested 32768-bit parsing/memory envelope and explicit program capacity. These are resource bounds, not upstream semantic limits. Work counts modular multiplication rounds, bitwise width, limb complexity and CONCAT bytes rather than treating wide POW as one cheap instruction. Program/input identity, model identity, step, state and predecessor bind checkpoints. Every checkpoint is replayed from input, including when network checkpoints were missed. Direct successors bind the retained predecessor. An independently replayed snapshot with an unavailable predecessor reports its chain link unchecked.

Checkpoint `modelDigest` identifies the reachable ring/checkpoint definitions and types, the generated evaluator, and the transitive JavaScript replay adapters under `stitch/execution-semantics/v1`. Canonical syntax determines the model portion, so proof formatting or unrelated product changes do not invalidate the same execution. Adapter bytes are deliberately conservative: any adapter change invalidates that execution identity. `MODEL_SOURCE` separately retains exact whole-source/vocabulary provenance. Legacy whole-source checkpoint roots are not implicitly accepted.

Typed digest observations bind every exact program, input, job, state and checkpoint field to its distinct domain and an independently supplied expected model root. This assumes the host hashes the exact typed input using the declared versioned canonical encoding. The model does not implement SHA-256, prove collision resistance or authenticate an observation producer; wire-byte-to-record correspondence remains a host contract. Legacy root-only predicates check replay, not commitment admission.

Partitions can cause duplicate pure computation. There is no exclusive execution or exactly-once external effect claim. VM output can be stored as an object but is not a semantically verified ring job.

## Policies and effects

Budgets keep request count, transfer bytes, stored bytes and compute steps separate. The caller supplies epoch/time interval/nonnegative limits. The ledger is the sole modeled resource authority, with immutable action IDs, epoch-bound reservations and per-resource aggregate validation. Reservations are immutable; duplicate action IDs fail. Unknown outcomes remain charged. Settlement reduces cost only when actual expenditure is known and within the reservation. A known expenditure observation permits settlement only within the ceiling, and is not proof of delivery or storage. The host must durably retain and serialize the ledger; scalar helpers are compatibility arithmetic, not effectful admission. Clock regression and expired epochs fail closed; a new epoch requires a deliberate new budget.

The browser exposes all operational limits and duration. Only the explicit Start New Epoch action grants another allowance; prior reservation ledgers remain retained and exportable. Renewal preserves stored objects, jobs, authority pins and trusted pointer heads and does not retry pending work. The browser shares one explicit admission controller across transport, storage, computation, and DNS. It bounds application requests and UTF-8 payload ceilings, cumulative cache allocation, and replayed abstract compute work. It does not meter TLS, ICE/STUN, VM, browser or operating-system overhead. The default ten-minute epoch is configurable and never resets or refunds automatically; exhaustion is an explicit refusal, not evidence of indefinite service.

The survival heuristic remains an experimental proposal. Browser evaluation uses monotonic elapsed time and an internal cap. One favorable churn schedule does not establish optimality or a universal Poisson model.

## Evidence register

| ID | Claim | Required evidence |
|---|---|---|
| ST-OBJ | Compatible fragment pairs recover committed bytes | Formal XOR relation, independent vectors, tamper refusals |
| ST-CUSTODY | Unacknowledged transfer is not committed; a live bound receipt and exact ledger reservation are required before replacement activation | Admission predicates, transition/expiry/superseded-copy tests |
| ST-BUDGET | Admitted reservations stay within every bound | Nat arithmetic theorem, boundary/duplicate/clock/settlement tests |
| ST-POINTER | Accepted successor is fresh, ordered and authorized under a supplied anchor | Successor theorem, signatures/wrong-key/replay/conflict tests |
| ST-JOB | Accepted checkpoints match replay; resume equals uninterrupted execution | Transition/link theorems, all-op/all-width/every-cut tests |
| ST-HOST | Evidence reuse requires exact typed scope and dependency bindings | Modeled boundary and concrete receipts; field trials remain required |
| ST-BINDING | Runtime functions match their source | Strict extractor, source digest, freshness and independent differential tests |

Evidence labels are not attestations: comparing KernelChecked or HostAssumptions fields does not prove the producer authenticated them. Exact dependency-root and ordered-snapshot checks do not discover unknown dependencies.

Formal status comes from the actual exact-revision SDK job, not this table. Node/Python conformance proves neither the browser nor a live network. The gate must publish the exact model lock, verification report and built artifact identity before a release proof claim. Handcrafted holos and invented attestations are prohibited.

## Reproduction and negative tests

`npm test` checks generated freshness, baseline regressions and adversarial contracts. `python3 scripts/verify-custody.py` independently checks wire vectors. `cargo test --locked` checks original UOR conformance. `sh scripts/check-model-sdk.sh` runs formal acceptance inside the locked SDK. CI uses the same source revision.

Tests alter fragment bytes, manifests, checkpoint states with recomputed digests, links, signers, revisions and budgets. Correctly hashing a forged state is not enough: semantic replay must reject it. Generated drift must fail before execution. These are deterministic tests, not physical three-peer reliability measurements.

## Extending Stitch

New encodings specify exact decoding and all dependencies. New effects expose request/acknowledgment/commit/unknown states. Policies may propose choices but cannot bypass resource/safety admission. Extend LexLean semantics first, add positive and negative vectors, regenerate bindings and pass SDK/runtime gates. Do not introduce random weights or unrelated cellular automata merely to make a model appear richer.
