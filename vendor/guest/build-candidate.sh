#!/bin/sh
# Explicit candidate build only. Never alter images/buildroot-bzimage.bin.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source=${1:?Usage: build-candidate.sh PINNED_BUILDROOT_CHECKOUT NEW_OUTPUT_DIRECTORY}
out=${2:?Usage: build-candidate.sh PINNED_BUILDROOT_CHECKOUT NEW_OUTPUT_DIRECTORY}
source=$(CDPATH= cd -- "$source" && pwd)
pin=7fdeadb3b9f12f78e5fccca914d7fef47090ab9a
[ "$(git -C "$source" rev-parse HEAD)" = "$pin" ] || { echo 'Wrong Buildroot revision' >&2; exit 1; }
git -C "$source" diff --quiet HEAD -- || { echo 'Buildroot has tracked modifications' >&2; exit 1; }
missing=
for tool in gcc g++ make patch perl tar cpio unzip rsync bc file wget python3 gzip xz; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
[ -z "$missing" ] || { echo "Missing Buildroot host prerequisites:$missing" >&2; exit 2; }
mkdir "$out"
out=$(CDPATH= cd -- "$out" && pwd)
export SOURCE_DATE_EPOCH=$(git -C "$source" show -s --format=%ct HEAD)
make -C "$source" O="$out" BR2_EXTERNAL="$here" stitch_v86_defconfig
make -C "$source" O="$out" dependencies
# Download hashed package sources once, then construct and collect legal materials.
make -C "$source" O="$out" BR2_DL_DIR="$out/downloads" source
make -C "$source" O="$out" BR2_DL_DIR="$out/downloads" all
make -C "$source" O="$out" BR2_DL_DIR="$out/downloads" legal-info
mkdir "$out/release-materials"
git -C "$source" archive --format=tar --prefix=buildroot-2026.08.1/ "$pin" | gzip -n > "$out/release-materials/buildroot-source.tar.gz"
tar -czf "$out/release-materials/stitch-external-tree.tar.gz" -C "$here" .
cp "$out/.config" "$out/release-materials/buildroot.config"
cp "$out/images/bzImage" "$out/release-materials/stitch-guest-candidate.bin"
(cd "$out/release-materials" && sha256sum buildroot-source.tar.gz stitch-external-tree.tar.gz buildroot.config stitch-guest-candidate.bin > SHA256SUMS)
printf '%s\n' 'Candidate only: preserve downloads/, legal-info/, configs and build logs; review warnings and run the runtime matrix before adoption.'
