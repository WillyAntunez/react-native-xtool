# Troubleshooting

Start with `rn-xtool doctor`: it checks the toolchain, SDK, login, connected device, Wi‑Fi install readiness and
project, and exits non-zero on problems. This page lists the first-run steps on the iPhone and the problems seen so
far with their fixes. Wi‑Fi install problems have their own list in [wifi-install.md](wifi-install.md#troubleshooting).

[Back to README](../README.md)

## First-run checklist (on the iPhone)

`install` prints this checklist after installing.

1. Enable Developer Mode (Settings > Privacy & Security > Developer Mode); the phone reboots.
2. Trust the certificate: Settings > General > VPN & Device Management > your Apple ID > Trust.
3. Open the app by hand, and allow Local Network access when asked.
4. Keep the phone and the computer on the same Wi‑Fi network with `rn-xtool start` running.

## The app does not start or cannot reach Metro

- **Black screen on launch:** Info.plist had an unresolved `$(VAR)` (for example
  `$(PRODUCT_MODULE_NAME).SceneDelegate`). rn-xtool resolves them; if you see this, rebuild with `build --clean` and
  report it.
- **Red screen "No script URL provided":** the app cannot reach Metro. Check that `start` is running, that the phone is
  on the same Wi‑Fi, that Local Network is allowed, and the firewall (below).
- **"No script URL" with a VPN on:** rn-xtool bakes in the IP of your default route; a VPN can make that a tunnel
  address (`tun0`, `wg0`, `tailscale0`) the phone cannot reach. `build` and `doctor` warn about it; set `lanIp` in
  `rn-xtool.config.json` to your Wi‑Fi address and rebuild.
- **Firewall:** ufw blocks Metro by default: `sudo ufw allow <port>/tcp`.
- **LAN IP changed (new network, DHCP):** `start` detects it and tells you; rebuild and reinstall, or pin `lanIp`.

- **After adding a native library: `TurboModuleRegistry.getEnforcing(...) could not be found`** (the app was not
  rebuilt) **or `Metro has encountered an error while trying to resolve module`** (stale Metro cache): use
  `rn-xtool run`, which rebuilds, reinstalls and starts Metro with `--clear` whenever dependencies changed; `run --force`
  and `start --clear` force it.

## Metro port

- **Metro already running on 8081:** `build` keeps the port when a Metro already serves `packager-status:running` there
  (rn-xtool cannot tell which project it belongs to; if it is another project's Metro, stop it). `start` then reports
  that Metro is running and leaves it alone. Only a different program on the port makes `build` look further (next
  item).
- **Port busy (8081 taken, for example by Docker):** `build` picks the Metro port in this order: the configured
  `metroPort` if free or already serving Metro; otherwise the previous build's port (from
  `ios-xtool/.rn-xtool-state.json`) if free or serving Metro, so a running Metro keeps matching the installed app;
  otherwise the next free port after the configured one. To choose differently, free the port, or set `metroPort` in
  the config and rebuild + reinstall (the port is baked in; `start` tells you which).

## Build and patches

- **Metal shaders are skipped on Linux:** a library that ships `.metal` files (react-native-svg's `MetalCI` filters)
  would fail the build with `unable to spawn process 'metal'`, because the Metal compiler only exists on macOS. The
  scaffolder excludes them and prints `Skipped N Metal shader(s)`; the library works, but features that rely on those
  shaders are unavailable in the build.
- **svg Metal filters stay unavailable under SwiftPM:** react-native-svg loads its prebuilt `*.metallib` files from
  `RNSVGFilters.bundle`, declared in the podspec through `s.ios.resource_bundles`. The scaffolder does not read resource
  bundles yet (on any host, macOS included), so the bundle is never built or copied into the app. Skipping `.metal`
  compilation is the only Linux-specific part. Rendering that does not use those filters is unaffected.
- **An Expo config plugin change is missing from the app** (for example expo-image-picker's photo library text in
  Info.plist): `build` runs `expo prebuild` only when `ios/` is missing. After adding or changing a config plugin in
  `app.json`, run `rn-xtool build --clean` (or `run --clean`), which re-runs `expo prebuild --clean`.
- **A committed project patch no longer applies** (after a library upgrade): delete it from `patches/` and let
  `rn-xtool build` re-scaffold it.
- **"⚠ patches/<name> was written by an older rn-xtool scaffolder (revision <n>, now 3); delete it so rn-xtool
  regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old Package.swift)":** the
  `patches` step found a persisted scaffold patch from an older scaffolder. Revision 1 patches lack the Swift importer
  paths of mixed libraries, and revision 2 patches lack those of clang-only libraries and their module map (fixes 17
  and 18 in [upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md)). Without them, Swift code that
  imports a scaffolded library (the app, or expo-router importing react-native-screens) can fail with
  `'RNSReactBaseView.h' file not found` (a mixed library, such as react-native-screens 4.26) or
  `'RNSDefines.h' file not found` (a clang-only one, such as react-native-screens 4.30). Do what the warning says:
  delete the patch, remove the library from `node_modules` and reinstall it, then build; rn-xtool scaffolds it again
  and persists the new patch.
- **"Missing SceneDelegate.swift: <path> (Info.plist's UIApplicationSceneManifest names ...)":** `SceneDelegate.swift`
  is optional (SDK 57's template has none), but Info.plist names a scene delegate class and the file is missing, so
  `ios/` is incomplete. `rn-xtool build --clean` regenerates it with `expo prebuild --clean`.
- **"rn-xtool could not patch <package>":** your project has a different version of an Expo package than the one this
  release of rn-xtool patches. The message names the versions: pin the package to the patched version, or report the
  new version in the issue tracker so the patch can be refreshed.
- **A reanimated or worklets patch fails at `patches` with "Applying the project's patches/ failed":** rn-xtool rewrites
  these libraries' `Package.swift` in `node_modules` so it compiles on Linux (`manifest — made … portable to Linux`).
  A patch you made with `npx patch-package react-native-reanimated` (or `react-native-worklets`) after an rn-xtool
  build includes that rewrite next to your own change. On a machine where rn-xtool already rewrote the file,
  patch-package then can apply the patch neither forward nor backward. Reinstall the package, for example
  `rm -rf node_modules/react-native-reanimated && npm install`, and build again. If the patch holds nothing but the
  `Package.swift` fix, delete it instead: rn-xtool applies that fix itself.
- **"manifest — skipped <package>: it is a link to <path>; apply the portable manifest in its source":** the package
  is a symlink out of your project's `node_modules` (`npm link`, a `file:` dependency, a workspace), so rn-xtool does
  not edit it. Make the change from
  [upstream/reanimated-worklets-manifest.md](upstream/reanimated-worklets-manifest.md) in that source checkout.
- **"Could not write node_modules/<package>/Package.swift (EACCES) to make it portable to Linux":** `node_modules` is
  read-only, often after `sudo npm install`. Make it writable (reinstall without `sudo`), or apply the portable
  manifest yourself.

## Expo SDK 57

rn-xtool builds Expo SDK 57 only with exact versions (see [how-it-works.md](how-it-works.md#expo-sdk-57)). `doctor`
(the `project` check) and `build` stop with these messages:

- **"Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo 57.0.31) and SDK 58 or newer."** The project is on
  SDK 56 or older.
- **"Expo SDK 57 needs exactly expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24, expo-modules-autolinking
  57.0.16 and expo-modules-jsi 57.1.3; installed: <package> <version>, .... Pin those versions in package.json and
  reinstall."** The installed list names only the packages at another version (or `not installed`). Each is read
  where the build resolves it: expo-modules-core from `expo`, expo-modules-jsi from expo-modules-core,
  expo-modules-autolinking from the project root, else from `expo`.
- **"expo-modules-jsi <version> resolves from <path>, not from the project's top-level node_modules: rn-xtool patches
  and builds only the top-level copy. Pin expo-modules-jsi to 57.1.3 in package.json and reinstall (npm dedupe may
  also fix it)."** npm nested the copy the build uses (under expo-modules-core), and patch-package patches only
  `node_modules/expo-modules-jsi`.
- **"expo-modules-macros 0.22.0 has no Linux binary for <arch> (@expo/modules-macros-linux-<arch>); reinstall
  react-native-xtool without --omit=optional."** SDK 57's own macro plugin is macOS-only, so rn-xtool brings
  expo-modules-macros 0.22.0, whose Linux binary is an optional npm dependency: an install with `--omit=optional`, or
  a host architecture without a binary, leaves it out.
- **"ExpoModulesJSI needs React Native's headers at <dir>, which does not exist. rnArtifactsDir must hold adapted
  0.86.3 slots, as rn-xtool's rn-artifacts step writes them."** At the `jsi` step: `rnArtifactsDir` points at raw
  0.86.3 artifacts. Build once without `rnArtifactsDir` and point it at that project's `ios/build/rn-artifacts/0.86.3`
  (see [bare-react-native.md](bare-react-native.md#older-artifacts-086)).

**Install SDK 57's reanimated and worklets explicitly.** expo-router declares react-native-reanimated as a `*` peer.
When the app does not install it, npm installs the latest reanimated and react-native-worklets, and that worklets is
outside the range expo-modules-core 57 accepts (`^0.7.4 || ^0.8.0 || ^0.9.0 || ^0.10.0`). Such an app (reanimated
4.7.1, worklets 0.13.1, gesture-handler 3.4.0, screens 4.30.1) built and launched on 2026-10-28, but only the launch
was checked. Install SDK 57's versions (reanimated 4.5.1, worklets 0.10.1) with
`npx expo install react-native-reanimated react-native-worklets`.

**After `npx expo install expo-router`, run `npx expo install react-dom`.** npm adds react-dom 19.3.1 as a peer of
expo-router's web dependencies, and it needs react ^19.3.1 while the SDK 57 template has react 19.2.3. npm only prints
`npm warn ERESOLVE overriding peer dependency` at first, but the next `npx expo install <package>` stops with
`ERESOLVE could not resolve`: `expo install` still writes the package into `package.json`, and nothing is installed.
`npx expo install react-dom` installs SDK 57's react-dom 19.2.3 and clears it; the native build does not use react-dom.

## Device and signing

- **"Developer Mode required":** enable it on the phone (see the checklist above) and reboot.
- **"Untrusted Developer":** trust the certificate under VPN & Device Management.
- **App stops opening after a week:** free-account signatures expire after 7 days. Run `rn-xtool install` again.
- **`xtool launch` fails with `DebugserverClient.Error`:** known on current iOS. Open the app by hand.
- **Anything else:** run `rn-xtool doctor` first.

Bare React Native build errors (`Cannot resolve build setting`, `unsupported source type in the app target`) are
explained in [bare-react-native.md](bare-react-native.md).
