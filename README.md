# react-native-xtool

Build, sign and install Expo and bare React Native iOS dev builds from Linux, with no Mac, then develop with Metro and
Fast Refresh over Wi‑Fi. Built on [xtool](https://github.com/xtool-org/xtool) and the official React Native / Expo
SwiftPM pipeline.

[![npm](https://img.shields.io/npm/v/react-native-xtool/alpha?label=npm%20%40alpha)](https://www.npmjs.com/package/react-native-xtool)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Status:** alpha, [`react-native-xtool@0.1.0-alpha.1` on npm](https://www.npmjs.com/package/react-native-xtool) under the
`alpha` tag. Verified end to end on a physical iPhone on 2026-10-26.

<!-- demo GIF: rn-xtool run → app opens on the iPhone → Fast Refresh -->
Demo video coming soon.

## Which projects work

| Project or target | Status |
| --- | --- |
| Expo SDK 58 | ✅ |
| Bare React Native 0.88 (`@react-native-community/cli init`) | ✅ [details](docs/bare-react-native.md) |
| Bare React Native + Expo modules (hybrid) | ✅ [details](docs/bare-react-native.md#hybrid-bare--expo-modules) |
| Expo SDK 57 and older, React Native 0.87 and older | ⏳ not yet |
| iOS simulator | ❌ macOS only |
| Production / App Store builds | ❌ use EAS |
| macOS or Windows as the host | ❌ (WSL2 on x86_64 should work as Linux; not tested yet, reports welcome) |

CocoaPods is not needed: the `Podfile` is ignored. Any library with a podspec is tried automatically (CocoaPods-only
ones get a generated `Package.swift`); [docs/libraries.md](docs/libraries.md) lists the ones verified on a device and
what does not work yet (library resource bundles, vendored binaries, Xcode-only tools).

## Before you start

- Linux x86_64 (arm64 should work, untested). Node 20+. About 15 GB of free disk.
- `Xcode.xip` (Xcode 27.x, about 12 GB), downloaded yourself from developer.apple.com with an Apple ID.
- An Apple ID. Free accounts: signatures last 7 days, 3 apps at a time, no push notifications or special entitlements
  (a paid developer account lifts these).
- An iPhone connected over USB for the first install (later installs can go [over Wi‑Fi](docs/wifi-install.md)).
- `libfuse2` (`sudo apt install libfuse2`), `python3`, `iproute2`. `setup` installs Swift and prints the exact `apt-get`
  line for any missing Swift system packages ([list](docs/how-it-works.md#what-setup-installs)).
- npm or Yarn classic. patch-package needs a flat `node_modules`; pnpm and Yarn PnP are not supported.

## Install

```sh
npm i -g react-native-xtool@alpha       # the package is react-native-xtool, the command is rn-xtool
npx react-native-xtool@alpha doctor     # or try it without installing
npm i -g github:WillyAntunez/react-native-xtool   # from GitHub (builds on install via `prepare`)
git clone https://github.com/WillyAntunez/react-native-xtool   # from a clone, for contributors
cd react-native-xtool && npm ci && npm run build && npm link
```

## Quick start

```sh
rn-xtool setup --xcode-xip ~/Downloads/Xcode_27.1.xip   # once per machine: Swift 6.4, xtool 1.23.0, Darwin SDK
rn-xtool auth login                                     # your Apple ID (interactive, handled by xtool)
```

### Expo

```sh
npx create-expo-app@latest my-app --template default@sdk-58 && cd my-app
rn-xtool run   # with the iPhone plugged in
```

### Bare React Native

```sh
npx @react-native-community/cli init MyApp --version 0.88.0 && cd MyApp
rn-xtool run   # with the iPhone plugged in
```

`run` = `build` + `install` + `start`, skipping build and install when nothing changed. A fresh `create-expo-app`
project works as is: with no `ios.bundleIdentifier` in `app.json`, `build` writes `com.anonymous.<slug>` there and tells
you (change it if you want another; `expo prebuild` would ask you for one). First run on the iPhone
([checklist](docs/troubleshooting.md#first-run-checklist-on-the-iphone)):

- Enable Developer Mode (Settings > Privacy & Security > Developer Mode); the phone reboots.
- Trust your Apple ID under Settings > General > VPN & Device Management.
- Open the app by hand and allow Local Network access; keep the phone on the same Wi‑Fi as the computer.

## Daily loop

`rn-xtool run` is the one command to use. It fingerprints your installed dependencies (plus `patches/*.patch`) and
compares them with the last successful build and install ([details](docs/how-it-works.md#rebuild-detection)):

- **Up to date**, and the baked Metro port and LAN IP still work: prints `Native app is up to date`, skips build and
  install, and starts Metro without clearing its cache.
- **Changed** (for example after `npx expo install <native lib>`), never installed, or the port or LAN IP changed: it
  rebuilds, reinstalls and starts Metro with `--clear`. Any dependency change rebuilds, native or JS.
- `run --force` (or `--clean`) always rebuilds and reinstalls; `start --clear` forces a Metro cache reset.
- `run --network` installs over Wi‑Fi, no cable, after a one-time USB pairing
  ([docs/wifi-install.md](docs/wifi-install.md)).

## Commands

| Command | What it does |
| --- | --- |
| `setup [--xcode-xip <path>] [--wifi [--yes] [--udid <udid>]]` | Installs Swift via swiftly, the xtool AppImage and the Darwin SDK. Idempotent. `--wifi` is the one-time USB step for Wi‑Fi installs: it caches the pair record and, with `--yes`, enables Wi‑Fi connections on the iPhone. |
| `auth [args...]` | Runs `xtool auth <args>` (`auth login`, `auth logout`); with no arguments, `xtool auth status`. |
| `doctor` | Checks toolchain, SDK, login, connected device, Wi‑Fi install readiness and project. Exits non-zero on problems. |
| `build [--clean]` | Prebuild if `ios/` is missing (Expo only), patches, RN/Expo SwiftPM pipeline, ExpoModulesJSI (Expo modules only), generates `ios-xtool/`, `xtool dev build`. `--clean` re-runs `expo prebuild --clean` for Expo; for bare it removes `ios/build` and `ios-xtool` and leaves the rest of `ios/` alone. |
| `install [--network [ip] [--udid <udid>] [--pair-record <file>]]` | Signs and installs the app on the USB-connected iPhone (over Wi‑Fi without the cable with `--network`, see [docs/wifi-install.md](docs/wifi-install.md)), then prints the Metro URL (Expo apps with `expo-dev-client` only) and the first-run checklist. |
| `start [--clear]` | Starts Metro (`npx expo start`; `npx react-native start` for bare) on the port and LAN IP the app was built for. Tells you to rebuild if either changed; clears the Metro cache when dependencies changed (or with `--clear`). |
| `run [--clean] [--force] [--network [ip]]` | `build` and `install` when dependencies changed (or with `--force`), then `start`. `--network` installs over Wi‑Fi. |

## Configuration

Optional `rn-xtool.config.json` in the project root (recommended). A `rn-xtool.config.js` also works, but it must be
CommonJS (`module.exports = {...}`) unless your project is ESM. Both are merged, `.js` winning:

```json
{ "xcodeXipPath": "/home/me/Downloads/Xcode_27.1.xip", "metroPort": 8082, "lanIp": "192.168.1.20",
  "rnArtifactsDir": "/home/me/rn-artifacts/0.88.0/debug", "xtoolPath": "/opt/xtool/xtool" }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `xcodeXipPath` | none | Xcode.xip used by `setup` when `--xcode-xip` is not given (the flag wins). |
| `metroPort` | `8081` | Metro port, baked into the app at build time. |
| `lanIp` | auto-detected | LAN IP the phone uses to reach Metro, baked into the app. Pin it when a VPN is on. |
| `rnArtifactsDir` | none | Use already-downloaded React Native prebuilts instead of downloading (offline). |
| `xtoolPath` | managed copy | Use a specific xtool binary in `setup`, `doctor` and `install` (`setup` skips the download; it must exist and be executable). |
| `projectKind` | auto-detected | `"expo"` or `"bare"`, to skip [project detection](docs/bare-react-native.md#detection). |

## Limits

- The Metro port and LAN IP are baked into the app: if either changes, rebuild and reinstall (`run` does it for you).
- The installed bundle ID is `XTL-<TEAM_ID>.<bundleIdentifier>` because xtool renames it.
- `expo-dev-client`: the launcher's and dev menu's icons are missing (no `actool` on Linux for their asset catalogs);
  with Metro off port 8081, type the URL `install` prints (`http://<lanIp>:<metroPort>`) in the launcher.
- Bare projects: one app target and one `.xcodeproj`, always built for iOS 16.4; `.xcconfig` files, entitlements,
  capabilities, script phases, storyboards, asset catalogs and `.xib` files are not used ([details](docs/bare-react-native.md#limits)).
- Metal shaders are not compiled on Linux: react-native-svg's Metal filters are unavailable.

## Learn more

- [docs/how-it-works.md](docs/how-it-works.md): what `setup` installs, the patches, the build steps, reference timings.
- [docs/bare-react-native.md](docs/bare-react-native.md): bare React Native and hybrid projects in detail.
- [docs/wifi-install.md](docs/wifi-install.md): installing over Wi‑Fi, WSL2, Wi‑Fi troubleshooting.
- [docs/troubleshooting.md](docs/troubleshooting.md): first-run checklist and common problems.
- [docs/libraries.md](docs/libraries.md): library compatibility matrix.
- [docs/recipe.md](docs/recipe.md): the technical recipe the CLI automates, with file locations.
- [docs/RELEASING.md](docs/RELEASING.md): how releases are made.
- [docs/README.md](docs/README.md): index of every page, including upstream write-ups, research and design records.

## Contributing

Branches: `feature/<kebab-name>` or `fix/<kebab-name>`; Conventional Commits in English (`type: short imperative
summary`). Run `npm test` before opening a PR. It needs no external setup: tests reading the patched React Native / Expo
files use the reference app (default `../app`, a sibling of the checkout; `RN_XTOOL_REF_APP` overrides) and skip without
it. The functional Expo plugin check re-runs `setup-apple-spm.js update`, rewriting that app's `ios/build`, so it runs
only with `RN_XTOOL_E2E=1` (it also needs Swift and the `shims/` directory on `PATH`).

## License

MIT, see [LICENSE](LICENSE). You bring your own `Xcode.xip` and Apple ID: rn-xtool redistributes nothing from Apple;
it extracts the SDK locally from your copy, and Apple's Xcode license terms apply to that use.
