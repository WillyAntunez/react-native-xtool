#!/usr/bin/env bash
# Copies the ios-arm64 slice of every runtime framework the app links into <out>/Frameworks,
# dereferencing symlinks, so xtool can embed the directory as an app resource.
#
#   stage-frameworks.sh <out-dir> <framework-dir>...   (each arg is a dir holding X.framework)
set -euo pipefail
OUT="${1:?out dir}"; shift
DEST="$OUT/Frameworks"
rm -rf "$DEST"; mkdir -p "$DEST"
for dir in "$@"; do
  for fw in "$dir"/*.framework; do
    [ -d "$fw" ] || continue
    cp -RL "$fw" "$DEST/"
    echo "staged $(basename "$fw")"
  done
done
du -sh "$DEST"
