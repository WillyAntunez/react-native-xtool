# react-native-xtool

Build, sign and install Expo (SDK 58+) and bare React Native (0.88+) iOS dev builds from Linux, with no Mac, using
[xtool](https://github.com/xtool-org/xtool) and the official React Native / Expo SwiftPM pipeline.
Then develop with Metro and Fast Refresh over Wi-Fi, as you would with Xcode.

**Status:** early. Works end to end on a physical iPhone as of 2026-10-23. Expo SDK 58+ and bare React Native 0.88+ (see [Bare React Native projects](docs/bare-react-native.md)).
Version 0.x, alpha (npm tag `alpha`).

## Requirements

- Linux x86_64 (arm64 should work, untested). Node 20+.
- `libfuse2` (runs the xtool AppImage): `sudo apt install libfuse2` on Ubuntu.
- Swift's system packages. `setup` installs Swift itself (via swiftly) and, when packages are missing, prints the
  exact `sudo apt-get update && sudo apt-get -y install ...` line to run before running `setup` again (on Ubuntu 24.04: `binutils zip gnupg2 libc6-dev
  libcurl4-openssl-dev libedit2 libgcc-13-dev libpython3-dev libstdc++-13-dev libxml2-dev libncurses-dev libz3-dev pkg-config zlib1g-dev`).
- `python3` (used by the `plutil` / `otool` shims) and `iproute2` (the `ip` command, to detect the LAN IP).
- Package manager: npm or Yarn classic. patch-package needs a flat `node_modules`; pnpm and Yarn PnP are not supported.
- About 15 GB of free disk (Xcode.xip is about 12 GB, the extracted SDK about 7 GB).
- `Xcode.xip` (Xcode 27.x) that you download yourself from developer.apple.com.
- An Apple ID (free or paid) and an iPhone connected over USB for the first install.
- An Expo SDK 58+ project, or a bare React Native 0.88+ project with `ios/<Name>.xcodeproj` (React Native 0.88.0 or
  newer is required for its SwiftPM artifacts). CocoaPods is not needed: the `Podfile` is ignored.

## Install

Linux only: x86_64 is the tested platform, and WSL2 (Ubuntu) on x86_64 is supported as Linux.

```sh
# 1. From npm (alpha tag), after the first publish
npx react-native-xtool@alpha doctor
npm i -g react-native-xtool@alpha

# 2. From GitHub (builds on install through the `prepare` script)
npm i -g github:WillyAntunez/react-native-xtool

# 3. From a clone, for contributors
git clone https://github.com/WillyAntunez/react-native-xtool && cd react-native-xtool
npm ci && npm run build && npm link
```

## Quick start

```sh
# Once per machine: Swift 6.4 (swiftly), xtool 1.23.0, Darwin SDK from your Xcode.xip
rn-xtool setup --xcode-xip ~/Downloads/Xcode_27.1.xip

# Sign in with your Apple ID (interactive, handled by xtool)
rn-xtool auth login

# In your Expo project, with the iPhone plugged in
cd my-app
rn-xtool run
```

A project straight out of `create-expo-app` works as is: when `app.json` has no `ios.bundleIdentifier`, `build` writes
`com.anonymous.<slug>` into it and tells you (change it there if you want another; `expo prebuild` would ask you for one).

`run` = `build` + `install` + `start`, but it skips the build and install when
nothing changed since the last build. The cable is needed only when it reinstalls, or never with
[Wi‑Fi installs](docs/wifi-install.md) (`install --network`).

## Daily loop

`rn-xtool run` is the one command to use. It fingerprints your installed dependencies
(every `dependencies`/`devDependencies` entry at its installed version, plus `patches/*.patch`)
and compares that with the fingerprints stored by the last successful `build` and `install`:

- **Unchanged** (built and installed for the current dependencies, and the baked Metro port and
  LAN IP still work): it prints `Native app is up to date`, skips build and install and starts
  Metro without clearing its cache.
- **Changed** (for example after `npx expo install <native lib>`), or never installed, or the
  port or LAN IP no longer match: it rebuilds, reinstalls and starts Metro with `--clear`
  (every rebuild clears the cache), so a new native module and new Babel plugins are picked up.
  Without this you get `TurboModuleRegistry.getEnforcing(...) could not be found` (app not
  rebuilt) or `Metro has encountered an error while trying to resolve module` (stale cache).

There is no native/JS distinction: any dependency change rebuilds. JS-only changes also need
a Metro cache reset, and telling native dependencies apart reliably needs the autolinking pass.

- `rn-xtool start` warns and adds `--clear` itself when dependencies changed since the last
  build; `rn-xtool start --clear` forces a cache reset.
- `rn-xtool run --force` always rebuilds and reinstalls (`--clean` does too).
- `rn-xtool doctor` reports a `deps` warning when the app is out of date.

## Commands

| Command | What it does |
| --- | --- |
| `setup [--xcode-xip <path>]` | Installs Swift via swiftly, the xtool AppImage and the Darwin SDK. Idempotent. |
| `setup --wifi [--yes] [--udid <udid>]` | One-time USB step for Wi‑Fi installs: caches the pair record and, with `--yes`, enables Wi‑Fi connections on the iPhone. |
| `doctor` | Checks toolchain, SDK, login, connected device, Wi‑Fi install readiness and project. Exits non-zero on problems. |
| `build [--clean]` | Prebuild if `ios/` is missing (Expo only), patches, RN/Expo SwiftPM pipeline, ExpoModulesJSI (Expo modules only), generates `ios-xtool/`, `xtool dev build`. `--clean` re-runs `expo prebuild --clean` for Expo; for bare it removes `ios/build` and `ios-xtool` and leaves the rest of `ios/` alone. |
| `install` | Signs and installs the app on the USB-connected iPhone, then prints the Metro URL (for the expo-dev-client launcher; Expo apps with `expo-dev-client` only) and the first-run checklist. |
| `install --network [ip] [--udid <udid>] [--pair-record <file>]` | Same, over Wi‑Fi without the cable (see below). |
| `start [--clear]` | Starts Metro (`npx expo start`; `npx react-native start` for bare) on the port and LAN IP the app was built for. Tells you to rebuild if either changed; clears the Metro cache when dependencies changed (or with `--clear`). |
| `run [--clean] [--force] [--network [ip]]` | `build` and `install` when dependencies changed (or with `--force`), then `start`. `--network` installs over Wi‑Fi. |


## Configuration

Optional `rn-xtool.config.json` in the project root (recommended). A `rn-xtool.config.js` also works, but it
must be CommonJS (`module.exports = {...}`) unless your project is ESM. Both are merged, `.js` winning:

```json
{
  "xcodeXipPath": "/home/me/Downloads/Xcode_27.1.xip",
  "metroPort": 8082,
  "lanIp": "192.168.1.20",
  "rnArtifactsDir": "/home/me/rn-artifacts/0.88.0/debug",
  "xtoolPath": "/opt/xtool/xtool"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `xcodeXipPath` | none | Xcode.xip used by `setup` when `--xcode-xip` is not given (the flag wins). |
| `metroPort` | `8081` | Metro port, baked into the app at build time. |
| `lanIp` | auto-detected | LAN IP the phone uses to reach Metro, baked into the app. |
| `rnArtifactsDir` | none | Use already-downloaded React Native prebuilts instead of downloading (offline). |
| `xtoolPath` | managed copy | Use a specific xtool binary in `setup`, `doctor` and `install` (`setup` skips the download; it must exist and be executable). |

## How it works

Patches, the SwiftPM pipeline, mixed-language manifests and scaffolded libraries: [docs/how-it-works.md](docs/how-it-works.md).

## Bare React Native projects

See [docs/bare-react-native.md](docs/bare-react-native.md).

## Wi-Fi installs

See [docs/wifi-install.md](docs/wifi-install.md).

## Limits and non-goals

- Expo SDK 57 and older, and React Native older than 0.88, are out of scope. Production / App Store builds are out of scope (use EAS).
- `expo-dev-client` builds and runs. Known gaps: the launcher's and dev menu's icons are missing (their asset catalogs
  need Xcode's `actool`, which does not exist on Linux), and when Metro is not on the default port 8081 you type the
  URL in the launcher yourself (`install` prints it: `http://<lanIp>:<metroPort>`). See [docs/libraries.md](docs/libraries.md).
- No iOS simulator (macOS only). macOS and native Windows are not supported; WSL is untested.
- Free Apple ID: signature lasts 7 days, 3 apps at a time, no push notifications or special entitlements.
  A paid developer account lifts these.
- The installed bundle ID is `XTL-<TEAM_ID>.<bundleIdentifier>` because xtool renames it.
- The Metro port and LAN IP are baked into the app. If either changes you must rebuild and reinstall.

## Troubleshooting

First-run checklist and common problems: [docs/troubleshooting.md](docs/troubleshooting.md).

## Legal

You bring your own `Xcode.xip` and Apple ID. rn-xtool does not redistribute anything from Apple; it extracts the
SDK locally from your copy, and Apple's Xcode license terms apply to that use.

## Contributing

Branches: `feature/<kebab-name>` or `fix/<kebab-name>`. Commits follow Conventional Commits in English
(`type: short imperative summary`). Run `npm test` before opening a PR.

Testing: the suite needs no external setup. Tests that read the patched React Native / Expo files look for the
reference app (default `../app`, a sibling of the repo checkout, override with `RN_XTOOL_REF_APP`) and skip when it is
absent. The functional Expo plugin check re-runs `setup-apple-spm.js update` and rewrites that app's `ios/build`,
so it only runs with `RN_XTOOL_E2E=1` (it also needs Swift and the `shims/` directory on `PATH`).

## License

MIT, see [LICENSE](LICENSE).
