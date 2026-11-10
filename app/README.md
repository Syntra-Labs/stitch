# Stitch source model

This is Stitch's project-owned LexLean 1.2 model and `stitch.domain` language
extension. It is not a specification of the whole internet or a proof of the
browser, WebRTC, DNS, a relay, arbitrary VM effects, indefinite retention, or
policy optimality.

## Domain graph

- `Identity`: immutable canonical bytes, byte length, eight full 32-bit digest
  words, and domain/canonicalization-bound digest observations. The legacy
  truncated FNV address is not a cryptographic identity.
- `Encoding`: representation identity distinct from object identity, decoder,
  dependency kind/presence/integrity, exact byte recovery, and complete recovery
  byte accounting including external basis bytes.
- `Fragments`: indexed manifest-bound fragments; duplicate-index refusal;
  XOR bit-plane recovery from systematic/left-parity/right-parity pairs. The
  inductive bit-stream definitions cover every finite bit stream, rather than
  only one example object. Byte layout, padding and commitments have independent
  cross-language runtime vectors.
- `Custody`: requested, acknowledged, committed, failed and uncertain transfers;
  exact request/manifest/fragment/index/holder/lease receipt binding; distinct
  holders; and indexed migration/retirement transitions. Requests and uncertain
  transfers do not establish completed custody. A receipt is not proof of future
  reachability.
- `Observation`: observer-relative reachability, sequence and elapsed-time
  freshness. A timeout does not assert permanent death.
- `Budget`: four independent resource dimensions, monotonic elapsed epochs,
  reserve-before-effect admission and conservative settlement. Unknown outcomes
  retain their entire reservation. No heuristic can change the bound.
- `Pointer`: a pinned single writer, full successor/predecessor bindings, exactly
  one revision increment and half-open validity intervals. A signature-valid
  observation does not establish the authority of an arbitrary key.
- `Compute`: a concrete deterministic ring-instruction evaluator, all supported
  opcodes and widths, checkpoint program/input/model/predecessor/replay bindings,
  strict step advancement and uninterrupted/continued execution equivalence.
  POW uses bounded modular square-and-multiply. Version 2 typed programs add
  capacity-bound byte-sequence CONCAT and explicit result widths, including
  non-power-of-two widths and empty sequences. Version 1 DIV/MOD by zero retain
  Stitch's defined legacy zero result. See [primitive semantics](../docs/uor-primitives.md).
- `Effects`: correlated mesh/VM generations, DNS unknown-write reconciliation and honest C1 measurement transitions, bound to actual host callbacks.
- `Relay`: frame admission, assembly counters, deadlines, delivery and disclosure guards. Hash/UTF8 observations and the indexed-buffer representation remain explicit host adapter responsibilities.
- `Product.Experience`: actual browser journeys, evidence views, action guards and context-sensitive disclosure/navigation policy.
- `Evidence`: separate claim kinds and evidence levels, bounded reuse, explicit
  host effects and named external assumptions.
- `System`: the product state, budgeted requests with custody/evidence frame
  conditions, and a concrete invariant-preserving migration transition. No
  caller-supplied “preservation passed” flag serves as the preservation proof.

## What executes

The browser runtime imports `src/layer1-uor/generated-model.js`, reproduced by
`node scripts/check-model.mjs --write`. Its closed Nat/Bool/record/list/inductive
subset is evaluated with BigInt. Program replay executes the source-model
`Stitch.Compute.ringStep`, and budget, pointer, checkpoint and custody admission
use the same source-derived predicates. Unsupported translator syntax fails.
The generator binds every source and language-extension file into
`modelSourceDigest` for provenance. Checkpoints bind the separate
`modelExecutionDigest`: reachable replay semantics and exact transitive adapter
bytes. Unrelated model/proof/UI changes need not invalidate execution identity;
changed replay adapters do. Old checkpoints are never silently relabeled.

This subset translator is not LexLean, a semantic type checker, Lean, a Prism
compiler, an axiom audit, or a certificate. Its freshness check, generated-code
corpus and independent runtime oracles are implementation evidence. They do not
substitute for the exact SDK gate.

`StitchApp` is explicitly a **conformance probe**, not a full network application.
It builds a source-derived pure WASM probe with 128-bit ring values and u64
admission quantities. Its receipt/signature flags are observations supplied by
the host, not a crypto implementation. The probe has no host capabilities.

## Proof and trust boundary

The source contains stated reconstruction, admission/refusal, reservation,
settlement, migration/frame, pointer-order and continuation obligations with
explicit proof terms. A theorem is kernel-verified only after `lexlean verify`
succeeds for its exact source and axiom policy. Native artifact qualification
separately requires the full PrismPM build. The [source-verification summary](../product/source-verification.json) records the checked20-module closure and exact hashes.
A checked source theorem is still not evidence that separately handwritten
network/crypto/browser adapters implement every assumption.

Cryptographic collision resistance, signature unforgeability, pinned-authority
bootstrap, receipt authentication, retention through a declared lease,
independent failure domains, a suitable clock, and source/artifact conformance
are explicitly external. Formal records never set these assumptions to true on
behalf of a host. No finite custody condition guarantees indefinite retention.

## Reproduction

The repository's `prismpm.lock` and `standards.lock` are copied byte-identically
from the reviewed official template. Use only the immutable SDK that lock names.
There is no handwritten `.holo` or fabricated verification record.

Authoring, inside that SDK:

1. `sh scripts/check-model-sdk.sh --prepare` writes the real source lock and
   canonical formatting, then checks the source.
2. On the Docker-capable runner, `npx prism-code@0.7.2 axioms --write --project app`
   derives exact policies from Lean's observed axiom sets. Review that diff. Do
   not invent axiom allowances or weaken the verifier to get green output.
3. `node scripts/check-model.mjs --write` reproduces the source bindings after
   canonicalization/auditing. Review and commit the canonical source, actual
   lock, exact axiom policies and generated bindings together.
4. `sh scripts/check-model-sdk.sh --check` is read-only: SDK lock/standards,
   binding freshness, canonical source and source lock, then the full PrismPM
   verification, which owns LexLean checking, Lean and leanchecker verification,
   native build and acceptance vectors. No separate proof build repeats it.

Prepare output is an authoring artifact, not a release. The source lock is
produced by the actual pinned LexLean compiler. CI refuses absent committed
authoring inputs before downloading the SDK; it never rewrites source or axiom
policies to make a submission pass. The gate refuses stale locks and unreviewed
source changes.

The hosted LexLean service receives publicly unlisted source. This project does
not send the user's private architecture input or invoke that service without
specific authorization. The fork's pinned-SDK Actions job is the intended build
route when the local machine lacks Docker/LexLean.

## Probe wire contract

All multibyte integers are unsigned, big-endian. Every request begins with
version byte `1` and operation byte. Lengths and Boolean flag bytes are checked
exactly; Boolean flags must be `0` or `1`. Responses are UTF-8 decimal values,
`admit`, `refuse`, or a typed error string. The model is over mathematical Nat;
the u64/u128 probe fields are a wire representation, not semantic budget limits.

- `0` (36 bytes): width byte, opcode byte, 16-byte input, 16-byte argument.
  Widths are 8/16/32/64/128. Operands are normalized in that ring.
- `1` (58 bytes): seven u64 fields: spent, reserved, cost, limit, now, last, end.
- `2` (45 bytes): current/next revision u64s; predecessor, authority and signature
  observation flags; not-before, expiry and now u64s.
- `3` (10 bytes): eight flags: requested, acknowledged, matching manifest,
  matching fragment, matching holder, live lease, current source, distinct target.
- `4` (7 bytes): two fragment-index bytes and matching manifest, valid-fragments,
  dependencies-present flags.

The probe's request maximum 58 is derived from these fixed records. Its 512-byte
allocation bound is the inherited SDK resource envelope, not a storage/network
claim; a unique 512-byte rejection vector exercises that boundary.
