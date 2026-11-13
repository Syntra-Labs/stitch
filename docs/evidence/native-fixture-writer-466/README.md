# Actual regeneration of two LexLean fixture expectations

The [fork diagnostic run](https://github.com/afflom/stitch/actions/runs/42938289470)
passed at Stitch diagnostic commit `42127189e465c0056ae3416468f44289c48431f3`.
It checked out unchanged LexLean source `cc5561203de8fa5594d573904147a306b2b8bbbf`,
tree `c2bbc659b3cea7d58f2a2d0557579d8b2e92ff9e`, with Rust 1.97.1 and Lean 4.32.1.

The public `repo_conformance::fixtures::write` implementation used by the normal
fixture writer regenerated exactly `certificate-resource-exhausted` and
`preservation-drift`. Each then passed a fresh `fixtures::check` observation.
The helper did not serialize expected output itself or alter either fixture.

The preserved patch changes only four JSON files. Both command and diagnostic
records reflect generated module size 274972 → 275460 or Core.lean location
806:8 → 820:8. Comparison with the exact upstream source confirms no other byte
change. Codes LLS8002/LLV7014, exit statuses 4/3, unsuccessful verification and
empty artifacts remain unchanged. `review.json` records the exact output hashes.

Artifact `13819487356` was downloaded and verified against SHA-256
`5c585acedcddc986254f438b35a239b863cab610a3e2c8ebebe0824e6b7efa8a`.
Its original patch, generated files, writer log and toolchain/source records are
preserved here. These observations do not establish which earlier change caused
the drift. They also do not replace full EX-07, final PR acceptance or qualified
SDK construction. No upstream LexLean branch or PR was changed by this run.

The earlier diagnostic run stopped before generation because its temporary
helper lacked crate documentation. The passing run added that documentation;
the existing lint, writer and fixture checks remained enabled.
