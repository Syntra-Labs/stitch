# Native compiler candidate rehearsal

This is diagnostic evidence for LexLean PR #466, not a released compiler, a qualified PrismPM SDK, or acceptance of Stitch's complete product. The accepted SDK and project locks were not modified.

## Inputs and provenance

- Compiler source: `UOR-Foundation/LexLean@cc5561203de8fa5594d573904147a306b2b8bbbf`; source tree `c2bbc659b3cea7d58f2a2d0557579d8b2e92ff9e`.
- [Candidate build and RT-03](https://github.com/UOR-Foundation/LexLean/actions/runs/42910816795), [artifact 13807497041](https://github.com/UOR-Foundation/LexLean/actions/runs/42910816795/artifacts/13807497041). Artifact expires November 17, 2026. `compiler/artifact.json` records ZIP and executable SHA-256 values; the toolchain and focused-test logs accompany it.
- Binary SHA-256: `05ed3b3da7390aa8250288841cbe6baecc20ef28e96249df3d7682b8a51a4cfa`. Built with Rust 1.97.1; Lean 4.32.1.
- Stitch source checkpoint `dad91e429ffbf8248ae6ed9f9319dd90e229a299`. All 66 remote `app/` blobs at [2f1fde828fea0d07cb4fca36c3241702e29e193f](https://github.com/afflom/stitch/tree/2f1fde828fea0d07cb4fca36c3241702e29e193f/app) match that checkpoint; comparison recorded in `stitch/remote-app-comparison.json`. All 25 source modules were individually compared with committed bytes, with SHA-256 in `stitch/source-provenance.json`.
- Template source [a7a3041cd85d745bb2d6dfc7ee72513185fa48be](https://github.com/UOR-Foundation/template/tree/a7a3041cd85d745bb2d6dfc7ee72513185fa48be/app). All three source modules were individually compared with committed bytes; hashes are in `template/source-provenance.json`.

## Results

| Check | Stitch | Template |
| --- | --- | --- |
| Actual candidate `build --all` | 25 modules | 3 modules |
| Actual candidate `verify --all` | Passed | Passed |
| Cold native Lake build | 30 jobs, exit 0, 16.355 seconds | 6 jobs, exit 0, 11.097 seconds |
| Verification attestation | `f8a8f3cde75f310721acf22c24e4cdf8f8594dbc105cbef144d4422d229382e4` | `8467b85f3a910a0991610b9999fb8d8285d3ef954e4ee3029d7c49dea2ae3164` |

The actual Rust RT-03 harness passed: 1 test passed, 0 failed, 481 filtered out, 93.02 seconds. It includes native C emission/execution and reconstruction-group regression checks. These are observed timings on one execution, not performance guarantees.

## Method and reproduction

1. Download the diagnostic artifact and verify its ZIP and binary digests against `compiler/artifact.json`. Its embedded version prints `lexlean 0.4.0`, but this does not make the candidate a published release.
2. Export the specified `app/` trees into separate temporary directories. Use the pinned Lean 4.32.1 toolchain. Run the candidate executable with `--project <temporary-app>/lexlean.toml lock`, then `build --all`, then `verify --all`. Only temporary candidate locks/output may change. Preserve original source bytes and compare their hashes.
3. Obtain runtime `.lean` sources emitted by that candidate, not from the old SDK or by text patching. In this rehearsal they were copied unchanged from the running verifier's `.lexlean/verified/.staging-*/lean-src` workspace before cleanup; the verification was then required to finish successfully. Stitch's snapshot contains all 25 generated app modules and the three emitted runtime modules. Template's three generated modules came from its build tree; its sole Portable runtime was reused byte-for-byte from the same candidate's emitted runtime. The per-file hashes are in each `generated-native-inputs.json`.
4. Stage those exact generated files in a new native workspace with the accompanying `lakefile.toml`. No `.lake` cache is copied. Run `LEAN_NUM_THREADS=2 lake --verbose build PrismGenerated` with the actual pinned Lake executable on PATH and a 600-second process bound. Both configs use `moreLeanArgs = ["-j2"]`; all native roots are explicit. The logs retain emitted `lean ... -c` commands as evidence that this was native C emission, not an object-only shortcut.
5. Compare exit status, outputs, source provenance, and the resulting evidence with this report. A new compiler or changed source requires its own result; these attestations must not be reused for other inputs.

No runtime was edited, no Laws import was removed, and no kernel or policy check was disabled. Logs contain temporary diagnostic paths; no full duplicate source tree or binary is included here.

## Remaining acceptance boundary

This rehearsal uses the real proposed compiler and demonstrates that it removes the previously observed native stall on these inputs. It does not run the absent local `prismpm` executable, prove complete SDK compatibility, replace the repository's unchanged artifact/vector gate, or qualify external browser/provider/VM behavior. LexLean's full acceptance and the SDK owner's compiler-pair/immutable-artifact qualification remain separate requirements. Track [LexLean #465 / PR #466](https://github.com/UOR-Foundation/LexLean/pull/466) and the existing [PrismPM SDK owner coordination](https://github.com/UOR-Foundation/PrismPM/issues/194#issuecomment-6780585108). Published tags remain untouched.

## Updated placement-source rehearsal

The later source checkpoint `c99dc0d74d8b0f1c036df1aff18cc047b3bf5c1a` adds the placement declarations while retaining 25 app modules. Its separate evidence is in `stitch-placement/`; the original `stitch/` result above remains scoped to its earlier input.

All 25 source files were compared against this exact commit. Actual candidate `lock` and `build --all` ran only in an isolated exported app tree, yielding build `0ad014252e6f1ff6af86aad9d33e66b760cf38724c1fe8d25cd2dcb4cb3859d9`. The 25 freshly generated app modules and the three unchanged runtime modules emitted by the same candidate compiler were staged in a fresh native directory. The unchanged native command/configuration passed all 30 jobs with exit 0 in 16.093 seconds under the same 600-second bound.

Only affected candidate generation and cold native compilation were repeated. Full candidate verification and the unchanged Template rehearsal were not repeated, so the earlier candidate attestation must not be attributed to this new source. The accepted-pinned source proof is recorded separately by the project; this diagnostic does not replace it or whole-SDK qualification. No accepted lock was modified.
