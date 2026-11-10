# Source-controlled guest candidate

This is a **candidate configuration and build recipe**, not a built image,
performance result, compatibility certificate or redistribution clearance.
It does not replace `images/buildroot-bzimage.bin`.

## Pinned official inputs

- Buildroot stable tag `2026.08.1`, commit
  `7fdeadb3b9f12f78e5fccca914d7fef47090ab9a`:
  https://github.com/buildroot/buildroot/tree/7fdeadb3b9f12f78e5fccca914d7fef47090ab9a
- Linux `6.18.7`, the version and source hash in that Buildroot release's
  official `configs/qemu_x86_defconfig` and `board/qemu/patches/linux/linux.hash`.
  Kernel archive SHA-256:
  `b726a4d15cf9ae06219b56d87820776e34d89fbc137e55fb54a9b9c3015b8f1e`.
- All other package versions, download locations and hashes come from this
  Buildroot revision. `BR2_DOWNLOAD_FORCE_CHECK_HASHES=y` rejects unrecorded
  source downloads. Never substitute a newer mutable branch implicitly.

The base `board/stitch/linux.config` is copied unchanged from Buildroot's
`board/qemu/x86/linux.config`. The init table is adapted from Buildroot's
`package/busybox/inittab`, with its original notice retained. Their upstream
license is in `BUILDROOT-COPYING`; root project licensing does not replace it.
This source recipe is updateable; pin and qualify security updates rather than
claiming this immutable package selection remains current forever.

## Capabilities to preserve

- 32-bit Pentium Pro target, no unsupported x86-64 requirement.
- Single bzImage containing BusyBox initramfs, compatible with v86's `bzimage`
  loader instead of adding a disk-image or external bootloader dependency.
- Legacy VGA text/keyboard console and serial shell, with familiar shell prompt
  for existing readiness observations.
- NE2000 PCI Ethernet (`NE2K_PCI`), `ifconfig`, route, IP, ping and DHCP tools.
  No automatic network lease is requested: Stitch currently assigns the guest's
  private address using its runtime command and governs transport consent.
- Virtio 9p filesystem support for the existing fs9p host/guest administration.
- Embedded kernel configuration for future provenance inspection.
- No SSH daemon or network-accessible root-login service. Local console shells
  belong to the host-controlled sandbox and must remain behind host consent.

## What has actually been checked

The pinned recipe built a candidate and collected its source/license materials
in [run42906244489](https://github.com/afflom/stitch/actions/runs/42906244489).
The initial probe failed because it bypassed Buildroot's `/init` device setup
and recognized a kernel banner as a shell prompt. The unchanged image passed
real v86 boot, serial shell, bidirectional 9p and Ethernet configuration in
4.68seconds after those host-probe corrections. See the exact image identity,
logs and source inventory in [the candidate evidence](../../docs/guest-candidate-evidence.md).

This is not adoption: production browser/VM lifecycle and consented-network
qualification, plus durable reviewed corresponding-source distribution, remain
required. The current shipped guest is unchanged.

## Build and retain source materials

Use an authorized Linux build host with GCC/G++, GNU make, patch, Perl, tar,
cpio, unzip, rsync, bc, file, wget, Python 3, gzip and xz. Buildroot performs its
own additional host dependency checks. It builds its cross-toolchain and host
helpers, so absence of a preinstalled target compiler is not itself a blocker.
Allow sufficient disk, memory and time for that first build; do not repeat it
inside ordinary JavaScript CI or on every unrelated change.

Clone the official Buildroot repository, check out the exact commit above,
then run:

```sh
vendor/guest/build-candidate.sh /path/to/buildroot /new/output/directory
```

The recipe performs dependency checks, hashed source retrieval, build and
`legal-info`. It enables Buildroot's reproducibility option and pins
`SOURCE_DATE_EPOCH` to the source commit. Bit reproducibility must still be
measured with a second clean build before being claimed.

Keep **all** of these together with a candidate release:

1. `release-materials/`: candidate image, exact Buildroot source archive, this
   complete external configuration tree, resolved Buildroot config and hashes.
2. `legal-info/`: manifests, all licenses, saved source packages, and README
   warnings. Review every warning; the mere existence of this directory does
   not prove that every license/source obligation is satisfied.
3. `downloads/`: original hashed package sources and toolchain sources, including
   material not automatically copied by `legal-info`.
4. Resolved Linux and BusyBox configs from `build/`, package/build logs, build
   host tool versions, and the final output hashes. Preserve patches and any
   subsequent local changes with their corresponding source.

Inventory the actual result rather than inventing a package inventory before
it exists. Never publish only the guest binary while leaving these materials
on an ephemeral build host.

## Adoption gate: real runtime, not compilation alone

Use the exact current Stitch JS/Wasm/BIOS and the candidate in a test fixture:
boot within the current 64 MiB allocation; reach VGA and serial shells; type
commands and observe output; configure the existing private Ethernet address;
exchange consented frames and verify revocation; mount/read/write the 9p share;
exercise host byte/inode limits without bypass; stop, restart and reset.
Record failures, time-to-ready, peak allocation and image hashes. Qualify the
kernel's CPU requirements against v86 instead of silently expanding resource
budgets or disabling capabilities. Coordinate with the VM administration
adapter owner before adoption. Only after passing this matrix may runtime
image URLs, model inventories, hashes and source-package pointers change.

## Purpose-specific GitHub build

`.github/workflows/guest-candidate.yml` runs only on manual dispatch or changes
to image-producing board/configuration/build-script inputs on `feat/**` branches.
Documentation and probe changes reuse existing images; workflow-only edits are
run explicitly when needed. It is not added to the
ordinary per-push model/runtime gate. The job installs official Ubuntu host
prerequisites, checks out the exact Buildroot commit, requires at least 20 GiB
free disk, and bounds the build step to 175 minutes (200-minute total job).
If that runner cannot meet disk/time/memory requirements, use a larger
explicitly authorized Linux runner with this same recipe; do not weaken source
checks or silently ship the old image as cleared.

The job retains logs, configs, image if produced, original downloads and
`legal-info`/source materials as an artifact for 14 days, including partial
failure evidence where available. Artifacts are temporary review outputs, not
a durable source distribution. Before releasing a successful image, publish
its reviewed corresponding-source package durably alongside it. No workflow
step changes the shipped image, publishes a release or grants clearance.

`qualify-candidate.mjs IMAGE` executes the actual repository-pinned v86 JS/Wasm
with existing BIOS and 64 MiB RAM. It requires an actual serial shell, tests
host-to-guest and guest-to-host 9p content, and asks the guest to find and
configure its `eth0`. Success is distinct from input echo and requires a host
readback of guest-written bytes. It fails after 180 seconds without complete
results. This is **not** a peer Ethernet exchange test, browser VGA/UI check,
resource-limit enforcement proof, or reset/restart test; the rest of the
adoption matrix remains mandatory for an actual replacement decision.
