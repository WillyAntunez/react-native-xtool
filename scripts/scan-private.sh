#!/usr/bin/env bash
# Repo-public scan: fails when tracked files contain private paths, names or identifiers.
set -u
cd "$(dirname "$0")/.."
self=scripts/scan-private.sh
hits=0
scan() { # $1 = grep flags, $2 = pattern
  local out
  out=$(git ls-files -z | xargs -0 grep -nIP"$1" -e "$2" -- 2>/dev/null | grep -vE "^(\./)?($self|docs/RELEASING\.md):")
  if [ -n "$out" ]; then echo "$out"; hits=1; fi
}
scan i '/home/(?!me\b)|doktu|grescup|bella|iPhone de|00008030-0016|willyantunez(?!/expo-xtool)|towerhouse'
scan "" '\bTHS\b|G7T6C5W9ZU'
if [ "$hits" -ne 0 ]; then echo "scan-private: private identifiers found" >&2; exit 1; fi
echo "scan-private: clean"
