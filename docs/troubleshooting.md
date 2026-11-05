# Troubleshooting

Start with `rn-xtool doctor`: it checks the toolchain, SDK, login, connected device, Wi‑Fi install readiness and
project, and exits non-zero on problems. `rn-xtool doctor --project` checks only the project
([below](#doctor---project)). This page lists the first-run steps on the iPhone and the problems seen so
far with their fixes. Wi‑Fi install problems have their own list in [wifi-install.md](wifi-install.md#troubleshooting).
If none of it helps, `rn-xtool doctor --report` prints a report to paste into an issue
([Reporting a problem](#reporting-a-problem)).

[Back to README](../README.md)

## First-run checklist (on the iPhone)

`install` prints this checklist after installing.

1. Enable Developer Mode (Settings > Privacy & Security > Developer Mode); the phone reboots.
2. Trust the certificate: Settings > General > VPN & Device Management > your Apple ID > Trust.
3. Open the app by hand, and allow Local Network access when asked. The red screen "No script URL provided" may show
   behind that prompt: after Allow, the app reloads by itself. A dev-client app shows the launcher's own Local Network
   screen instead; then open the link or QR code `install` printed ([Dev client](#dev-client)).
4. Keep the phone and the computer on the same Wi‑Fi network with `rn-xtool start` running.

## The app does not start or cannot reach Metro

- **Black screen on launch:** Info.plist had an unresolved `$(VAR)` (for example
  `$(PRODUCT_MODULE_NAME).SceneDelegate`). rn-xtool resolves them; if you see this, rebuild with `build --clean` and
  report it.
- **Red screen "No script URL provided":** the app could not reach Metro. On the first launch it shows behind iOS's
  Local Network prompt and clears by itself after Allow. An app opened before `rn-xtool start` also reloads by itself
  once Metro runs, for up to 5 minutes after the red screen first appeared. If you tapped Don't Allow, the app shows
  "Local Network access is off" once, with an Open Settings button: turn Local Network on for the app (Settings →
  Privacy & Security → Local Network) and come back. If the red screen stays: check that `start` is running, that the
  phone is on the same Wi‑Fi, that Local Network is on for the app, and the firewall (below); then tap Reload.

  This applies to apps without `expo-dev-client` (Expo and bare): `build` adds a small helper to their debug build
  that waits for Metro after the red screen and reloads the app once it answers
  ([how it works](how-it-works.md#first-launch)). It reloads at most once per failure, so a bundling error with Metro
  up never reloads in a loop. If another program answers on Metro's port, the app reloads once and then shows the red
  screen again. The alert's text: "This debug build loads its JavaScript from Metro on your computer, which needs Local
  Network access. Turn it on for this app in Settings (Privacy & Security → Local Network), then come back. If the red
  screen stays, tap Reload." It shows only while the app is in front, not while iOS's prompt is up, after 3 seconds
  without access. If it does not show, turn Local Network on in Settings anyway.
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

## Dev client

These sections are about apps with `expo-dev-client` (Expo, or bare with the dev client). Its launcher does not use the
Metro address baked into the app: it opens a URL, or lists the Metro servers it finds on the network.

### Opening the project in the dev client

- `build` writes `http://<lanIp>:<metroPort>` into the app's Info.plist as the launcher's default URL
  (`DEV_CLIENT_DEFAULT_LAUNCHER_URL`), unless the app's Info.plist already has one (Expo: `defaultLaunchURL` in the
  `expo-dev-client` plugin's options). From the second launch, the app opens the project by itself.
- On the first launch the launcher asks for Local Network access and skips the default URL. Open the link or QR code
  `install` printed:

  ```text
  Metro URL for the dev launcher: http://<lanIp>:<metroPort>
  Scan this QR code with the iPhone camera to open the app on that Metro server:
  <QR code>
  Or open this link on the iPhone: <scheme>://expo-development-client/?url=http%3A%2F%2F<lanIp>%3A<metroPort>
  ```

  The QR code is drawn with the project's own `toqr` (Expo projects have it). Without it, when the output is not a
  terminal, or when the terminal is too narrow, `install` prints only the link:
  `Open this link on the iPhone to open the app on that Metro server: <link>`. The scheme is the app's URL scheme from
  `ios-xtool/Info.plist`. Without one, `install` prints
  `ℹ ios-xtool/Info.plist has no URL scheme, so there is no link to open the dev client: enter http://<lanIp>:<metroPort> in the dev launcher.`
- In Expo apps, `expo start` (run by `rn-xtool start`) prints its own QR code for the dev client too, in a terminal.
- When the launcher is set to open the most recent project, a stale last URL is tried first, for up to 10 seconds,
  before the default URL.
- After a LAN IP change, rebuild and reinstall: the default URL and the link carry the old address. `start` stops and
  says so.
- When `rn-xtool start` was killed (`kill -9`, a closed terminal, a crash) rather than stopped with Ctrl+C, the
  launcher can keep listing the old server until its announcement expires (`dnssd-advertise` announces it for 120
  seconds). Start Metro again with `rn-xtool start`, or pick the live entry.
- On a network that blocks the Bonjour announcement (Wi‑Fi client isolation, a firewall that drops UDP port 5353),
  the dev launcher does not list the server. Open the project with the link or QR code `rn-xtool install` printed.
- When two machines on the same Wi‑Fi run `rn-xtool start` for the same app (the same bundle id and team), the
  launcher lists both under the same name and can open the other machine's Metro. Expo CLI announces the same way.
  Open the project with the link or QR code `rn-xtool install` printed on your own machine.

### Servers hidden by your discovery filters

- xtool installs the app as `XTL-<Team ID>.<bundle id>`. Expo SDK 58's launcher lists only servers announced under
  the installed app's own bundle id ("Match bundle identifier", on by default); Expo announces Metro under the app
  config's id, so the list stays empty or says "… hidden by your discovery filters".
- `rn-xtool install` records the id of the app it installed, and `rn-xtool start` announces Metro over Bonjour
  (`_expo._tcp`) under that id, in place of Expo's announcement. It uses the project's own `dnssd-advertise`, as Expo
  CLI does. `start` prints `ℹ Announcing Metro to the dev launcher as XTL-<Team ID>.<bundle id>.`
- If the list is still empty: run `rn-xtool install` once, then `rn-xtool start`. Or open the link `install` printed.
  Or, in the launcher's Settings under "Server discovery", turn off "Match bundle identifier" (it stays off until the
  app is deleted).

What `start` prints when it cannot announce Metro:

- `` ℹ No installed bundle id recorded: run `rn-xtool install` once so `start` can announce Metro under the app's real id (Expo SDK 58's dev launcher hides other servers). ``
  The app was installed by an older rn-xtool or not by `rn-xtool install`, or the bundle id changed since. Expo's
  announcement stays on.
- `ℹ Could not announce Metro for the dev launcher (<reason>); Expo announces it under the app config's bundle id, which Expo SDK 58's dev launcher hides unless "Match bundle identifier" is off in its Settings.`
  The project's `dnssd-advertise` is missing (`dnssd-advertise is not installed in the project`), is not the 1.x
  version Expo CLI uses (`dnssd-advertise has no advertise() function`,
  `dnssd-advertise's advertise() did not return a stop function`), or failed. Expo's announcement stays on.
- Bare apps: `` ℹ Could not announce Metro for the dev launcher (<reason>); `react-native start` does not announce it, so the launcher will not list it. Open the app with the link `rn-xtool install` printed. ``
- `` ⚠ The Metro announcement for the dev launcher failed (<reason>). Open the app with the link `rn-xtool install` printed, or turn off "Match bundle identifier" in the launcher's Settings. ``
  Printed once, when the network interface that carries the LAN IP reports an error while `start` runs. Errors on
  other interfaces (Docker bridges, VPNs) are ignored, as Expo CLI ignores them.

**Turning the announcement off.** With `CI=1`, `EXPO_UNSTABLE_BONJOUR=0` or `EXPO_UNSTABLE_HEADLESS=1`, `start`
announces nothing, the same rule Expo CLI follows for its own announcement. For a dev-client app it says which variable
did it, in case a shell profile or a devcontainer set it without you knowing:
`` ℹ Metro is not announced to the dev launcher: CI=1 in the environment turns Bonjour off, as in Expo CLI. Open the app with the link `rn-xtool install` printed. ``
Unset that variable to get the announcement back, or open the app with that link. rn-xtool reads
these variables from the environment `start` runs in, not from the project's `.env` files (which Expo CLI also loads):
set them in the shell, for example `EXPO_UNSTABLE_BONJOUR=0 rn-xtool start`.

## Setup and xtool

- **"xtool could not run (exit <code>): ... On Ubuntu this usually means FUSE 2 is missing: sudo apt install
  libfuse2t64 on Ubuntu 24.04 and newer, sudo apt install libfuse2 on older releases":** the xtool AppImage needs FUSE
  2 to start. Ubuntu 24.04 renamed its package to `libfuse2t64`; older releases call it `libfuse2`. Install the one for
  your release, then run the command again.
- **`xtool — not found — run rn-xtool setup` after an rn-xtool update:** rn-xtool pins the xtool version it was
  tested with (1.24.0 in this release) and keeps one copy per version. After an update that pins a newer xtool, run
  `rn-xtool setup` once to download it. A copy at another path (`xtoolPath` in `rn-xtool.config.json`) of another
  version gives a warning, `expected 1.24.0, got <version>`.
- **"Not enough free disk space for setup: the filesystem of <folder> has <free> GB free, and setup needs about <need>
  GB there (<parts>). Free some space, then run `rn-xtool setup` again.":** `setup` adds up what it will download
  before the first download, per filesystem, and stops when one is short. The parts are: Swift toolchain 5 GB (in
  `~/.local/share/swiftly`), xtool 0.2 GB (next to the xtool AppImage), Darwin SDK 15 GB (in `~/.swiftpm/swift-sdks`,
  or `$XDG_CONFIG_HOME/swiftpm/swift-sdks` when `XDG_CONFIG_HOME` is set, where xtool puts it; xtool unpacks the whole
  Xcode there before it keeps only the SDK) and first build 4 GB (React Native artifacts, then the app's
  `ios-xtool/.build`; counted on the filesystem of `~/Library/Caches/ReactNative`). Only the parts `setup` still has
  to install count; the first build counts while the Swift toolchain or the SDK is still to install. The `Xcode.xip`
  itself is not counted.
- `setup` can be run again at any time: it skips what is installed and downloads nothing when everything is there.
  After an interrupted SDK install it first removes the half-written `darwin.artifactbundle.tmp`
  (`ℹ Removing ~/.swiftpm/swift-sdks/darwin.artifactbundle.tmp, left by an interrupted Darwin SDK install.`; under
  `$XDG_CONFIG_HOME/swiftpm` when that is set).

## Unsupported setups

Some setups cannot be built by rn-xtool yet. `rn-xtool doctor --project` names the ones below on its `known-limits`
line ([doctor --project](#doctor---project)), and `rn-xtool build` (also when `run` builds) stops on them before it
changes anything in the project: no `expo prebuild`, no `--clean`, no patches. Before rn-xtool checked for them,
these setups failed minutes into the build, deep in the SwiftPM steps, with an error that did not name the cause. The
checks only read files: they run no code from your project and make no network request.

Each refusal gives the reason, a link to its section below, and on the next line how to build anyway:
`To build anyway, add "<name>" to knownLimits.allow in rn-xtool.config.json.` When there are several, `build` lists
them all after `rn-xtool cannot build this project yet:`.

These are only the setups rn-xtool knows it cannot build. Other setups it cannot build are not caught early: they
still fail during the build, as before.

**Building anyway.** To try a refused setup (for example after you changed the library yourself, or if you think the
check is wrong), list it in `knownLimits.allow` in `rn-xtool.config.json`: the package name for a library, or
`"pnpm"`, `"pnp"` or `"hoisted"` for the install refusals.

```json
{ "knownLimits": { "allow": ["@react-native-async-storage/async-storage", "pnpm"] } }
```

The refusal then becomes a warning, in `doctor --project` and in `build`, and the build goes on:

```text
⚠ known-limits — <reason> (allowed by rn-xtool.config.json knownLimits.allow; the build may fail later)
```

The build may still fail later, at the point where it failed before rn-xtool had these checks. An entry that names no
current refusal is ignored. A `knownLimits` of the wrong shape is an error in every command:
`rn-xtool.config.json: knownLimits must be an object with an allow list` or
`rn-xtool.config.json: knownLimits.allow must be a list of package names or "pnpm", "pnp", "hoisted"`.

### Libraries with prebuilt binaries

`<package> <version>: its podspec (<podspec>) declares vendored_frameworks and the package ships no Package.swift, so
rn-xtool would have to scaffold it, and it cannot link prebuilt binaries yet.` (or `vendored_libraries`, or both)

The library has no `Package.swift`, so rn-xtool would generate one from its podspec, as it does for every
CocoaPods-only library. But the podspec ships precompiled binaries (an `.xcframework` or a static library), and the
generated `Package.swift` cannot link them yet. @react-native-async-storage/async-storage 3.x is the known case
([libraries.md](libraries.md)). Expo modules are not affected: Expo's own SwiftPM plugin links their binaries.

What to do:

- Use a version of the library without prebuilt binaries. For async-storage that is 2.x, whose iOS side is plain
  Objective-C (not tested on a device yet).
- If the app does not need the library on iOS, take it out of iOS autolinking (`ios: null` under its `platforms` in
  `react-native.config.js`, or `expo.autolinking.exclude`): the check then skips it.
- A `Package.swift` of the library's own, or one your project's `patches/` create (also a generated one you edited
  to add a `.binaryTarget`), is accepted: the check passes.
- Binaries declared only in a test spec or under a Ruby condition (`if`, `unless`) do not count.

### Libraries that build vendored C sources

`<package> <version>: its podspec (<podspec>) builds C sources from vendor/ (<files>) and the package ships no
Package.swift; rn-xtool cannot build vendored C sources yet.`

The library is an Expo module whose podspec compiles C sources from its `vendor/` folder (expo-sqlite, which builds
SQLite and SQLCipher that way). It has no `Package.swift`, and the package ships no precompiled copy of it, so Expo's
SwiftPM plugin would have to compile those sources, which it cannot do yet. There is no fix in rn-xtool yet: remove
the library, or take it out of iOS autolinking (`expo.autolinking.exclude`) if the app does not need it on iOS.
`expo-sqlite/kv-store` comes from the same package, so it is not a way around it. An Expo module that ships a
precompiled copy, or has a `Package.swift` of its own or from your project's `patches/`, passes.

### pnpm and Yarn PnP

`This project was installed with pnpm (pnpm-lock.yaml and a node_modules/.pnpm store); rn-xtool needs the flat
node_modules that npm or Yarn classic installs. Remove node_modules and install with npm.`

`This project uses Yarn Plug'n'Play (.pnp.cjs); rn-xtool needs a node_modules folder. Add nodeLinker: node-modules to
.yarnrc.yml and run yarn install.`

rn-xtool patches packages in place with patch-package and reads them at fixed paths in `node_modules`, which pnpm's
linked store and Yarn's Plug'n'Play do not provide. Do what the message says:

- pnpm: `rm -rf node_modules && npm install`. A pnpm install with `node-linker=hoisted` (a flat `node_modules`) is not
  refused.
- Yarn Plug'n'Play: add `nodeLinker: node-modules` to `.yarnrc.yml`, then `yarn install`.

Only the project folder itself is checked: a pnpm lockfile in a parent folder does not count.

### Packages hoisted to a parent folder

`react-native is installed in ../node_modules/react-native, outside this project: a workspace hoisted it to a parent
folder, and rn-xtool patches and builds only the project's own node_modules/react-native. Install the app outside the
workspace, or keep react-native in the app's node_modules (for example with nohoist).` (the same for `expo`)

In a monorepo, the package manager can install react-native or expo once in the workspace's `node_modules` instead of
the app's. rn-xtool patches and builds the copy in the app's own `node_modules`, so it would miss that one. Install
the app outside the workspace, or keep react-native and expo in the app's `node_modules` (for example with Yarn
classic's `nohoist`). Only parent folders' `node_modules` are checked, not Node's global folders.

## Build and patches

- **Metal shaders are skipped on Linux:** a library that ships `.metal` files (react-native-svg's `MetalCI` filters)
  would fail the build with `unable to spawn process 'metal'`, because the Metal compiler only exists on macOS. The
  scaffolder excludes them and prints `Skipped N Metal shader(s)`; the library works, but features that rely on those
  shaders are unavailable in the build.
- **svg Metal filters stay unavailable under SwiftPM:** react-native-svg loads its prebuilt `*.metallib` files from
  `RNSVGFilters.bundle`, declared in the podspec through `s.ios.resource_bundles`. A scaffolded library's resources are
  not copied into the app (on any host, macOS included), so the bundle is never built, and `build` names it in its
  `ℹ Not copied into the app` line ([below](#scaffolded-libraries)). Skipping `.metal` compilation is the only
  Linux-specific part. Rendering that does not use those filters is unaffected.
- **An Expo config plugin change is missing from the app** (for example expo-image-picker's photo library text in
  Info.plist): `build` runs `expo prebuild` only when `ios/` is missing. After adding or changing a config plugin in
  `app.json`, run `rn-xtool build --clean` (or `run --clean`), which re-runs `expo prebuild --clean`.
- **A committed project patch no longer applies** (after a library upgrade): delete it from `patches/` and let
  `rn-xtool build` re-scaffold it.
- **"⚠ patches/<file> is for <package>, which is not installed; skipped. Delete it if you removed the library.":** a
  patch in your `patches/` (subfolders included) is for a package that has no `node_modules/<package>/package.json`,
  usually after `npm uninstall`. patch-package stops on such a patch, so the `patches` step leaves it out, applies the
  other patches from a copy in `ios-xtool/.project-patches`, and the build goes on. `doctor --project` prints the same
  line (`⚠ patches — patches/<file> is for <package>, …`). If you removed the library, delete the patch; if not, run
  `npm install`, and the next build applies the patch again. A nested package's patch
  (`<parent>++<child>+<version>.patch`) is named `<parent> => <child>`. A package installed at another version than
  its patch's is not skipped: patch-package applies the patch with its own version warning.
- **"⚠ patches/<name> was written by an older rn-xtool scaffolder (revision <n>, now 4); delete it so rn-xtool
  regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old Package.swift)":** the
  `patches` step found a persisted scaffold patch from an older scaffolder. Revision 1 patches lack the Swift importer
  paths of mixed libraries, revision 2 patches lack those of clang-only libraries and their module map, and revision 3
  patches lack fixes 20–22 and 24 (fixes 17 to 24 in [the scaffolder fixes](upstream/react-native-scaffolder.md)).
  Without them, Swift code that imports a scaffolded library (the app, or expo-router importing react-native-screens)
  can fail with `'RNSReactBaseView.h' file not found` (a mixed library, such as react-native-screens 4.26) or
  `'RNSDefines.h' file not found` (a clang-only one, such as react-native-screens 4.30). Do what the warning says:
  delete the patch, remove the library from `node_modules` and reinstall it, then build; rn-xtool scaffolds it again and
  persists the new patch. This release's scaffolder is revision 4, so each scaffold patch persisted before it gets the
  line at every build until it is regenerated, for example `⚠ patches/react-native-screens+4.30.0.patch was written by
  an older rn-xtool scaffolder (revision 3, now 4); delete it so rn-xtool regenerates it (also remove
  node_modules/react-native-screens and reinstall: that copy still has the old Package.swift)`. Until then the build
  goes on with the older manifest.
- **"⚠ patches/<name> was scaffolded for React Native <version>; delete it so rn-xtool regenerates it for <installed>
  (also remove node_modules/<package> and reinstall: that copy still has the old Package.swift)":** the persisted
  scaffold patch was made for another React Native version, for example after moving a project from 0.88.0 to 0.88.1.
  Do the same as for the revision warning above. Both warnings also read patches with the marker's name before the
  rename, `expo-xtool-scaffold-revision` (apps scaffolded before 0.1.0-alpha.1).
- **"ℹ node_modules/<package>/Package.swift was scaffolded with revision <n> for React Native <version>, older than
  patches/<name> (revision 4, React Native <installed>): rn-xtool replaced it with the persisted one":** a teammate
  committed a regenerated scaffold patch, and your `node_modules` still had the copy an older patch wrote
  (patch-package does not replace a file that exists). rn-xtool owns these generated files, so the `patches` step
  removes the files the current patch creates and patch-package writes them again; the line is printed once
  patch-package has done so. Nothing to do; files the older scaffold wrote and the current one does not stay in place.
  This happens only when the patch holds nothing but scaffolded new files.
- **"⚠ node_modules/<package>/Package.swift was scaffolded with revision <n> for React Native <version>, older than
  patches/<name> (revision 4, React Native <installed>), and that patch also changes the library's own files, so
  rn-xtool does not replace it: run rm -rf node_modules/<package> && npm install, then build again":** the same case,
  but the persisted patch also holds your own fix to the library. rn-xtool persists a scaffold with
  `patch-package <package>`, which writes everything that differs from the published package into one patch.
  Removing only the scaffold files would leave a patch that patch-package can apply neither forward nor backward, so
  rn-xtool changes nothing and the build goes on with the older manifest. Run the command: the reinstall gives the
  published package, and the next build applies the whole patch.
- **"ℹ node_modules/<package>/Package.swift was scaffolded by an older rn-xtool scaffolder (revision <n>, now 4)" (or
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

### Scaffolded libraries

The `rn-spm` step scaffolds only the libraries React Native reports without a `Package.swift`, and it forces nothing:
the `Package.swift` of every other library, persisted in `patches/` or edited by hand, stays as it is
([how it works](how-it-works.md#cocoapods-only-libraries)).

- **"✖ Scaffolding <library> failed: <reason>":** the scaffolder wrote no `Package.swift` for a library React Native
  named, and the build stops there. The first line is the real cause, in the scaffolder's words, for example
  `✖ Scaffolding @react-native-community/netinfo failed: Podspec read failed: EACCES: permission denied, open
  '<project>/node_modules/@react-native-community/netinfo/react-native-netinfo.podspec'`. That library's own scaffold
  warnings follow, one `  ! <warning>` line each, and a blank line separates the libraries when several failed. The
  reason is `no Package.swift was written` when the scaffolder gave none, and `the scaffolder did not find <library>
  among the autolinked iOS libraries` when React Native named a library the scaffolder did not see. Nothing is
  persisted for a failed library, and React Native does not run a second time; the libraries that did scaffold are
  persisted as usual (`✔ scaffold — persisted patches/<file>`). Fix the cause and build again.
- **A library keeps its old `Package.swift` after you edit its podspec, or install a dependency it left out:** a
  library is scaffolded again only when React Native reports it without a `Package.swift`. To re-scaffold one now,
  delete its `Package.swift`, its `react-native-spm-prefix.h` (when it has one) and its patch in `patches/`, then
  build:

  ```sh
  rm -f node_modules/<package>/Package.swift node_modules/<package>/react-native-spm-prefix.h
  rm patches/<package>+<version>.patch
  rn-xtool build
  ```

  Delete all three. With the patch kept, the `patches` step puts the old `Package.swift` back, and a patch whose new
  files are only partly in `node_modules` (the `Package.swift` deleted, the prefix header left) no longer applies: the
  build stops with `✖ Applying the project's patches/ failed.` Removing the library from `node_modules`, reinstalling
  it and deleting its patch works too.
- **"! react-native-vision-camera: Dependency "react-native-worklets-core" is not installed (or not linked for iOS);
  left out with the subspec "FrameProcessors" that declares it (its sources, headers, settings and dependencies), as
  CocoaPods leaves it out.":** a podspec depends on a React Native library that is not autolinked for iOS. The
  scaffolder leaves that dependency out, as CocoaPods does, and with it the subspec that declares it, so
  react-native-vision-camera builds without frame processors. A dependency of the main spec is left out alone, and
  every source stays: `Dependency "<name>" is not installed (or not linked for iOS); left out, as CocoaPods leaves it
  out.` Installing the dependency later does not bring the subspec back, and `build` prints no warning about it: the
  library's persisted scaffold is current, and React Native scaffolds only the new package. To get the subspec,
  install the dependency, then re-scaffold the library as above.
- **Swift language mode:** scaffolded Swift compiles in the Swift 5 language mode (`swiftLanguageModes: [.v5]` in the
  generated `Package.swift`), as CocoaPods compiles a pod, unless the podspec declares `swift_version` 6 or higher; an
  interpolated or computed value counts as not declared. A library that declares Swift 6 compiles in Swift 6, as under
  CocoaPods. In a library that declares no Swift 6, strict-concurrency errors such as `static property 'shared' is not
  concurrency-safe because non-'Sendable' type 'AudioSessionManager' may have shared mutable state` (react-native-video
  6.19.3) come from a scaffold of revision 3 or older: see the revision warning above.
- **"ℹ Not copied into the app: <library> (<resources>), …. Code that loads them at run time does not find them.":**
  `build` prints it once, right after `rn-spm`, for the scaffolded libraries whose podspec declares resources
  (`resource_bundles`, `resources`): the scaffolded `Package.swift` holds no resources, and rn-xtool copies no bundle
  into `App.app`. A bundle made only of privacy manifests is named by its files, any other bundle as `<name>.bundle`
  (react-native-svg's `RNSVGFilters.bundle`), and a plain resource by its file name. Values under a Ruby condition,
  and those for other platforms than iOS, are not read. A feature that loads one of these resources at run time is
  unavailable, such as svg's Metal filters. When every resource named is a privacy manifest, the line ends
  "Development builds run without them; privacy manifests are read only at App Store submission." instead, for
  example `ℹ Not copied into the app: react-native-device-info (PrivacyInfo.xcprivacy). Development builds run without
  them; privacy manifests are read only at App Store submission.`; there is nothing to do for a development build.

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
  release of 0.85.x, 0.86.x, 0.87.x or 0.88.x newer than every version of its line this release was verified with,
  for example 0.88.2 or 0.85.4.
  A hybrid app (bare + Expo modules) does not get this warning: it needs react-native 0.88.1, and on a newer 0.88.x
  G1 stops it.
- **"⚠ Not among the React Native <minor> versions this rn-xtool release was verified with: react-native <version>.
  Verified: <versions>. The build continues; if it fails or the app crashes at launch, move react-native to
  <version> as https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native
  describes, and report it at https://github.com/WillyAntunez/react-native-xtool/issues."** The same case, for a
  release between two verified versions of the line: 0.85.1 and 0.85.2 sit between the verified 0.85.0 and 0.85.3.
  The version to move to is the line's last verified one, which is newer than the installed one.

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
  React Native 0.85, 0.86 or 0.87; a hybrid on 0.88.0 gets the first message, naming `react-native 0.88.0`.

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
  (see [bare-react-native.md](bare-react-native.md#older-artifacts-085-086)).

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
  `React Native 0.88.1: the 0.88 line (0.88.0 or newer), verified 0.88.0 and 0.88.1`,
  `React Native 0.85.0: the 0.85 line (0.85.0 or newer), verified 0.85.0 and 0.85.3` or
  `Expo SDK 58: expo 58.0.21 (verified 58.0.21), react-native 0.88.1 (verified 0.88.1)`. It fails with a reason when
  no line covers the version (below), and adds `; refused by the version gate (see project)` when a version gate (G1,
  a bare floor, a hybrid's gate) refuses the project; the `project` line then holds the gate's message. Expo SDK 59
  and newer read `Expo SDK <n>: no verified set in this release; the installed plugin builds it, gated by G4 only`.
- **rn-scripts**: the SwiftPM scripts the build would use. rn-xtool reads the files of the installed
  `react-native/scripts` and looks for the entry points and options its driver calls (see
  [how-it-works.md](how-it-works.md#vendored-swiftpm-scripts)):
  - `react-native's own SwiftPM scripts (0.88 layout)`: the installed scripts are used (0.88.x).
  - `react-native ships no SwiftPM scripts: rn-xtool's vendored copy (React Native 0.88.0)` (0.85.x, 0.86.x, Expo SDK
    57).
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
- **patches** (only when a patch's package is not installed): one ⚠ line per such patch in `patches/`, the `build` line
  without its `⚠`: `patches/<file> is for <package>, which is not installed; skipped. Delete it if you removed the
  library.` ([details](#build-and-patches)).
- **known-limits**: the setups rn-xtool refuses before a build ([Unsupported setups](#unsupported-setups)). With none,
  it reads `none of the setups rn-xtool refuses early (CocoaPods-only libraries with prebuilt binaries or vendored C
  sources, pnpm, Yarn PnP, hoisted packages)`. Otherwise there is one ✖ line per refusal, with its reason and a link
  to its section, followed by `To build anyway, add "<name>" to knownLimits.allow in rn-xtool.config.json.` on the
  next line, and `doctor --project` exits non-zero. A refusal that `knownLimits.allow` lets through is a ⚠ warning
  instead, ending with `(allowed by rn-xtool.config.json knownLimits.allow; the build may fail later)`.

The rn-scripts, rn-artifacts, expo-plugin and expo-modules lines are left out when the project has no react-native or
no expo. On a version no line covers, the rn-scripts and rn-artifacts lines are information only, and they do not
promise the vendored copy.

**Unsupported reasons** on the versions line:

- `react-native is not installed: run npm install` and `expo is not installed: run npm install`.
- `React Native <version>: below the <minor> floor (<floor>); move react-native to <floor> or newer`, for example
  0.86.1.
- `React Native <version>: a prerelease; rn-xtool supports releases of the <minor> line from <floor>`, for example
  0.88.2-rc.1.
- `React Native <minor>: newer than the lines this release supports (0.85, 0.86, 0.87 and 0.88); a new minor is added
  once it is verified on a device`.
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

## App icon and launch screen

`build` gives the app the icon from `ios/<target>/Images.xcassets/AppIcon.appiconset`: the 1024×1024 entry, else the
largest iPhone size. Expo writes that set during `expo prebuild` from the app config's `icon` (or `ios.icon`); in a
bare app, it is the icon set of your Xcode project. `build` copies the PNG to `ios-xtool/AppIcon.png`, and xtool puts
it in the app. It prints what it used:

- `ℹ App icon: <path> (<width>×<height>)`.
- `` ℹ No app icon: <set> does not exist. Add a 1024×1024 PNG to it to give the app an icon (Expo: set "icon" in the app config, then run `rn-xtool build --clean`). ``
  The same advice follows `ℹ No app icon: <set> lists no PNG in its Contents.json.` (a fresh bare template's set
  lists sizes without files).
- `ℹ No app icon: <file> is not a PNG file. Replace it with a 1024×1024 PNG.`
- `` ℹ No app icon: <icon> is an Icon Composer icon, which needs Xcode's actool. Set a 1024×1024 PNG as "icon" in the app config, then run `rn-xtool build --clean`. ``
- `⚠ No app icon: an app resource is copied to the app bundle as AppIcon.png, the name rn-xtool gives the icon. Rename that resource to give the app its icon.`
- `⚠ App icon <file> is <w>×<h>, not square: iOS stretches it. Use a 1024×1024 PNG.` and
  `⚠ App icon <file> is <w>×<h>, smaller than 180×180: it looks blurry on the home screen. Use a 1024×1024 PNG.`
  The icon is still used.
- `` ⚠ The app config icon <icon> changed since the last expo prebuild wrote <set>: run `rn-xtool build --clean` to use it. ``
  The record is only refreshed when `build` runs the prebuild: after a `npx expo prebuild` run outside rn-xtool, the
  app already gets the new icon, but the warning stays until `rn-xtool build --clean`, which also refreshes the
  record.

A missing or unusable icon never stops the build.

**Expo: a changed icon needs `rn-xtool build --clean`.** `build` runs `expo prebuild` only when `ios/` is missing or
with `--clean`, so a new `icon` in the app config does not reach the icon set by itself. Each time `build` runs
prebuild, it records the icon's path and a hash of its content. When the app config names another file, or the file's
content changed, `build` prints the `⚠` line above and still uses the old icon. Touching the file or checking out the
same content gives no warning. A project last built by an older rn-xtool, or prebuilt outside rn-xtool, has no record:
the first `build` records the current icon without a warning, and later changes warn.

**The home screen keeps a blank or old icon after a reinstall:** iOS caches app icons. Delete the app from the iPhone
and install it again, or restart the phone.

**Not supported:** dark and tinted icons, Icon Composer `.icon` icons, and a custom splash colour or image. The launch
screen is the system background colour. They need Xcode's asset catalog compiler (`actool`), which does not run on
Linux.

## Device and signing

- **"Developer Mode required":** enable it on the phone (see the checklist above) and reboot.
- **"Untrusted Developer":** trust the certificate under VPN & Device Management.
- **App stops opening after a week:** free-account signatures expire after 7 days. Run `rn-xtool install` again.
- **`xtool launch` fails with `DebugserverClient.Error`:** known on current iOS. Open the app by hand.
- **Anything else:** run `rn-xtool doctor` first.

Bare React Native build errors (`Cannot resolve build setting`, `unsupported source type in the app target`) are
explained in [bare-react-native.md](bare-react-native.md).

### Apple sign-in errors

`rn-xtool auth login` (and `auth status` and `auth logout`) runs xtool's sign-in. When xtool fails with one of these
known errors, rn-xtool prints what happened, whose side it is on and what to do, instead of xtool's raw error:

- **"Apple's sign-in service answered HTTP 503 (Service Temporarily Unavailable): Apple refused the request before it
  checked your Apple ID, so this is on Apple's side, not your project or your password."** xtool's output names
  `GsService2` and `HTTP 503`. xtool 1.24.0 fixed one cause of it: `rn-xtool doctor` shows whether your xtool is the
  version rn-xtool pins, and `rn-xtool setup` installs it. Then try again later.
  ([xtool issue #404](https://github.com/xtool-org/xtool/issues/404))
- **"The anisette server xtool signs in through did not answer in time (HTTPClientError.deadlineExceeded)."** xtool
  signs in through an anisette server, which supplies the device information Apple's sign-in expects. That server
  did not answer; it has been down before and came back on its own. Try again later.
  ([xtool issue #401](https://github.com/xtool-org/xtool/issues/401))
- **"A connection xtool needs to sign in timed out (HTTPClientError.connectTimeout)"**: Apple's sign-in server
  (gsa.apple.com) stalls now and then on some networks, and an unreachable anisette server fails the same way. Run
  the command again; a new sign-in may ask for a new verification code.
  ([xtool issue #414](https://github.com/xtool-org/xtool/issues/414) and
  [#401](https://github.com/xtool-org/xtool/issues/401))
- **"Sign-in was interrupted. If the verification code never arrived on your trusted devices, that is a known problem
  between xtool and Apple's sign-in, not your project."** You pressed Ctrl+C at xtool's `Code:` prompt. It went away
  for others after they turned off Advanced Data Protection for the Apple ID (on the iPhone: Settings → your name →
  iCloud → Advanced Data Protection); then run `rn-xtool auth login` again. rn-xtool exits with status 130. A Ctrl+C
  at any other step of `auth login` ends as xtool ends it, with `Cancelled.`, and also exits with status 130.
  ([xtool issue #407](https://github.com/xtool-org/xtool/issues/407))

Any other sign-in error is shown as xtool prints it. rn-xtool recognises these errors by xtool's current texts: if a
new xtool release words one differently, it is shown as xtool prints it too. These explanations are given only on
`rn-xtool auth`: the same timeout during an install has another cause, so `install` shows it as xtool prints it.

### App ID limit

**"Apple refused to register another App ID: a free Apple ID can register 10 App IDs per 7 days, and each new bundle
identifier takes one."** `rn-xtool install` (over USB or `--network`) and `rn-xtool run` print it when Apple refuses
to register the app. The numbers come from Apple's own answer.

Each new bundle identifier you install registers a new App ID with Apple, and a free Apple ID can register only a few
of them a week. A fresh Expo app gets `com.anonymous.<slug>`, so every new test app takes one. What to do:

- Reuse a bundle identifier that is already installed on your iPhone, without the `XTL-<Team ID>.` prefix xtool adds:
  set it as `ios.bundleIdentifier` in the Expo app config, or as `PRODUCT_BUNDLE_IDENTIFIER` of the app target in a
  bare project. Then run `rn-xtool build` and `rn-xtool install` again.
- Or wait until the oldest of those App IDs is 7 days old.

### iPhone not registered

**"Apple has no iPhone registered on your Apple ID's team, so xtool could not sign the app for one."**
`rn-xtool install --network` prints it when Apple answers "There are no current IOS devices on this team".

Over Wi‑Fi, xtool signs the app for the iPhones already registered on your team, and it registers an iPhone only when
it installs over USB. A registration can be gone a while after the last USB install. Connect the iPhone by USB once
and run `rn-xtool install` without `--network`. After that, `rn-xtool install --network` works again.

## Reporting a problem

Run `rn-xtool doctor --report` in the project folder (`rn-xtool doctor --report --project` for the project only) and
paste its whole output into a [new issue](https://github.com/WillyAntunez/react-native-xtool/issues/new/choose). It
prints one block with rn-xtool's, Node's, Swift's and xtool's versions, the OS and architecture, the project's kind
and versions, and every `doctor` line, the `doctor --project` lines included. It exits 0 whatever the checks say.

It replaces private values with placeholders:

| Value | Shown as |
| --- | --- |
| your home folder (and other users' folders, including a WSL Windows home) | `~` |
| a user folder on an external drive | `/media/<user>`, `/run/media/<user>` |
| your Apple ID, other e-mail addresses | `<apple-id>`, `<email>` |
| your Team ID | `<team-id>` |
| bundle identifiers, the `XTL-<Team ID>.` prefix included | `<bundle id>` |
| UDIDs | `<udid>` |
| device names | `<device>` |
| IP addresses | `<ip>` |
| MAC addresses, also inside network interface names such as `enx…` | `<mac>` |
| tokens and passwords | `<token>` |

It makes no network request, to the internet or on your local network, and does not contact the iPhone: the
artifacts line reads the cache only and says `not checked (offline)` otherwise, and the device and Wi‑Fi lines read
`not checked (report)`.
Anything your project's config prints while the report is built is left out.

The report ends with:

> Read the report before you post it: rn-xtool replaced your home folder, Apple ID, Team ID, bundle identifiers,
> device names and UDIDs, IP and MAC addresses and tokens with placeholders. Remove anything else you consider private.

Do that before you post: the placeholders cover the values above, not every private word, such as a folder or
project name.

The issue templates ask for the report: **Bug report** when rn-xtool fails or does something unexpected (the command
you ran, what you expected and what happened), and **My library does not build** for a library (its npm name and
version). Both end with a checkbox that you read the report and removed anything private.
