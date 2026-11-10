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
| Evidence | A receipt does not silently expand the scope of its claim |
| System | Composition preserves admission conditions and never treats an attempted effect as completed |

## Object wire contract

`src/layer1-uor/custody.js` specifies the exact canonical JSON subset and hash frame. It is not unrestricted RFC 8785: only safe integer numbers are accepted. Accessors, custom prototypes, hidden/unknown fields, lone surrogates, malformed digests and oversized input are refused.

Each hash frames a versioned ASCII domain, unsigned 64-bit big-endian payload length and exact bytes. Object, encoding, fragment and manifest domains differ. A fragment binds its encoding digest and unsigned index. A manifest never hashes its own digest field. Initial encoding is raw, self-contained bytes; unsupported dependencies/encodings fail closed.

XOR splits bytes into two equal-sized halves, padding only the last half, with their XOR as the third fragment. Recovery validates two different compatible indices and full fragment commitments, reconstructs the declared length, then checks object and encoding digests. Empty/odd-length inputs and every pair are covered independently in Node/Python vectors.

The sender may retain the full original while remote peers hold distinct fragments. Thus 1.5× is a nominal coding ratio, not total physical storage. Superseded copies remain accounted until release. Retrieval copies and public-relay copies are additional. Peer IDs do not prove physical failure-domain independence.

## Mutable pointers

The v1 body contains `version`, `name`, `authorityKey`, `revision`, `previousDigest`, `objectRoot`, `validFromMs` and `validUntilMs`. Signature bytes cover a domain label and canonical body. The pointer digest covers body and signature. Bootstrap requires revision zero, no predecessor and an independently supplied trusted authority. A successor is exactly current revision plus one and binds the retained pointer digest. Validity is `from <= now < until`.

Conflicts/stale updates are refused. A client that loses its trusted head needs a separate recent anchor to prevent rollback. Key rotation/revocation and multi-writer rules are not implicit extensions. The DNS button remains a labeled session-key demonstration with full roots; production consumers use the pinned-authority API rather than mistaking self-verification for owner authentication.

## Pure jobs and checkpoints

Programs specify version, width (8/16/32/64/128), exact input and all instructions. Values use canonical lowercase unsigned hex. Operations are NEG, BNOT, SUCC, PRED, ADD, SUB, MUL, XOR, AND, OR, LE, LT, GE, GT, DIV and MOD. Arithmetic wraps. DIV/MOD by zero yield zero, matching the legacy interpreter. CONCAT/POW are refused.

Policy bounds programs to 1,024 instructions; this is a resource bound, not a theorem. Program/input identity, model identity, step, state and predecessor bind checkpoints. Every checkpoint is replayed from input, including when network checkpoints were missed. Direct successors bind the retained predecessor. An independently replayed snapshot with an unavailable predecessor reports its chain link unchecked.

Partitions can cause duplicate pure computation. There is no exclusive execution or exactly-once external effect claim. VM output can be stored as an object but is not a semantically verified ring job.

## Policies and effects

Budgets keep request count, transfer bytes, stored bytes and compute steps separate. The caller supplies epoch/time interval/nonnegative limits. Reservations are immutable; duplicate action IDs fail. Unknown outcomes remain charged. Settlement reduces cost only when actual expenditure is known and within the reservation. Clock regression and expired epochs fail closed; a new epoch requires a deliberate new budget.

The survival heuristic remains an experimental proposal. Browser evaluation uses monotonic elapsed time and an internal cap. One favorable churn schedule does not establish optimality or a universal Poisson model.

## Evidence register

| ID | Claim | Required evidence |
|---|---|---|
| ST-OBJ | Compatible fragment pairs recover committed bytes | Formal XOR relation, independent vectors, tamper refusals |
| ST-CUSTODY | Unacknowledged transfer is not committed; replacement preserves admitted coverage | Admission predicates, transition/expiry/superseded-copy tests |
| ST-BUDGET | Admitted reservations stay within every bound | Nat arithmetic theorem, boundary/duplicate/clock/settlement tests |
| ST-POINTER | Accepted successor is fresh, ordered and authorized under a supplied anchor | Successor theorem, signatures/wrong-key/replay/conflict tests |
| ST-JOB | Accepted checkpoints match replay; resume equals uninterrupted execution | Transition/link theorems, all-op/all-width/every-cut tests |
| ST-HOST | Evidence never implies properties beyond its scope | Modeled boundary and concrete receipts; field trials remain required |
| ST-BINDING | Runtime functions match their source | Strict extractor, source digest, freshness and independent differential tests |

Formal status comes from the actual exact-revision SDK job, not this table. Node/Python conformance proves neither the browser nor a live network. The gate must publish the exact model lock, verification report and built artifact identity before a release proof claim. Handcrafted holos and invented attestations are prohibited.

## Reproduction and negative tests

`npm test` checks generated freshness, baseline regressions and adversarial contracts. `python3 scripts/verify-custody.py` independently checks wire vectors. `cargo test --locked` checks original UOR conformance. `sh scripts/check-model-sdk.sh` runs formal acceptance inside the locked SDK. CI uses the same source revision.

Tests alter fragment bytes, manifests, checkpoint states with recomputed digests, links, signers, revisions and budgets. Correctly hashing a forged state is not enough: semantic replay must reject it. Generated drift must fail before execution. These are deterministic tests, not physical three-peer reliability measurements.

## Extending Stitch

New encodings specify exact decoding and all dependencies. New effects expose request/acknowledgment/commit/unknown states. Policies may propose choices but cannot bypass resource/safety admission. Extend LexLean semantics first, add positive and negative vectors, regenerate bindings and pass SDK/runtime gates. Do not introduce random weights or unrelated cellular automata merely to make a model appear richer.
