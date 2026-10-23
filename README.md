# expo-xtool

Build, sign and install Expo (SDK 58+) iOS dev builds from Linux — no Mac — using
[xtool](https://github.com/xtool-org/xtool) and the official React Native / Expo SwiftPM pipeline.

Status: early stage. The recipe works end to end on a physical iPhone (2026-10-23); the CLI that
automates it is being built. See `docs/superpowers/specs/2026-10-23-expo-xtool-design.md`.

What's here today:

- `patches/` — small diffs to Expo's node_modules so the SPM pipeline runs on Linux.
- `scripts/` — build ExpoModulesJSI with the xtool Darwin SDK; stage runtime frameworks.
- `shims/` — minimal `plutil` and `otool` for Linux.

You bring your own `Xcode.xip` and Apple ID. Free Apple IDs work with the usual limits
(7-day signing, 3 apps, no push/entitlements).
