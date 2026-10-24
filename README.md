# expo-xtool

Build, sign and install Expo (SDK 58+) iOS dev builds from Linux, with no Mac, using
[xtool](https://github.com/xtool-org/xtool) and the official React Native / Expo SwiftPM pipeline.
Then develop with Metro and Fast Refresh over Wi-Fi, as you would with Xcode.

**Status:** early. Works end to end on a physical iPhone as of 2026-10-23. Expo SDK 58+ only.
Version 0.x, not published to npm yet.

## Requirements

- Linux x86_64 (arm64 should work, untested). Node 20+.
- `libfuse2` (runs the xtool AppImage): `sudo apt install libfuse2` on Ubuntu.
- `python3` (used by the `plutil` / `otool` shims) and `iproute2` (the `ip` command, to detect the LAN IP).
- Package manager: npm or Yarn classic. patch-package needs a flat `node_modules`; pnpm and Yarn PnP are not supported.
- About 15 GB of free disk (Xcode.xip is about 12 GB, the extracted SDK about 7 GB).
- `Xcode.xip` (Xcode 27.x) that you download yourself from developer.apple.com.
- An Apple ID (free or paid) and an iPhone connected over USB for the first install.
- An Expo SDK 58+ project (React Native 0.88+).

## Quick start

expo-xtool is not published yet, so install it from a clone:

```sh
git clone <repo-url> expo-xtool && cd expo-xtool
npm ci && npm run build && npm link
```

`npx expo-xtool` will work once it is published; until then use `expo-xtool` as below.

```sh
# Once per machine: Swift 6.4 (swiftly), xtool 1.23.0, Darwin SDK from your Xcode.xip
expo-xtool setup --xcode-xip ~/Downloads/Xcode_27.1.xip

# Sign in with your Apple ID (interactive, handled by xtool)
~/.cache/expo-xtool/xtool-1.23.0.AppImage auth login

# In your Expo project, with the iPhone plugged in
cd my-app
expo-xtool run
```

`run` = `build` + `install` + `start`, but it skips the build and install when
nothing changed since the last build. The cable is needed only when it reinstalls.

## Daily loop

`expo-xtool run` is the one command to use. It fingerprints your installed dependencies
(every `dependencies`/`devDependencies` entry at its installed version, plus `patches/*.patch`)
and compares that with the fingerprint stored by the last `build`:

- **Unchanged:** it prints `Native app is up to date`, skips build and install and starts Metro.
- **Changed** (for example after `npx expo install <native lib>`): it rebuilds, reinstalls
  and starts Metro with `--clear`, so a new native module and new Babel plugins are picked up.
  Without this you get `TurboModuleRegistry.getEnforcing(...) could not be found` (app not
  rebuilt) or `Metro has encountered an error while trying to resolve module` (stale cache).

There is no native/JS distinction: any dependency change rebuilds. JS-only changes also need
a Metro cache reset, and telling native dependencies apart reliably needs the autolinking pass.

- `expo-xtool start` warns and adds `--clear` itself when dependencies changed since the last
  build; `expo-xtool start --clear` forces a cache reset.
- `expo-xtool run --force` always rebuilds and reinstalls (`--clean` does too).
- `expo-xtool doctor` reports a `deps` warning when the app is out of date.

## Commands

| Command | What it does |
| --- | --- |
| `setup [--xcode-xip <path>]` | Installs Swift via swiftly, the xtool AppImage and the Darwin SDK. Idempotent. |
| `doctor` | Checks toolchain, SDK, login, connected device and project. Exits non-zero on problems. |
| `build [--clean]` | Prebuild if `ios/` is missing, patches, RN/Expo SwiftPM pipeline, ExpoModulesJSI, generates `ios-xtool/`, `xtool dev build`. `--clean` re-runs `expo prebuild --clean`. |
| `install` | Signs and installs the app on the USB-connected iPhone, then prints the Metro URL (for the expo-dev-client launcher) and the first-run checklist. |
| `start [--clear]` | Starts Metro on the port and LAN IP the app was built for. Tells you to rebuild if either changed; clears the Metro cache when dependencies changed (or with `--clear`). |
| `run [--clean] [--force]` | `build` and `install` when dependencies changed (or with `--force`), then `start`. |

Reference timings on a warm cache: patches 3.6 s, RN SwiftPM 11.1 s, ExpoModulesJSI 12.7 s,
xtool build 24.5 s. The resulting `App.app` is about 99 MB with 8 embedded frameworks.

## Configuration

Optional `expo-xtool.config.json` in the project root (recommended). A `expo-xtool.config.js` also works, but it
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

1. Applies four patches to `node_modules` with patch-package. Two are one-liners (the `@ExpoModule` scanner gate in
   expo-modules-autolinking, a Swift 6.4 access-level error in expo-modules-jsi). The other two are large:
   - **Expo** (`patches/expo+58.0.17.patch`, files under `expo/scripts/spm/`): finds the Swift macro plugin on Linux;
     gives pure-Swift modules the Foundation/UIKit imports CocoaPods' umbrella header provides
     ([docs/upstream/expo-spm-plugin-umbrella.md](docs/upstream/expo-spm-plugin-umbrella.md)); builds Expo modules
     that mix Swift and Objective-C or are Objective-C only, such as expo-application and the dev client chain; skips
     meta pods (no sources) and placeholder files; links generated packages to their podspec `dependency` pods; excludes
     resources only Xcode's tools compile (asset catalogs, storyboards); refuses modules built from vendored C sources
     such as expo-sqlite ([docs/upstream/expo-spm-plugin-mixed-modules.md](docs/upstream/expo-spm-plugin-mixed-modules.md)).
   - **React Native** (`patches/react-native+0.88.0.patch`, about 1.75k lines across 3 files under
     `react-native/scripts/spm/`: `read-podspec.js`, `scaffold-package-swift.js`, `spm-utils.js`): 12 generic fixes
     to the `spm scaffold` podspec reader and `Package.swift` generator, including mixed Swift + Objective-C/C++
     targets and known CocoaPods dependencies mapped to SwiftPM packages, plus one to the per-app header farm
     ([docs/upstream/react-native-scaffolder.md](docs/upstream/react-native-scaffolder.md)).
   Mixed Swift + Objective-C packages (scaffolded or generated) get two manifests: `Package.swift`
   (`swift-tools-version: 6.4;(experimentalMultiLang)`, what Swift 6.4 builds) and `Package@swift-6.5.swift`
   (the same with tools-version 6.5 and no flag, SE-0541), which SwiftPM 6.5+ picks instead. `doctor` notes
   it when your Swift is 6.5 or newer. The 6.5 form is untested until a 6.5 toolchain is available.
2. Runs React Native 0.88's SwiftPM pipeline and Expo's SPM plugin, with Linux shims for `plutil` and `otool`.
3. Builds ExpoModulesJSI with the Darwin SDK and stages the runtime frameworks.
4. Generates `ios-xtool/` (Package.swift, xtool.yml, Info.plist, ip.txt, app config). It is a regenerable
   artifact; do not edit it by hand.
5. CocoaPods-only libraries (no `Package.swift`) get one generated automatically by React Native's `spm scaffold`.
   expo-xtool persists it in your project's `patches/` with patch-package: commit those files. The React Native
   patch above is what makes that scaffolder work for real-world podspecs. Mapped external dependencies
   (for example SwiftUIIntrospect, pinned to an exact version) are fetched from GitHub on the first clean build;
   offline builds with `rnArtifactsDir` need them already cached in `ios-xtool/.build`.
   On every build the `patches` step applies expo-xtool's own patches and then your project's `patches/` (when
   present), so a fresh `node_modules` gets those Package.swift files back. To also restore them on a plain
   `npm install`, add `"postinstall": "patch-package"` to your `package.json` scripts and `patch-package` to your
   devDependencies. If persisting a scaffolded package fails (no lockfile, no network, ...), expo-xtool prints a
   warning and keeps building; the package is simply re-scaffolded after the next fresh install.
6. `xtool` builds, signs and installs it; Metro serves JS to the phone over Wi-Fi.

Details and file locations: [docs/recipe.md](docs/recipe.md). Design:
[docs/superpowers/specs/2026-10-23-expo-xtool-design.md](docs/superpowers/specs/2026-10-23-expo-xtool-design.md).

## Limits and non-goals

- Expo SDK 57 and older are out of scope. Production / App Store builds are out of scope (use EAS).
- `expo-dev-client` builds and runs. Known gaps: the launcher's and dev menu's icons are missing (their asset catalogs
  need Xcode's `actool`, which does not exist on Linux), and when Metro is not on the default port 8081 you type the
  URL in the launcher yourself (`install` prints it: `http://<lanIp>:<metroPort>`). See [docs/libraries.md](docs/libraries.md).
- No iOS simulator (macOS only). macOS and native Windows are not supported; WSL is untested.
- Free Apple ID: signature lasts 7 days, 3 apps at a time, no push notifications or special entitlements.
  A paid developer account lifts these.
- The installed bundle ID is `XTL-<TEAM_ID>.<bundleIdentifier>` because xtool renames it.
- The Metro port and LAN IP are baked into the app. If either changes you must rebuild and reinstall.

## First-run checklist (on the iPhone)

1. Enable Developer Mode (Settings > Privacy & Security > Developer Mode); the phone reboots.
2. Trust the certificate: Settings > General > VPN & Device Management > your Apple ID > Trust.
3. Open the app by hand, and allow Local Network access when asked.
4. Keep the phone and the computer on the same Wi-Fi network with `expo-xtool start` running.

## Troubleshooting

- **Black screen on launch:** Info.plist had an unresolved `$(VAR)` (for example
  `$(PRODUCT_MODULE_NAME).SceneDelegate`). expo-xtool resolves them; if you see this, rebuild with `build --clean`
  and report it.
- **Red screen "No script URL provided":** the app cannot reach Metro. Check that `start` is running, that the phone is
  on the same Wi-Fi, that Local Network is allowed, and the firewall (below).
- **"No script URL" with a VPN on:** expo-xtool bakes in the IP of your default route; a VPN can make that a tunnel
  address (`tun0`, `wg0`, `tailscale0`) the phone cannot reach. `build` and `doctor` warn about it; set `lanIp` in
  `expo-xtool.config.json` to your Wi‑Fi address and rebuild.
- **Metal shaders are skipped on Linux:** a library that ships `.metal` files (react-native-svg's `MetalCI` filters)
  would fail the build with `unable to spawn process 'metal'`, because the Metal compiler only exists on macOS. The
  scaffolder excludes them and prints `Skipped N Metal shader(s)`; the library works, but features that rely on those
  shaders are unavailable in the build.
- **svg Metal filters stay unavailable under SwiftPM:** react-native-svg loads its prebuilt `*.metallib` files from
  `RNSVGFilters.bundle`, declared in the podspec through `s.ios.resource_bundles`. The scaffolder does not read
  resource bundles yet (on any host, macOS included), so the bundle is never built or copied into the app. Skipping
  `.metal` compilation is the only Linux-specific part. Rendering that does not use those filters is unaffected.
- **Firewall:** ufw blocks Metro by default: `sudo ufw allow <port>/tcp`.
- **A committed project patch no longer applies** (after a library upgrade): delete it from `patches/` and let
  `expo-xtool build` re-scaffold it.
- **"expo-xtool could not patch <package>":** your project has a different version of an Expo package than the one
  this release of expo-xtool patches. The message names the versions: pin the package to the patched version, or
  report the new version in the issue tracker so the patch can be refreshed.
- **Metro already running on 8081:** `build` keeps the port when a Metro already serves `packager-status:running` there
  (expo-xtool cannot tell which project it belongs to; if it is another project's Metro, stop it). `start` then reports
  that Metro is running and leaves it alone. Only a different program on the port makes `build` look further (next item).
- **Port busy (8081 taken, for example by Docker):** `build` picks the Metro port in this order: the configured
  `metroPort` if free or already serving Metro; otherwise the previous build's port (from `ios-xtool/.expo-xtool-state.json`)
  if free or serving Metro, so a running Metro keeps matching the installed app; otherwise the next free port after the
  configured one. To choose differently, free the port, or set `metroPort` in the config and rebuild + reinstall
  (the port is baked in; `start` tells you which).
- **LAN IP changed (new network, DHCP):** `start` detects it and tells you; rebuild and reinstall, or pin `lanIp`.
- **"Developer Mode required":** enable it on the phone (see checklist) and reboot.
- **"Untrusted Developer":** trust the certificate under VPN & Device Management.
- **App stops opening after a week:** free-account signatures expire after 7 days. Run `expo-xtool install` again.
- **`xtool launch` fails with `DebugserverClient.Error`:** known on current iOS. Open the app by hand.
- **Anything else:** run `expo-xtool doctor` first.

## Legal

You bring your own `Xcode.xip` and Apple ID. expo-xtool does not redistribute anything from Apple; it extracts the
SDK locally from your copy, and Apple's Xcode license terms apply to that use.

## Contributing

Branches: `feature/<kebab-name>` or `fix/<kebab-name>`. Commits follow Conventional Commits in English
(`type: short imperative summary`). Run `npm test` before opening a PR.

Testing: the suite needs no external setup. Tests that read the patched React Native / Expo files look for the
reference app (default `expo-ios-linux/app` next to this repo, override with `EXPO_XTOOL_REF_APP`) and skip when it is
absent. The functional Expo plugin check re-runs `setup-apple-spm.js update` and rewrites that app's `ios/build`,
so it only runs with `EXPO_XTOOL_E2E=1` (it also needs Swift and the `shims/` directory on `PATH`).

## License

TBD
