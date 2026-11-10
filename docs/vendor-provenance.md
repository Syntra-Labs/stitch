# Vendored VM asset provenance review

Reviewed 2026-11-10. This is evidence and a remaining-work checklist, not a
redistribution clearance, legal opinion, reproducible-build receipt or runtime
verification. No binary, runtime, formal model or product register was changed
by this review. All five `redistributionCleared = false` flags should remain.

## Local identity and introduction

All five assets were added in the same existing upstream commit,
[`da38ff68f09a78f38ea8600b76ae6df36d46dd57`](https://github.com/Syntra-Labs/stitch/commit/da38ff68f09a78f38ea8600b76ae6df36d46dd57).
The local history shows no subsequent asset change. That commit supplies the
repository introduction, not an original vendor download or build record.

| Path | Bytes | SHA-256 of local file |
| --- | ---: | --- |
| `v86/libv86.js` | 353762 | `b80fba71dacb7977e5b46800b3ba194bba7fe13e52fa3d22f80cc060ff015a4e` |
| `v86/v86.wasm` | 1418156 | `abd512988f39f5c81d4930f564bafa1a6e1e0d5210de9b20e2bdec13fbc318d9` |
| `v86/seabios.bin` | 131072 | `73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98` |
| `v86/vgabios.bin` | 36352 | `a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880` |
| `images/buildroot-bzimage.bin` | 5166352 | `7befbaea31e249d9a518c4b95fa42b2a193d0e3de46250d617cbdeb866ee28b0` |

These are reproducible with `sha256sum v86/* images/*`. They agree with the
product register at review time.

## BIOS origin established; packaging not cleared

The connected GitHub API directory listing for
[`copy/v86` at `315b2b0b758703ef0e6cc7b4088d6068f83f3c20`](https://github.com/copy/v86/tree/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios)
reports the same Git blob identifiers and byte sizes as the local files:

- [`bios/seabios.bin`](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios/seabios.bin):
  Git blob `8c9ab8ffea3b4e4d5fbbbe63a43ceaf2dcb501c7`, 131072 bytes.
- [`bios/vgabios.bin`](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios/vgabios.bin):
  Git blob `bd393e2b5edb10c04a822fb9e7c02b7cb4ffa6f5`, 36352 bytes.

The local identifiers are independently reproducible with `git hash-object`
on each file. This is an upstream Git-blob identity match, not a claim that
upstream published the SHA-256 values above or that this review rebuilt them.
The reviewed v86 commit is a pinned location containing the matching bytes;
it is not asserted to be the original BIOS build or import commit.

The pinned upstream
[`fetch-and-build-seabios.sh`](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios/fetch-and-build-seabios.sh)
checks out SeaBIOS `rel-1.16.2` and copies both normal BIOS outputs from that
build. The local SeaBIOS binary also contains `rel-1.16.2-0-gea1b7a0`.
The VGA binary identifies itself as a SeaBIOS VBE adapter; it should not be
mistaken for the separate Bochs VGA BIOS also present upstream.

SeaBIOS's tagged
[`src/post.c`](https://github.com/coreboot/seabios/blob/rel-1.16.2/src/post.c)
and
[`vgasrc/vgabios.c`](https://github.com/coreboot/seabios/blob/rel-1.16.2/vgasrc/vgabios.c)
explicitly state GNU LGPLv3. The release includes
[`COPYING.LESSER`](https://github.com/coreboot/seabios/blob/rel-1.16.2/COPYING.LESSER)
and the incorporated GPLv3 terms in
[`COPYING`](https://github.com/coreboot/seabios/blob/rel-1.16.2/COPYING).
Do not classify these BIOS files under v86's BSD license.

Next action: retain the applicable copyright and license texts with the
distribution; package or provide a compliant corresponding-source route for
the exact SeaBIOS release, configuration and build scripts; review the
source/component notices and actual distribution method. The upstream recipe
and blob match make this concrete work, but are not themselves fulfillment of
the distribution obligations. A rebuild would strengthen reproducibility
evidence; none was performed here.

## v86 JavaScript and WebAssembly: exact source build unresolved

The reviewed upstream
[`LICENSE`](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/LICENSE)
is BSD-2-Clause. It requires preservation of the copyright, conditions and
disclaimer in source distributions and reproduction in accompanying materials
for binary distributions. The upstream
[README](https://github.com/copy/v86/blob/master/Readme.md) additionally identifies
separately licensed incorporated code, including SoftFloat, zstd and MIT-licensed
QEMU-derived floppy code. A BSD label for the complete bundle is insufficient.

The local Wasm producer metadata names Rust `1.96.0 (ac68faa20 2026-05-25)` and
clang `22.1.6`. This identifies compiler metadata, not a v86 source commit.
No exact upstream build/release identity for the local JS/Wasm pair was
established by this review. The latest-release GitHub endpoint returned 404;
this is not evidence that no release assets exist.

Next action: match both existing files to a pinned upstream build/release (or
recover their original build record), then retain the complete applicable
notice set for that build and its included dependencies. Do not substitute
current upstream source provenance for these unidentified built bytes.

## Linux/Buildroot image: image-level source and license set unresolved

`file images/buildroot-bzimage.bin` identifies a Linux x86 bzImage with embedded
version `5.6.15 (fabian@nyu) #16 Mon Jul 20 19:33:46 CDT 2020`.
This is a build string, not proof of the complete source/configuration or an
inventory of bundled userspace. Linux's
[`v5.6/COPYING`](https://github.com/torvalds/linux/blob/v5.6/COPYING)
states GPL-2.0-only with the Linux syscall exception and notes that other
licenses can apply. It does not license every package in a Buildroot image.

The upstream v86 README directs users to `copy/images` for image information.
That repository's
[README](https://github.com/copy/images/blob/master/Readme.md) explicitly warns
that it is not updated; its current root listing does not contain this
Buildroot image. No upstream byte match or complete corresponding-source
bundle for this exact local image was established.

Next action: recover the original image distribution/build manifest, exact
kernel patches/configuration, Buildroot configuration and included package
versions, applicable license notices and corresponding sources. If unavailable,
propose a separately authorized, reproducible replacement rather than marking
the existing image cleared. Neither the filename nor Linux's general license
is adequate evidence for clearing this image.

## Release decision

The warnings are substantive. BIOS provenance can now be stated more precisely,
but no asset has a complete documented redistribution package in this review.
Keep all five blockers until the listed evidence and packaging work is complete.
This conclusion concerns distribution readiness, not whether the typed product
graph is closed or whether the pure Stitch core passes its proof checks.
