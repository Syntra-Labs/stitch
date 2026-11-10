# Native build diagnosis and passing-project comparison

The source proof and native artifact gate are distinct. A successful Lean kernel
check is not a successful native Prism build. The original pinned SDK and
`scripts/check-model-sdk.sh` acceptance path remain unchanged.

## Reproduced failure

The [20-module checkpoint run](https://github.com/afflom/stitch/actions/runs/42843185062)
passed runtime checks but failed the model job with `PP5007: application-lean timed
out`. The SDK is pinned to
`ghcr.io/uor-foundation/prismpm-sdk-candidate@sha256:cd3b47d7a370c4a26b8285f5e9c3bb15e639973c55505c3809ddbe55352fea58`,
using LexLean 0.3.0 and Lean 4.32.1.

A cold local reproduction used the exact generated 20-module source closure,
PrismPM's Lake configuration, `moreLeanArgs = ["-j2"]` and
`LEAN_NUM_THREADS=2`. Portable, Collections and independent project modules
compiled. `LexLeanRuntime.Laws` emitted its Lean object/IR but stalled during C
emission beyond 600 seconds.

Post-frontend inspection found 695 declaration-order entries for 689 distinct
local impure declarations. Six matcher-splitter entries from
`LexLeanCollections.lessThan` and `LexLeanLaws.sumNat` had been reconstructed
automatically and then compiled again by the runtime reconstruction loop.
Lean's native declaration ranking consequently asserted while consuming the
longer order list, and C emission repeatedly failed during ranking/sorting.

A diagnostic-only guard avoiding duplicate reconstruction made the same cold
graph pass all 25 Lake jobs in 15.503 seconds. Every generated Stitch project
module remained byte-identical. This is evidence for the root cause, **not an
accepted runtime patch or release attestation**. A production fix must preserve
mutual-recursion groups, kernel/axiom checking and native exported behavior.

## Why other Prism projects pass

- [Template's successful native run](https://github.com/UOR-Foundation/template/actions/runs/42820101494/job/129843150506)
  at commit `05855f42dd1186aee9f4907985920514907b255e` uses the same SDK and really
  executes `prismpm --project app verify`. Its three generated modules import
  `Init` and `LexLeanRuntime.Portable`, not Laws or Collections. An independent
  cold native build of that exact source closure passed all six Lake jobs in
  about 11 seconds, with no factory seed or warm cache.
- [Rule30's successful proof run](https://github.com/afflom/rule30/actions/runs/42786571256/job/129729166929)
  at commit `7e99c8418cade772c10d79be2731c193de7cd31a` uses LexLean 0.4.0 at
  `15c667bd36604c94c28e39502edec3fcad38e0ce`. Its build stages Laws as Lean
  object/IR without `-c`; Laws is not a native Lake root. That run does not execute
  the equivalent `prismpm verify` gate.
- [Verdant's successful web run](https://github.com/afflom/verdant-resonance/actions/runs/42842203896)
  at commit `4b5f7fda5c7dac106e11475dc62aaf7147f1cb9f` runs npm, TypeScript,
  JavaScript tests and a Vite build. It does not run a native Prism gate.

Template and Stitch both use a nonroot container user, ephemeral HOME, tmpfs
`/tmp` and `PRISMPM_EPHEMERAL_HOME=1`. Template additionally initializes Docker
buildx and runs earlier checks within the same container. The independent cold
template pass shows that a warm cache is unnecessary for its smaller runtime
closure. This is a specific native reconstruction failure exercised by Stitch,
not evidence that all Prism projects or all uses of this SDK fail.

## Acceptance of the repair

Use a corrected immutable upstream SDK, then run the unchanged Stitch source,
kernel, native artifact and vector gates, plus the passing template regression.
Do not remove Laws imports, replace the native gate with object-only compilation,
accept diagnostic artifacts as official outputs, or call a longer timeout a fix.
Full browser/provider/VM qualification and redistribution obligations remain
separate product requirements even after native verification passes.

## Proposed compiler tested on actual project sources

The actual compiler built from [LexLean PR #466](https://github.com/UOR-Foundation/LexLean/pull/466)
at `cc5561203de8fa5594d573904147a306b2b8bbbf` passed its integrated native
regression, then generated and verified the unchanged 25-module Stitch
checkpoint at `2f1fde8`. Its cold native graph passed all 30 Lake jobs in
16.355 seconds; the three-module template comparison passed six jobs in
11.097 seconds. [The diagnostic report, original logs and input hashes](evidence/native-candidate-466/README.md)
record the exact scope and reproduction. This used candidate-generated runtime
sources, not edited runtime text. The accepted SDK lock remains unchanged
pending upstream qualification and publication.

After the placement model changed, the same actual candidate regenerated the
25-module closure at local source checkpoint `c99dc0d` and passed all 30 cold
native jobs again in 16.093 seconds. The separate `stitch-placement/` evidence
records those new input hashes; no earlier source attestation is reused for it.

## Completion flow and evidence ownership

Keep the dependency chain explicit instead of rerunning the known broken native
build after unrelated host changes:

1. **Stitch source → source proof.** The current
   [source summary](../product/source-verification.json) binds every declared
   source/vocabulary/configuration input to the retained actual
   [attestation](../product/source-attestation.json) and
   [build manifest](../product/source-build-manifest.json): 25 modules, 1,321
   declaration audits and 85 successful Lean/leanchecker processes. This is
   source evidence only, not native acceptance.
2. **LexLean source → repaired compiler.** LexLean owns PR #466's complete
   acceptance. The exact compiler candidate and unchanged current-source native
   rehearsal are already retained above. A successful diagnostic does not
   authorize a Stitch SDK lock update.
3. **Compiler → qualified SDK.** PrismPM owns reconciliation of the accepted
   compiler revision, compiler-pair and SDK qualification, then publication of
   an immutable image. Track the existing
   [SDK owner coordination](https://github.com/UOR-Foundation/PrismPM/issues/194#issuecomment-6780585108).
   The current `prismpm.lock` still selects the reproduced failing compiler;
   this dependency is blocked, not a green or skipped native result.
4. **Qualified SDK → Stitch acceptance.** Consume the owner's qualified digest
   and matching official locks, regenerate only the authoring outputs required
   by that compiler, and run the unchanged
   `sh scripts/check-model-sdk.sh --check` in that SDK. Retain its real source,
   native artifact and vector evidence. A changed compiler requires new proof
   evidence even if the application source is unchanged.

`node scripts/check-source-evidence.mjs` cheaply checks the retained evidence's
input freshness, existing digest/ID bindings, reported statuses/counts and pinned
proof-tool identities. The normal Node suite includes negative cases for stale,
added, missing and mismatched inputs. Host-only changes leave these exact source
inputs intact, so the same source proof remains useful without another manual
proof build. Discovery includes `.lex.tex` modules and each bound lexicon's
`lexicon.toml` and `entries/` files; other documentation is not a compiler input.
This check authenticates no producer and replays no proof; it is
not a certificate verifier, native gate, workflow router or CI result cache.

The factory work in [PrismPM #586](https://github.com/UOR-Foundation/PrismPM/pull/586)
describes release-line obligation identities and owner-controlled receipts. It
is draft upstream work, not a qualified consumer receipt API to copy here.
Stitch keeps its existing CI gates. Runtime/browser checks bind their own host
and test inputs; the independent source-complete guest build binds its recipe,
toolchain and resulting image/source/license materials. Neither a passing source
proof nor a passing browser test clears guest redistribution. Do not restart
that long build for unrelated model or host edits, and do not replace the
bundled guest until its actual candidate and accompanying materials qualify.
