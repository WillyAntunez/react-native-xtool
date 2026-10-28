#!/usr/bin/env bash
# Rebuilds the arm64 iOS Mach-O fixtures for tests/symbols.test.ts with the Swift toolchain's clang and xtool's
# Darwin SDK linker. lld warns that it "does not support linking for platform iOS"; the output is still valid.
set -euo pipefail
cd "$(dirname "$0")"
PATH="$HOME/.local/share/swiftly/bin:$PATH"
LD="$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/toolset/bin/orig/ld64.lld"
OBJ="$(mktemp -d)"
trap 'rm -rf "$OBJ"' EXIT

link() { # <output> <name> <object> [extra ld args]
  local out="$1" name="$2" obj="$3"
  shift 3
  mkdir -p "$(dirname "$out")"
  "$LD" -arch arm64 -platform_version ios 16.4 16.4 -dylib -install_name "@rpath/$name.framework/$name" \
    -o "$out" "$obj" "$@"
}

for src in core-v1 core-v2 mod; do
  clang -target arm64-apple-ios16.4 -c "src/$src.c" -o "$OBJ/$src.o"
done
link Core-v1/Core.framework/Core Core "$OBJ/core-v1.o"
link Core-v2/Core.framework/Core Core "$OBJ/core-v2.o"
link Mod.framework/Mod Mod "$OBJ/mod.o" Core-v2/Core.framework/Core
