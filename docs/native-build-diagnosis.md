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
