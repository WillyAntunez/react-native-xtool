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

`run` = `build` + `install` + `start`. After the first install you only need
`expo-xtool start`; the cable is needed again only to reinstall.

## Commands

| Command | What it does |
| --- | --- |
| `setup [--xcode-xip <path>]` | Installs Swift via swiftly, the xtool AppImage and the Darwin SDK. Idempotent. |
| `doctor` | Checks toolchain, SDK, login, connected device and project. Exits non-zero on problems. |
| `build [--clean]` | Prebuild if `ios/` is missing, patches, RN/Expo SwiftPM pipeline, ExpoModulesJSI, generates `ios-xtool/`, `xtool dev build`. `--clean` re-runs `expo prebuild --clean`. |
| `install` | Signs and installs the app on the USB-connected iPhone, then prints the first-run checklist. |
| `start` | Starts Metro on the port and LAN IP the app was built for. Tells you to rebuild if either changed. |
| `run [--clean]` | `build`, `install`, `start`. |

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

1. Applies four small patches to `node_modules` with patch-package.
2. Runs React Native 0.88's SwiftPM pipeline and Expo's SPM plugin, with Linux shims for `plutil` and `otool`.
3. Builds ExpoModulesJSI with the Darwin SDK and stages the runtime frameworks.
4. Generates `ios-xtool/` (Package.swift, xtool.yml, Info.plist, ip.txt, app config). It is a regenerable
   artifact; do not edit it by hand.
5. CocoaPods-only libraries (no `Package.swift`) get one generated automatically by React Native's `spm scaffold`.
   expo-xtool persists it in your project's `patches/` with patch-package: commit those files. The fourth patch fixes
   two bugs in that scaffolder ([docs/upstream/react-native-scaffolder.md](docs/upstream/react-native-scaffolder.md)).
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
- `expo-dev-client` is not supported (not SwiftPM-ready in Expo 58). The dev menu is React Native's (shake the phone).
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
- **Firewall:** ufw blocks Metro by default: `sudo ufw allow <port>/tcp`.
- **A committed project patch no longer applies** (after a library upgrade): delete it from `patches/` and let
  `expo-xtool build` re-scaffold it.
- **"expo-xtool could not patch <package>":** your project has a different version of an Expo package than the one
  this release of expo-xtool patches. The message names the versions: pin the package to the patched version, or
  report the new version in the issue tracker so the patch can be refreshed.
- **Metro already running on 8081:** `build` keeps the port when a Metro already serves `packager-status:running` there
  (expo-xtool cannot tell which project it belongs to; if it is another project's Metro, stop it). `start` then reports
  that Metro is running and leaves it alone. Only a different program on the port makes `build` pick the next free one.
- **Port busy (8081 taken, for example by Docker):** free the port, or set `metroPort` in the config and rebuild + reinstall
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

## License

TBD
