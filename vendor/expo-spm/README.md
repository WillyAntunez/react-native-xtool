# Vendored Expo SwiftPM plugin

Expo's React Native SwiftPM autolinking plugin from Expo SDK 58.0.19 (`scripts/spm/`, without
`__tests__/` and `jest.config.js`). rn-xtool runs it for Expo SDK 57, which ships no SwiftPM plugin
of its own. SDK 58 and newer keep using the plugin installed in the app.

- Origin: expo 58.0.19, MIT, 650 Industries, Inc. (aka Expo) (see `LICENSE`).
- Modifications, in order:
  1. rn-xtool's fixes to Expo's plugin, applied with `patches/expo+58.0.19.patch` (`patch -p4`,
     run in the extracted `scripts/`), the same patch rn-xtool applies to SDK 58 apps.
  2. Five vendored-only edits (P1-P5) in `rn-xtool-edits.patch` (`patch -p1`, run in this
     directory). SDK 58 never runs them:
     - P1 (`plugin.js`): `expo-modules-macros` is resolved from expo-modules-core, then from this
       copy, so rn-xtool's `expo-modules-macros` 0.22.0 is used when core lacks it (SDK 57).
     - P2 (`app-target.js`, `flavored-frameworks.js`): the app's `@expo/config-plugins` (and the
       `xcode` next to it) and the monorepo precompiled base are resolved from
       `RN_XTOOL_PROJECT_ROOT`, never from this copy's location.
     - P3 (`manifests.js`): generated mixed and Objective-C packages default their header dir to
       the pod name, as CocoaPods does.
     - P4 (`manifests.js`): generated mixed and Objective-C packages get a CocoaPods-style
       `prefix.pch` that imports UIKit, passed with `-include` to C and C++.
     - P5 (`flavored-frameworks.js`): precompiled tarballs are extracted without macOS AppleDouble
       (`._*`) entries and pax xattrs.
- Environment: `RN_XTOOL_PROJECT_ROOT` (the app root, required; the plugin throws without it) and
  `EXPO_PRECOMPILED_MODULES_PATH` (optional, as upstream).
- `expo-modules-autolinking` 58.0.15 and `expo-modules-macros` 0.22.0 (with the host's
  `@expo/modules-macros-linux-<arch>`) are exact dependencies of rn-xtool; this copy finds them in
  rn-xtool's `node_modules`. Every package of the app (`expo`, `expo-modules-core`, the modules,
  `react-native`, `@expo/config-plugins`) is resolved from the app.
- `package.json` (`{ "type": "commonjs" }`) is needed because rn-xtool is `"type": "module"`.

`tests/vendor-expo-spm.test.ts` re-derives this directory from the pristine tarball and compares bytes.
