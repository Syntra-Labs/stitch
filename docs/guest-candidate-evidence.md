# Guest candidate evidence, 2026-11-10

This records the build and source review of the subsequently adopted image.
See [hosted qualification](guest-browser-qualification.md) and the durable
[source notice](../vendor/guest/SOURCE-NOTICE.md). It is not native SDK acceptance.

## Immutable build and inspection

- Build run: https://github.com/afflom/stitch/actions/runs/42906244489
- Build commit: `d17aa7f3ffc6944b799ac43f6a5bab04ab3b82ef`.
- Original artifact: `13810385970`, 758474204 bytes; ZIP SHA-256
  `91e8c082de05e97e0781e97f5636ae89a7b0095001192b3019ab9ff7054fc714`.
- Inspection run: https://github.com/afflom/stitch/actions/runs/42917114652
  on isolated diagnostic branch. Original ZIP and internal checksums passed;
  source archive partition reassembly matched the unchanged archive digest.
- Candidate image SHA-256:
  `313a6b545290a2b47856b49bfcc4c7577469749b315932ae008d39fe70fc7f07`.
- Image artifact `13810002248`; inspection artifact `13809487986`.
- Source parts: `13809457978` and `13809323434`, each below the connector's
  512 MiB limit. Reassemble in aa,ab order and check the supplied digests.
- These artifacts expire 2026-11-24; they are review outputs, not durable
  corresponding-source distribution.

## Exact failure and repair without rebuilding

The 61-minute image/source build succeeded. Initial qualification failed after
180 seconds. The real guest booted Linux 6.18.7, initialized NE2000 Ethernet and
9p, then repeatedly reported missing `/dev/tty1` and `/dev/ttyS0`.

The host command line selected `rdinit=/sbin/init`, bypassing Buildroot's
`/init` wrapper. That wrapper mounts devtmpfs before running `/sbin/init`;
initramfs does not automatically mount devtmpfs. In addition, the test's old
byte-stream prompt regex reacted to the `#` in the kernel's `#1` banner and
injected its command before the shell existed.

The same unmodified candidate image passed after the qualifier supplied
`rdinit=/init` and waited for a newline-anchored, space-terminated shell prompt.
Actual bundled-v86 execution completed in 4.68 seconds with 64 MiB configured
memory, verifying boot, serial command execution, host-to-guest 9p contents,
guest-to-host independent readback and guest eth0 presence/configuration.
No toolchain/image rebuild or runtime asset replacement was needed. The host
must retain `rdinit=/init` for this exact image: its compiled default still
contains the earlier `rdinit=/sbin/init` setting. A future recipe cleanup can
correct that default during a justified image rebuild.

This does not establish browser VGA/user-interface behavior, peer Ethernet
exchange/consent, administrator resource limits or reset/restart correctness.
Those paths were subsequently exercised in the linked hosted qualification. Do not rerun the full compiler
build merely to change or re-execute the small qualification script.

## Actual corresponding-source inventory

The inspection includes resolved Linux/BusyBox configs, Buildroot config,
target/host license manifests, complete source file inventory and build tail.
Target manifests identify Linux 6.18.7, BusyBox 1.38.0, glibc
`2.44-57-g34106fee698c83eb0af71d4d0381e66b399be746`, and GCC runtime components.
The archive includes corresponding package sources, applicable license texts,
BusyBox patches and their ordered series, and host build sources.

`legal-info/README` reports the standard missing-Buildroot-source warning. This
is addressed by the separately saved `release-materials/buildroot-source.tar.gz`
(SHA-256 `5313d2b5c366ecb6771543a8a587e5fab57d4c254c6c99e575f44466c248dee1`),
plus the exact external-tree archive/configuration and build script. Preserve
those with the package source materials, rather than presenting `legal-info`
alone as complete. Final distribution can deduplicate identical archives; it
must retain actual required source, modifications and instructions, accessible
with the image. A generic upstream link or temporary Actions artifact alone
is not the completed distribution route.

## Consumable source package prepared after inspection

The original source archive is 721,901,605 bytes (SHA-256
`ec0cb061df8f400ec2efbe36e18b9021ae91459c40b046bb9c40585d948d4635`).
It includes unnecessary glibc download-cache Git history: a 271,496,818-byte
pack and 21,747,832-byte index, although the actual 41,528,183-byte glibc source
archive is already present.

A source-review package was assembled without that redundant cache, preserving
**all** existing `legal-info` target/host sources, license texts and patches,
original `release-materials`, resolved Linux/BusyBox configurations and their
hash inventory. Shared source archives retain hardlinks instead of repeated
copies. The result is 398,457,213 bytes, SHA-256
`fbc04b0c55f8421ca9bcf9e9dbac1952c07a1a2d82fd644ac67e66415b0106bc`.
All 178 file-path checks and original release-material hashes pass. It fits a
single artifact download. It has now been durably published as verified parts
on a separate source-only Git branch, keeping bulky sources out of the product
feature diff. The immutable commit and reconstruction instructions are in the source notice.

The necessary release set is the actual image's applicable target sources,
modifications/patches, licenses, configuration and build/install scripts,
including Buildroot and the external tree. General-purpose host tools do not
become a new universal source-disclosure obligation just because they were
used to compile it. This convenient package retains the already-collected host
source materials as well, rather than making further size optimization a
release barrier. Retain the published package with equivalent access
alongside the image and preserve its verified URL/hash notice. No claim
of independent bit-identical image reproduction is required or made.
