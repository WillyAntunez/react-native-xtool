#!/usr/bin/env bash
# Builds ExpoModulesJSI for iOS on Linux with the xtool Darwin SDK and wraps it as
# ExpoModulesJSI.framework, replacing Expo's "Build ExpoModulesJSI" Xcode phase
# (expo-modules-jsi/apple/scripts/build-swiftpm-app-phase.sh), which needs xcodebuild.
#
#   build-expo-modules-jsi.sh <app-root> <out-dir>
#
# RN_XTOOL_REACT_HEADERS / RN_XTOOL_DEPS_HEADERS replace the ios-arm64 Headers dirs of ReactNativeHeaders and
# ReactNativeDependenciesHeaders (default: under ios/build/xcframeworks, which SDK 57 builds after this script).
#
# Produces <out-dir>/ExpoModulesJSI.framework (ios-arm64, debug).
set -euo pipefail

APP_ROOT="$(cd "${1:?app root}" && pwd)"
OUT="${2:?out dir}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"

node_dir() { node -e 'console.log(require("path").dirname(require.resolve(process.argv[1]+"/package.json",{paths:[process.argv[2]]})))' "$1" "$2"; }
RN_DIR="$(node_dir react-native "$APP_ROOT")"
CORE_DIR="$(node_dir expo-modules-core "$(node_dir expo "$APP_ROOT")")"
JSI_DIR="$(node_dir expo-modules-jsi "$CORE_DIR")"

SDK="${XTOOL_DARWIN_SDK:-$HOME/.swiftpm/swift-sdks/darwin.artifactbundle}"
XCFRAMEWORKS="$APP_ROOT/ios/build/xcframeworks"
SLICE=ios-arm64
REACT_HEADERS="${RN_XTOOL_REACT_HEADERS:-$XCFRAMEWORKS/ReactNativeHeaders.xcframework/$SLICE/Headers}"
DEPENDENCIES_HEADERS="${RN_XTOOL_DEPS_HEADERS:-$XCFRAMEWORKS/ReactNativeDependenciesHeaders.xcframework/$SLICE/Headers}"

WORK="$OUT/.jsi-build"
STAGE="$WORK/pods-stage"
PUBLIC="$STAGE/Headers/Public"
mkdir -p "$PUBLIC"

# Same header staging as build-swiftpm-app-phase.sh: a CocoaPods-shaped Headers/Public tree.
stage_link() { mkdir -p "$(dirname "$PUBLIC/$2")"; ln -sfn "$1" "$PUBLIC/$2"; }
stage_link "$RN_DIR/ReactCommon/jsi/jsi" React-jsi/jsi
stage_link "$RN_DIR/ReactCommon/react/renderer/runtimescheduler" React-runtimescheduler/react/renderer/runtimescheduler
stage_link "$RN_DIR/ReactCommon/react/renderer/consistency" React-rendererconsistency/react/renderer/consistency
stage_link "$RN_DIR/ReactCommon/react/performance/timeline" React-performancetimeline/react/performance/timeline
stage_link "$RN_DIR/ReactCommon/react/timing" React-timing/react/timing
stage_link "$RN_DIR/ReactCommon/react/debug" React-debug/react/debug
stage_link "$RN_DIR/ReactCommon/callinvoker/ReactCommon" React-callinvoker/ReactCommon
stage_link "$RN_DIR/ReactCommon/runtimeexecutor/ReactCommon" React-runtimeexecutor/ReactCommon
stage_link "$REACT_HEADERS/hermes" hermes-engine/hermes
stage_link "$DEPENDENCIES_HEADERS" ReactNativeDependencies

export PODS_ROOT="$STAGE" RN_ROOT="$RN_DIR" REACT_NATIVE_PATH="$RN_DIR" EXPO_CUSTOM_BUILD_ROOT="$WORK/custom-build"
mkdir -p "$EXPO_CUSTOM_BUILD_ROOT"
bash "$JSI_DIR/apple/scripts/generate-modulemap.sh"

# Cross-compile the way xtool does (PackLib/BuildSettings.swift, swiftbuild path).
unset SDKROOT
# <swift/bridging> lives in the host toolchain's usr/include, which the Darwin resource dir lacks.
# `swift` may be a swiftly proxy, so ask the toolchain for its real location.
TOOLCHAIN="$(swiftly use --print-location 2>/dev/null || dirname "$(dirname "$(readlink -f "$(command -v swift)")")")"
SWIFT_INCLUDE="$TOOLCHAIN/usr/include"
export XCODE_EXTRA_PLATFORM_FOLDERS="$SDK/Developer/Platforms"
export PATH="$SDK/toolset/bin:$PATH"
swift build \
  --configuration debug \
  --build-system swiftbuild \
  --triple arm64-apple-ios16.4 \
  --toolset "$SDK/toolset-swb.json" \
  --package-path "$JSI_DIR/apple" \
  --scratch-path "$WORK/.build" \
  --product ExpoModulesJSI \
  -Xcxx -I"$SWIFT_INCLUDE" -Xswiftc -Xcc -Xswiftc -I"$SWIFT_INCLUDE" \
  -Xlinker -install_name -Xlinker @rpath/ExpoModulesJSI.framework/ExpoModulesJSI \
  -Xlinker -all_load
# -all_load: xtool's SDK turns `ld64.lld -r` into a libtool static archive, so without it the
# dylib link pulls no objects out of ExpoModulesJSI.o and ships empty.

PRODUCTS="$WORK/.build/out/Products/Debug-iphoneos"
echo "== products:"; ls -la "$PRODUCTS" | head -30

# Wrap the dylib as a framework: the autolinked graph links `-framework ExpoModulesJSI` and
# ExpoModulesCore loads it as @rpath/ExpoModulesJSI.framework/ExpoModulesJSI.
FW="$OUT/ExpoModulesJSI.framework"
rm -rf "$FW"; mkdir -p "$FW"
cp "$PRODUCTS/libExpoModulesJSI.dylib" "$FW/ExpoModulesJSI"
cat > "$FW/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>ExpoModulesJSI</string>
  <key>CFBundleIdentifier</key><string>dev.expo.modules.jsi</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>ExpoModulesJSI</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>16.4</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array>
</dict></plist>
PLIST
echo "== framework: $FW"; ls -la "$FW"
