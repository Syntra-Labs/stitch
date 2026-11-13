# Vendored VM asset provenance and distribution materials

Current assessment: 2026-11-10. This replaces the earlier incomplete-origin
review. It distinguishes actual distribution obligations from optional
independent build reproduction. It is an engineering evidence assessment,
not a legal warranty or a whole-runtime correctness claim.

## Current disposition

| Asset | Recommendation for repository distribution | Required accompanying material |
| --- | --- | --- |
| `v86/libv86.js` | Clear the former missing-origin/notices blocker | `vendor/v86/` notice package |
| `v86/v86.wasm` | Clear the former missing-origin/notices blocker | `vendor/v86/` notice package |
| `v86/seabios.bin` | Clear the former missing-source/notices blocker | Complete `vendor/seabios/` source, config, build instructions and notices |
| `v86/vgabios.bin` | Clear the former missing-source/notices blocker | Complete `vendor/seabios/` source, config, build instructions and notices |
| `images/buildroot-bzimage.bin` | Replaced with qualified source-complete Linux 6.18.7 image | `vendor/guest/SOURCE-NOTICE.md` and its immutable complete source package |

These recommendations assume the accompanying directories are actually
included with the repository/download/static deployment that conveys the
assets. Do not strip them out of a release package. This is the concrete
packaging condition to verify, not a requirement to reconstruct every compiler
or make every historical binary reproducible. The product register should
reflect the integrated package after review; no runtime replacement is needed
to clear the four resolved material-packaging gaps.

## Exact asset identities

The original five files were introduced by upstream Stitch commit
[`da38ff68f09a78f38ea8600b76ae6df36d46dd57`](https://github.com/Syntra-Labs/stitch/commit/da38ff68f09a78f38ea8600b76ae6df36d46dd57).
The four v86/BIOS files remain unchanged. The guest is now the exact qualified replacement below.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `v86/libv86.js` | 353762 | `b80fba71dacb7977e5b46800b3ba194bba7fe13e52fa3d22f80cc060ff015a4e` |
| `v86/v86.wasm` | 1418156 | `abd512988f39f5c81d4930f564bafa1a6e1e0d5210de9b20e2bdec13fbc318d9` |
| `v86/seabios.bin` | 131072 | `73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98` |
| `v86/vgabios.bin` | 36352 | `a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880` |
| `images/buildroot-bzimage.bin` | 8053248 | `313a6b545290a2b47856b49bfcc4c7577469749b315932ae008d39fe70fc7f07` |

## v86 JavaScript and WebAssembly

Both files exactly match the official downloads retrieved 2026-11-10:

- https://copy.sh/v86/build/libv86.js
- https://copy.sh/v86/build/v86.wasm

The official https://copy.sh/v86/ homepage identifies deployed revision
`1e4f43c95` (Jul 3, 2026 23:07), resolved by GitHub to
[`1e4f43c954701db9699fa976b27cc675f9971265`](https://github.com/copy/v86/commit/1e4f43c954701db9699fa976b27cc675f9971265).
An actual JavaScript build from that pinned source using upstream Closure
v20210601 reproduces the shipped JS byte for byte. `vendor/v86/` supplies the
tracked source archive, checksum-checked offline reconstruction recipe and
applicable distribution notices:

- v86 BSD-2-Clause copyright, conditions and disclaimer;
- QEMU-derived floppy implementation MIT copyright and terms;
- incorporated SoftFloat copyright, BSD conditions and disclaimer;
- Zstandard 1.4.5 BSD license and incorporated Zstd/xxHash notices;
- preserved per-file notices in the complete source archive.

These permissive binary-distribution notice obligations do **not** require an
independent bit-identical Wasm reconstruction. The Wasm's exact official byte
origin is established; its source reconstruction has not been independently
performed because Rust/clang are absent on this worker. Record that limitation
honestly, but do not turn it into a release blocker. Similarly, shipping source
is useful here but is not a new BSD/MIT source-disclosure obligation.

The validated runtime remains untouched. VM administration relies on internal
fs9p APIs in this revision. Any future upgrade/replacement needs compatibility
tests, not a speculative switch to an unrelated npm version.

## SeaBIOS and its VGA BIOS

Both bundled files exactly match the upstream Git blobs in
[`copy/v86` bios directory](https://github.com/copy/v86/tree/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios):

- `bios/seabios.bin`: `8c9ab8ffea3b4e4d5fbbbe63a43ceaf2dcb501c7`.
- `bios/vgabios.bin`: `bd393e2b5edb10c04a822fb9e7c02b7cb4ffa6f5`.

The upstream build recipe explicitly selects `rel-1.16.2`; the BIOS identifies
`rel-1.16.2-0-gea1b7a0`. The official release tag resolves to SeaBIOS commit
[`ea1b7a0733906b8425d948ae94fba63c32b1d425`](https://github.com/coreboot/seabios/tree/ea1b7a0733906b8425d948ae94fba63c32b1d425).
The complete unchanged source archive, original per-file notices, LGPLv3 and
incorporated GPLv3 texts, v86 configuration, original build script and usable
build instructions are supplied in `vendor/seabios/`.

This supplies a concrete corresponding-source route with the object-code
distribution. Include those materials alongside both ROM files, accessible
without an additional charge or access restriction. Do not relabel them under
v86's BSD license or this repository's MIT license. Retain the ability to use
modified ROMs; this patch imposes no signature or replacement restriction.

The candidate build script successfully builds both ROMs. Two clean-directory
runs on the same toolchain produce matching candidate hashes, but those hashes
differ from the historical bundled ROMs. That difference alone does **not**
make the supplied original source/configuration inadequate and is not a
license obligation to reproduce an old compiler. It is recorded as a build
reproduction limitation. No candidate adoption is required to resolve this
source/notice packaging gap. If a replacement is chosen later, validate its
actual VM behavior before changing the shipped hashes.

## Source-complete replacement guest

The original Linux 5.6.15 image (`7befbaea31e249d9a518c4b95fa42b2a193d0e3de46250d617cbdeb866ee28b0`) matched i.copy.sh, but its complete original build inputs were not recovered. It is no longer the shipped image; this does not retroactively resolve historical distributions.

The replacement is the existing Linux 6.18.7 image built by [run 42906244489](https://github.com/afflom/stitch/actions/runs/42906244489), from exact Buildroot commit `7fdeadb3b9f12f78e5fccca914d7fef47090ab9a` and Stitch build commit `d17aa7f3ffc6944b799ac43f6a5bab04ab3b82ef`. No image/toolchain rebuild was performed for adoption.

The [durable corresponding-source tree](https://github.com/afflom/stitch/tree/fd59fae669e9a40271fb584ca071270d8ed0b8f8) supplies all reviewed source/license materials, patches, build scripts, resolved configs and image. Its reassembler validates each part and the 398,457,213-byte final archive SHA-256 `fbc04b0c55f8421ca9bcf9e9dbac1952c07a1a2d82fd644ac67e66415b0106bc`. Retain [the source notice](../vendor/guest/SOURCE-NOTICE.md) and equivalent source access with the image. The existing distribution checker binds the image, notice and exact parts manifest; it does not claim to check remote availability on every CI run.

Actual hosted production UI/lifecycle and two-peer Ethernet qualification passed on this exact image with the required host arguments; see [the qualification record](guest-browser-qualification.md). The runtime now uses `console=tty0 console=ttyS0,115200 rdinit=/init nomodeset`. Source availability, those observed scenarios, and native Prism SDK acceptance are distinct. The latter remains pending; no product release or whole-runtime certification is claimed.
