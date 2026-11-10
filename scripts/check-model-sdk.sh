#!/bin/sh
# Run only inside the immutable SDK selected by prismpm.lock.
# --prepare is an authoring writer, never a release gate. It writes the source
# lock and canonical formatting. Axiom policies still require prism-code axioms.
set -eu
cd "$(dirname "$0")/.."
mode=${1:---check}
case "$mode" in --check|--prepare) ;; *) echo 'usage: scripts/check-model-sdk.sh [--check|--prepare]' >&2; exit 64;; esac
for tool in lexlean prismpm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "required pinned SDK executable missing: $tool" >&2; exit 69; }
done
[ -f /opt/prismpm/share/standards.lock ] || { echo 'not running in the PrismPM SDK' >&2; exit 69; }
cmp standards.lock /opt/prismpm/share/standards.lock || { echo 'SDK standards lock differs from repository lock' >&2; exit 2; }
prismpm lock check
if [ "$mode" = --prepare ]; then
  (cd app && lexlean lock && lexlean fmt --all && lexlean lock && lexlean check)
  echo 'Authoring output only. Audit exact axioms with prism-code@0.7.2 axioms --write --project app; review source and lock changes; regenerate JS bindings; then run --check.'
  exit 0
fi
node scripts/check-model.mjs --check
(cd app && lexlean fmt --check && lexlean lock --check && lexlean check && lexlean verify)
prismpm --project app verify
