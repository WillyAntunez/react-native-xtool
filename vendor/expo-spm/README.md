# Vendored Expo SwiftPM plugin

Expo's React Native SwiftPM autolinking plugin from Expo SDK 58.0.19 (`scripts/spm/`, without
`__tests__/` and `jest.config.js`). rn-xtool runs it for Expo SDK 57, which ships no SwiftPM plugin
of its own. SDK 58 and newer keep using the plugin installed in the app.

- Origin: expo 58.0.19, MIT, 650 Industries, Inc. (aka Expo) (see `LICENSE`).
- Modifications, in order:
  1. rn-xtool's fixes to Expo's plugin, applied with `patches/expo+58.0.19.patch` (`patch -p4`,
     run in the extracted `scripts/`), the same patch rn-xtool applies to SDK 58 apps.
  2. Six vendored-only edits (P1-P6) in `rn-xtool-edits.patch` (`patch -p1`, run in this
     directory). SDK 58 never runs them:
     - P1 (`plugin.js`): `expo-modules-macros` is resolved from expo-modules-core, then from this
       copy, so rn-xtool's `expo-modules-macros` 0.22.0 is used when core lacks it (SDK 57).
     - P2 (`app-target.js`, `flavored-frameworks.js`): the app's `@expo/config-plugins` (through
       the app's `expo`, as the installed copy finds it, and the `xcode` next to it) and the
       monorepo precompiled base are resolved from `RN_XTOOL_PROJECT_ROOT`, never from this copy's
       location.
     - P3 (`manifests.js`): generated mixed and Objective-C packages default their header dir to
       the pod name, as CocoaPods does.
     - P4 (`manifests.js`): generated mixed and Objective-C packages get a CocoaPods-style
       `prefix.pch` that imports UIKit, passed with `-include` to C and C++.
     - P5 (`flavored-frameworks.js`): precompiled tarballs are extracted without macOS AppleDouble
       (`._*`) entries and pax xattrs. Its tar flags assume GNU tar: rn-xtool targets Linux, and
       busybox tar and bsdtar are not supported (accepted limitation).
     - P6 (`podspec.js`, `manifests.js`, `plugin.js`): a subspec with its own `compiler_flags` and
       `source_files` under one directory inside the source directory becomes a Clang target of its
       own, `<Pod>_<Subspec>` (expo-dev-launcher 57's `Unsafe` subspec, `-x objective-c++
       -std=c++20 -fno-objc-arc`, as `EXDevLauncher_Unsafe` over `ios/Unsafe`). The module's target
       excludes the directory; the new target has the module's Clang settings plus the subspec's
       flags, then `-fno-cxx-modules` when they switch the language to C++ (React's C++ headers are
       redefined through the React module otherwise), takes over the module's excludes under its
       directory (tests, Apple-only resources), depends on the module's target and is in its
       product. Its headers keep their `<header_dir/...>` forwarders. `emitSourceModule` is
       exported for the tests. SDK 58's dev-launcher has no such subspec. Limits (the podspec is
       read as text, never run):
       - Only literal values are read: `x.compiler_flags` and `x.source_files` must be a string,
         strings separated by commas or an array of strings, with nothing else on the line but a
         comment. A condition (`'-w' if ENV['X']`), a variable, an operator, `+=` or `<<`, or
         interpolation leaves the subspec in the module's target, as before P6.
       - Flags are split on whitespace only, without shell quoting: `'-DNAME="a b"'` becomes
         `-DNAME="a` and `b"`, where Xcode would pass one argument.
       - Each glob must be `<dir>/**/<pattern>` or `<dir>/<pattern>`, all with one `<dir>`. The whole
         directory, subdirectories included, then belongs to the subspec: the pattern is not
         checked against the files in it.
       - Not split, its files built as before P6 (in the module's target without the flags, or not
         at all outside the source directory): a directory with Swift, without C-family sources,
         equal to or outside the source directory, or inside an ignored one (`Tests`, `UITests`, any
         `*Tests`); a subspec whose target name an earlier subspec already took (`Foo-Bar` and
         `Foo_Bar`).
       - Overlapping directories, in podspec order: a subspec whose directory is inside an earlier
         subspec's is not split, and its files are compiled in the outer subspec's target with the
         outer subspec's flags. A subspec whose directory contains an earlier subspec's is not split
         either: the earlier subspec keeps its own files, and the rest stays in the module's target
         without the flags.
- How rn-xtool runs it: the driver (`scripts/rn-spm-generate.js --expo-plugin <this>/spm/plugin.js`)
  sets `RN_SPM_EXPO_PLUGIN` to this plugin, which the vendored React Native scripts load as `expo`'s
  autolinking plugin (edit E5 in `vendor/rn-spm`), and `RN_XTOOL_PROJECT_ROOT` to the app root.
- Environment: `RN_XTOOL_PROJECT_ROOT` (the app root, required; the plugin throws without it) and
  `EXPO_PRECOMPILED_MODULES_PATH` (optional, as upstream). rn-xtool sets the latter to
  `ios/build/expo-precompiled`, where its `jsi` step writes the `ExpoModulesJSIHeaders.xcframework`
  that SDK 57 does not ship.
- `expo-modules-autolinking` 58.0.15 and `expo-modules-macros` 0.22.0 (with the host's
  `@expo/modules-macros-linux-<arch>`) are exact dependencies of rn-xtool; this copy finds them in
  rn-xtool's `node_modules`. Every package of the app (`expo`, `expo-modules-core`, the modules,
  `react-native`, `@expo/config-plugins`) is resolved from the app.
- rn-xtool's `expo-modules-autolinking` is not patched. On Linux its `@ExpoModule` scanner returns
  early, without a warning, so only modules declared in `expo-module.config.json` are linked: the
  same set as SDK 57's own autolinking, which has no scanner.
- `package.json` (`{ "type": "commonjs" }`) is needed because rn-xtool is `"type": "module"`.

`tests/vendor-expo-spm.test.ts` re-derives this directory from the pristine tarball and compares
bytes (skipped until the tarball is fetched with
`mkdir -p tests/.cache && npm pack expo@58.0.19 --pack-destination tests/.cache`). After a change to
`patches/expo+58.0.19.patch`, re-derive this directory the same way so the test stays green.
