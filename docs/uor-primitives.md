# UOR primitive operations and typed replay

## Semantic source

The audit uses UOR-Framework workspace version 0.5.2 at immutable commit
[`51c01382200b0179d6640b07e9c8119364ab69a1`](https://github.com/UOR-Foundation/UOR-Framework/tree/51c01382200b0179d6640b07e9c8119364ab69a1).
The existing Rust dependency remains `uor-foundation = "0.5.2"`; Cargo.lock pins
registry archive checksum `0179d3c29eb68e52ed03f9b48136159d4d4d26bd6b8008da3a9864b43ed0492f`.
The audited Git source and the registry archive are distinct provenance records;
this audit does not assert their byte identity or claim to have run Cargo.

Specific references under that commit:

- `foundation/src/enums.rs`: PrimitiveOp discriminants 0 through 17.
- `foundation/src/pipeline.rs:5115–5150`: CONCAT appends the complete big-endian
  left term bytes followed by right term bytes. It is not ring multiplication,
  OR, a sentinel zero, or truncation modulo the original width. Its evaluator's
  INLINE_BYTES parameter controls capacity; the framework has no universal
  128-bit/4096-byte CONCAT limit. ADR-028 validates output capacity before use.
- `foundation/tests/behavior_catamorphism_evaluator.rs:536`: `abcd` concatenated
  with `1234` is the four-byte term `abcd1234`.
- `foundation/src/enforcement.rs:5364`: `const_pow_w128` uses square-and-multiply
  with the entire 128-bit exponent and wrapping multiplication, including 0^0=1.
- `foundation/src/pipeline.rs:5202–5226,5397`: binary arithmetic uses the maximum
  operand byte width, at least one byte. POW operates modulo 2^(8·width), including
  the byte-level wide path. Comparisons return one byte. DIV/MOD by zero are
  rejected in the term pipeline, whereas the constant ring evaluators return 0.

The pipeline's unary path currently converts to u64 and clamps output to eight
bytes (`pipeline.rs:5068–5099`). Stitch deliberately retains the genuine full-width
ring unary operations modeled by `const_ring_eval_w128`, rather than silently
copying that truncation into existing jobs. Therefore this is an explicit ring/
byte-sequence execution profile, not a claim that Stitch implements every detail
of UOR's general term-tree evaluator. Stream, borrowed-carrier, resolver, and
arbitrary term-tree evaluation are outside this pure instruction interface.

## Existing version 1 programs

Version 1 program and checkpoint field sets remain unchanged. Program widths
remain 8/16/32/64/128. Existing operation results, including DIV/MOD by zero=0 and
ring-width comparison results, retain their meaning. POW 17 is now supported at
every width. It normalizes both operands in that ring and never narrows an
exponent to Number/u64. CONCAT 14 is still refused in this scalar-only version.

The legacy `applyPrimitiveOp` adapter also supports POW. Its CONCAT result is a
wider Datum with the sum of operand widths, or a RangeError if that result exceeds
Datum's existing 128-bit implementation envelope. Datum coordinate `toBytes()`
stays little-endian. CONCAT follows the term's big-endian sequence ordering, so
its numeric value is `left · 2^right.bits + right`. These are different encodings.

## Version 2 width-tracked programs

A version 2 program has exactly these fields:

- `version`: 2.
- `bits`: initial byte width in bits, including 0 for the empty sequence.
- `capacityBits`: explicitly declared maximum intermediate/result byte width.
- `initialValueHex`: canonical unsigned lowercase hex numeric value.
- `instructions`: unary `{op}` or binary `{op,argBits,argHex}` records.

Every width is a multiple of8, including non-power-of-two widths 24,40,72,etc.
`0x0` with width 0 represents the empty sequence. Width is never inferred from
numeric magnitude, so leading zero bytes survive CONCAT and checkpoints.

CONCAT sums widths and appends without truncation. Arithmetic chooses the maximum
operand width, at least 8 bits, then normalizes in that ring. Comparisons return an
8-bit 0/1 word. Unary operations retain the full input width, at least 8 bits, per
the ring profile above. DIV/MOD zero operands are rejected before execution.

The source-owned `Word`, `TypedInstruction`, `typedInstructionAllowed`, `typedStep`,
`typedExecute`, and work functions define these rules. Runtime validation uses
the same source predicates and result-width function for every instruction.
`typedResumeEqualsUninterrupted` proves continuation for arbitrary finite typed
instruction lists. The source also proves exact CONCAT value/width identities,
capacity refusal, result-width admission, the zero-exponent unit/cost laws, and a kernel-evaluated 128-bit POW vector with exponent bit 100 set.
These proofs do not establish cryptographic hashing or the complete host adapter.

Version 2 checkpoint bodies add `stateBits` and use `version:2`. The program hash
binds capacity, initial width, all operand widths and values. Checkpoint hashing
binds state width. Verification replays both width and value, rejecting even a
self-consistently rehashed forged width. Checkpoint predecessor checks remain
strict. Both versions bind `modelExecutionDigest`, including source semantics,
interpreter and transitive replay adapter bytes. Old execution roots are refused;
no old checkpoint is silently relabeled as executing new semantics.

## Resource contract

The pure source model is capacity-parametric. The JavaScript host exposes a
separate local policy: at most 1024 instructions, 32768 bits (4096 bytes) per term,
and 1,000,000 abstract work units per program. The 32768-bit limit is a tested
parsing/memory envelope, not an upstream semantic limit or a promise of unbounded
stream handling. Program-wide width and work validation completes before any
replay step. A supplied admission ledger reserves the exact replay range's work
before evaluation; verification and suffix execution each pay for their actual
replay range.

`computeSteps` is the historical budget field name. It now measures explicit
abstract interpreter work, not just instruction count or wall-clock CPU:

- Version 1 existing instructions cost 1. POW costs 1 plus one modular square per
  exponent bit and one modular multiply per set bit.
- Version 2 CONCAT costs 1 plus output byte count. Bitwise operations cost 1 plus
  arithmetic bit width. ADD/SUB/unary/comparisons cost 1 plus 64-bit limb count.
- Version 2 MUL/DIV/MOD cost 1 plus squared limb count. POW costs 1 plus squared
  limb count times its exact square/multiply count. The ceiling conservatively
  prices wide arithmetic; it is not a benchmark of a JavaScript engine.

No exponentiation forms the unbounded integer `base ** exponent`. The source
square-and-multiply helpers reduce after every multiply. Source tail calls are
trampolined in the subset interpreter; modulus construction and bitwise helpers
also avoid width-dependent JavaScript call-stack growth. Tests exercise the full
local capacity and refuse a maximum-width hostile exponent on static work cost.
Host validation, hashing, allocations, VM/browser/network overhead and physical
energy remain distinct from these abstract compute units.

## Verification

`tests/primitive-operations.test.js` covers pinned upstream examples, independent
left-to-right modular exponentiation across all version 1 widths, exponent bits
above 64, every 8-bit CONCAT output width through 128, empty terms, mixed operands,
comparison widths, checkpoints/resume, recomputed width forgeries, budget refusal,
and maximum-capacity CONCAT/bitwise/power recursion. The existing source/adapter
mutation and execution-identity suites are updated to cover the new reachable
semantics. The SDK's exact Lean/axiom gate remains mandatory; no SDK pin or native
acceptance vector is changed by this implementation.
