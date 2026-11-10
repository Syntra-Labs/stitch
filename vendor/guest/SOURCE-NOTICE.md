# Guest source and license notice

The shipped `images/buildroot-bzimage.bin` is Linux 6.18.7 with Buildroot userspace.
Its SHA-256 is `313a6b545290a2b47856b49bfcc4c7577469749b315932ae008d39fe70fc7f07`
and its length is 8,053,248 bytes. The guest is not licensed solely under Stitch's MIT license.

**Complete corresponding source and license materials:** [https://github.com/afflom/stitch/tree/fd59fae669e9a40271fb584ca071270d8ed0b8f8](https://github.com/afflom/stitch/tree/fd59fae669e9a40271fb584ca071270d8ed0b8f8).
Download that exact source commit as a ZIP, extract it, and run `python3 reassemble.py`.
The standard-library script verifies every part and atomically reconstructs the archive:
`stitch-guest-corresponding-source.tar.gz`, 398,457,213 bytes, SHA-256
`fbc04b0c55f8421ca9bcf9e9dbac1952c07a1a2d82fd644ac67e66415b0106bc`.
The archive includes all target and host source archives, license texts, modifications,
patches, resolved configurations, external build tree and build/install scripts collected
for build `d17aa7f3ffc6944b799ac43f6a5bab04ab3b82ef`. Buildroot's source is also included.
Linux, BusyBox, glibc and other incorporated components retain their individual licenses
and copyright notices under `legal-info`; source files retain their original notices.
See `manifest.json` in the source commit for part identities and order.

Keep this notice and equivalent no-extra-charge access to those exact source materials
with any image distribution. For offline distribution, include the reconstructed source
archive rather than relying on network access. Do not substitute a generic upstream
source URL, an expiring Actions artifact, or a newer configuration for this image's sources.
This source branch is not a Stitch product release. Available materials and observed
runtime qualification do not imply a legal warranty or native Prism SDK acceptance.

The exact image requires host boot arguments
`console=tty0 console=ttyS0,115200 rdinit=/init nomodeset`.
Build recipe and qualification details are in `vendor/guest/README.md` and
`docs/guest-browser-qualification.md`.
