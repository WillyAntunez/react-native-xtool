# Troubleshooting

Start with `rn-xtool doctor`: it checks the toolchain, SDK, login, connected device, Wi‑Fi install readiness and
project, and exits non-zero on problems. `rn-xtool doctor --project` checks only the project
([below](#doctor---project)). This page lists the first-run steps on the iPhone and the problems seen so
far with their fixes. Wi‑Fi install problems have their own list in [wifi-install.md](wifi-install.md#troubleshooting).

[Back to README](../README.md)

## First-run checklist (on the iPhone)

`install` prints this checklist after installing.

1. Enable Developer Mode (Settings > Privacy & Security > Developer Mode); the phone reboots.
2. Trust the certificate: Settings > General > VPN & Device Management > your Apple ID > Trust.
3. Open the app by hand, and allow Local Network access when asked. On the first launch after an install, the red
   screen "No script URL provided" shows behind that prompt: the app looked for Metro before access was allowed. Tap
   Allow, then Reload.
4. Keep the phone and the computer on the same Wi‑Fi network with `rn-xtool start` running.

## The app does not start or cannot reach Metro

- **Black screen on launch:** Info.plist had an unresolved `$(VAR)` (for example
  `$(PRODUCT_MODULE_NAME).SceneDelegate`). rn-xtool resolves them; if you see this, rebuild with `build --clean` and
  report it.
- **Red screen "No script URL provided":** the app cannot reach Metro. On the first launch after an install this is
  expected behind iOS's Local Network prompt: tap Allow, then Reload. Otherwise check that `start` is running, that the
  phone is on the same Wi‑Fi, that Local Network is allowed, and the firewall (below).
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
- **"⚠ patches/<name> was scaffolded for React Native <version>; delete it so rn-xtool regenerates it for <installed>
  (also remove node_modules/<package> and reinstall: that copy still has the old Package.swift)":** the persisted
  scaffold patch was made for another React Native version, for example after moving a project from 0.88.0 to 0.88.1.
  Do the same as for the revision warning above. Both warnings also read patches with the marker's name before the
  rename, `expo-xtool-scaffold-revision` (apps scaffolded before 0.1.0-alpha.1).
- **"ℹ node_modules/<package>/Package.swift was scaffolded with revision <n> for React Native <version>, older than
  patches/<name> (revision 3, React Native <installed>): rn-xtool replaced it with the persisted one":** a teammate
  committed a regenerated scaffold patch, and your `node_modules` still had the copy an older patch wrote
  (patch-package does not replace a file that exists). rn-xtool owns these generated files, so the `patches` step
  removes the files the current patch creates and patch-package writes them again; the line is printed once
  patch-package has done so. Nothing to do; files the older scaffold wrote and the current one does not stay in place.
  This happens only when the patch holds nothing but scaffolded new files.
- **"⚠ node_modules/<package>/Package.swift was scaffolded with revision <n> for React Native <version>, older than
  patches/<name> (revision 3, React Native <installed>), and that patch also changes the library's own files, so
  rn-xtool does not replace it: run rm -rf node_modules/<package> && npm install, then build again":** the same case,
  but the persisted patch also holds your own fix to the library. rn-xtool persists a scaffold with
  `patch-package <package>`, which writes everything that differs from the published package into one patch.
  Removing only the scaffold files would leave a patch that patch-package can apply neither forward nor backward, so
  rn-xtool changes nothing and the build goes on with the older manifest. Run the command: the reinstall gives the
  published package, and the next build applies the whole patch.
- **"ℹ node_modules/<package>/Package.swift was scaffolded by an older rn-xtool scaffolder (revision <n>, now 3)" (or
  "was scaffolded for React Native <version>, not <installed>"), followed by "rn-xtool removed it so the rn-spm step
  scaffolds it again":** a library has no persisted patch, and the manifest rn-xtool generated for it is out of date,
  for example after you deleted a stale patch but kept the package installed. The `rn-spm` step scaffolds it again
  and persists a new patch. Manifests without rn-xtool's marker (yours, or one a library ships) are never touched.
- **"rn-xtool could not apply its patch to <package>@<version> (patch file: <file>): node_modules/<package> is the
  version the patch is for, but its files match neither the original package nor the patched one.":** the message
  goes on "This usually means an earlier rn-xtool release (such as 0.1.0-alpha.2) patched it differently, or its
  files were edited by hand. Reinstall the package, then build again: rm -rf node_modules/<package> && npm install".
  patch-package records nothing about which content it applied, so when a new rn-xtool release changes a bundled
  patch for the same version (0.1.0-alpha.3 changed `react-native+0.88.0.patch` and the Expo patch), a
  `node_modules/<package>` patched by the older release takes neither the new patch nor its reverse. rn-xtool does not
  reinstall packages itself: run the command, then build again.
- **"Missing SceneDelegate.swift: <path> (Info.plist's UIApplicationSceneManifest names ...)":** `SceneDelegate.swift`
  is optional (SDK 57's template has none), but Info.plist names a scene delegate class and the file is missing, so
  `ios/` is incomplete. `rn-xtool build --clean` regenerates it with `expo prebuild --clean`.
- **"rn-xtool could not patch <package>":** your project has a different version of a package than the one this release
  of rn-xtool patches, and the patch does not apply to it (on SDK 57 or 58, a newer patch of the SDK that changed a
  patched file; on bare React Native, a newer patch of its line). The message names the versions. On SDK 58 (Expo
  published a newer 58.x than this release patches) it gives two options. One is an `"overrides"` block in package.json
  with the verified set, `"overrides": { "expo-modules-core": "58.0.28", "expo-modules-jsi": "58.0.21",
  "expo-modules-autolinking": "58.0.16" }` plus the failing package at its floor when it is another one (`"expo":
  "58.0.21"`; `expo` is a direct dependency, so set it to `"58.0.21"` in `dependencies` too), then `npm install`. The
  other is to wait for an rn-xtool release and report the new version. Do not pin expo-modules-* packages as direct
  dependencies: npm then nests the copy expo uses (expo-modules-jsi, which G2 refuses). Overrides hold every copy,
  nested ones included, on one version. Remove any direct pin first (`npm uninstall <package>`); while an override
  differs from a direct dependency, npm stops every install and uninstall with `EOVERRIDE … conflicts with direct
  dependency`. When package-lock.json kept expo-modules-jsi nested under expo-modules-core, `npm install` leaves it
  there; run `npm update expo-modules-jsi` as G2 says. On 2026-10-28, on the default SDK 58 template with npm 11, the
  block gave one copy of each package at those versions (`npm ls` exit 0, shown as `overridden`), and `doctor` passed.
  npm also accepts an override outside expo's own range without an error (expo-modules-core 58.0.27 under expo 58.0.21's
  `~58.0.28`), so a newer `expo` whose modules really need newer versions could still fail at G4 or at launch. SDK 57
  gets the same two options, with the block `"overrides": { "expo-modules-core": "57.0.24", "expo-modules-autolinking":
  "57.0.16", "expo-modules-jsi": "57.1.3" }`. Elsewhere the message says to pin the package to the patched version, for
  example `pin "react-native" to 0.88.1` when a newer 0.88.x does not take the 0.88.1 patch. When react-native is on a
  release line rn-xtool bundles no patch for, the build stops before patch-package runs, with "patch-package was not
  run: react-native <version> is installed and the bundled react-native patches are for 0.88.0 and 0.88.1." Patches that
  applied before a failure stay in `node_modules`; see [Expo SDK 58](#expo-sdk-58).
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

## Newer than the verified versions

Each supported line has a floor: the oldest version rn-xtool accepts. A newer patch of the line builds, with a
warning, so an upstream patch release does not need a new rn-xtool release. `doctor` (the `project` check) shows the
same warning.

- **"⚠ Newer than the Expo SDK <n> set this rn-xtool release was verified with: <package> <version>, .... Verified:
  <the SDK's set>. The build continues; if it fails or the app crashes at launch, report it at
  https://github.com/WillyAntunez/react-native-xtool/issues."** On Expo SDK 57 or 58, a package of the verified set
  is newer than its floor, on the same SDK. A package of another SDK's line (for example expo-modules-jsi 58.0.19 on
  SDK 57) is not "newer": G1 names it and the build stops ([Expo SDK 57](#expo-sdk-57), [Expo SDK 58](#expo-sdk-58)).
  react-native gets no warning, because it stays exact: 0.86.3 on SDK 57, 0.88.1 on SDK 58.
- **"⚠ Newer than the React Native <minor> line this rn-xtool release was verified with: react-native <version>.
  Verified: <versions>. The build continues; if it fails or the app crashes at launch, move react-native back to
  <version> as https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native
  describes, and report it at https://github.com/WillyAntunez/react-native-xtool/issues."** A bare project is on a
  release of 0.86.x, 0.87.x or 0.88.x above the floor that this release was not verified with, for example 0.88.2.
  A hybrid app (bare + Expo modules) does not get this warning: it needs react-native 0.88.1, and on a newer 0.88.x
  G1 stops it.

On a newer version the build uses the line's patches: the patch for the installed version when rn-xtool bundles one,
else the highest bundled patch of the same release line (react-native 0.88.2 gets the 0.88.1 patch; a newer 57.x
expo-modules-jsi gets the 57.1.3 patch). When that patch does not apply, the build stops at `patches` with
"rn-xtool could not patch <package>@<version> (patch file: <file>)". The message gives the remedy (see
[Build and patches](#build-and-patches)): the npm `"overrides"` block on Expo SDK 57 and 58, `pin "react-native" to
0.88.1` on bare 0.88.x.

**If a newer version builds but the app fails at launch**, go back to the verified versions:

- Bare React Native: move react-native back to the version the warning names, with the sequence in
  [Upgrading React Native](bare-react-native.md#upgrading-react-native) (react-native and every `@react-native/*`
  package together).
- Expo SDK 57 and 58: hold the packages on the verified set with the npm `"overrides"` block described under
  [Build and patches](#build-and-patches).

Then report the version at https://github.com/WillyAntunez/react-native-xtool/issues. G4 stops a build whose
precompiled Expo frameworks do not fit together, but it cannot see every runtime change (see "What G4 does not catch"
under [Expo SDK 58](#expo-sdk-58)).

## Expo SDK 58

rn-xtool builds Expo SDK 58 on a floor of verified versions, the 58.0.21 set (see
[how-it-works.md](how-it-works.md#expo-sdk-58)). `doctor` (the `project` check) and `build` stop with the first five
messages and the two hybrid ones at the end, and print the sixth and go on; the patch and G4 messages come from the
`patches` and `frameworks` steps of `build`.

- **"Expo SDK 58 needs react-native 0.88.1 and at least expo 58.0.21, expo-modules-core 58.0.28, expo-modules-jsi
  58.0.21, expo-modules-autolinking 58.0.16, expo-file-system 58.0.13 and expo-font 58.0.11; installed: <package>
  <version>, .... Remove any pin or override on these packages from package.json, then run
  `npx expo install --fix`; then run `npx expo install react-native@0.88.1`, since `--fix` alone can leave
  react-native on another version."** The installed list names only the packages below the floor, on another
  SDK's release line, missing (`not installed`), or, for react-native, not 0.88.1. Each is read where the build
  resolves it: expo-modules-core from `expo`, expo-modules-jsi from expo-modules-core, expo-file-system and expo-font
  from `expo` (npm nests them under `node_modules/expo`). The remedy follows the order of
  [Moving to the 58.0.21 set](#moving-to-the-58021-set), and adapts to the project:
  - When package.json lists expo-modules-core, expo-modules-jsi or expo-modules-autolinking, it starts with
    "Remove the expo-modules-jsi and expo-modules-autolinking pins (`npm uninstall expo-modules-jsi
    expo-modules-autolinking`)" for the ones listed. A project pinned to the SDK 58 versions rn-xtool 0.1.0-alpha.2
    asked for gets this.
  - When `expo` itself is listed, the commands are "`npx expo install expo@~58.0.21` and `npx expo install --fix`":
    `expo` moves first, so that `--fix` then aligns the other packages with the new `expo`.
  - When react-native is the only package listed, the message ends with "Run `npx expo install react-native@0.88.1`."
    instead. That command is needed because of the next entry.
  - In a hybrid app, the react-native step reads "move react-native to 0.88.1 as
    https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native
    describes (`npx expo install react-native@0.88.1` alone leaves the template's @react-native/* packages on the old
    version)". That command does not always stop with ERESOLVE: in a hybrid it can install react-native 0.88.1 with
    only a warning and leave `@react-native/*` on 0.88.0, so `npm ls --all` exits 1.

  When react-native is newer than 0.88.1, the message ends with "React Native <version> is newer than this rn-xtool
  release supports: pin react-native to 0.88.1, or update rn-xtool."
- **`npx expo install --check` (or `--fix`) says react-native "expected 0.88.0" on SDK 58:** this is Expo's own
  mismatch, and it shows on the official SDK 58 template too. Expo's versions API lists react-native 0.88.0 for
  SDK 58, while `expo` 58.0.21 itself bundles 0.88.1 (`node_modules/expo/bundledNativeModules.json`), and
  `expo install` lets the API win. Keep react-native 0.88.1, which rn-xtool requires, and ignore that warning. If
  `--fix` moved it to 0.88.0, run `npx expo install react-native@0.88.1`: an explicit version wins over the API.
- **"expo-modules-jsi <version> resolves from <path>, not from the project's top-level node_modules: rn-xtool patches
  and builds only the top-level copy. Remove any expo-modules-jsi pin or override from package.json (expo-modules-core
  <version> needs <range>) (`npm uninstall expo-modules-jsi` removes a pin), then run `npm update expo-modules-jsi`:
  it moves the copy to the top level, which a reinstall does not do while package-lock.json keeps it nested."** A pin
  or override on expo-modules-jsi that differs from what expo-modules-core asks for makes npm nest a second copy under
  expo-modules-core, and patch-package patches only `node_modules/expo-modules-jsi`. After the pin is gone, npm keeps
  the remaining copy where package-lock.json placed it: `npm install`, `rm -rf node_modules && npm install` and
  `npm dedupe` all leave it nested (there is only one copy, so nothing to dedupe). `npm update expo-modules-jsi` moves
  it to the top level and changed no other package in our check (2026-10-28). Deleting package-lock.json also works,
  but re-resolves every package (it moved react-native-screens and react-native-safe-area-context there).
- **"expo-modules-macros is not installed next to expo-modules-core <version>, which depends on it; run
  `npx expo install --fix` and reinstall."** expo-modules-core's own dependency is missing from `node_modules`.
- **"expo-modules-macros <version> (from expo-modules-core <version>) has no Linux binary for <arch>:
  @expo/modules-macros-linux-<arch> <version> is not installed. Run `npm install --include=optional` and commit
  package-lock.json: `npm ci` installs only what the lockfile lists, and a lockfile written on macOS can leave this
  package out (so does --omit=optional)."** The Linux binary of Expo's Swift macro plugin is an optional npm
  dependency of expo-modules-macros, and the message names the version that expo-modules-macros asks for. A
  `package-lock.json` resolved on a teammate's Mac can lack the Linux packages; `npm ci` then never installs them.
  `npm install --include=optional` installs it and adds it to package-lock.json (it also overrides an
  `omit=optional` setting in `.npmrc`); commit the lockfile so `npm ci` works afterwards. Checked on 2026-10-28 with
  npm 11 and `@expo/modules-macros-linux-x64` 0.27.1, which Expo publishes for Linux x64 with glibc.
- **"expo-modules-macros <version> (from expo-modules-core <version>) ships no Linux binary for <arch> (it lists no
  @expo/modules-macros-linux-<arch>); Expo publishes one for x64 and arm64."** The host's architecture has no binary;
  no install fixes it.
- **"⚠ Newer than the Expo SDK 58 set this rn-xtool release was verified with: <package> <version>, .... Verified:
  expo 58.0.21, react-native 0.88.1, expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, expo-modules-autolinking
  58.0.16, expo-file-system 58.0.13 and expo-font 58.0.11. The build continues; if it fails or the app crashes at
  launch, report it at https://github.com/WillyAntunez/react-native-xtool/issues."** Expo published a newer 58.x than
  this release was checked with. The build uses the floor's patches; `doctor` shows the line as a warning. If a patch
  does not apply, the build stops with "rn-xtool could not patch <package>" ([Build and patches](#build-and-patches)).
- **A bundled patch failed and earlier ones stay applied:** patch-package applies the bundled patches one after the
  other, so when one fails (the "could not patch" message), the patches before it are already in `node_modules`.
  After you follow the message, reinstall (`rm -rf node_modules && npm install`) so every package is back to its
  published files, then build again.
- **"<Framework>.framework (<package> <version>, from <dir>) needs <n> symbols that <Framework>.framework (<package>
  <version>, from <dir>) does not export, for example <symbol>. The app would crash at launch (dyld: Symbol not
  found). Its precompiled binary was built against another <package>. Run `npx expo install --fix`, remove any pin or
  lockfile hold on <package>, reinstall, and build again."** G4, at the `frameworks` step: a precompiled framework
  needs symbols another embedded framework does not have, so the installed packages do not belong together. One
  line per pair of frameworks; symbols are shown mangled. For the reference app's launch crash (expo-modules-core
  58.0.26 held by its lockfile, expo-file-system 58.0.13 next to it) it reads
  `ExpoFileSystem.framework (expo-file-system 58.0.13, from node_modules/expo/node_modules/expo-file-system) needs
  2 symbols that ExpoModulesCore.framework (expo-modules-core 58.0.26, from node_modules/expo-modules-core) does not
  export, for example _$s15ExpoModulesCore9AnyModuleP11_classTypesSayAA12SharedObjectCmGvgZTq. ...`. When the
  framework lacking the symbols is ExpoModulesJSI, which rn-xtool builds, its origin reads
  `built by rn-xtool from <dir>` and the message adds the range expo-modules-core declares:
  `(expo-modules-core <version> declares expo-modules-jsi <range>)`. The remedy is the same. In a bare app without
  the `expo` package the last sentence reads "Remove any pin or lockfile hold on <package>, reinstall, and build
  again."
- **"llvm-nm was not found on the Swift toolchain's PATH; rn-xtool checks the precompiled frameworks with it. Run
  `rn-xtool setup` to install Swift 6.4 through swiftly."** G4 uses `llvm-nm` from the Swift toolchain; run `setup`.
  `doctor` shows the same text on its `llvm-nm` line. The Swift 6.4.1 toolchain `setup` installs ships it in
  `usr/bin`; a custom toolchain without it fails here.
- **"Expo SDK <n> (expo <version>) with Expo modules is not supported in a bare app. Expo modules in a bare app need
  Expo SDK 58 or newer: install expo ~58.0.21 and run `npx expo install --fix`, then move react-native to 0.88.1 as
  https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native
  describes."** A hybrid
  app (bare React Native with Expo modules) has an older `expo`. Hybrids also get the messages above.
- **"React Native <version> with Expo modules is not supported. Expo SDK 58 needs React Native 0.88.1."** A hybrid on
  React Native 0.86 or 0.87; a hybrid on 0.88.0 gets the first message, naming `react-native 0.88.0`.

### Moving to the 58.0.21 set

A project on rn-xtool 0.1.0-alpha.2's SDK 58 set (expo 58.0.19, react-native 0.88.0, often with expo-modules-jsi and
expo-modules-autolinking pinned) moves in this order, the one G1's message gives. On 2026-10-28 the Expo reference
app (with expo-router) moved in this order. The hybrid reference app removed its pins after step 3 instead, which left
expo-modules-jsi nested until step 5.

1. Remove the expo-modules-* pins, for the ones in your package.json:
   `npm uninstall expo-modules-jsi expo-modules-autolinking`. Do not pin them again: on SDK 58 they follow `expo`.
2. `npx expo install expo@~58.0.21`.
3. `npx expo install --fix`. In a hybrid app it also moves the template's `jest` from ^29.6.3 to ~30.5.2 and
   `@types/jest` to 30.0.0 (Expo's SDK 58 versions); the template's test passed on jest 30 in our check.
4. react-native 0.88.1: `npx expo install react-native@0.88.1` in an Expo app. In a hybrid app, follow
   [Upgrading React Native](bare-react-native.md#upgrading-react-native) instead, so the `@react-native/*` packages move
   too.
5. `rn-xtool doctor`. If it says expo-modules-jsi resolves from
   `node_modules/expo-modules-core/node_modules/expo-modules-jsi`, run `npm update expo-modules-jsi` (G2 above).
6. `rn-xtool build`. Follow the scaffold-patch warnings it prints for the 0.88.0 slot
   ([Build and patches](#build-and-patches)). If it stops with "rn-xtool could not apply its patch to <package>",
   reinstall that package as the message says.

`npx expo install --check` then still reports react-native as "expected 0.88.0"; see the entry about it above.

What G4 does not catch: G4 compares the symbols each embedded framework imports with the ones the framework it
imports from exports, the check dyld runs at launch. It cannot see C++ or Swift layout changes that keep the same
symbols, or lookups by name at runtime (NSClassFromString, Swift _typeByName). rn-xtool pins react-native exactly
(0.88.1 on SDK 58) because Expo's precompiled modules are built against it. If an app that passed G4 still closes at
launch, report it with the installed versions (`npm ls expo react-native expo-modules-core expo-modules-jsi`).

## Expo SDK 57

rn-xtool builds Expo SDK 57 on a floor of verified versions, like SDK 58: at least expo 57.0.31, expo-modules-core
57.0.24, expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3, each on SDK 57's line (57.x), with react-native
exactly 0.86.3 (see [how-it-works.md](how-it-works.md#expo-sdk-57)). A newer 57.x prints the warning in
[Newer than the verified versions](#newer-than-the-verified-versions) and the build continues. `doctor` (the `project`
check) and `build` stop with these messages:

- **"Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo 57.0.31 or newer 57.x) and SDK 58 or newer."** The
  project is on SDK 56 or older.
- **"Expo SDK 57 needs react-native 0.86.3 and at least expo 57.0.31, expo-modules-core 57.0.24,
  expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3; installed: <package> <version>, .... Remove any pin or
  override on these packages from package.json, then run `npx expo install --fix`; then run
  `npx expo install react-native@0.86.3`, since `--fix` alone can leave react-native on another version."** G1. The
  installed list names only the packages below the floor, on another SDK's release line (for example
  `expo-modules-jsi 58.0.19`), missing (`not installed`), or, for react-native, not 0.86.3. Each is read where the
  build resolves it: expo-modules-core from `expo`, expo-modules-jsi from expo-modules-core, expo-modules-autolinking
  from the project root, else from `expo`. The remedy adapts to the project as on SDK 58
  ([Expo SDK 58](#expo-sdk-58)): it names the pins package.json lists, moves `expo` first when `expo` itself is listed
  (`npx expo install expo@~57.0.31`), and, when react-native is the only package listed, ends with "Run
  `npx expo install react-native@0.86.3`." When react-native is newer than 0.86.3, the message ends with "React Native
  <version> is newer than this rn-xtool release supports: pin react-native to 0.86.3, or update rn-xtool."
- **"expo-modules-jsi <version> resolves from <path>, not from the project's top-level node_modules: rn-xtool patches
  and builds only the top-level copy. Remove any expo-modules-jsi pin or override from package.json (expo-modules-core
  <version> needs <range>) (`npm uninstall expo-modules-jsi` removes a pin), then run `npm update expo-modules-jsi`:
  it moves the copy to the top level, which a reinstall does not do while package-lock.json keeps it nested."** G2,
  the same check and text as on SDK 58: npm nested the copy the build uses (under expo-modules-core), and
  patch-package patches only `node_modules/expo-modules-jsi`. The part in parentheses about expo-modules-core is left
  out when expo-modules-core declares no expo-modules-jsi dependency.
- **"expo-modules-macros 0.22.0 has no Linux binary for <arch> (@expo/modules-macros-linux-<arch>); reinstall
  react-native-xtool without --omit=optional."** SDK 57's own macro plugin is macOS-only, so rn-xtool brings
  expo-modules-macros 0.22.0, whose Linux binary is an optional npm dependency: an install with `--omit=optional`, or
  a host architecture without a binary, leaves it out. When another package or a parent folder installs an
  expo-modules-macros that expo-modules-core resolves, the plugin uses that copy instead, and the check names it with
  the `(from expo-modules-core <version>)` texts of the [Expo SDK 58](#expo-sdk-58) section.
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

## doctor --project

`rn-xtool doctor --project` checks only the project in the current folder: no toolchain, login, device or Wi‑Fi
checks, so it also runs on a machine without Swift or xtool. Run it from the project root, the folder with
`package.json`. From a subfolder (for example `ios/`) it reads that folder and reports
`react-native is not installed: run npm install`; running `npm install` there does not help. It prints `node`,
`project` and `project-config` as plain `doctor` does, then these lines (each with ✔ ok, ⚠ warning, ✖ failure or
ℹ information), and exits non-zero when any line fails:

- **versions**: the line that covers the installed versions, for example
  `React Native 0.88.1: the 0.88 line (0.88.0 or newer), verified 0.88.0 and 0.88.1` or
  `Expo SDK 58: expo 58.0.21 (verified 58.0.21), react-native 0.88.1 (verified 0.88.1)`. It fails with a reason when
  no line covers the version (below), and adds `; refused by the version gate (see project)` when a version gate (G1,
  a bare floor, a hybrid's gate) refuses the project; the `project` line then holds the gate's message. Expo SDK 59
  and newer read `Expo SDK <n>: no verified set in this release; the installed plugin builds it, gated by G4 only`.
- **rn-scripts**: the SwiftPM scripts the build would use. rn-xtool reads the files of the installed
  `react-native/scripts` and looks for the entry points and options its driver calls (see
  [how-it-works.md](how-it-works.md#vendored-swiftpm-scripts)):
  - `react-native's own SwiftPM scripts (0.88 layout)`: the installed scripts are used (0.88.x).
  - `react-native ships no SwiftPM scripts: rn-xtool's vendored copy (React Native 0.88.0)` (0.86.x, Expo SDK 57).
  - `react-native's SwiftPM scripts lack <file> export <name>; ... (0.87 layout): rn-xtool's vendored copy (React
    Native 0.88.0)` (0.87.x).
  - `not recognised (missing: <what>); the version table picks the <mode> scripts — run npm install to reinstall
    react-native; if this line stays, reinstall rn-xtool`: the installed scripts' layout matches none that rn-xtool
    knows, so the build falls back to the scripts mode of the version's line. `<what>` lists what was looked for and
    not found: a file (`<file> file`, or `<file> unreadable`), an export, an option, or
    `no bundled react-native patch for <minor>` (rn-xtool's own `patches/` folder lacks the patch for that line, which
    is what "reinstall rn-xtool" fixes). It is a warning; it fails (✖) when react-native ships older scripts, or
    none, on a line whose bundled react-native patch expects its own scripts (`missing: react-native 0.88's own
    SwiftPM scripts, which rn-xtool's 0.88 patch expects`): the build would stop at that patch.
  - `not recognised (missing: <what>); no supported line (see versions)`: the version itself is not supported.
- **rn-artifacts**: React Native's prebuilt artifacts (React, ReactNativeDependencies and Hermes, debug and release):
  - `React Native <version> artifacts are in the cache`: already downloaded; nothing is requested.
  - `React Native <version> artifacts come from rnArtifactsDir <dir> (not probed)`: `rnArtifactsDir` is set in
    `rn-xtool.config.json`, so the build uses that local folder; doctor does not check it.
  - `published for React Native <version>`: each artifact answers on one of its release URLs (HEAD requests,
    nothing is downloaded). Without the `hermes-compiler` package it adds `(Hermes not checked: hermes-compiler is not
    installed)`.
  - `not published for React Native <version>: <artifacts>` fails on a supported line: the build could not download
    them.
  - `not checked: <reason>` is a warning: the requests failed or timed out, which says nothing about the artifacts.
    The probe waits at most 10 s in total; behind a slow proxy or DNS, `doctor --project` takes those 10 s and
    reports `not checked: timed out after 10 s`.
- **expo-plugin** (Expo and hybrid projects): `expo ships its SwiftPM plugin` (SDK 58), or
  `expo ships no SwiftPM plugin: rn-xtool's vendored copy (Expo 58.0.19)` (SDK 57).
- **expo-modules**: `precompiled (expo-modules-core <version>)`, or
  `built from source (expo-modules-core <version> ships no prebuilds)`.
- **podspecs** (information only): the podspec features the dependencies use that rn-xtool tracks (`subspecs`,
  `compiler_flags`, `header_dir`, `header_mappings_dir`, `vendored_frameworks`, `resource_bundles`), each with the
  packages that use it, or `no tracked podspec features in the dependencies`.

The rn-scripts, rn-artifacts, expo-plugin and expo-modules lines are left out when the project has no react-native or
no expo. On a version no line covers, the rn-scripts and rn-artifacts lines are information only, and they do not
promise the vendored copy.

**Unsupported reasons** on the versions line:

- `react-native is not installed: run npm install` and `expo is not installed: run npm install`.
- `React Native <version>: below the <minor> floor (<floor>); move react-native to <floor> or newer`, for example
  0.86.1.
- `React Native <version>: a prerelease; rn-xtool supports releases of the <minor> line from <floor>`, for example
  0.88.2-rc.1.
- `React Native <minor>: newer than the lines this release supports (0.86, 0.87 and 0.88); a new minor is added once
  it is verified on a device`.
- `React Native <minor>: <what its scripts are>; support comes with the translator`, for older minors such as 0.81,
  and `Expo SDK <n>: expo ships <its|no> SwiftPM plugin; React Native <minor>: <what its scripts are>; support comes
  with the translator` for Expo SDK 56 and older. `<what its scripts are>` is `no SwiftPM scripts`,
  `SwiftPM scripts without the entry points rn-xtool needs`,
  `SwiftPM scripts rn-xtool could use, not verified on this line` or `SwiftPM scripts rn-xtool does not recognise`,
  followed by `, no prebuilt artifacts for <version>` when the artifacts are not published. The translator is planned
  work in rn-xtool that does not exist yet; until then these versions are not supported.

**A malformed `rn-xtool.config.json`** fails the `project` line with the file's name and the JSON error, for example
`rn-xtool.config.json: Expected double-quoted property name in JSON at position 25 (line 1 column 26)`, and no
capability line is printed. Every command names the file the same way.

## Device and signing

- **"Developer Mode required":** enable it on the phone (see the checklist above) and reboot.
- **"Untrusted Developer":** trust the certificate under VPN & Device Management.
- **App stops opening after a week:** free-account signatures expire after 7 days. Run `rn-xtool install` again.
- **`xtool launch` fails with `DebugserverClient.Error`:** known on current iOS. Open the app by hand.
- **Anything else:** run `rn-xtool doctor` first.

Bare React Native build errors (`Cannot resolve build setting`, `unsupported source type in the app target`) are
explained in [bare-react-native.md](bare-react-native.md).
