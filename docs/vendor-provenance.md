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
| `images/buildroot-bzimage.bin` | Remains unresolved | Actual guest source/configuration, included-package inventory and applicable license materials |

These recommendations assume the accompanying directories are actually
included with the repository/download/static deployment that conveys the
assets. Do not strip them out of a release package. This is the concrete
packaging condition to verify, not a requirement to reconstruct every compiler
or make every historical binary reproducible. The product register should
reflect the integrated package after review; no runtime replacement is needed
to clear the four resolved material-packaging gaps.

## Exact asset identities

All five original files were introduced by upstream Stitch commit
[`da38ff68f09a78f38ea8600b76ae6df36d46dd57`](https://github.com/Syntra-Labs/stitch/commit/da38ff68f09a78f38ea8600b76ae6df36d46dd57).
No runtime asset has been changed by this packaging work.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `v86/libv86.js` | 353762 | `b80fba71dacb7977e5b46800b3ba194bba7fe13e52fa3d22f80cc060ff015a4e` |
| `v86/v86.wasm` | 1418156 | `abd512988f39f5c81d4930f564bafa1a6e1e0d5210de9b20e2bdec13fbc318d9` |
| `v86/seabios.bin` | 131072 | `73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98` |
| `v86/vgabios.bin` | 36352 | `a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880` |
| `images/buildroot-bzimage.bin` | 5166352 | `7befbaea31e249d9a518c4b95fa42b2a193d0e3de46250d617cbdeb866ee28b0` |

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

## Genuine remaining guest-image source gap

The Linux/Buildroot image exactly matches the official download
https://i.copy.sh/buildroot-bzimage.bin. It identifies Linux 5.6.15, built by
`fabian@nyu` on 2020-07-20. This establishes download origin, not the complete
corresponding source of the kernel and bundled userspace.

The decompressed kernel has no `IKCFG_ST` embedded-configuration marker.
The obsolete `copy/images` repository provides no matching image/configuration
in its available history. We have not recovered the complete kernel build
configuration, patches, Buildroot configuration or actual included-package
inventory. A generic Linux source link or a license label on the image cannot
supply those missing materials. This remains a substantive distribution issue.

`vendor/guest/` provides a pinned official Buildroot candidate recipe preserving
VGA/serial shells, NE2000 Ethernet, embedded initramfs and virtio 9p support.
The Buildroot configuration step succeeded; the dependency preflight found
missing host programs `cpio`, `rsync` and `bc`. No candidate image has been built
or qualified, and kernel/BusyBox fragment resolution remains unverified. The
recipe retains source downloads, resolved configs and `legal-info` materials;
those actual outputs and warnings must be reviewed before claiming completion.

Two valid completion routes remain: recover the original guest's actual source
materials, or build the candidate and qualify it with the current runtime,
then distribute its complete source/license package. Neither requires disabling
the VM feature, declaring an untested replacement complete, or adding unrelated
costly checks to every CI run.
