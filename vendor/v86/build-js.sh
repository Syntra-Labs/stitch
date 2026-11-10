#!/bin/sh
# Reconstruct the shipped JS from pinned source without network access.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
jar=${1:?Usage: build-js.sh CLOSURE_COMPILER_JAR NEW_OUTPUT_DIRECTORY}
out=${2:?Usage: build-js.sh CLOSURE_COMPILER_JAR NEW_OUTPUT_DIRECTORY}
jar=$(realpath "$jar")
expected=64f161c65a3dba42c9a4f5a79db335ac0e757fcba486cd7928205ac4c258ef08
actual=$(sha256sum "$jar" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo 'Wrong Closure compiler checksum' >&2; exit 1; }
(cd "$here" && sha256sum -c SHA256SUMS)
mkdir "$out"
out=$(CDPATH= cd -- "$out" && pwd)
mkdir "$out/source"
tar -xzf "$here/source.tar.gz" --strip-components=1 -C "$out/source"
make -C "$out/source" CLOSURE="$jar" build/libv86.js
cp "$out/source/build/libv86.js" "$out/libv86.js"
actual=$(sha256sum "$out/libv86.js" | cut -d ' ' -f 1)
[ "$actual" = b80fba71dacb7977e5b46800b3ba194bba7fe13e52fa3d22f80cc060ff015a4e ] || {
  echo 'Build differs from shipped JS; do not replace runtime automatically' >&2; exit 1;
}
printf '%s\n' 'Exact shipped JavaScript reconstructed; runtime files unchanged.'
