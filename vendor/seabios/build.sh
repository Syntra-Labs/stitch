#!/bin/sh
# Build candidates only. Never replace the shipped ROMs implicitly.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${1:?Usage: build.sh NEW_OUTPUT_DIRECTORY}
mkdir "$out" # Refuse existing directories, including the repository root.
out=$(CDPATH= cd -- "$out" && pwd)
(cd "$here" && sha256sum -c SHA256SUMS)
mkdir "$out/source"
tar -xzf "$here/source.tar.gz" --strip-components=1 -C "$out/source"
cp "$here/seabios.config" "$out/source/.config"
# SeaBIOS's supported release-tarball version input avoids time/hostname stamps.
printf '%s\n' 'rel-1.16.2-0-gea1b7a0' >"$out/source/.version"
make -C "$out/source" EXTRAVERSION=-stitch1 PYTHON=python3
cp "$out/source/out/bios.bin" "$out/seabios.bin"
cp "$out/source/out/vgabios.bin" "$out/vgabios.bin"
(cd "$out" && sha256sum seabios.bin vgabios.bin > SHA256SUMS)
printf '%s\n' 'Candidates built; VM boot/console/network regression tests are required before adoption.'
