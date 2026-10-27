#!/usr/bin/env bash
# Repo-public scan: fails when tracked files contain private paths, names or identifiers.
# Generic patterns live here; private literals live in the untracked .scan-private.local
# (one PCRE per line, '#' comments allowed).
set -u
cd "$(dirname "$0")/.."
self=scripts/scan-private.sh
local_file=.scan-private.local
hits=0
scan() { # $1 = pattern
  local out
  out=$(git ls-files -z | xargs -0 grep -nIiP -e "$1" -- 2>/dev/null | grep -vE "^(\./)?($self|$local_file|docs/RELEASING\.md):")
  if [ -n "$out" ]; then echo "$out"; hits=1; fi
}
scan '/home/(?!me\b)|bun-tmp/claude-|\b(?![0-9]{8}-0{8})[0-9]{8}-[0-9A-F]{16}\b'
if [ -f "$local_file" ]; then
  while IFS= read -r pat || [ -n "$pat" ]; do
    case "$pat" in ''|'#'*) continue ;; esac
    scan "$pat"
  done < "$local_file"
else
  echo "scan-private: no $local_file, generic patterns only"
fi
if [ "$hits" -ne 0 ]; then echo "scan-private: private identifiers found" >&2; exit 1; fi
echo "scan-private: clean"
