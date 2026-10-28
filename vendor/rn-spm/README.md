# Vendored React Native SwiftPM scripts

SwiftPM setup scripts from React Native 0.88.0 (`scripts/setup-apple-spm.js`, `scripts/spm/`,
`scripts/codegen/templates/Package.swift.spm-template`), used by rn-xtool for React Native
versions that ship no `scripts/spm` of their own.

- Origin: react-native 0.88.0, MIT, Meta Platforms, Inc. and affiliates (see `LICENSE`).
- Modifications, in order:
  1. The 18 fixes of `docs/upstream/react-native-scaffolder.md`, applied with
     `patches/react-native+0.88.0.patch` (`patch -p4`, run in the extracted `scripts/`).
  2. Five rn-xtool edits (E1-E5) in `rn-xtool-edits.patch` (`patch -p1`, run in this directory):
     the codegen template resolves relative to this copy, the installed React Native root comes
     only from `RN_SPM_RN_ROOT`, `download-spm-artifacts.js` gains `--allow-pre-headers-spec`, and
     (E5) `spm/autolinking-plugins.js` takes the autolinking plugin of the dependency named `expo`
     from `RN_SPM_EXPO_PLUGIN` (an absolute path, set by the driver's `--expo-plugin`) when `expo`
     declares none, which is the case for Expo SDK 57.
- `package.json` (`{ "type": "commonjs" }`) is needed because rn-xtool is `"type": "module"`.
- The `__dirname` candidates in `spm/spm-utils.js` and `setup-apple-spm.js` `resolveReactNativeRoot`
  are untouched and unreachable: the driver always passes `--react-native-root`.

`tests/vendor-rn-spm.test.ts` re-derives this directory from the pristine tarball and compares bytes.
