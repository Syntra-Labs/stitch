# SeaBIOS source and notices

This directory provides the complete unmodified source tree, original per-file
copyright notices, and GNU LGPLv3/GPLv3 license texts for SeaBIOS 1.16.2. It
also includes the v86 configuration and original upstream build recipe.

## Provenance

- Source: https://github.com/coreboot/seabios/tree/ea1b7a0733906b8425d948ae94fba63c32b1d425
- Tag: `rel-1.16.2`; resolved commit `ea1b7a0733906b8425d948ae94fba63c32b1d425`.
- Config and upstream recipe: https://github.com/copy/v86/tree/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios
- Archive generation: `git archive --format=tar --prefix=seabios-1.16.2/ ea1b7a0733906b8425d948ae94fba63c32b1d425 | gzip -n > source.tar.gz`.
- Verify all supplied upstream materials: `sha256sum -c SHA256SUMS` from this directory.

SeaBIOS source includes additional per-file notices; the archive preserves all
of them, including notices on the build scripts. Do not relabel it as MIT or
as v86's BSD license. Distribute this source package and notices alongside the
ROMs, including when deploying the static site; links alone are not the supplied
source package. The source/config correspondence evidence is documented in
`docs/vendor-provenance.md`. This is not a legal clearance for other VM assets.

## Build candidates without network access

Run `vendor/seabios/build.sh /absolute/path/to/new-output-directory` from the
repository root. Requirements: GNU make, GCC with x86 code generation, GNU
binutils, Python 3, tar, gzip and sha256sum. No download or installation occurs.
The output directory must not exist. Sources, generated build files, ROMs and
output hashes remain available there for inspection. This script does not
modify the bundled runtime assets or mark them verified.

The source archive is unchanged. For the build only, the script supplies the
supported `.version` file and `EXTRAVERSION=-stitch1` to avoid embedding wall
clock/host metadata. The output still depends on the compiler/binutils version;
this is not a promise of bit-identical results across toolchains. Before
adopting a rebuilt pair, exercise VM boot, serial console, VGA display, guest
networking and restart with Stitch's actual guest image, then record the
replacement hashes in the product register. Keep the source bundle with it.

The first experimental rebuild using the upstream config with GCC 14.2.0,
GNU binutils 2.44 and GNU make 4.4.1 succeeded but did **not** reproduce either
existing ROM byte for byte. Do not represent that rebuild as proof that the
existing binaries were reconstructed. Exact original toolchain provenance is
not established; the controlled candidate build is a path to replacing this
uncertainty, not concealing it.

Two independent clean-directory runs of `build.sh` on that toolchain produced:

- `seabios.bin`: `5e9514ae936823c3a303c76cef337f248476ac2692ddbe68a46e76504c35e8de`
- `vgabios.bin`: `84f1f09a4e7ce66bb203f7f569af6f1068bfb1c6fe1ff4ea35713a3cd241f4df`

These are candidate build receipts, not shipped-runtime verification. Candidate
binaries are intentionally not included in this source-package change.
