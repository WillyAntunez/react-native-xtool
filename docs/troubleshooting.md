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

### Libraries that depend on CocoaPods pods

`<package> <version>: its podspec depends on the CocoaPods pod <pod>, which has no SwiftPM package rn-xtool knows. Add
one under "pods" in rn-xtool.config.json: { "pods": { "<pod>": { "url": "<git URL>", "exact": "<version>", "products":
["<product>"] } } }, or leave the library out with "exclude". See <this section>`

The library's podspec depends on a CocoaPods pod whose spec is a git source, and neither rn-xtool's pod table nor the
`pods` of your `rn-xtool.config.json` names a SwiftPM package for it. With several such pods the text names them all
(`the CocoaPods pods <pod> and <pod>, which have no SwiftPM package rn-xtool knows. Add them …`), and the snippet
names the first. Pods under a Ruby condition (`if`, `unless`) do not count, nor do those of a subspec the scaffolder
leaves out for a missing dependency ([Scaffolded libraries](#scaffolded-libraries)). A pod that ships prebuilt static
binaries, such as GoogleMLKit (@react-native-ml-kit/text-recognition 2.0.0), is not refused: rn-xtool downloads and
links it ([CocoaPods binaries](#cocoapods-binaries)).

The early checks read a pod's route offline, from `rn-xtool-pods.lock.json` or a spec in rn-xtool's cache. A pod
neither names is not refused there: `ℹ pods — GoogleMLKit (from @react-native-ml-kit/text-recognition) is not
resolved yet; rn-xtool build reads its spec from the CocoaPods CDN.` The `pods` step then reads it, still before
anything changes in the project, and gives the refusal above for a git-source pod, also for one a binary pod depends
on, with the chain that reaches it. `knownLimits.allow` and these pods:
[CocoaPods binaries](#knownlimitsallow-and-binary-pods).

rn-xtool's pod table maps AppAuth (react-native-app-auth) to AppAuth-iOS 3.0.0 and SwiftUIIntrospect
(react-native-pager-view) to swiftui-introspect 1.5.0. A mapped pod becomes a `.package(url:exact:)` dependency of the
library's scaffolded `Package.swift`, and SwiftPM fetches it from GitHub at the `xtool-build` step. The first build, and
any build after `ios-xtool/.build` is deleted, needs the network for it; an offline or rate-limited fetch fails with
SwiftPM's resolve error naming the URL.

**Adding a pod.** When the pod has a SwiftPM package (a git repository with a `Package.swift`), add it under `pods` in
`rn-xtool.config.json`. rn-xtool's own AppAuth entry is the example to copy (its `forwardHeaders` list is shortened
here; the shipped one, in `data/pods.json`, has all 31 headers):

```json
{
  "pods": {
    "AppAuth": {
      "url": "https://github.com/openid/AppAuth-iOS",
      "exact": "3.0.0",
      "products": ["AppAuth"],
      "forwardHeaders": {
        "AppAuth/AppAuth.h": ["OIDAuthState.h", "OIDAuthorizationService.h", "iOS/OIDExternalUserAgentIOS.h"]
      }
    }
  }
}
```

- `url`: the package's git URL, `https://…`.
- `exact`: the version SwiftPM pins, a full version such as `3.0.0` (a tag of the repository).
- `products`: the package's products the library links (`"product": "AppAuth"` works for one).
- `subspecs` (optional): `{ "<subspec>": ["<product>", …] }`, the products for a dependency on `<pod>/<subspec>`; any
  other subspec gets `products`.
- `forwardHeaders` (optional): `{ "<Dir/Header.h>": ["<header>", …] }`, for a pod whose umbrella header is not part of
  its SwiftPM targets. List the headers the umbrella includes, as paths under the public header directories of the
  package's targets, which every importer has on its include path: AppAuth-iOS 3.0.0's `Sources/AppAuth.h` gives
  `OIDAuthState.h` and 25 more headers from `Sources/AppAuthCore`, then, from its iOS branch, the 5 headers of
  `Sources/AppAuth/iOS`, as `iOS/OIDAuthState+IOS.h` and so on. The scaffolder writes
  `rn-spm-pod-headers/<Dir/Header.h>` into the library, holding one `#import <header>` per entry, and adds
  `rn-spm-pod-headers` to the library's header search paths, so `#import <AppAuth/AppAuth.h>` resolves as it does under
  CocoaPods. The forwarder includes the headers textually because Objective-C++ (`.mm`) files compile without C++
  modules, as in Xcode, so an `@import` there is an error; in Objective-C (`.m`) the `#import` of a module's header
  still imports the module. A module name in the list, the form of 0.1.0-alpha.6 (`["AppAuthCore", "AppAuth"]`), is
  refused with `pods.<pod>.forwardHeaders.<header> lists the module <name>; list the pod's public headers instead
  (relative paths ending in .h), which the forwarder includes textually: Objective-C++ compiles without modules, so it
  cannot @import`.
- `outsideRequirement` (optional): a sentence saying why `exact` is outside a requirement on purpose, checked by you.
  The pin check then prints one `ℹ` line with it instead of the `⚠` (rn-xtool's GoogleToolboxForMac entry,
  [CocoaPods binaries](#warnings-and-information-lines)). It holds for the entry's own `url` and `exact`: a config
  entry that pins another one drops it.
- `emptyTargets` (optional): `["<target>", …]`, the package's targets without sources (GoogleToolboxForMac's
  `GTMDefines`). Swift Build writes no object for them but lists one at link, so rn-xtool writes an empty one in its
  place before `xtool-build` ([How the binaries are linked](#how-the-binaries-are-linked)). Like
  `outsideRequirement`, it holds for the entry's own `url` and `exact`: a config entry that pins another one drops it.
  `"emptyTargets": []` clears it for the same pin.

Every command checks the shape, offline, and names the key: `rn-xtool.config.json: pods.AppAuth.products must be a
list of product names`. The other texts end in `pods must be an object of CocoaPods pod names`, `pods.<pod> must be a
CocoaPods pod name (no "/", spaces or quotes)`, `pods.<pod>.url must be a git URL (https://…)`, `pods.<pod>.exact must
be a version such as 3.0.0`, `pods.<pod>.subspecs must be an object of subspec names`,
`pods.<pod>.subspecs.<name> must be a list of product names`, `pods.<pod>.outsideRequirement must be a sentence saying
why the pin is outside the requirement`, `pods.<pod>.emptyTargets must be a list of target names`,
`pods.<pod>.forwardHeaders must be an object of header paths` and `pods.<pod>.forwardHeaders.<header> must be a list
of the pod's public headers (relative paths ending in .h), under a relative path ending in .h`. A URL or product that
is well formed but wrong is named by SwiftPM at `xtool-build`, in its resolve error. A header that is well formed but
not in the package is named by clang, when a file that imports the forwarded header compiles: `'<header>' file not
found`.

**Changing a shipped pod.** An entry for a pod rn-xtool's table maps overrides only the fields it names, and the
others stay. It still needs `url`, `exact` and `products`. To pin AppAuth 2.1.0:

```json
{
  "pods": {
    "AppAuth": { "url": "https://github.com/openid/AppAuth-iOS", "exact": "2.1.0", "products": ["AppAuth"] }
  }
}
```

The shipped `forwardHeaders` stay; `"forwardHeaders": {}` removes them, and `"subspecs": {}` removes subspecs. They
list AppAuth-iOS 3.0.0's headers: if the version you pin moves or renames one, give your own `forwardHeaders` with
that version's umbrella header list.

**A pin outside the podspec's requirement.** `doctor --project` (its `pods` line) and the start of `build` print, for
example, `⚠ AppAuth 1.0.0 (rn-xtool.config.json) is outside react-native-app-auth's requirement ">= 1.7.6"`
(`(rn-xtool.config.js)` when `pods` comes from that file, `(rn-xtool table)` for a pin of rn-xtool's own). The build
goes on with the pinned version; SwiftPM or the compiler gives the verdict.

**A persisted scaffold with another pin.** Each scaffolded `Package.swift` records the pods it pins on a marker line
(`// rn-xtool-pods: AppAuth=3.0.0`). After you change a pin, the library's persisted patch still holds the old one,
and the `patches` step (and `doctor --project`) says so, for example `⚠ patches/react-native-app-auth+8.5.1.patch
pins AppAuth 3.0.0, the config says 2.1.0; delete it so rn-xtool regenerates it (also remove
node_modules/react-native-app-auth and reinstall: that copy still has the old Package.swift)`. The build goes on with
the old pin until you re-scaffold the library through `rn-xtool build`:

```sh
rm patches/react-native-app-auth+8.5.1.patch
rm -rf node_modules/react-native-app-auth && npm install
rn-xtool build
```

A library without a persisted patch is re-scaffolded by `build` itself: `ℹ
node_modules/react-native-app-auth/Package.swift pins AppAuth 3.0.0, not 2.1.0: rn-xtool removed it so the rn-spm step
scaffolds it again`. A scaffold that pins nothing although the podspec depends on a mapped pod was made without
rn-xtool's pod table, for example by running `npx react-native spm scaffold` by hand: `⚠ patches/<file> does not pin
AppAuth, rn-xtool's table says 3.0.0: it was scaffolded without rn-xtool's pod table (not through rn-xtool build);
delete it so rn-xtool regenerates it (…)`. It lacks the forwarder too; the same three steps fix it.

**One version of each package.** SwiftPM resolves one version of a package for the whole app. When a library with a
`Package.swift` of its own, or the app, needs the same package at a version the pin excludes, `xtool-build` stops with
SwiftPM's version conflict naming both; align the pin under `pods`.

**A pod named like React Native's own.** A pod whose name starts like a React Native core pod (`React-`, `RCT`,
`Yoga`, `glog`, …) is read as part of React Native and left out without a warning, so the refusal above does not
appear; the build fails later with a "file not found" naming one of its headers. `pods` cannot map such a name,
because the core names are read first. Leave the library out with `exclude`, or report it with the "My library does
not build" template ([Reporting a problem](#reporting-a-problem)).

**react-native-app-auth on Expo SDK 58.** Use 8.5.1: `npx expo install react-native-app-auth@8.5.1`, with its config
plugin in the app config. `npx expo install react-native-app-auth` picks 9.0.0, whose config plugin stops `expo
prebuild` on SDK 58 with `react-native-app-auth could not find application(_:continue:restorationHandler:) in the Expo
AppDelegate` (SDK 58's AppDelegate has no such method; the error is the library's, and a plain `npx expo prebuild`
fails the same way). The plugin's bridging header reaches Swift: rn-xtool passes the `SWIFT_OBJC_BRIDGING_HEADER` of
the Xcode project `expo prebuild` writes, so `RNAppAuthAuthorizationFlowManager` compiles in `AppDelegate.swift`.

**A sibling installed but not listed in package.json** (bare React Native):

`<package> <version>: its podspec depends on <npm>, which is installed but not listed in package.json, so React Native
does not link it; add it to dependencies (npm i <npm>). See <this section>`

The library's podspec depends on another React Native library by its pod name (react-native-reanimated's
`s.dependency "RNWorklets"`), and that library is in `node_modules`, installed as a peer or as a dependency of another
package, but not in your package.json. On bare React Native the community CLI links only the packages package.json
lists (`dependencies`, `devDependencies` and `peerDependencies`), so the scaffolder would read the name as a CocoaPods
pod it cannot map. Run the `npm i` the text gives. With several, the text names them all (`npm i <a> <b>`). Expo's
autolinking links every installed package, so Expo apps do not get this refusal.

rn-xtool reads the packages at the top level of `node_modules` (and of `node_modules/@scope/`); a nested copy, which
npm installs under the library that depends on it after a version conflict
(`node_modules/<library>/node_modules/react-native-worklets`), is read as a CocoaPods pod with no SwiftPM package, and
the refusal at the top of this section names its pod (`RNWorklets`): instead of adding it under `pods`, run `npm
dedupe`, or add the package to package.json.

### Leaving a module out

List a native module in `exclude` in `rn-xtool.config.json` to leave it out of rn-xtool's iOS builds:

```json
{ "exclude": ["react-native-vision-camera"] }
```

rn-xtool sets the module's `platforms.ios` to `null` in the autolinking configuration the SwiftPM steps read, on bare
and Expo apps alike: the same as `platforms.ios: null` in `react-native.config.js`, but only for rn-xtool. Use
`exclude` when Xcode, CocoaPods or Android builds of the same project still need the module, since your
`react-native.config.js` stays as it is; use `react-native.config.js` when the app needs the module on no iOS build.
The early checks skip an excluded module, so `exclude` is also the way through a refusal above. A persisted scaffold
patch of an excluded module stays applied, and harmless, and gets no warnings.

`doctor --project` and `build` then print `ℹ exclude — left out of this iOS build: react-native-vision-camera
(rn-xtool.config.json). JavaScript that uses it must check that it is there; see <this section>` (rn-xtool.config.js
when the key comes from there). A name that is not a native iOS dependency of the project prints `⚠ exclude names
<name>, which is not a native iOS dependency of this project; ignored`.

**Expo modules** are linked by Expo's autolinking, which `exclude` does not reach:
`⚠ exclude names <name>, an Expo module: Expo's autolinking links it anyway; list it in expo.autolinking.exclude in
package.json to leave it out`. List it there instead:

```json
{ "expo": { "autolinking": { "exclude": ["expo-camera"] } } }
```

**Libraries that depend on it.** A library whose podspec depends on an excluded one gets the scaffolder's `Dependency
"<name>" is not installed (or not linked for iOS); left out …` warning, and fails to compile when it needs it. Exclude
those libraries too.

**The JavaScript is still bundled.** A module looked up when it is imported (`TurboModuleRegistry.getEnforcing`)
throws at the import, and one looked up later throws on first use: on the iPhone, a red screen. Wrap the import and
its use:

```js
let NetInfo;
try {
  NetInfo = require('@react-native-community/netinfo').default;
} catch {
  NetInfo = undefined; // left out of this iOS build
}
```

Do not render a native view whose module is left out.

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

## CocoaPods binaries

Some libraries depend on CocoaPods pods that ship prebuilt static binaries instead of sources: Google's ML Kit, behind
@react-native-ml-kit/text-recognition, is ten such pods. rn-xtool links them without CocoaPods or Ruby. It reads their
specs from the CocoaPods CDN, downloads the files the specs name, checks each one against `rn-xtool-pods.lock.json` at
the project root, and keeps them in its own cache, `~/.cache/rn-xtool/pods` (`$XDG_CACHE_HOME/rn-xtool/pods` when
`XDG_CACHE_HOME` is set). The copies a build puts in the project are git-ignored. ML Kit text recognition 2.0.0 is
the verified case: it builds, and recognizes text on a physical iPhone (2026-11-05; [libraries.md](libraries.md)).
The steps are in [how-it-works.md](how-it-works.md#cocoapods-binaries).

A pod takes this route when no pod table entry maps it and its spec downloads an archive (`.tar.gz`, `.tgz` or `.zip`)
that holds static `vendored_frameworks` (`.framework` or `.xcframework`), or only headers (GoogleMLKit's `MLKitCore`).
The git-source pods it depends on go through the pod table, as a library's do
([above](#libraries-that-depend-on-cocoapods-pods)). rn-xtool's table maps ML Kit's four: GTMSessionFetcher 3.5.0,
GoogleUtilities 8.1.5, GoogleDataTransport 10.1.1 and GoogleToolboxForMac 6.0.1. When another package needs one of
them at another exact version (a Firebase package, GoogleSignIn), `xtool-build` stops with SwiftPM's version conflict
naming both; the pod table (`pods` in `rn-xtool.config.json`) is the one place to align them.

The work happens in the `pods` step, the first step of `build` (and of `run` when it builds), before anything changes
in the project: no `expo prebuild`, no patches. A stop there leaves the project as it was. The `pod-binaries` step,
right before `rn-spm`, then writes the package the scaffolds link, `ios/build/pod-binaries`, from the cache, on every
build, so `expo prebuild --clean` wiping `ios/` costs nothing. When `ios/build/pod-binaries` or a pod's bundle in
`ios-xtool/Resources` is gone after the build (a hand-run `npx expo prebuild --clean`, `rm -rf ios/build`), `install`
(and so `run`) stages it again from the lock and the cache before xtool builds: `ℹ pods — ios/build/pod-binaries is
missing since the last build; rn-xtool stages it again from rn-xtool-pods.lock.json and its cache.` When the binary
pods changed since then, it stops: ``The CocoaPods binaries the project needs changed since the last build. Run
`rn-xtool build`, then install again.`` Build through rn-xtool: SwiftPM run by hand on a scaffold that links binary
pods stops with SwiftPM's "package manifest cannot be accessed" when `ios/build/pod-binaries` is missing.

### The first download

Before it downloads anything, the `pods` step says what, how much, from where and whose. For ML Kit:

`ℹ pods — @react-native-ml-kit/text-recognition needs 10 CocoaPods binaries that are not in rn-xtool's cache, 40.3 MB
from dl.google.com: MLKitTextRecognitionCommon 5.0.0 (30.3 MB), MLKitCommon 13.0.0 (2.5 MB), …, MLImage 1.0.0-beta7
(7 KB). From Google, Inc. ("Copyright 2024 Google LLC", "Copyright 2025 Google LLC";
https://developers.google.com/ml-kit/guides; terms: https://developers.google.com/ml-kit/terms). rn-xtool keeps them in
~/.cache/rn-xtool/pods and does not copy them into the project.`

- The vendor is each spec's `authors` (`From an unnamed vendor` when a spec names none), followed by the license texts
  of that vendor's pods and the spec's homepage. `terms:` comes from rn-xtool's `data/pod-terms.json`, which maps a
  homepage to the vendor's terms page; a homepage it does not list gets no `terms:`.
- Sizes come from each host's `Content-Length`: the total reads `at least <size>` when some files have none, and
  `size unknown` when none do.
- The files are the vendor's, under the vendor's terms: for ML Kit, the ML Kit Terms
  (https://developers.google.com/ml-kit/terms). rn-xtool downloads them on your machine, from the URL in each spec,
  for your own build, as CocoaPods does. It does not accept the terms on your behalf, and its npm package holds none of
  these files.
- Nothing of them is committed: the cache is outside the project, `ios/build/pod-binaries` has its own `.gitignore`
  (`*`), and the bundles and `.build` sit under `ios-xtool/`, which is ignored too. The lock holds versions, URLs,
  sizes and hashes, none of the files' content. Do not publish the cache either (a CI cache, a shared drive): it holds the vendor's files.
- The line comes back only for files missing from the cache (after it was deleted, or a new pod), and for a cached
  file that no longer has its recorded sha256, which is downloaded again.
- After the downloads: `ℹ pods — recorded the sha256 of 10 downloads in rn-xtool-pods.lock.json; commit it, so other
  machines check that they get the same files.`

**Disk.** Before the first download, the step checks that the cache's filesystem has about 8 times the download size
free: the downloads, their unpacked and wrapped copies in the cache, and the copies each app holds. Otherwise it stops
with `Not enough free disk space for the CocoaPods binaries: the filesystem of ~/.cache/rn-xtool/pods has <free> free,
and rn-xtool needs about <need> there (<n> downloads <size>, unpacked, wrapped and per-app copies <rest>). Free some
space, then build again.` When the project is on another filesystem than the cache, the cache's needs about 6 times
the download size (`unpacked and wrapped copies <rest>`) and the project's 2 times, for the per-app copies; the stop
then names each filesystem that is short, the project's as `the filesystem of <project> has <free> free, and rn-xtool
needs about <need> there (the per-app copies in ios/build/pod-binaries and ios-xtool/Resources)`. For ML Kit's
40.3 MB, the cache takes about 237 MB, and each app about 66 MB more (`ios/build/pod-binaries` and the model bundles
in `ios-xtool/Resources`). `App.app` grows by about 53 MB, and the
proof app's `ios-xtool/.build` took about 0.84 GB.

### The lock file

`rn-xtool-pods.lock.json` sits next to `rn-xtool.config.json`; commit it. For each binary pod it records the version,
the subspecs used, the download's URL, size and sha256, and the libraries that need it. The first build records,
later builds check: a file missing from the cache is downloaded again and must have the recorded sha256, and a cached
file is hashed again before it is used.

- **Versions stay.** The locked version is kept while it meets every requirement, so `~> 13.0.0` does not move to a
  newer MLKitCommon by itself. After a library upgrade whose requirement it no longer meets, `doctor --project` warns
  `⚠ pods — <pod>: rn-xtool-pods.lock.json records <old>, which no longer meets "<requirement>" (<library>
  <version>); rn-xtool build resolves it again and records the new version`, and `build` does so: `ℹ pods — <pod>:
  rn-xtool-pods.lock.json records <old>, which no longer meets "<requirement>" (<who>); now <new>, recorded in
  rn-xtool-pods.lock.json`.
- **A changed file:** `The file dl.google.com serves for MLImage 1.0.0-beta7 is not the one rn-xtool-pods.lock.json
  records (sha256 <new> instead of <recorded>). rn-xtool does not use it. If you trust the new file, delete the
  "MLImage" entry from rn-xtool-pods.lock.json and build again.` The vendor re-uploaded the same version, or the file
  was changed on its way. rn-xtool deletes the download and does not retry; the project and the lock stay as they
  were. Without the entry, the next build announces, downloads and records the file again.
- **The same file at a new URL:** `ℹ pods — <pod> <version> moved to <url>; same file (its sha256 matches
  rn-xtool-pods.lock.json), so the lock's URL is updated`. Another file there is a changed file, above.
- **The first download is trusted on first use**, over HTTPS: ML Kit's specs carry no checksum, so nothing checks the
  file before the lock records it. A spec that names its own `sha256` or `sha1` is checked too: `The file <host> serves
  for <pod> <version> does not match the <sha256|sha1> its spec names (<got> instead of <want>). rn-xtool does not use
  it.`
- **Plain http:** `<pod> <version> downloads over plain http from <host>; rn-xtool downloads it only when
  rn-xtool-pods.lock.json already records its sha256.` A spec URL that is not https, or an https URL that redirects to
  plain http, is refused, because nothing would protect or pin the file. When the lock records the file, it is
  downloaded and checked against that sha256.
- **Merge conflicts:** `rn-xtool-pods.lock.json has merge conflict markers; keep either side and build again: rn-xtool
  checks every file against the hashes it keeps.` Keep either side: the next build checks every file against the
  entries that remain, and records what is missing.
- **A lock rn-xtool cannot read:** `rn-xtool-pods.lock.json is not a lock rn-xtool can read (<reason>); fix it, or
  delete it to record the files again.`, where the reason is the JSON error or the key with a wrong value
  (`pods.MLImage.sha256 must be a sha256 in hex`). `doctor --project` shows it as `⚠ pods — not checked: <that text>`.
- **Entries no library needs** (a library removed, or left out with `exclude`) stay, so toggling `exclude` keeps the
  recorded hashes; rn-xtool never removes them. `doctor --project` lists them: `ℹ pods — rn-xtool-pods.lock.json also
  records <pods>, which no library needs now; rn-xtool keeps these entries`. Delete them by hand once the library is
  gone for good.

### Offline and behind a proxy

- With the lock and every file it records in the cache, the `pods` step makes no request, so a build works without
  internet (`.build` kept; see the last bullet). With no network at all, set `lanIp` in `rn-xtool.config.json`:
  `build` otherwise reads this computer's LAN address from its default route, and stops with `Could not detect LAN IP;
  set lanIp in rn-xtool.config.json`.
- A machine without the cache needs the network once: the CocoaPods CDN (`cdn.cocoapods.org`, which redirects to
  jsDelivr) for the specs, and the vendor's host for the files. Offline, the step stops before anything changes:
  `Cannot reach dl.google.com (getaddrinfo ENOTFOUND) to download MLKitCommon 13.0.0 (2.5 MB), which is not in
  rn-xtool's cache (~/.cache/rn-xtool/pods). Connect to the network and build again; once downloaded, builds use the
  cache.` The same text names `cdn.cocoapods.org` for a spec (`to read the spec of GoogleMLKit 8.0.0, which is not …`)
  or a version list (`to read the versions of GoogleMLKit, which are not …`), and adds `(and <n> more)` when other
  files are missing too.
- Specs are cached per version and never read again: CocoaPods trunk is read-only from 2026-12-02, so a version's spec
  no longer changes. A pod's version list is read again on its first resolution and when its locked version no longer
  meets a requirement, so a machine with an older cache resolves the versions a fresh machine does.
- If the CDN or jsDelivr goes away, machines with the cache and the lock keep building; a machine without them stops
  with the text above. rn-xtool mirrors nothing.
- **A file the vendor removed:** `<host> answered 404 for <pod> <version> (needed by <library>): <url>. The vendor no
  longer serves this file; a machine whose rn-xtool cache holds it keeps building.` (or 410).
- **A pod that is not on trunk** (a private spec repo, a deleted version): `<pod> <version> (needed by <library>) is
  not on the CocoaPods trunk: <url> answered 404. rn-xtool reads pods from trunk only; map the pod to a SwiftPM package
  under "pods" in rn-xtool.config.json, or leave the library out with "exclude".` (`its version list <url> does not
  name it` for a pod trunk does not know).
- **Other answers.** A reset connection or a 5xx answer is read once more (a download is retried once after any
  failure); a second failure stops with the texts here.
  `<host> answered HTTP <status> for <url> (<what>). Build again later; if it keeps failing, see <this section>`;
  `<host> answered <url> (<what>) with something other than <a CocoaPods version list|a CocoaPods spec> ("<the start of
  the answer>"). …` when a proxy's or captive portal's page comes back; `Could not download <pod> <version> from
  <host>: <reason>. Build again; the cache keeps what was complete.` A download stops after 15 minutes.
- **"Cannot reach cdn.cocoapods.org (…)" on a network that needs a proxy, while `curl` and `git` work.** rn-xtool
  downloads with Node's built-in `fetch`, which ignores `HTTPS_PROXY` and `HTTP_PROXY`, as rn-xtool's other downloads
  do. On Node 24, run the build with `NODE_USE_ENV_PROXY=1` (for example `NODE_USE_ENV_PROXY=1 rn-xtool build`) so
  `fetch` uses those variables. A machine whose cache holds every file `rn-xtool-pods.lock.json` records builds without
  any request.
- **"Cannot reach cdn.cocoapods.org (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)" (or `SELF_SIGNED_CERT_IN_CHAIN`, or the same
  for `dl.google.com`) on a network that inspects TLS with its own root certificate, while `curl` and `git` work.**
  Node's `fetch` trusts its own list of certificate authorities, not the system's. Give it the network's root
  certificate with `NODE_EXTRA_CA_CERTS=<file.pem>` (for example `NODE_EXTRA_CA_CERTS=~/company-root.pem rn-xtool
  build`). As behind a proxy, a machine whose cache holds every file the lock records builds without any request.
- The source pods' SwiftPM packages come from GitHub at `xtool-build`, as for any mapped pod: the first build, and any
  build after `ios-xtool/.build` is deleted, need the network for them, and an offline fetch fails with SwiftPM's
  resolve error naming the URL.

### Stops

Most stops name the pod, its version and the library that needs it, and end with a link to this section. Most of the
shapes below end `Leave the library out with "exclude" in rn-xtool.config.json.`:
[Leaving a module out](#leaving-a-module-out) builds the app without it.

- **A git-source pod with no SwiftPM package.** The `pods` step gives the refusal of
  [Libraries that depend on CocoaPods pods](#libraries-that-depend-on-cocoapods-pods), with the chain when a binary pod
  depends on it: `<library> <version>: its podspec depends on the CocoaPods pod <root>, and through it (<root>
  <version> → <pod> <version>) on the CocoaPods pod <pod>, which has no SwiftPM package rn-xtool knows. Add one under
  "pods" in rn-xtool.config.json: …, or leave the library out with "exclude".` Add the pod under `pods`, as that
  section shows.
- **No version fits:** `No version of <pod> satisfies every requirement: "<requirement>" (<who>), "<requirement>"
  (<who>). rn-xtool resolves CocoaPods versions without backtracking; leave one of the libraries out with "exclude" in
  rn-xtool.config.json.` Each pod gets the newest version that meets every requirement, and a prerelease
  (`1.0.0-beta7`) only when a requirement names one. There is no backtracking, so a combination CocoaPods would find by
  trying older versions stops here too.
- **A changed file, plain http:** see [The lock file](#the-lock-file).
- **No arm64 device slice:** `<pod> <version> (needed by <library>) ships no arm64 device slice (it has x86_64):
  <file>. rn-xtool builds for iPhones only. …`, and for a simulator build: `… ships an arm64 slice built for the iOS
  simulator, not for iPhones (<file>). …`.
- **Other binary shapes:** `<pod> <version> (needed by <library>) ships a dynamic framework (<path>); rn-xtool links
  static CocoaPods binaries only. …` (or `a Swift framework`). The spec's own shape is named the same way: `…
  ships vendored libraries (<path>); rn-xtool links static CocoaPods binaries only. …`, `… compiles sources
  (<path>); …`, `… is a <kind> download (<url>); …` and `… comes from a <kind> source, which rn-xtool cannot
  download; …`. rn-xtool links static frameworks and headers-only pods; dynamic frameworks, Swift binaries,
  `vendored_libraries`, compiled sources in a downloaded pod and other sources are not supported.
- **No iOS:** `<pod> <version> (needed by <library>) does not support iOS (its platforms: <platforms>), so an iPhone
  app cannot use it. …`.
- **Two of one name:** `<pod> <version> (needed by <library>) ships two frameworks named <Name>: <path> and <path>.
  rn-xtool makes one module of each name. …`; `Two CocoaPods binaries make the module <Name>: <pod> <version> and
  <pod> <version>. rn-xtool cannot link both.`; `… its source_files hold two headers named <file> (<path> and <path>),
  which rn-xtool puts in one folder.`; and, for the bundles, `Two resource bundles would be copied to
  App.app/<Key>.bundle: <owner> and <owner>.`, `The resource bundle <Key>.bundle (<owner>) would be copied over the
  app resource <file> in App.app.` and `<Key>.bundle (<owner>) would hold <file> twice: <path> and <path>.` (a
  scaffolded library's bundle that would hold one name twice is left out instead, and named in the `ℹ Not copied into
  the app` line).
- **Module maps rn-xtool cannot rewrite:** `<pod> <version> (needed by <library>): <path>/Modules/module.modulemap names
  the framework bundle (an umbrella directory ("Headers")), which rn-xtool cannot rewrite for SwiftPM.` The parenthesis
  can also read `a path relative to the framework ("…")`, `a framework submodule`, `another framework module` or `a
  module.private.modulemap`. rn-xtool moves a framework's headers to `Headers/<Name>/` and drops the `framework`
  keyword of its module map, and these maps would then name other files. Leave the library out. A framework with no
  module map and no umbrella header stops with `…: <path> has no Modules/module.modulemap and no Headers/<Name>.h, so
  rn-xtool cannot make a module for it.`
- **A spec path outside the pod:** `The spec of <pod> <version> has a "<key>" path that leaves the pod's folder
  (<path>).` (an absolute path, or one that goes up with `..`), and for an `.xcframework` slice `… ships <path>, whose
  <slice> slice names a <key> that leaves it (<value>).`
- **A file the spec names and the download lacks** (a vendored framework, a header, a module map): `<pod> <version>
  (needed by <library>): its spec names <path>, which the download does not hold. Its top-level entries: <entries>.`
- **Extraction.** rn-xtool lists every archive before it unpacks it, and refuses one with an unsafe entry: `rn-xtool
  refuses to extract <file> (<pod> <version>): its entry "<entry>" has an absolute path. Nothing was extracted.` (or
  `goes up with ..`, `is a device or special file`, `is a link that points outside the archive`). A damaged archive
  stops with `rn-xtool cannot list <file> (<pod> <version>): <reason>.` or `rn-xtool could not extract <file> (<pod>
  <version>): <reason>.`, and a `.zip` without `unzip` on the host with `<pod> <version> is a .zip download, and unzip
  is not installed. Install it (sudo apt install unzip) and build again.`
- **llvm-ar:** ``llvm-ar was not found on the Swift toolchain's PATH; rn-xtool wraps CocoaPods binaries with it. Run
  `rn-xtool setup` to install Swift 6.4 through swiftly.``, or `llvm-ar could not wrap <pod> <version>'s object
  (<path>): <error>`. The Swift toolchain `setup` installs ships it. `doctor` prints `✔ llvm-ar — LLVM <version>`, or
  the missing text as ✖ when the project's lock records binary pods (⚠ otherwise).
- **The iOS SDK:** `<pod> <version> (needed by <library>) links the framework <Name>, which the iOS SDK rn-xtool builds
  with (<SDK>) does not have.` (or `the library <name>`), before any download.
- **A file that is no Mach-O binary rn-xtool knows:** `… ships a binary rn-xtool does not recognise (<path>, which
  starts with <bytes>).`

### Warnings and information lines

- **Privacy manifests**, on every build: `ℹ pods — not copied into the app: the PrivacyInfo.xcprivacy inside
  MLKitCommon.framework and MLKitTextRecognitionCommon.framework. Development builds run without them; privacy
  manifests are read only at App Store submission.` Nothing to do for a development build.
- **A pin outside a binary pod's requirement**, on every build: `ℹ GoogleToolboxForMac 6.0.1 (rn-xtool table) is
  outside MLKitCommon's and MLKitVision's requirement ">= 4.2.1, < 5.0": 4.x ships no Package.swift; 6.0.1 keeps the
  GTMLogger API ML Kit links against`. A table entry's `outsideRequirement` marks such a pin as checked, which makes
  the ⚠ of [A pin outside the podspec's requirement](#libraries-that-depend-on-cocoapods-pods) this ℹ. An entry in
  your config that pins another `url` or `exact` drops it, so the ⚠ comes back: `⚠ GoogleToolboxForMac <version>
  (rn-xtool.config.json) is outside MLKitCommon's and MLKitVision's requirement ">= 4.2.1, < 5.0"`.
- **A newer iOS minimum:** `⚠ <pod> needs iOS <version>; the app's minimum is 16.4; it fails to load on older
  iPhones`, from the spec's platform or the binary's own minimum. rn-xtool builds every app for iOS 16.4; ML Kit needs
  15.5.
- **A scaffold persisted before rn-xtool linked the binary pods** (a library built under `knownLimits.allow` before):
  `⚠ patches/<file> does not link GoogleMLKit's CocoaPods binaries: it was scaffolded before rn-xtool resolved them;
  delete it so rn-xtool regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old
  Package.swift)`. Do what it says, as for the other stale scaffolds
  ([Build and patches](#build-and-patches)). Without a persisted patch, `build` removes the old manifest itself: `ℹ
  node_modules/<package>/Package.swift does not link GoogleMLKit's CocoaPods binaries: rn-xtool removed it so the
  rn-spm step scaffolds it again`.
- **A pod that moved to a SwiftPM package:** after you map a binary pod under `pods`, `⚠ patches/<file> links <pod>'s
  CocoaPods binaries, but the config maps <pod> to a SwiftPM package now; delete it so rn-xtool regenerates it (also
  remove …)` (`rn-xtool's table` when the table maps it).
- **The persist guard.** The `pods` and `pod-binaries` steps write nothing under `node_modules`, so a persisted scaffold never holds the
  vendor's files. As a guard, rn-xtool does not persist a scaffold patch that would hold a binary file:
  `⚠ Did not persist <library>'s scaffold: the patch would contain a binary file (<path>)`, or `⚠ Did not persist
  <library>'s scaffold: rn-xtool could not read <patch> to check it for binary files`. The build goes on. A
  persisted patch holds only the files the scaffold wrote and those the library's existing patch held, so the Android
  build outputs under the package (`android/build/…/*.dex`) stay out of it. The binary line can still appear when the library's existing patch holds a binary file, or when rn-xtool
  diffs the whole package and a build left binaries under it: an `ℹ … persisting <library>'s whole package, …` line
  before it says why (most often `ℹ Could not tell which files patches/<file> changes`, a patch whose
  `diff --git a/node_modules/<library>/…` headers it cannot read). For the first, remove the binary file's section from
  the patch; for the second, fix or delete the patch the `ℹ` line names, or remove the library's build outputs
  (`android/build`, `android/.cxx`), then build.

### knownLimits.allow and binary pods

A library in `knownLimits.allow` builds anyway when one of its pods is a git-source pod with no SwiftPM package (the
first stop above). The `pods` step leaves that pod out with `⚠ known-limits — <the refusal> (allowed by
rn-xtool.config.json knownLimits.allow; the build may fail later)`, once (not again when the early checks printed it),
and the build goes on; it may fail later, where the pod is needed. Its other pods are resolved and linked as usual.
`doctor --project` shows the same line as `⚠ pods — …`, and a refusal for a library the list does not name as
`✖ pods — <the refusal>` (unless its `known-limits` line names it already).

Once a build has read that pod's spec, it is in rn-xtool's cache: the early checks find it there and print the line,
and the `pods` step leaves the pod out before any CDN read. With the lock and a full cache, such a library then builds
offline too. A machine that never read the spec needs the CDN once; offline, the step stops with `Cannot reach
cdn.cocoapods.org (<reason>) to read the versions of <pod>, which are not in rn-xtool's cache
(~/.cache/rn-xtool/pods). …`.

### How the binaries are linked

- Each static framework becomes a headers-only `.xcframework` for compiling and a thin arm64 archive, linked once with
  `-Xlinker -force_load` on the App target (ML Kit: nine archives). Nothing links them a second time, and there is no
  `-all_load`.
- With binary pods, and only then, the App target also gets `-Xlinker -no_objc_relative_method_lists`: without it,
  xtool's `ld64.lld` crashes while it builds Objective-C method lists from MLKitTextRecognitionCommon's object.
  Builds without binary pods are unchanged.
- GoogleToolboxForMac 6.0.1's `GTMDefines` target has no sources, so Swift Build writes no object for it but lists
  one at link (`Build input file cannot be found: '…/Products/Debug-iphoneos/GTMDefines.o'`). Its table entry lists
  it in `emptyTargets`, and rn-xtool writes the object clang makes for an empty C file at
  `ios-xtool/.build/out/Products/Debug-iphoneos/GTMDefines.o` before `xtool-build`; `install` writes it again before
  xtool builds, so deleting `ios-xtool/.build` costs nothing. A file there that is not byte for byte that object is
  rewritten.
- The source pods' privacy manifests reach the app as their SwiftPM bundles (`GoogleUtilities_Logger.bundle`, …).

### Resource bundles

- **Binary pods.** Each `resource_bundles` key `<Key>` of a pod becomes `ios-xtool/Resources/<Key>.bundle`, with an
  `Info.plist` holding CocoaPods' keys (`CFBundleIdentifier` `org.cocoapods.<Key>`), and xtool copies it to
  `App.app/<Key>.bundle`, where the code looks for it. ML Kit's models are five: `LatinOCRResources`,
  `ChineseOCRResources`, `DevanagariOCRResources`, `JapaneseOCRResources` and `KoreanOCRResources`.
- **Scaffolded libraries.** The unconditional `resource_bundles` (and `ios.resource_bundles`) of each library rn-xtool
  scaffolds are built the same way, when their names and globs are plain strings: react-native-svg's
  `RNSVGFilters.bundle` (its prebuilt `*.iphoneos.metallib` filters) and react-native-device-info's
  `RNDeviceInfoPrivacyInfo.bundle`. What still does not arrive is named in the `ℹ Not copied into the app` line
  ([Scaffolded libraries](#scaffolded-libraries)).
- **Layout.** A glob ending in `/**` keeps the layout below its folder. A folder any other glob matches is copied whole
  under its name, and a matched file goes to the bundle's root under its name, inside its nearest `.lproj` folder when
  it has one (`fr.lproj/Localizable.strings`).
- Files that need Xcode's tools are left out with `ℹ Left out of <Key>.bundle (<owner>), as they need Xcode's tools
  (asset catalogs, storyboards, xibs): <files>`, and a bundle whose globs match nothing is not built: `⚠ <Key>.bundle
  (<owner>) matches no file (<globs>); it is not built`.

### Checks on the packed app

After `xtool-build`, with binary pods, rn-xtool reads the packed `App.app`: each pod's bundle is there with its
`Info.plist`, no binary target was embedded under `Frameworks/` as a dynamic framework, and every Objective-C class a
force-loaded archive defines is in the App binary. When one fails, it stops:

```text
✖ The packed app is not what the CocoaPods binaries need, so rn-xtool removed it and does not install it:
  - App.app/<Key>.bundle is missing (<pod> <version>)
  - App.app/Frameworks/<Name>.framework is there: xtool embedded a static binary as a dynamic framework
  - the App binary does not define _OBJC_CLASS_$_<Class> (<pod> <version>, force-loaded)
See <this section>
```

At most five missing classes are listed, then `- and <n> more`. rn-xtool removes `App.app` and the `.ipa` beside it,
and the build is not recorded as up to date, so `run` builds again. `install` (over USB and with `--network`, so `run`
too) has xtool build the app from `ios-xtool/.build` first and runs the same checks on it before it installs anything:
a refused app is removed and not installed.

### The cache

- `~/.cache/rn-xtool/pods` holds the specs (`specs/`), the downloads named by their sha256 (`downloads/`), and the
  trees rn-xtool unpacked (`extracted/`) and wrapped (`wrapped/`) from them. Two projects share one copy of a file.
- **It grows.** It keeps every version a build downloaded, and its trees; a tree made by an older rn-xtool (an older
  extractor or wrapper) stays there too. Deleting the folder is safe: the next build downloads what the project needs
  again and checks each file against `rn-xtool-pods.lock.json`.
- Temporary files and trees a stopped build left are removed when a later `pods` step starts, once they are 24 hours
  old. Files are synced to disk before they count as cached, and a tree whose files changed is built again.
- Two builds can share the cache. Rarely, a build that reads a tree while another build puts the same tree in place
  stops with a missing-file error; building again passes.

### Leaving it out

`"exclude": ["@react-native-ml-kit/text-recognition"]` still builds the app without the library: its pods are not
resolved, downloaded or staged, its lock entries stay (listed by `doctor --project` as entries no library needs), and
an `ios/build/pod-binaries` from an earlier build stays on disk, unused ([Leaving a module out](#leaving-a-module-out)).

## Build and patches

- **Metal shaders are skipped on Linux:** a library that ships `.metal` files (react-native-svg's `MetalCI` filters)
  would fail the build with `unable to spawn process 'metal'`, because the Metal compiler only exists on macOS. The
  scaffolder excludes them and prints `Skipped N Metal shader(s)`; the library works, but features that rely on those
  shaders are unavailable in the build, unless the library ships them prebuilt, as react-native-svg does.
- **react-native-svg's Metal filters:** react-native-svg loads its prebuilt `*.metallib` files from
  `RNSVGFilters.bundle`, declared in the podspec through `s.ios.resource_bundles`. rn-xtool builds that bundle from the
  two `*.iphoneos.metallib` files the package ships and copies it to `App.app`
  ([resource bundles](#resource-bundles)), so skipping the `.metal` sources costs nothing there. This is checked by
  building and on a physical iPhone, where a `FeComposite` xor filter rendered (2026-11-05).
- **An Expo config plugin change is missing from the app** (for example expo-image-picker's photo library text in
  Info.plist): `build` runs `expo prebuild` only when `ios/` is missing. After adding or changing a config plugin in
  `app.json`, run `rn-xtool build --clean` (or `run --clean`), which re-runs `expo prebuild --clean`.
- **`expo prebuild` fails at `▸ prebuild`** (a config plugin throws, for example): rn-xtool removes the half-written
  `ios/` the failed prebuild left, and the error ends with "The failed prebuild left ios/ half-written, so rn-xtool
  removed it; the next build runs expo prebuild again." Fix the cause (the config plugin, or the library's version)
  and build again. When `ios/` cannot be removed, the error ends with "…, and rn-xtool could not remove it (<reason>);
  delete ios/ before the next build, or run rn-xtool build --clean." instead: a build that finds `ios/` does not run
  the prebuild again, and would build the half-written one. A prebuild that fails before it writes `ios/` (an
  `app.config.js` that throws, for example) ends with its own error only.
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
- **"⚠ patches/<name> was written by an older rn-xtool scaffolder (revision <n>, now 8); delete it so rn-xtool
  regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old Package.swift)":** the
  `patches` step found a persisted scaffold patch from an older scaffolder. Revision 1 patches lack the Swift importer
  paths of mixed libraries, revision 2 patches lack those of clang-only libraries and their module map, revision 3
  patches lack fixes 20–22 and 24 (fixes 17 to 24 in [the scaffolder fixes](upstream/react-native-scaffolder.md)),
  revision 4 patches hold pod header forwarders that `@import` modules (fix 13), and revision 5 patches may lack the
  sources of a podspec that builds its globs from Ruby locals and conditions (fix 28: react-native-screens 4.24.0 got no
  `ios/` sources), and revision 6 patches may lack defines a podspec builds from its package.json (react-native-worklets
  0.8.3's `WORKLETS_VERSION`, whose `WorkletsVersion.cpp` then stops with `use of undeclared identifier
  'WORKLETS_VERSION_STRING'`), and revision 7 patches were read without React Native's podspec helpers (fix 29:
  react-native-gesture-handler 3.3.0 lacks `RNGH_USE_WORKLETS=1` beside react-native-worklets 0.8 or later, and
  react-native-webview 14.0.1 has the `-Wno-comma -Wno-shorten-64-to-32` of its old-architecture branch). Without
  those fixes, Swift code that imports a scaffolded library (the app, or expo-router importing react-native-screens)
  can fail with `'RNSReactBaseView.h' file not found` (a mixed library, such as react-native-screens 4.26) or
  `'RNSDefines.h' file not found` (a clang-only one, such as react-native-screens 4.30), and an Objective-C++ file that
  imports `<AppAuth/AppAuth.h>` stops with `use of '@import' when modules are disabled`, and an app with
  react-native-screens 4.24.0 stops at `build` with [the codegen classes
  check](#rctthirdpartycomponentsprovider-thirdpartyfabriccomponents). Do what the warning says: delete the
  patch, remove the library from `node_modules` and reinstall it, then build; rn-xtool scaffolds it again and persists
  the new patch. This release's scaffolder is revision 8, so each scaffold patch persisted before it gets the line at
  every build until it is regenerated, for example `⚠ patches/react-native-screens+4.30.0.patch was written by an
  older rn-xtool scaffolder (revision 4, now 8); delete it so rn-xtool regenerates it (also remove
  node_modules/react-native-screens and reinstall: that copy still has the old Package.swift)`. Until then the build
  goes on with the older manifest.
- **"⚠ patches/<name> was scaffolded for React Native <version>; delete it so rn-xtool regenerates it for <installed>
  (also remove node_modules/<package> and reinstall: that copy still has the old Package.swift)":** the persisted
  scaffold patch was made for another React Native version, for example after moving a project from 0.88.0 to 0.88.1.
  Do the same as for the revision warning above. Both warnings also read patches with the marker's name before the
  rename, `expo-xtool-scaffold-revision` (apps scaffolded before 0.1.0-alpha.1).
- **"ℹ node_modules/<package>/Package.swift was scaffolded with revision <n> for React Native <version>, older than
  patches/<name> (revision 8, React Native <installed>): rn-xtool replaced it with the persisted one":** a teammate
  committed a regenerated scaffold patch, and your `node_modules` still had the copy an older patch wrote
  (patch-package does not replace a file that exists). rn-xtool owns these generated files, so the `patches` step
  removes the files the current patch creates and patch-package writes them again; the line is printed once
  patch-package has done so. Nothing to do; files the older scaffold wrote and the current one does not stay in place.
  This happens only when the patch holds nothing but scaffolded new files.
- **"⚠ node_modules/<package>/Package.swift was scaffolded with revision <n> for React Native <version>, older than
  patches/<name> (revision 8, React Native <installed>), and that patch also changes the library's own files, so
  rn-xtool does not replace it: run rm -rf node_modules/<package> && npm install, then build again":** the same case,
  but the persisted patch also holds your own fix to the library. rn-xtool persists a scaffold with
  `patch-package <package>`, which writes everything that differs from the published package into one patch.
  Removing only the scaffold files would leave a patch that patch-package can apply neither forward nor backward, so
  rn-xtool changes nothing and the build goes on with the older manifest. Run the command: the reinstall gives the
  published package, and the next build applies the whole patch.
- **"ℹ node_modules/<package>/Package.swift was scaffolded by an older rn-xtool scaffolder (revision <n>, now 8)" (or
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
- **"library product 'App' should not contain executable targets (it has 'App')"** (bare React Native, from SwiftPM in
  the `xtool` step): the app target compiles a file named `main`, usually the `main.m` of a React Native template from
  before 0.77 (`AppDelegate.h`/`AppDelegate.mm` plus `main.m`). SwiftPM takes a target with a file named `main.<ext>`
  for an executable target, while xtool links the app's entry point from the App library, so rn-xtool 0.1.0-alpha.6
  and earlier stop here. Later releases copy a C-family `main` file as `AppMain.<ext>` in the same folder and print
  "ℹ <Target>/main.m is compiled as AppMain.m: SwiftPM takes a target with a file named main for an executable, and
  xtool links the app's entry point from the App library"; the app starts as before. A `main.swift` stops the build
  before the patches with "The app target compiles <Target>/main.swift: …", which gives the remedy: mark the app
  delegate class `@main`, move any other top-level code into it, and remove `main.swift` from the app target. See
  [Sources](bare-react-native.md#sources).
- **"'AppDelegate.h' file not found"** (bare React Native, compiling `ios-xtool/Sources/App/AppMain.m` or another
  source of the app target): the header sits outside the app folder's group in the Xcode project, typically next to
  the `.xcodeproj` in the project's main group with `main.m` and `AppDelegate.mm`. rn-xtool 0.1.0-alpha.6 and earlier
  copy only the headers of the Sources phase and of the app folder's group, so the header never reaches
  `Sources/App`. Later releases copy every header the project references under `ios/` (outside `Pods/`), each with a
  forward in `Sources/App/include`, so `#import "AppDelegate.h"` resolves as with Xcode's header map. A header outside
  `ios/` is still not copied: move it into `ios/` and add it to the project. See
  [Sources](bare-react-native.md#sources).
- **"'RCTAppDelegate.h' file not found"** (bare React Native, compiling the app's `AppDelegate.h` or another
  Objective-C source of the app target): the app imports a React Native header by its bare name
  (`#import <RCTAppDelegate.h>`, the spelling of the React Native 0.7x templates), which CocoaPods resolves through its
  per-pod header search paths. rn-xtool 0.1.0-alpha.6 and earlier give the App target only the `<React/…>` spelling.
  Later releases also search React Native's header directories by bare name, after the app's own paths. A sibling
  symptom is "'AppAuth/AppAuth.h' file not found" (react-native-app-auth's README has the app import it): later
  releases also search each autolinked library's `rn-spm-pod-headers`, where the scaffold writes the pod table's
  `forwardHeaders`. See
  [Mixed Swift + Objective-C/C++ app target](bare-react-native.md#mixed-swift--objective-cc-app-target).
- **"use of '`@import`' when modules are disabled"** (in `rn-spm-pod-headers/AppAuth/AppAuth.h`, compiling an
  Objective-C++ file that imports `<AppAuth/AppAuth.h>`, such as a bare app's `AppDelegate.mm`): the scaffold of
  rn-xtool 0.1.0-alpha.6 (scaffolder revision 4) wrote the pod table's `forwardHeaders` as `@import` lines.
  Objective-C++ compiles with `-fmodules -fno-cxx-modules`, Xcode's default, so `@import` is an error there;
  react-native-app-auth's own `RNAppAuth.m` is Objective-C and compiled. Later releases write the forwarder as one
  `#import` per public header of the pod, which compiles in `.m` and `.mm` files alike, and their scaffolder revision
  (5 and later) replaces an older scaffold: a copy in `node_modules` without a persisted patch is scaffolded again by
  itself, and a persisted patch gets the `⚠ patches/<name> was written by an older rn-xtool scaffolder (revision 4,
  now 8)` line
  above, whose steps regenerate it. A `forwardHeaders` entry of your config that still lists modules is refused with
  `… lists the module <name>; list the pod's public headers instead`: list the headers, as in [Libraries that depend
  on CocoaPods pods](#libraries-that-depend-on-cocoapods-pods).
- **"react/utils/hash_combine.h: … unknown type name 'Hashable'"** (bare React Native, compiling the app's
  `AppDelegate.mm` or another Objective-C++ source of the app target, often with fold-expression errors from the same
  header): `#import <RCTAppDelegate.h>` pulls in React Native's C++20 headers, and the file compiles with clang's
  default standard (gnu++17). Swift Build does not apply the package's `cxxLanguageStandard` to a mixed-language target,
  and rn-xtool 0.1.0-alpha.6 and earlier pass no `-std=` to the App target. Later releases pass the project's
  `CLANG_CXX_LANGUAGE_STANDARD` (C++20 when unset) to the app's `.mm` and `.cpp` files. See
  [Mixed Swift + Objective-C/C++ app target](bare-react-native.md#mixed-swift--objective-cc-app-target).
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

### Precheck

`build` checks the app target's own sources twice before `xtool-build` compiles them. Pass 1 runs before the `patches`
step (on Expo, once `expo prebuild` has written `ios/`), and in `doctor --project`, with file reads only: it resolves
the `#import` and `#include` lines of the app target's C-family sources, headers and bridging header (on Expo, the
bridging header alone) as the generated App target compiles them; with `--skip-precheck` it prints its misses as `⚠`
lines and does not stop. The `precheck` step, between `generate` and `xtool-build`, has SwiftPM plan the generated
package, reads the header folders and module maps of its dependency graph, resolves the includes again with the App
target's full include list (pass 2), and runs `swiftc -typecheck` over the Swift files and `clang -fsyntax-only` over
each C-family file with the generated manifest's flags. Every command line and all compiler output go to
`ios-xtool/.precheck/precheck.log`, which each precheck writes anew. clang's module cache is
`ios-xtool/.precheck/ModuleCache`, kept for one React Native version and toolchain at a time; `build --clean` (and `run
--clean`) empties it. The first precheck of a project, and the first after the cache is emptied, is slower than the next
ones while clang builds React Native's modules into the cache; the compilers run at low priority (`nice`), as many at a
time as the machine has cores. A precheck that passes does not promise that `xtool-build` does: it checks syntax and
includes with Swift Build's flags, and code generation and link errors still show in `xtool-build`.

- **"✖ ios/<Target>/AppDelegate.mm:3 imports "AppDelegate.h", which is not among the files the app target lists next
  to ios/<Target>/AppDelegate.mm, in the app target's headers or in <header search paths>"**, followed by "✖ <n>
  include(s) of the app's own sources resolve nowhere (listed above): the build would stop compiling them": pass 1
  found a quote include of one of the app's own headers (a header the app target references, or a file anywhere under
  `ios/`, case ignored, whose path ends with the spelling: for `"Shared/Utils.h"`, a `Shared/Utils.h`, not a `Utils.h`
  in another folder) in none of the places clang searches in the app target's copy, in the order the line names them:
  the files the target lists next to the including file, the app target's headers (the forwards in
  `Sources/App/include`) and `HEADER_SEARCH_PATHS`. On Expo the first place reads "among the files rn-xtool copies
  next to <bridging header>". `doctor --project` prints the same line as `✖ app-includes — …`
  and exits non-zero. The line ends with what `ios/` holds of that name:
  - `; <path> differs only in case (file names are case-sensitive on Linux)`: a Mac finds the file, Linux does not.
    Rename the file, or change the include, so both spell the name the same way.
  - `; <path> exists but the app target does not list it (add it to the target)`: rn-xtool copies only the files the
    Xcode project references. Add the header to the Xcode project; any group outside `Pods/` works
    ([Sources](bare-react-native.md#sources)).
  - `; <path> exists, but rn-xtool copies only the bridging header of an Expo app`: on Expo, the bridging header is
    the one file of `ios/` the App target compiles, so a header beside it is not there. Move what the bridging header
    needs from that header into the bridging header itself.
  - nothing: no file of that name is under `ios/` (outside `Pods/`, `build/`, `DerivedData/` and `ios-xtool/`). Restore
    the header, or fix the include.

  An absolute spelling that does not exist reads `<file>:<line> imports "<spelling>", which does not exist`. Pass 1
  stops on these only. An angle include (`#import <React/RCTBridge.h>`), a quote include of a header that is not the
  app's (the SDK's, a library's) and every miss in a project with CocoaPods binaries are left to the `precheck` step;
  `doctor --project` counts them in `ℹ app-includes — <n> includes into React Native's or the libraries' headers:
  checked at build`. When a miss is not real (Xcode, or `xtool-build`, finds the header), `rn-xtool build
  --skip-precheck` (or `run --skip-precheck`) prints each of these lines with `⚠` instead, then "⚠ <n> include(s) of
  the app's own sources resolve nowhere (listed above); checked by xtool-build (--skip-precheck)", and the build goes
  on; report it with `rn-xtool doctor --report`. `doctor --project` still prints them as `✖`.
- **"⚠ <file> sets <settings> for the app target; rn-xtool does not read xcconfig files"** (`⚠ app-target — …` in
  `doctor --project`): the Debug configuration of the app target or of the project is based on an `.xcconfig`, other
  than CocoaPods' `Pods-*.xcconfig`, that sets, itself or through its `#include` lines, one of the settings rn-xtool
  reads from the pbxproj: `HEADER_SEARCH_PATHS`, `GCC_PREPROCESSOR_DEFINITIONS`, `CLANG_CXX_LANGUAGE_STANDARD`,
  `SWIFT_OBJC_BRIDGING_HEADER`, `PRODUCT_MODULE_NAME`, `CODE_SIGN_ENTITLEMENTS` and `INFOPLIST_FILE`. The build goes on
  with the pbxproj's values only, so a header found only through the xcconfig's search paths is missing for pass 1,
  the precheck and `xtool-build` alike. Set the values the app needs in the target's build settings (in Xcode, or in
  the pbxproj).
  `⚠ <file> (the app target's base configuration) could not be read; rn-xtool does not read xcconfig files` is the
  same line for a base configuration, or a file it includes, that is missing or unreadable.
- **"The app target <name> takes its files from the synchronized folder <folder> (an Xcode 16 folder group); rn-xtool
  reads only the files a target lists. Convert the folder to a group (Xcode: Convert to Group) so the target lists its
  files"** (bare React Native): `build` stops before its first step, and `doctor --project` fails its `project` line.
  A synchronized folder gives the target every file in it without listing them in the pbxproj. Do what the line says:
  in Xcode, choose Convert to Group on the folder, which lists each file in the target, then build again.
- **"✖ precheck — <file>:<line> imports <spelling>, which is in none of the App target's <n> include folders (listed in
  ios-xtool/.precheck/precheck.log)"**: pass 2 looked for the header in the App target's include folders, the SDK,
  clang's own headers and the frameworks, and found it in none. The include is not behind a condition the precheck
  cannot evaluate, and its file is one the compile surely reads; an angle include stops only when its first path
  component names no target of the package. The log lists the folders in order. Fix the include or the header search
  path, or install the library that ships the header. The other misses are `⚠` lines, and the build goes on;
  `xtool-build` decides them:
  - `⚠ precheck — <file>:<line> imports <spelling>, which nothing compiles; checked by xtool-build if it is ever
    included`: the include is in a header of the app that no compiled file includes.
  - `⚠ precheck — <file>:<line> imports <spelling>, which only a condition the precheck cannot evaluate includes; the
    compile decides`: the file is reached only through an `#if __has_include(…)`, `#ifdef` or similar branch.
  - `⚠ precheck — <file>:<line> imports <spelling>, which rn-xtool did not find; <name> is a target of the package, so
    the compile decides`: an angle include whose first component is a target or product of the package graph
    (`<React/…>`).
  - `⚠ precheck — <file>:<line> imports <spelling>, which rn-xtool did not find; the compile decides`: clang's own
    header folder was not found, so an angle include cannot be judged.
- **"✖ precheck — <file>:<line>: <message>"**, each followed by its include stack (`In file included from
  <file>:<line>:` and clang's `While building module '<name>' imported from <file>:<line>:` lines), the first ten,
  then `… and <n> more`: a compiler error. A file of the app is named by its source in `ios/`, other files relative to
  the project root. An error in your own file is yours to fix. An error in a React Native or library header has a
  stack that starts at the app's file that included it, and its cause is usually the app's flags rather than the
  header: the C++ standard (`CLANG_CXX_LANGUAGE_STANDARD`; React Native's headers need C++20), a define in
  `GCC_PREPROCESSOR_DEFINITIONS`, or a header search path that makes another file of the same name win. Check those
  settings in the pbxproj (an `.xcconfig` that sets them prints the `⚠` line above).
- **"✖ precheck — <files>: compiler exited <code> without a diagnostic rn-xtool could read"**, followed by the
  compiler's last 20 lines: the compiler failed without an error line rn-xtool reads. Those lines, and the whole
  output in the log, say why. Exit code 137 means the system stopped the compiler, usually because memory ran out: the
  precheck runs as many compilers as the machine has cores, and the first one, with a cold module cache, needs the
  most. Close other programs and build again; the stop names `--skip-precheck` for a build without the step.
- An error in a header that several files include is printed and counted once, with the include stack of the first
  file that reported it.
- **"✖ precheck: <n> error(s) in the app's own sources before xtool-build (the first ten are above; all of them in
  ios-xtool/.precheck/precheck.log). If xtool-build compiles these files, this is a false stop: build with rn-xtool
  build --skip-precheck and report it with rn-xtool doctor --report"**: the stop after the lines above. Fix the errors
  and build again. When the errors are not real (Xcode compiles these files, or `xtool-build` does once the step is
  left out), the stop is false: `rn-xtool build --skip-precheck` builds without the step, then `rn-xtool install` and
  `rn-xtool start` run the app; `rn-xtool run --skip-precheck` does all three. Every build without the flag runs the
  precheck again; once the app is installed, `rn-xtool run` skips the build while nothing changed. Report the false
  stop with the block of `rn-xtool doctor --report` and the stop's lines ([Reporting a problem](#reporting-a-problem)).
- **"⚠ precheck skipped (--skip-precheck): errors in the app's own sources show in xtool-build"**: printed right after
  `generate` by a build with `--skip-precheck`, which still runs pass 1 (its misses as `⚠` lines). `rn-xtool doctor
  --report` then reads `precheck: skipped with --skip-precheck (last build)`; after a build that ran the step, stopped
  or not, it reads `precheck: run (last build)`, and before any build of this release reached `generate`, `precheck:
  not recorded`.
- **"ℹ precheck — <file> imports <module>, which SwiftPM builds: checked by xtool-build"**: a Swift file imports a
  module that exists only once SwiftPM builds it (a Swift library, or a library target with Swift files next to its
  Objective-C, whose clang half alone the precheck could give `swiftc`), or the bridging header `@import`s one, so
  `swiftc -typecheck` does not run and the Swift files are left to `xtool-build`. On Expo it is the usual line once Swift Build has written its module maps: the app's
  `AppDelegate.swift` imports `Expo`, or the generated `ExpoModulesProvider.swift` imports `ExpoModulesCore`. The
  C-family files are still checked. Nothing to do.
- **"ℹ precheck — <file> imports the module <M>, which SwiftPM builds; checked by xtool-build"**: a C-family file, or
  a header it includes, has `@import M;` for a module SwiftPM builds from Swift, or for one no module map of the
  package declares, so clang would not find it as `xtool-build` does. That file is not compiled (nor the Swift files,
  when it is the bridging header); the line names the first such file, and `ios-xtool/.precheck/precheck.log` lists
  them all. The other C-family files are still checked. Nothing to do.
- **"ℹ precheck — <files> import <header>, which the Swift check did not write: checked by xtool-build"**: these files
  import a `-Swift.h` header (Xcode's generated Swift header) that the Swift check did not write, because it did not
  run or the header is another module's, so they are left to `xtool-build`. Nothing to do.
- **"ℹ precheck — <n> module maps Swift Build writes are not there yet: files that need them are checked by
  xtool-build"** (or `…: <files> are checked by xtool-build`): on Expo, Swift Build writes the module maps of Expo's
  Swift importers during `xtool-build`, so the files that `@import` or import those modules are left to it. Nothing
  to do.
- **"ℹ precheck — <n> dependencies of App could not be placed (<names>): checked by xtool-build"**: the precheck could
  not match these dependencies of the App target to a package SwiftPM listed, so their headers are not in its include
  list and `xtool-build` checks what needs them.
- **"ℹ precheck — the module cache was stale (<clang's line>); checked again without it"**: clang found a module in the
  cache out of date, for example after a library changed; the precheck removed the cache and ran once more, at the
  speed of a first precheck. Nothing to do.
- **"✖ precheck — clang was not found on the Swift toolchain's PATH; run rn-xtool setup"** (or `swiftc`),
  **"✖ precheck — the iPhoneOS SDK was not found in the Darwin SDK (<path>); run rn-xtool setup --xcode-xip <path>"**
  and **"✖ precheck — the Swift resources were not found in the Darwin SDK (<path>); run rn-xtool setup --xcode-xip
  <path>"**: the toolchain or the Darwin SDK is incomplete. Do what the line says, then check with `rn-xtool doctor`.
- **"✖ precheck — SwiftPM refused the generated package (ios-xtool/Package.swift):"**, followed by SwiftPM's error
  lines, and its siblings `SwiftPM gave no plan for the generated package (ios-xtool/Package.swift)`, `SwiftPM's plan
  of the generated package (ios-xtool/Package.swift) has no App target`, `SwiftPM could not list the dependencies of
  the generated package (ios-xtool/Package.swift)` and `SwiftPM could not read the package <name> (<path>)`: SwiftPM
  cannot plan the package `xtool-build` builds. SwiftPM's lines after the first say why; `<path>` is the folder of the
  package it could not read.
- **"✖ precheck — SwiftPM plans the App target as an executable target (a file named main); xtool links the app's
  entry point from the App library"**: a file of the App target is named `main`. See
  [Sources](bare-react-native.md#sources) for how rn-xtool copies a C-family `main` file and what to do with a
  `main.swift`.
- **"✖ precheck — rn-xtool could not read the xcframework <name> (<path>): <reason>"**: a binary target of the package
  is an xcframework whose `Info.plist` is missing or cannot be parsed, so the precheck cannot find its headers.
  Rebuild or reinstall the library that ships it.
- **"…; if xtool-build builds this app, build with rn-xtool build --skip-precheck and report it with rn-xtool doctor
  --report"**: the end of every precheck stop other than the compilers' errors and a missing toolchain: the SwiftPM
  and xcframework lines above, and anything else that stops the step (a full disk, `ENOSPC`, or an error in rn-xtool
  itself). The first part says what failed; `ios-xtool/.precheck/precheck.log` ends with it on a `# stopped:` line.
  When `xtool-build` builds the app without the step, the stop is false: build with `--skip-precheck` and report it.

### Podspec reader

The `rn-spm` step reads each library's podspec with the system `ruby`, through a shim of CocoaPods' DSL and React
Native's podspec helpers, so a podspec gives the same fields it gives under CocoaPods. Without a usable Ruby, it reads
them with its reduced reader, written in JavaScript, which evaluates the subset of Ruby podspecs use for their fields.
`rn-xtool doctor` names the reader this machine uses (`✔ ruby — 3.3.8`, or `⚠ ruby — not found — podspecs are read
with the reduced reader; sudo apt install ruby`). The Ruby is the first `ruby` on `PATH`, asked once per run where it
lives; every podspec then runs with that interpreter, so a version manager (rbenv, asdf, mise) cannot switch Ruby
between podspecs.

- **"⚠ Ruby was not found, so rn-xtool read the podspecs with its reduced reader, which evaluates a subset of Ruby;
  install Ruby (sudo apt install ruby) to read them as CocoaPods does.":** `rn-spm` prints this once, after its runs,
  when the reduced reader read a podspec. The build goes on with the reduced reader. The first words say why, and
  `rn-xtool doctor` and `rn-xtool setup` give the same reason:
  - `Ruby was not found`, or `ruby <version> is older than 2.7.0`: the line ends with the install advice. Install Ruby
    2.7 or newer (`sudo apt install ruby`), check it with `rn-xtool doctor`, and build again.
  - `ruby cannot load json`: the line ends with a link to this section instead. The Ruby on `PATH` is built without
    its standard library's `json`; install the distribution's Ruby (`sudo apt install ruby`) or rebuild that Ruby
    with its default gems, then check it with `rn-xtool doctor`.
  - `ruby could not run the podspec reader (<detail>)`: the line ends with a link to this section. The `ruby` on
    `PATH` did not answer, often a version manager's shim that failed. Run `ruby --version` in the project folder:
    when it fails there, the detail says why, for example a `.ruby-version` (in the project or a folder above it)
    that selects a Ruby the version manager has not installed. Install that version, or change the `.ruby-version`,
    and run `rn-xtool doctor` in the project folder again.
  - `the podspec reader's Ruby shim is missing from <path>`: the line ends with a link to this section. Reinstall the
    package whose folder `<path>` names (rn-xtool, or an installed React Native 0.88), then build again.
- **"⚠ patches/<name> was written by the reduced podspec reader; Ruby is available here: delete it so rn-xtool
  regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old Package.swift)":** the
  `patches` step found a scaffold the reduced reader persisted, for example by a teammate without Ruby, on a machine
  where Ruby reads podspecs. It stays until you delete it, and the build goes on with it. Do what the line says, as
  for the revision warning in [Build and patches](#build-and-patches): the next build scaffolds that library with
  Ruby and persists the new patch.
- **"⚠ patches/<name> was written by the Ruby podspec reader, and this machine reads podspecs with the reduced one
  (<why>): keep the patch, and install Ruby (sudo apt install ruby) before you regenerate it":** the opposite case.
  The patch is the better reading, so keep it; a scaffold regenerated here would be the reduced reader's. With
  `RN_XTOOL_PODSPEC_READER=reduced` set, the line ends `keep the patch, and unset RN_XTOOL_PODSPEC_READER before you
  regenerate it`. When installing Ruby would not help (`ruby cannot load json`, `ruby could not run the podspec
  reader (<detail>)`, the shim missing), it ends `keep the patch; see <link to this section> before you regenerate
  it`: fix the reason as the first entry of this section says.
- **"⚠ RN_XTOOL_PODSPEC_READER=reduced is set, so rn-xtool read the podspecs with its reduced reader, which evaluates
  a subset of Ruby; unset it to read them as CocoaPods does.":** the variable is set in the environment of the build,
  so the reduced reader read every podspec, Ruby or not. Unset it (`unset RN_XTOOL_PODSPEC_READER`) once the podspec
  that needed it reads with Ruby again.
- **"⚠ RN_XTOOL_PODSPEC_READER=<value> is not a reader rn-xtool knows (only reduced); reading podspecs with Ruby":**
  the variable is set to another value (`REDUCED`, `1`, `ruby`), which picks nothing. Set it to `reduced` exactly, or
  unset it.
- **The environment a podspec sees:** rn-xtool reads every podspec with `RCT_NEW_ARCH_ENABLED` and
  `RCT_HERMES_V1_ENABLED` set, both to `1`, and your `PATH`, `HOME` and `LANG`, so that the `node` it calls is found;
  every other variable a podspec reads (`USE_FRAMEWORKS`, `USE_HERMES`, a library's own) is unset, whatever your shell
  has. The podspec runs in its own folder, with `ios/` as CocoaPods' installation root and nothing on its standard
  input. The names each podspec read are in `rn-xtool doctor --report`, under `podspec ENV:`, one `<podspec>: NAME,
  NAME` line per podspec that read any; the build does not print them. Only Ruby records them: after a run of the
  reduced reader, the report has no `podspec ENV:` block.
- **Podfile globals:** a podspec reads as with a Podfile that sets no globals (`$VCEnableLocation`,
  `$VCEnableFrameProcessors`, `$RNVideoUseVideoCaching` are undefined), so it takes its default branch:
  react-native-vision-camera compiles its location APIs in, and its frame processors only when
  react-native-worklets-core is installed.
- **A podspec that reads your project:** some podspecs compute their settings from the project when they run:
  react-native-reanimated reads its static feature flags from the app's `package.json`, and
  react-native-vision-camera checks whether react-native-worklets-core is installed. A persisted scaffold keeps what
  its podspec read the day it was written, and a later build does not read it again. After you change a library's
  feature flags or install an optional sibling, delete the library's patch and re-scaffold it as in [Scaffolded
  libraries](#scaffolded-libraries).
- **"! <library>: The podspec sets script_phases, which a CocoaPods build applies and rn-xtool's scaffold does
  not."** (also `prepare_command`, `info_plist` and `module_map`): the spec, a subspec the scaffold uses, or their
  `ios` attributes set a key that changes a CocoaPods build and that the scaffolded `Package.swift` does not carry.
  The build goes on without it. If the library needs what that key does (a build script, a generated file, its own
  module map), add it to the library's `Package.swift` and persist it in `patches/`.
- **"✖ Scaffolding <library> failed: <podspec>: uses spm_dependency(url: <url>, products: <a, b>), which rn-xtool
  does not map yet":** with Ruby, the podspec asks React Native's `spm_dependency` helper for a SwiftPM package, and
  the scaffold does not add that package, so the target would not link. Give the library a `Package.swift` of its
  own, persisted in `patches/`, and [report it](#reporting-a-problem).
- **"<podspec>:<line>: the podspec calls <name>(…), which rn-xtool's podspec reader does not model. Set
  RN_XTOOL_PODSPEC_READER=reduced to read it with the reduced reader for one run, and report it with rn-xtool doctor
  --report.":** the podspec calls a method of CocoaPods or React Native the shim does not provide, and `rn-spm` stops
  there. The same stop, with the same last sentence, has these other forms:
  - `<podspec>:<line>: the podspec uses <Name>, which rn-xtool's podspec reader does not model` (a constant);
  - `<podspec>:<line>: the podspec sets <spec>.<name>, which CocoaPods does not define` (an attribute CocoaPods does
    not have, often a typo);
  - `<podspec>: cannot load such file -- <name>; rn-xtool's podspec reader stubs only colored2` (a `require` of a gem);
  - `<podspec>: the podspec does not evaluate to a Pod::Spec`;
  - `<podspec> did not finish in 120 s.`;
  - `<podspec>: ruby exited with <code or signal>: <its last error line>` or `<podspec>: ruby could not run (<error>)`
    (Ruby ended without a result: out of memory, killed, or the interpreter the probe found is gone);
  - `<podspec>: rn-xtool could not run the podspec reader: <error>` (rn-xtool itself could not run the read, for
    example no writable temp folder: check `TMPDIR` and the disk space);
  - `<podspec>:<line>: key not found: "<NAME>"` (the podspec reads an environment variable with `ENV.fetch`, and
    rn-xtool gives podspecs only `PATH`, `HOME`, `LANG`, `RCT_NEW_ARCH_ENABLED` and `RCT_HERMES_V1_ENABLED`).

  When the failing line is in another of the library's files, `<podspec>:<line>` reads `<podspec> (<file>:<line>)`;
  when Ruby keeps no line, it is `<podspec>` alone. A podspec that raises another error of its own (`raise`, `abort`)
  stops with its message after `<podspec>:<line>: ` (or `<podspec>: `), without the last sentence.
  To build for one run, set the escape on the command: `RN_XTOOL_PODSPEC_READER=reduced rn-xtool build`. `rn-spm` then
  prints the `⚠ RN_XTOOL_PODSPEC_READER=reduced is set` line, and `doctor --report` records the reduced reader.
- **To report a podspec the reader cannot read:** run `rn-xtool doctor --report` in the project folder after the
  failed build and paste its block into a GitHub issue, with the stop's text and the library's name and version. Its
  `podspec reader:` line names the reader of the last `rn-spm` and how many podspecs it read (`podspec reader: reduced:
  RN_XTOOL_PODSPEC_READER=reduced is set (last rn-spm, 12 podspecs)`). When a podspec read environment variables,
  `podspec ENV:` follows with the names each one read; a run of the reduced reader records none, so the block is
  not there.

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
- **Resource bundles.** rn-xtool builds each unconditional `resource_bundles` (and `ios.resource_bundles`) entry of a
  scaffolded library whose name and globs are plain strings, as `<name>.bundle` at the root of `App.app`, where the
  code looks for it: react-native-svg's `RNSVGFilters.bundle` and react-native-device-info's
  `RNDeviceInfoPrivacyInfo.bundle`, for example ([details](#resource-bundles)). The scaffolded `Package.swift` itself
  holds no resources.
- **"ℹ Not copied into the app: <library> (<resources>), …. Code that loads them at run time does not find them.":**
  `build` prints it once, right after `rn-spm`, for what of the scaffolded libraries' resources still does not reach
  the app: a plain resource (`resources`), named by its file name, and a bundle (`<name>.bundle`) whose name or files
  are Ruby code rather than plain strings, or that would hold one file name twice. Values under a Ruby condition, and
  those for other platforms than iOS, are not read. A feature that loads one of these resources at run time is
  unavailable. When every resource named is a privacy manifest, the line ends "Development builds run without them;
  privacy manifests are read only at App Store submission." instead; there is nothing to do for a development build.

### `RCTThirdPartyComponentsProvider thirdPartyFabricComponents`

An app that crashes at start with `NSInvalidArgumentException` in `+[RCTThirdPartyComponentsProvider
thirdPartyFabricComponents]` (`-[__NSPlaceholderDictionary initWithObjects:forKeys:count:]: attempt to insert nil
object`) lacks the class of a third-party Fabric component. React Native's codegen writes a dictionary of
`NSClassFromString(@"<Class>")` for every component the autolinked libraries declare, and one class missing from the
app is a nil value that stops it. The build itself succeeded: the library's target compiled without the files that
define its classes.

`build` checks for it after `xtool-build`, and `install` (with `run`) checks the app xtool builds again before it
installs it: every class named in `ios/build/generated/ios/ReactCodegen/RCTThirdPartyComponentsProvider.mm` and
`RCTModuleProviders.mm` must be defined in the App binary or in a framework under `App.app/Frameworks`. When one is
not, rn-xtool removes the packed app and its `.ipa`, installs nothing and stops:

```
React Native's codegen names classes the packed app does not define, so rn-xtool removed it and does not install it:
  - RNSFullWindowOverlay (component RNSFullWindowOverlay, react-native-screens)
  - RNSModalScreen (component RNSModalScreen, react-native-screens)
  …
  - and 12 more
With a component class missing, the app would crash at start: +[RCTThirdPartyComponentsProvider thirdPartyFabricComponents] throws NSInvalidArgumentException (-[__NSPlaceholderDictionary initWithObjects:forKeys:count:]: attempt to insert nil object).
Check the sources of node_modules/react-native-screens/Package.swift: its target was built without the files that define them. A scaffold persisted in patches/ by an older rn-xtool can be the cause: delete that patch, reinstall the library and build again.
```

Each line names the class, the component (or module) and the library that declares it, from the provider file or the
library's `codegenConfig`, else "a library". A missing module provider class does not crash the app: the message says
`With a module class missing, React Native logs "Module provider <class> cannot be found in the runtime" and the
module is unavailable.`

- **react-native-screens 4.24.0 scaffolded by an older rn-xtool:** its podspec builds `source_files` from Ruby locals
  and conditions, which the podspec reader did not evaluate before scaffolder revision 6, so the scaffolded `RNScreens`
  target held only the C++ of its `common` subspec ([fix 28](upstream/react-native-scaffolder.md)). The revision
  warning above names its persisted patch; re-scaffold it as in [Scaffolded libraries](#scaffolded-libraries).
- **A podspec the reduced reader cannot evaluate** stops the scaffold instead of building such a target: ``✖
  Scaffolding <library> failed: <podspec>: `s.source_files = <expression>` cannot be evaluated: it uses <what>. …``.
  The reduced reader, used without Ruby or with `RN_XTOOL_PODSPEC_READER=reduced` ([Podspec reader](#podspec-reader)),
  evaluates locals, string interpolation, arrays, `ENV['…']`, comparisons, ternaries and `if`/`unless` blocks
  ([how it works](how-it-works.md#cocoapods-only-libraries)); a method call or a value it does not know in a source
  glob, `compiler_flags`, `header_dir`, `header_mappings_dir`, `frameworks` or `libraries` is refused. Install Ruby
  (`sudo apt install ruby`) so the podspec is read with Ruby instead, or give the library a `Package.swift` of its
  own.
- **"! <library>: Left out of s.pod_target_xcconfig OTHER_CFLAGS: `#{feature_flags}`, which the podspec reader cannot
  evaluate; CocoaPods passes its value."** (also `GCC_PREPROCESSOR_DEFINITIONS`, `HEADER_SEARCH_PATHS`,
  `SWIFT_ACTIVE_COMPILATION_CONDITIONS`): the reduced reader read the podspec, and the scaffold left that part of the
  value out, so the library compiles as if it were empty. CocoaPods computes it from the app or the Podfile, so with
  the reduced reader these libraries differ from a CocoaPods build:
  - react-native-worklets and react-native-reanimated: every static feature flag reads as off, also the ones their
    `src/featureFlags/staticFlags.json` turns on, such as worklets 0.8's `IOS_DYNAMIC_FRAMERATE_ENABLED` (the
    worklets display link asks for 120 fps throughout, instead of lowering its frame rate on a ProMotion iPhone when
    frames take longer) and reanimated 4.3's `USE_SYNCHRONIZABLE_FOR_MUTABLES`,
    `USE_COMMIT_HOOK_ONLY_FOR_REACT_COMMITS` and `FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS`. A `staticFeatureFlags`
    block in the app's `package.json` is not read.
  - react-native-vision-camera: frame processors and location tagging are compiled out
    (`VISION_CAMERA_ENABLE_FRAME_PROCESSORS` and `VISION_CAMERA_ENABLE_LOCATION` are not set). CocoaPods turns location
    tagging on by default, and frame processors when react-native-worklets-core is installed.

  With Ruby the podspec computes these values itself, as under CocoaPods, and the line does not appear. With the
  reduced reader, to set such a value, edit the library's `Package.swift` and persist it in `patches/`.
- **A hand-edited `Package.swift`** that leaves out the files defining a class: put them back.
- **"ℹ The packed app's binaries list no Objective-C class symbols, so rn-xtool could not check the <n> classes React
  Native's codegen providers name.":** the binaries have no symbol table, so nothing is checked and the build goes on.
  xtool's debug builds keep their symbols; if you see this line, [report it](#reporting-a-problem).

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
  packages that use it, or `no tracked podspec features in the dependencies`. `resource_bundles` names only the
  packages with a bundle rn-xtool does not build: one under a Ruby condition, or whose name or files are Ruby code
  rather than plain strings.
- **exclude** (only with `exclude` in `rn-xtool.config.json`): an ℹ line naming the modules left out of the build, and
  a ⚠ line for each name it ignores ([Leaving a module out](#leaving-a-module-out)).
- **pods** (only when a library depends on CocoaPods binaries, the lock records some, or a pin misses a requirement):
  - `✔ pods — 10 CocoaPods binaries for @react-native-ml-kit/text-recognition, in rn-xtool's cache and in
    rn-xtool-pods.lock.json`: the build needs no download.
  - `ℹ pods — 10 CocoaPods binaries for @react-native-ml-kit/text-recognition, 10 to download from dl.google.com
    (40.3 MB)`: what the first build downloads ([CocoaPods binaries](#cocoapods-binaries)). Pods the lock does not
    record are probed online (the CDN's specs, HEAD requests for the sizes, nothing downloaded) within the same 10 s
    budget as `rn-artifacts`; `size unknown` when a host sends no size.
  - `ℹ pods — not checked (offline)` under `--report`, which makes no request, and `⚠ pods — not checked: <reason>`
    when the CDN cannot be reached (`Cannot reach cdn.cocoapods.org (…) to read the versions of GoogleMLKit`), the lock
    cannot be read, or the probe takes more than 10 s (`timed out after 10 s`).
  - `⚠ pods — <pod>: rn-xtool-pods.lock.json records <old>, which no longer meets "<requirement>" (<library>
    <version>); rn-xtool build resolves it again and records the new version`.
  - `✖ pods — <the stop>`: what would stop the `pods` step, such as a git-source pod with no SwiftPM package, or a
    version conflict; `⚠ pods — <the refusal> (allowed by rn-xtool.config.json knownLimits.allow; the build may fail
    later)` for a library `knownLimits.allow` names.
  - `ℹ pods — rn-xtool-pods.lock.json also records <pods>, which no library needs now; rn-xtool keeps these entries`,
    and `✖ pods — <pod> <version> is a .zip download, and unzip is not installed. …`.
  - One ⚠ line per pod whose version in the pod table is outside the requirement of a library's podspec, the `build`
    line without its `⚠`: `AppAuth 3.0.0 (rn-xtool table) is outside react-native-app-auth's requirement ">= 4.0"`.
    The build goes on with the pinned version.
- **patches** (only when a patch's package is not installed, or a scaffold patch's pod pins are stale): one ⚠ line per
  such patch in `patches/`, the `build` line without its `⚠`: `patches/<file> is for <package>, which is not
  installed; skipped. Delete it if you removed the library.` ([details](#build-and-patches)), and one per pod a
  persisted scaffold pins at another version than the pod table (`patches/<file> pins AppAuth 3.0.0, the config says
  3.1.0; delete it so rn-xtool regenerates it …`) or does not pin although the library's podspec maps it.
- **app-includes**: pass 1 of the [precheck](#precheck) over the app target's own sources, as `build` runs it before
  the `patches` step: `✖ app-includes — <file>:<line> imports "<spelling>", which is not …` for each include of one
  of the app's own headers that resolves nowhere (the line `build` stops on),
  `ℹ app-includes — <n> includes into React Native's or the libraries' headers: checked at build` for the includes
  left to the `precheck` step, and `✔ app-includes — <n> includes of the app's own sources resolve` when there is no
  ✖ line and an include was checked. On Expo it reads the bridging header alone, and prints nothing before
  `expo prebuild` wrote `ios/`. A ✖ line also carries an error of the check itself, such as an Expo bridging header
  that is missing.
- **app-target**: one ⚠ line per `.xcconfig` that sets a setting rn-xtool reads from the pbxproj, the `build` line
  without its `⚠`, for example `⚠ app-target — ios/Config/App.xcconfig sets HEADER_SEARCH_PATHS for the app target;
  rn-xtool does not read xcconfig files` ([details](#precheck)).
- **known-limits**: the setups rn-xtool refuses before a build ([Unsupported setups](#unsupported-setups)). With none,
  it reads `none of the setups rn-xtool refuses early (CocoaPods-only libraries with prebuilt binaries, vendored C
  sources or CocoaPods pods without a SwiftPM package, pnpm, Yarn PnP, hoisted packages)`. Otherwise there is one ✖ line
  per refusal, with its reason and a link to its section, followed by `To build anyway, add "<name>" to
  knownLimits.allow in rn-xtool.config.json.` on the next line, and `doctor --project` exits non-zero. A refusal that
  `knownLimits.allow` lets through is a ⚠ warning instead, ending with `(allowed by rn-xtool.config.json
  knownLimits.allow; the build may fail later)`.
- **entitlements** (only when `CODE_SIGN_ENTITLEMENTS` names a file with keys): one ⚠ line per key xtool drops or does
  not enable, the `build` line without its `⚠` ([Entitlements](#entitlements)); `<file>: passed to xtool; every key is
  one xtool signs on a free team` when there is none; ✖ when the file is missing or not a property list dictionary, or
  the setting cannot be resolved. On an Expo app without `ios/` it reads `read after expo prebuild, at build`.

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

## Entitlements

rn-xtool reads the file `CODE_SIGN_ENTITLEMENTS` names in the app target's Debug configuration. On Expo it reads the
Xcode project `expo prebuild` writes, so the keys config plugins and `ios.entitlements` add are included. rn-xtool
builds Debug only, so a different Release file is not read. `$(PRODUCT_BUNDLE_IDENTIFIER)`, `$(CFBundleIdentifier)`
(both the bundle id) and the project's other settings in the values are resolved; `$(AppIdentifierPrefix)` and
`$(TeamIdentifierPrefix)` are kept, for xtool to fill in. When the file has keys, rn-xtool writes them to
`ios-xtool/App.entitlements`, names it as `entitlementsPath` in `xtool.yml`, and xtool signs the app with them
("Applying entitlements..." in the build log). An app built with an entitlements file installs and launches on the
iPhone as any other (checked on 2026-11-05). The file every Expo prebuild writes holds no keys, so it is not passed,
and `doctor --project` prints no `entitlements` line for it, as for a project without the setting.

**What xtool keeps.** xtool registers the app and signs it on your team, and it keeps only the entitlements it knows,
on a free team only those of free capabilities. Before compiling, `build` prints one line per key it drops or does not
enable, in the file's order (`doctor --project` prints the same lines on its `entitlements` line, without the `⚠`):

- a key xtool knows and marks paid: `⚠ aps-environment is not available on a free team; the build continues without
  it; push notifications fail at runtime.`
- App Groups, which xtool 1.24.0 marks paid although Apple gives them to free teams: `⚠
  com.apple.security.application-groups is not available on a free team; the build continues without it; sharing data
  with other apps and extensions through the group fails at runtime.`
- a key xtool does not know, which Apple does not give free teams: `⚠ com.apple.developer.networking.wifi-info is not
  available on a free team, and xtool does not enable it on a paid one; the build continues without it; reading the
  Wi-Fi network name returns nothing at runtime.`
- a key Apple gives free teams that xtool does not know, or a key rn-xtool's table does not list: `⚠
  com.apple.developer.default-data-protection is not enabled by xtool; the build continues without it; files keep the
  default protection.` (`the feature that needs it does not work at runtime` for a key without its own phrase)
- `keychain-access-groups` with a group other than the app's own (`$(AppIdentifierPrefix)` or
  `$(TeamIdentifierPrefix)` followed by the bundle id): `⚠ keychain-access-groups lists other groups; xtool
  signs the app with its own group only (<Team ID>.XTL-<Team ID>.com.example.app); the build continues; sharing
  keychain items with other apps fails at runtime.`

The lines say what happens on a free team: rn-xtool does not know your team when it builds. On a paid team xtool keeps
the paid keys it knows. A key it does not know stays in the signature there, but xtool enables no capability for it on
the App ID ([xtool issue #352](https://github.com/xtool-org/xtool/issues/352)), so the feature may still not work, or
the iPhone may refuse the install.

**The keychain group.** xtool installs the app as `XTL-<Team ID>.<bundle id>` and rewrites the keychain group to
`<Team ID>.XTL-<Team ID>.<bundle id>`, the only group in the signature. A library that takes a keychain access group
(react-native-keychain's `accessGroup`) must get that group, for example `TEAMID0000.XTL-TEAMID0000.com.example.app`,
or leave the option out to use the app's default group.

**Refusals.** `build` stops before the patches and SwiftPM steps, and `doctor --project` fails its `entitlements`
line, when xtool cannot sign with the file:

- `CODE_SIGN_ENTITLEMENTS names <file>, which does not exist; xtool cannot sign the app without it. Fix the setting or
  create the file.`
- `<file> (CODE_SIGN_ENTITLEMENTS) is not a property list dictionary; xtool cannot sign the app with it.`
- `CODE_SIGN_ENTITLEMENTS in ios/<project>.xcodeproj could not be read: <reason>`, when the setting names a build
  setting rn-xtool cannot resolve.

On an Expo app without `ios/`, `doctor --project` reads `entitlements — read after expo prebuild, at build`. When the
prebuild's `ios/` holds two Xcode projects, or a project with two application targets, `build` reads neither
entitlements nor bridging header from it and says so: `⚠ ios/ holds more than one .xcodeproj (<projects>); rn-xtool
reads no bridging header or entitlements from it`, or `⚠ ios/<project>.xcodeproj has more than one application target
(<targets>); rn-xtool reads no bridging header or entitlements from it`.

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
