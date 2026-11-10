# v86 sources and incorporated notices

## Distribution and source identity

On 2026-11-10, both official download files were retrieved and matched Stitch's
existing assets exactly:

- https://copy.sh/v86/build/libv86.js: SHA-256 `b80fba71dacb7977e5b46800b3ba194bba7fe13e52fa3d22f80cc060ff015a4e`.
- https://copy.sh/v86/build/v86.wasm: SHA-256 `abd512988f39f5c81d4930f564bafa1a6e1e0d5210de9b20e2bdec13fbc318d9`.

The official https://copy.sh/v86/ homepage identified version `1e4f43c95`
(Jul 3, 2026 23:07). GitHub resolves that revision to
[`1e4f43c954701db9699fa976b27cc675f9971265`](https://github.com/copy/v86/commit/1e4f43c954701db9699fa976b27cc675f9971265).
Building `build/libv86.js` from that exact source using the upstream Makefile
and Closure compiler v20210601 reproduced the shipped JavaScript byte for
byte. That is an actual reconstruction, not an inference from a version string.

`source.tar.gz` is the unchanged tracked source tree, produced using:

```sh
git archive --format=tar --prefix=v86-1e4f43c954/ 1e4f43c954701db9699fa976b27cc675f9971265 | gzip -n > source.tar.gz
```

The WebAssembly distribution identity is confirmed, but its source-to-binary
rebuild has **not** been performed. Its embedded producers identify Rust 1.96.0
and clang 22.1.6. Those compilers are not installed in the checked environment. Independent
Wasm reproduction is optional evidence, not a BSD/MIT binary-notice obligation
and not a prerequisite for distributing the existing official bytes with the
applicable notices supplied here.
Do not describe the Wasm as independently reconstructed or replace it with an
untested npm package: npm v86@0.5.473 produces different JS and Wasm hashes.

## Reconstruct JavaScript

Supply Google's upstream Closure v20210601 compiler from the official Maven
Central artifact used by v86's Makefile:
https://repo1.maven.org/maven2/com/google/javascript/closure-compiler/v20210601/closure-compiler-v20210601.jar

Expected SHA-256:
`64f161c65a3dba42c9a4f5a79db335ac0e757fcba486cd7928205ac4c258ef08`.

Run `vendor/v86/build-js.sh /path/to/compiler.jar /new/output/directory`.
The script requires Java, GNU make, tar, gzip, realpath and sha256sum. It does
not download/install tools or overwrite runtime files. It verifies inputs and
fails unless the rebuilt output equals the existing shipped JS hash. This is
a targeted reconstruction check, not an additional mandatory expensive CI gate.

The unchanged source tree also contains the upstream `build/v86.wasm` recipe.
A future Wasm reproduction must use the pinned toolchain and qualify the actual
Stitch guest/runtime APIs before any asset replacement. VM administration uses
internal `fs9p` APIs in this revision; do not substitute unrelated current builds.

## License materials

Distribute this directory alongside the JS/Wasm assets:

- `LICENSE`: v86 BSD-2-Clause copyright, conditions and disclaimer.
- `LICENSE.MIT`: incorporated QEMU floppy emulator notices and MIT terms.
- `INCORPORATED-NOTICES.md`: distinct verbatim copyright/license comment blocks
  from the source's runtime JS/Rust and incorporated SoftFloat/Zstd code.
- `ZSTD-LICENSE`: upstream Zstandard v1.4.5 BSD text, obtained from
  https://github.com/facebook/zstd/blob/v1.4.5/LICENSE; the incorporated source
  identifies version 1.4.5 and permits selection of BSD or GPLv2 terms.
- The source archive preserves all original per-file notices, including those
  of the included tests and tools. Do not apply the root BSD license to every
  included third-party component.

`SHA256SUMS` verifies the supplied materials. These additions do not mark any
product redistribution flag cleared, and do not resolve the separate guest
Linux/Buildroot source obligations. They supply the actual missing notices and
source material while retaining the exact runtime already being qualified.
