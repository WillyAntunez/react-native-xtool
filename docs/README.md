# rn-xtool documentation

Everything that does not fit in the [project README](../README.md): how the build works, bare React Native details,
Wi‑Fi installs, troubleshooting, library compatibility, and the research and design records behind them.

## Guides

- [how-it-works.md](how-it-works.md): what `setup` installs, the bundled patches, the build steps, Expo SDK 58's
  version floor and the precompiled framework check (G4), Expo SDK 57 through the vendored Expo SwiftPM plugin,
  mixed-language manifests, CocoaPods-only libraries and reference timings.
- [bare-react-native.md](bare-react-native.md): bare React Native projects (0.86.2, 0.86.3, 0.87.1, 0.88.0, 0.88.1)
  and 0.88.1 hybrids with Expo modules: supported versions, detection, what is read from the Xcode project, sources,
  resources, Metro, limits.
- [wifi-install.md](wifi-install.md): installing over Wi‑Fi without the cable, WSL2 pair records, Wi‑Fi troubleshooting.
- [troubleshooting.md](troubleshooting.md): first-run checklist on the iPhone and fixes for common build, Metro and
  signing problems, and the Expo SDK 58 and 57 version messages.
- [libraries.md](libraries.md): library compatibility matrix (Expo and bare), tested on a physical iPhone.

## Reference

- [recipe.md](recipe.md): the technical recipe the CLI automates, step by step with file locations.
- [RELEASING.md](RELEASING.md): release checklist and npm publishing under the `alpha` tag.

## Upstream write-ups

Fixes carried as patches, written up for the upstream projects:

- [upstream/expo-spm-plugin-umbrella.md](upstream/expo-spm-plugin-umbrella.md): Expo SwiftPM plugin, Swift files
  without imports lose UIKit.
- [upstream/expo-spm-plugin-mixed-modules.md](upstream/expo-spm-plugin-mixed-modules.md): Expo SwiftPM plugin, mixed,
  Objective-C-only and placeholder modules, meta pods, dev client chain.
- [upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md): the generic fixes to React Native's
  `spm scaffold`.
- [upstream/reanimated-worklets-manifest.md](upstream/reanimated-worklets-manifest.md): reanimated / worklets
  `Package.swift` fails on Linux hosts.
- [upstream/pymobiledevice3-tcp-heartbeat.md](upstream/pymobiledevice3-tcp-heartbeat.md): services over Wi‑Fi need a
  heartbeat session.
- [upstream/async-storage-analysis.md](upstream/async-storage-analysis.md): why async-storage 3.x does not build under
  SwiftPM yet.

## Research

- [research/mixed-modules-survey.md](research/mixed-modules-survey.md): which Expo SDK 58 / RN 0.88 libraries mix
  languages, and how Expo's SPM plugin classifies them.
- [research/oss-mixed-modules-survey.md](research/oss-mixed-modules-survey.md): experiments building mixed Swift +
  Objective-C modules with SwiftPM 6.4 and xtool.
- [research/wifi-install-spike.md](research/wifi-install-spike.md): the spike behind Wi‑Fi installs.
- [research/expo-57-vendored-plugin-spike.md](research/expo-57-vendored-plugin-spike.md): the spike that built Expo
  SDK 57 through Expo 58's SwiftPM plugin and React Native 0.88's SwiftPM scripts.
- [research/compat-suite-proposal.md](research/compat-suite-proposal.md): library popularity and linkage mechanisms,
  a proposal for a library compatibility suite.
- [research/expo-58-drift.md](research/expo-58-drift.md): Expo SDK 58 version drift (58.0.19 to 58.0.21), how Expo
  picks its precompiled modules, and the support model behind the 58.0.21 floor and G4.

## Design records

Historical specs and implementation plans, kept as written (some in Spanish; the project was called expo-xtool then).

- [design/specs/2026-10-23-expo-xtool-design.md](design/specs/2026-10-23-expo-xtool-design.md): original design.
- [design/specs/2026-10-23-generic-scaffold-design.md](design/specs/2026-10-23-generic-scaffold-design.md): generic
  SwiftPM scaffolding for CocoaPods-only libraries.
- [design/specs/2026-10-23-mixed-language-targets-design.md](design/specs/2026-10-23-mixed-language-targets-design.md):
  mixed-language (Swift + Objective-C) modules.
- [design/specs/2026-10-23-wifi-install-design.md](design/specs/2026-10-23-wifi-install-design.md): Wi‑Fi install.
- [design/specs/2026-10-26-bare-react-native-design.md](design/specs/2026-10-26-bare-react-native-design.md): bare
  React Native projects.
- [design/specs/2026-10-27-expo-sdk-57-design.md](design/specs/2026-10-27-expo-sdk-57-design.md): Expo SDK 57 through
  a vendored Expo SwiftPM plugin.
- [design/plans/2026-10-23-expo-xtool-cli.md](design/plans/2026-10-23-expo-xtool-cli.md): CLI implementation plan.
- [design/plans/2026-10-26-bare-react-native.md](design/plans/2026-10-26-bare-react-native.md): bare React Native
  implementation plan.
- [design/plans/2026-10-28-expo-sdk-57.md](design/plans/2026-10-28-expo-sdk-57.md): Expo SDK 57 implementation plan.
