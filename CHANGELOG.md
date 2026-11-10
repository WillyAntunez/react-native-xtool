# Changelog

All notable changes to react-native-xtool. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) with `alpha` prereleases.

## [Unreleased]

### Changed
- `build` stops seconds after it starts, before the `patches` step (on Expo, once `expo prebuild` has written `ios/`),
  when a file of the app target has a quote include of one of the app's own headers that resolves nowhere, instead of
  minutes later in `xtool-build`: one `✖` line per include, naming the file and line, the places the app target's copy
  searched ("which is not among the files the app target lists next to <file>, in the app target's headers or in <search
  paths>") and, when `ios/` holds one, a file of that name that differs only in case ("file names are case-sensitive on
  Linux"), that the target does not list, or, on Expo, that is not copied ("exists, but rn-xtool copies only the
  bridging header of an Expo app"), then "<n> include(s) of the app's own sources resolve nowhere (listed above): the
  build would stop compiling them; if xtool-build builds them, build with rn-xtool build --skip-precheck and report it
  with rn-xtool doctor --report". With `--skip-precheck` each line is a `⚠` line instead, followed by "⚠ <n>
  include(s) of the app's own sources resolve nowhere (listed above); checked by xtool-build (--skip-precheck)", and the
  build goes on. In a project with CocoaPods binaries it never stops: every miss is left to the `precheck` step. A
  quote include with a folder (`"SomeLib/Utils.h"`) counts as the app's own only when a header of the app target, or a
  file under `ios/`, has that path, and an include under a condition on a macro the App compile does not define
  (`RCT_NEW_ARCH_ENABLED`) is left to the compile. On Expo it reads the bridging header. See
  [troubleshooting.md](docs/troubleshooting.md#precheck).
- A bare React Native app target that takes its files from an Xcode 16 synchronized folder is refused by `build`
  and `doctor --project`: "The app target <name> takes its files from the synchronized folder <folder> (an Xcode 16
  folder group); rn-xtool reads only the files a target lists. Convert the folder to a group (Xcode: Convert to
  Group) so the target lists its files".

### Added
- The `precheck` build step, between `generate` and `xtool-build`: SwiftPM plans the generated package, the app's
  includes are resolved again with the App target's full include list, `swiftc -typecheck` checks the Swift files and
  `clang -fsyntax-only` each C-family file with the generated manifest's flags. When a Swift file imports a module
  SwiftPM builds from Swift (a Swift library, or one with Swift files next to its Objective-C), the Swift files are left
  to `xtool-build`, and a C-family file that `@import`s such a module, or one no module map of the package graph
  declares (an SDK module such as CommonCrypto is left to xtool-build too), is left to it too ("ℹ precheck — <file>
  imports the module <M>, which SwiftPM builds; checked by xtool-build", or "…, which no module map of the package
  graph declares; …"); on Expo the app's Swift files import such a module (`Expo`, or `ExpoModulesCore` in the
  generated `ExpoModulesProvider.swift`), so they are always checked there. Errors stop the build before `xtool-build`, with one line per include that resolves nowhere and
  the compilers' first ten errors with their include stacks (an error several files report counts once), and the stop
  names `rn-xtool build --skip-precheck` for a false one; so does every other stop of the step (SwiftPM's refusals, an
  unreadable xcframework, a full disk) except a missing toolchain, which names `rn-xtool setup`. A precheck that passes
  does not promise that `xtool-build` does: code generation and link errors still show there. Every command and its
  output go to `ios-xtool/.precheck/precheck.log`; after a write to it fails (a full disk), the log may miss the lines
  that follow, while the terminal and the stop lose none. The first precheck is slower while clang builds React Native's
  modules into the module cache, which `--clean` empties. See
  [how-it-works.md](docs/how-it-works.md#the-build-step-by-step).
- `--skip-precheck` on `build` and `run` leaves the `precheck` step out, with "⚠ precheck skipped (--skip-precheck):
  errors in the app's own sources show in xtool-build"; the check of the app's own includes at the start of `build`
  still runs, and prints its misses as `⚠` lines without stopping.
- `rn-xtool doctor --project` checks the app's own includes as `build` does, without a toolchain: `app-includes` lines
  (`✖` per include that resolves nowhere, `ℹ` for those left to the `precheck` step, `✔` when they resolve).
- A `⚠` line, at `build` and as `app-target` in `doctor --project`, for an `.xcconfig` other than CocoaPods' that the
  Debug configuration of the app target or of the project is based on and that sets a setting rn-xtool reads from the
  pbxproj: "⚠ <file> sets <settings> for the app target; rn-xtool does not read xcconfig files".
- `rn-xtool doctor --report` has a `precheck:` line: `precheck: run (last build)`, `precheck: skipped with
  --skip-precheck (last build)` or `precheck: not recorded`.

## [0.1.0-alpha.8] - 2026-11-09

### Upgrading from 0.1.0-alpha.7
- Install Ruby 2.7 or newer (`sudo apt install ruby`) before your first build with this release, so rn-xtool reads
  podspecs as CocoaPods does; `rn-xtool doctor` shows the reader this machine uses. Without Ruby, `rn-spm` reads them
  with the reduced reader and says so in a `⚠` line.
- On React Native 0.88 (bare, and Expo SDK 58), the first build after the upgrade stops at `patches` with "rn-xtool
  could not apply its patch to react-native@0.88.1 (patch file: react-native+0.88.1.patch): node_modules/react-native
  is the version the patch is for, but its files match neither the original package nor the patched one.": this
  release changes the bundled react-native patch (a new file, `scripts/spm/read-podspec-shim.rb`, and a rewritten
  `scripts/spm/read-podspec.js`), and `node_modules/react-native` still holds 0.1.0-alpha.7's. Run
  `rm -rf node_modules/react-native && npm install`, then build again.
- The scaffolder is now revision 8, so every scaffold patch rn-xtool persisted in your `patches/` before this release
  gets a warning at each `build`: "⚠ patches/<name> was written by an older rn-xtool scaffolder (revision 7, now 8);
  delete it so rn-xtool regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old
  Package.swift)". With Ruby installed, delete each such patch, remove the library from `node_modules` and reinstall
  it, then build: rn-xtool scaffolds it again and persists the new patch.

### Changed
- The scaffolder reads every podspec with the system `ruby` (2.7 or later) through a shim of CocoaPods' DSL and React
  Native's podspec helpers, the way CocoaPods runs it on a Mac: `install_modules_dependencies`, `defined?` and
  `respond_to?` answer as under React Native's Podfile, and a library's own Ruby and `node` scripts run. So
  react-native-gesture-handler 3.3.0 gets `RNGH_USE_WORKLETS=1` beside react-native-worklets 0.8 or later, and
  react-native-webview 14.0.1 takes its `install_modules_dependencies` branch. Every podspec runs for at most 120 s,
  with the interpreter of the first `ruby` on `PATH`, by its absolute path, so a version manager's `ruby` shim cannot
  pick another one per folder. Without a usable Ruby, the reduced reader of earlier releases reads them, and `rn-spm`
  prints one `⚠` line saying why. See [how-it-works.md](docs/how-it-works.md#cocoapods-only-libraries).
- `pod ipc spec` is no longer run, so a machine with CocoaPods reads a podspec exactly as any machine with Ruby, instead
  of with React Native's helpers stripped (react-native-webview, `@react-native-async-storage/async-storage`,
  react-native-keychain and react-native-video took their old-architecture branch there).
- A podspec's `ios` attributes (`s.ios.exclude_files`, `ss.ios.dependency`, …) are merged over the spec and each
  subspec the scaffold uses, as CocoaPods merges them for an iOS target; `osx`, `tvos`, `visionos` and `watchos` ones
  are never read.
- A podspec Ruby cannot read, or one that does not finish in 120 s, stops `rn-spm` with the podspec (and its line,
  when Ruby keeps one) and the reason, also when autolinking reads it for header search paths, on React Native 0.88
  and in the copy used for 0.85–0.87 and Expo SDK 57, instead of leaving that library without them. A gap of the
  reader, a timeout, a Ruby that ends without a result and a `key not found` from `ENV.fetch` end with "Set
  RN_XTOOL_PODSPEC_READER=reduced to read it with the reduced reader for one run, and report it with rn-xtool doctor
  --report." See [troubleshooting.md](docs/troubleshooting.md#podspec-reader).
- A podspec that calls React Native's `spm_dependency` is refused by name, "<podspec>: uses spm_dependency(url: <url>,
  products: <a, b>), which rn-xtool does not map yet", instead of scaffolding a target that would not link.
- A podspec that sets `script_phases`, `prepare_command`, `info_plist` or `module_map` gets a line at `rn-spm`,
  "! <library>: The podspec sets <key>, which a CocoaPods build applies and rn-xtool's scaffold does not.", instead
  of leaving it out silently.

### Added
- `rn-xtool doctor` (also with `--project`) and `rn-xtool setup` report Ruby: `✔ ruby — 3.3.8`, or `⚠ ruby — not
  found — podspecs are read with the reduced reader; sudo apt install ruby`. The install command is named when Ruby is
  missing or older than 2.7; for another reason (no `json`, a Ruby that cannot run the reader) the line names it and
  links the troubleshooting page. `setup` never installs Ruby.
- `RN_XTOOL_PODSPEC_READER=reduced` reads every podspec with the reduced reader for one run, the escape when Ruby
  cannot read one; `rn-spm` says so in a `⚠` line. Another value is named in a warning and ignored.
- Each scaffolded `Package.swift` names its podspec reader on its marker (`// rn-xtool-podspec-reader: ruby` or
  `reduced`), and the `patches` step warns about a persisted scaffold patch the other reader wrote: delete one the
  reduced reader wrote where Ruby is available, keep one Ruby wrote on a machine that reads with the reduced reader.
- `rn-xtool doctor --report` has `ruby:`, `podspec reader:` (the reader of the last `rn-spm` and how many podspecs it
  read) and `podspec ENV:` (the environment variables each podspec read) lines, from
  `ios/build/rn-xtool-podspec-reads.jsonl`, which `rn-spm` writes.
- CI runs the podspec reader sweep, which reads the podspecs of a pinned set of libraries with both readers and
  compares them with recorded goldens, the shim's tests on Ruby 2.7, and a check that no Markdown file holds a bare
  `@` mention, which would notify a GitHub user.

## [0.1.0-alpha.7] - 2026-11-06

### Upgrading from 0.1.0-alpha.6
- The scaffolder is now revision 7, so every scaffold patch rn-xtool persisted in your `patches/` before this release
  gets a warning at each `build`: "⚠ patches/<name> was written by an older rn-xtool scaffolder (revision 4, now 7);
  delete it so rn-xtool regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old
  Package.swift)". Do what it says. A scaffolded library without a persisted patch is scaffolded again by itself.
- A `pods.<pod>.forwardHeaders` entry in `rn-xtool.config.json` that lists modules is refused: list the pod's public
  headers instead (see Changed).

### Changed
- `pods.<pod>.forwardHeaders` maps a forwarded header to the pod's public headers to include, as paths under the
  public header directories of its SwiftPM targets (`["OIDAuthState.h", "iOS/OIDAuthState+IOS.h", …]`), instead of
  module names; a module name is refused with a message saying to list the headers. rn-xtool's AppAuth entry lists
  the headers of AppAuth-iOS 3.0.0's umbrella header.
- A part of a scaffolded library's xcconfig value that only CocoaPods computes (in `OTHER_CFLAGS`,
  `GCC_PREPROCESSOR_DEFINITIONS`, `HEADER_SEARCH_PATHS` or `SWIFT_ACTIVE_COMPILATION_CONDITIONS`) is still left out,
  and `build` now names it in a `! <library>: Left out of …` line instead of dropping it silently:
  react-native-worklets' and react-native-reanimated's static feature flags (all off, worklets'
  `IOS_DYNAMIC_FRAMERATE_ENABLED` included) and react-native-vision-camera's frame processor and location switches
  (off). See [troubleshooting.md](docs/troubleshooting.md#rctthirdpartycomponentsprovider-thirdpartyfabriccomponents).

### Fixed
- A bare app target with an Objective-C `main.m` (the React Native templates before 0.77) builds, instead of stopping
  in SwiftPM with "library product 'App' should not contain executable targets (it has 'App')": the file is compiled
  as `AppMain.m` in its folder (any C-family `main.<ext>` as `AppMain.<ext>`), and the build says so in an `ℹ` line. A
  `main.swift` is refused early, by `build` and `doctor --project`, with the remedy: mark the app delegate class
  `@main` and remove `main.swift` from the app target.
- Bare app targets whose headers sit outside the app folder group (an Objective-C `AppDelegate.h` next to the project)
  compile: every header the project references under `ios/`, outside `Pods/`, is copied with its forward in
  `Sources/App/include`. A referenced header that does not exist is skipped with an `ℹ` line instead of stopping the
  build.
- A bare app target's Objective-C sources and bridging header find React Native's headers by bare name
  (`#import <RCTAppDelegate.h>`) and the pod table's `<Pod/Header.h>` forwards (`#import <AppAuth/AppAuth.h>`), as with
  CocoaPods, instead of stopping with "'RCTAppDelegate.h' file not found"; the app's own headers still come first.
- A bare app target's Objective-C++ and C++ files (an `AppDelegate.mm` importing `<RCTAppDelegate.h>`) compile with
  the project's `CLANG_CXX_LANGUAGE_STANDARD` (C++20 when unset), instead of clang's default, which stopped on React
  Native's C++20 headers with "unknown type name 'Hashable'" in `react/utils/hash_combine.h`.
- An Objective-C++ file that imports a pod table forward (a bare app's `AppDelegate.mm` with
  `#import <AppAuth/AppAuth.h>`) compiles, instead of stopping with "use of '`@import`' when modules are disabled": the
  scaffold's forwarder `#import`s the pod's public headers instead of `@import`ing its modules.
- A library that was also built for Android gets its scaffold persisted, instead of "⚠ Did not persist <library>'s
  scaffold: the patch would contain a binary file (node_modules/<library>/android/build/…/BuildConfig.dex)" and a new
  scaffold at every build: the patch holds the files the scaffold wrote and those its existing patch held.
- react-native-screens 4.24.0 scaffolds with its `ios/` sources, instead of a target with only its C++ and an app that
  crashed at start: the podspec reader evaluates Ruby locals, interpolation, `ENV` lookups, ternaries, `if`/`unless`
  blocks, `push` on a local array, hashes and the library's `package.json`, and leaves out the branches a condition
  rules out; a source glob, `compiler_flags`, `header_dir` or `frameworks` value it cannot evaluate stops that
  library's scaffold with the podspec, the field and the expression (an xcconfig flag it cannot evaluate is left out,
  see Changed). react-native-worklets 0.8.3 keeps its `WORKLETS_VERSION` and `REACT_NATIVE_MINOR_VERSION` defines.
- `build` and `install` stop, and remove the packed app, when a class React Native's codegen providers name is not in
  the app, naming the class, its component or module and its library, instead of installing an app that would crash
  at start in `+[RCTThirdPartyComponentsProvider thirdPartyFabricComponents]`.
- With these fixes, a production bare React Native 0.85.0 app with an Objective-C app target (`main.m`,
  `AppDelegate.h` and `AppDelegate.mm` next to the project, a bridging header and a Swift file) and 20 native
  libraries builds, installs over USB and launches on a physical iPhone (checked on 2026-11-06: the JS bundle loaded
  from Metro and the app's own UI appeared; its features are not checked yet).

## [0.1.0-alpha.6] - 2026-11-05

### Upgrading from 0.1.0-alpha.5
- `rn-xtool run` rebuilds and reinstalls the app after this upgrade, which gives it the app icon and, for apps without
  expo-dev-client, the reload after Allow.
- If the home screen keeps a blank icon, delete the app from the iPhone and install it again, or restart the phone:
  iOS caches app icons.
- With expo-dev-client, run `rn-xtool install` once, so that `rn-xtool start` can announce Metro under the installed
  app's bundle id. Until then `start` prints "ℹ No installed bundle id recorded: run `rn-xtool install` once so
  `start` can announce Metro under the app's real id (Expo SDK 58's dev launcher hides other servers)."
- The scaffolder is now revision 4, so every scaffold patch rn-xtool persisted in your `patches/` before this release
  gets a warning at each `build`: "⚠ patches/<name> was written by an older rn-xtool scaffolder (revision <n>, now 4);
  delete it so rn-xtool regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old
  Package.swift)". Do what it says: delete the patch, remove the library from `node_modules` and reinstall it, then
  build; rn-xtool scaffolds it again and persists the new patch. Until then the build goes on with the older manifest.
- On React Native 0.88 (bare, and Expo SDK 58), the first build after the upgrade can stop at `patches` with "rn-xtool
  could not apply its patch to react-native@0.88.1 (patch file: react-native+0.88.1.patch): node_modules/react-native
  is the version the patch is for, but its files match neither the original package nor the patched one.": this
  release changes the bundled react-native patch, and `node_modules/react-native` still holds 0.1.0-alpha.5's. Run
  `rm -rf node_modules/react-native && npm install`, then build again.
- CocoaPods binaries need nothing from you, unless your `patches/` hold a scaffold of a library that depends on them
  (@react-native-ml-kit/text-recognition) persisted without them, under `knownLimits.allow`: `build` then warns "⚠
  patches/<file> does not link GoogleMLKit's CocoaPods binaries: it was scaffolded before rn-xtool resolved them;
  delete it so rn-xtool regenerates it (also remove node_modules/<package> and reinstall: that copy still has the old
  Package.swift)". Do what it says. (A scaffold persisted by 0.1.0-alpha.5 gets the revision warning above instead.)
- The first build of an app with @react-native-ml-kit/text-recognition downloads 40.3 MB from dl.google.com, after the
  line that announces it, and writes `rn-xtool-pods.lock.json` at the project root: commit it.

### Added
- Binary CocoaPods pods: a library's dependency on pods that ship prebuilt static frameworks is resolved and linked,
  with no CocoaPods or Ruby. rn-xtool reads the pods' specs from the CocoaPods CDN, picks the newest versions that meet
  every requirement, downloads the files on your machine into `~/.cache/rn-xtool/pods`, wraps each framework for
  SwiftPM (a headers-only xcframework, and its arm64 archive linked once with `-force_load`), and writes the local
  package `ios/build/pod-binaries` that the scaffold links. @react-native-ml-kit/text-recognition 2.0.0 builds this way
  on bare React Native 0.88.1 (checked on a device on 2026-11-05: it recognized printed text from a photo): ten Google
  pods, their five OCR model bundles at the root of `App.app`, and GoogleToolboxForMac, GoogleUtilities,
  GoogleDataTransport and GTMSessionFetcher from their SwiftPM packages through the pod table. The app grows by about
  53 MB. Other shapes (dynamic or Swift frameworks, vendored libraries, compiled sources) stop with a message naming the
  pod. See [troubleshooting.md](docs/troubleshooting.md#cocoapods-binaries).
- `rn-xtool-pods.lock.json`, at the project root, records each binary pod's version, URL, size and sha256: "ℹ pods —
  recorded the sha256 of 10 downloads in rn-xtool-pods.lock.json; commit it, so other machines check that they get the
  same files." Later builds keep the locked versions and check every download against it; a file with another sha256
  stops the build with what to do. With the lock and a full cache, the step makes no request.
- Before the first download, `build` says what it downloads, how much, from where and whose: "ℹ pods —
  @react-native-ml-kit/text-recognition needs 10 CocoaPods binaries that are not in rn-xtool's cache, 40.3 MB from
  dl.google.com: … From Google, Inc. (…; terms: https://developers.google.com/ml-kit/terms). rn-xtool keeps them in
  ~/.cache/rn-xtool/pods and does not copy them into the project." The terms page comes from `data/pod-terms.json`.
  rn-xtool does not accept the terms on your behalf, and its package holds none of these files.
- Scaffolded libraries' `resource_bundles` reach the app: each unconditional entry whose name and globs are plain
  strings becomes `<name>.bundle` at the root of `App.app`, as CocoaPods places it, with `.lproj` folders kept.
  react-native-svg gets `RNSVGFilters.bundle` with its prebuilt Metal filters, and react-native-device-info its
  privacy bundle (checked by building; svg's filters also on a device on 2026-11-05: a `FeComposite` xor filter
  rendered).
- `doctor --project` has a `pods` line for binary pods, from the lock and the cache, or probed online within its 10 s
  budget: "✔ pods — 10 CocoaPods binaries for @react-native-ml-kit/text-recognition, in rn-xtool's cache and in
  rn-xtool-pods.lock.json", "ℹ pods — …, 10 to download from dl.google.com (40.3 MB)", and the lock entries no library
  needs. `doctor` has an `llvm-ar` line: binary pods are wrapped with the Swift toolchain's `llvm-ar`.
- A pod table entry can carry `outsideRequirement`, a sentence that turns the `⚠` for a pin outside a requirement into
  one `ℹ` line ("ℹ GoogleToolboxForMac 6.0.1 (rn-xtool table) is outside MLKitCommon's and MLKitVision's requirement
  ">= 4.2.1, < 5.0": 4.x ships no Package.swift; 6.0.1 keeps the GTMLogger API ML Kit links against"), and
  `emptyTargets`, the package's targets without sources, for which rn-xtool writes an empty object before the build
  (GoogleToolboxForMac's `GTMDefines`, which Swift Build lists at link anyway). A config entry that pins another
  `exact` or `url` drops both; `"emptyTargets": []` clears the list for the same pin.
- CocoaPods pods with a SwiftPM package: a scaffolded library's dependency on a CocoaPods pod becomes a
  `.package(url:exact:)` dependency when the pod table names the pod. rn-xtool's table maps AppAuth to AppAuth-iOS
  3.0.0, so react-native-app-auth 8.5.1 builds on bare React Native 0.88.1 and on Expo SDK 58 (both checked by building
  on 2026-11-05; on bare React Native 0.88.1 it is also linked on a device, and its login flow is not checked yet). A
  `pods` object in `rn-xtool.config.json` adds pods or overrides rn-xtool's entries field by field (`url`, `exact`,
  `products`, and optional `subspecs` and `forwardHeaders`, which forward a pod's umbrella header to its SwiftPM
  modules). Each scaffold records its pins (`// rn-xtool-pods: AppAuth=3.0.0`), and `build` and `doctor --project` warn
  about a persisted scaffold whose pins differ from the table, and about a pin outside a podspec's requirement: "⚠
  AppAuth 1.0.0 (rn-xtool.config.json) is outside react-native-app-auth's requirement ">= 1.7.6"". See
  [troubleshooting.md](docs/troubleshooting.md#libraries-that-depend-on-cocoapods-pods).
- `doctor --project` and `build` refuse early a CocoaPods-only library that depends on a pod the pod table does not
  map, naming the pod and the `pods` entry to add: "<package> <version>: its podspec depends on the CocoaPods pod <pod>,
  which has no SwiftPM package rn-xtool knows. …", for a pod whose spec is a git source (a pod of prebuilt binaries is
  linked, above). Before, the scaffold was persisted without the pod and the build failed at
  compile time. A library that depends on a sibling by its pod name (react-native-reanimated's `RNWorklets`) is not
  refused when the sibling is installed as a peer, outside package.json, on Expo, whose autolinking links it.
- `"exclude": ["<package>"]` in `rn-xtool.config.json` leaves native modules out of rn-xtool's iOS builds, as
  `platforms.ios: null` in `react-native.config.js` does, without touching that file. `doctor --project` and `build`
  print "ℹ exclude — left out of this iOS build: <packages> (rn-xtool.config.json). JavaScript that uses it must check
  that it is there; …", and a `⚠` line for a name that is not a native iOS dependency, or is an Expo module (those go
  in `expo.autolinking.exclude`). See [troubleshooting.md](docs/troubleshooting.md#leaving-a-module-out).
- Entitlements: `build` reads the file `CODE_SIGN_ENTITLEMENTS` names in the app target's Debug configuration (on Expo,
  in the prebuild's Xcode project) and passes it to xtool when it has keys (`entitlementsPath` in `xtool.yml`). Before
  compiling, it prints a `⚠` line for each key xtool drops or does not enable on a free team, for example "⚠
  aps-environment is not available on a free team; the build continues without it; push notifications fail at
  runtime.", and for a shared keychain group, which xtool replaces with `<Team ID>.XTL-<Team ID>.<bundle id>`. A
  missing file, or one that is not a property list dictionary, stops the build. `doctor --project` has a new
  `entitlements` line. See [troubleshooting.md](docs/troubleshooting.md#entitlements).
- On Expo, the bridging header of the prebuild's Xcode project reaches Swift when it holds more than comments, so a
  config plugin's imports (react-native-app-auth's `RNAppAuthAuthorizationFlowManager.h`) compile.
- The red screen "No script URL provided" on the first launch clears by itself after Allow. Debug builds of apps
  without expo-dev-client (Expo and bare) get a small helper that waits for Metro after the red screen and reloads the
  app once it answers: at most once per failure, only in the foreground, for up to 5 minutes. An app opened before
  `rn-xtool start` also reloads once Metro runs. See
  [troubleshooting.md](docs/troubleshooting.md#the-app-does-not-start-or-cannot-reach-metro).
- When Local Network access is denied (Don't Allow), the app shows one alert, "Local Network access is off", with an
  Open Settings button.
- Apps with expo-dev-client open their Metro server by themselves from the second launch: `build` sets the dev
  launcher's default URL (`DEV_CLIENT_DEFAULT_LAUNCHER_URL`, unless the app sets one) and adds `_expo._tcp` to
  `NSBonjourServices`, which a bare app with the dev client lacked.
- `rn-xtool install` prints, for apps with expo-dev-client, a link and a QR code that open the app on its Metro server,
  for the first launch. The QR code is drawn with the project's own `toqr`; without it, the link is printed alone. See
  [troubleshooting.md](docs/troubleshooting.md#dev-client).
- With expo-dev-client, `rn-xtool start` announces Metro to the dev launcher under the installed app's bundle id
  (`XTL-<Team ID>.<bundle id>`), in place of Expo's announcement, so Expo SDK 58's launcher lists the server with its
  "Match bundle identifier" filter on. It uses the project's own `dnssd-advertise` and prints "ℹ Announcing Metro to
  the dev launcher as <id>."; when it cannot announce, Expo's announcement stays. `CI=1` or `EXPO_UNSTABLE_BONJOUR=0`
  in the environment turns it off, as for Expo CLI (the project's `.env` files are not read for this).
- The app gets its icon on the home screen: `build` takes the PNG from `Images.xcassets/AppIcon.appiconset` (Expo and
  bare) and prints "ℹ App icon: <path> (<width>×<height>)", or an `ℹ` line saying why there is none. For Expo, when the
  app config's icon changed since the last expo prebuild, it says to run `rn-xtool build --clean`. Dark, tinted and
  Icon Composer icons and custom splash screens are not supported. See
  [troubleshooting.md](docs/troubleshooting.md#app-icon-and-launch-screen).
- `rn-xtool setup` checks the free space for everything it will install (Swift toolchain, xtool, Darwin SDK, the first
  build) before the first download, per filesystem: "Not enough free disk space for setup: the filesystem of <folder>
  has <free> GB free, and setup needs about <need> GB there (<parts>). ...". It removes a half-written
  `darwin.artifactbundle.tmp` left by an interrupted SDK install first.
- Bare React Native 0.85 (0.85.x from 0.85.0) builds through the same route as 0.86: rn-xtool's vendored SwiftPM
  scripts, the prebuilt artifacts downloaded and adapted, and Hermes from the project's `hermes-compiler`
  (250829098.0.10). 0.85.0 is verified on a physical iPhone (`build`, install over Wi‑Fi, the first launch, Hermes,
  Fast Refresh, and reanimated 4.3.4 with worklets 0.8.3 animating); 0.85.3 is build-verified. A project on
  `@react-native-community/cli` 20.0.0 builds too. react-native-reanimated 4.3.4 with react-native-worklets 0.8.3
  builds on 0.85.0: the scaffolded worklets target now gets the `HERMES_V1_ENABLED` define that CocoaPods gives it
  (also worklets 0.10.x when it is scaffolded again), so it no longer looks for the legacy Hermes inspector headers.
  0.85.1 and 0.85.2 build with a warning that says to move to 0.85.3. The daily drift watch checks 0.85, and the
  weekly exploration covers 0.81–0.84. See [bare-react-native.md](docs/bare-react-native.md#react-native-085).
- `build` names the resources of scaffolded libraries that do not reach the app (plain `resources`, and bundles written
  as Ruby code), in one line after `rn-spm`, for example "ℹ Not copied into the app: <library> (<name>.bundle). Code
  that loads them at run time does not find them." When every resource is a privacy manifest, the line ends
  "Development builds run without them; privacy manifests are read only at App Store submission." It reads the
  podspec's `resource_bundles` and `resources`. See [troubleshooting.md](docs/troubleshooting.md#scaffolded-libraries).
- After `xtool-build`, with binary pods, rn-xtool checks the packed app: each pod's resource bundle with its
  `Info.plist`, no binary pod embedded as a dynamic framework, and every Objective-C class a force-loaded archive
  defines in the App binary. A failure removes `App.app` and stops: "The packed app is not what the CocoaPods binaries
  need, so rn-xtool removed it and does not install it: …".

### Changed
- The early checks read a pod's route offline, from `rn-xtool-pods.lock.json` or a spec in rn-xtool's cache, and
  refuse only a git-source pod with no SwiftPM package. A pod they cannot route gets "ℹ pods — <pod> (from
  <library>) is not resolved yet; rn-xtool build reads its spec from the CocoaPods CDN.", and the new `pods` step, the
  first step of `build`, decides before anything changes in the project. For a library in `knownLimits.allow`, the
  `pods` step leaves such a pod out with "⚠ known-limits — <the refusal> (allowed by rn-xtool.config.json
  knownLimits.allow; the build may fail later)", and the build goes on. Once a build has cached that pod's spec, the
  step leaves the pod out before any CDN read, so the library builds offline too; a machine that never read the spec
  stops offline with "Cannot reach cdn.cocoapods.org (<reason>) to read the versions of <pod>, which are not in
  rn-xtool's cache (~/.cache/rn-xtool/pods). …". In
  `doctor --project`, such a refusal is "✖ pods — …", and "⚠ pods — not checked: …" means only that the host could not
  be reached, the 10 s budget ran out or the lock could not be read.
- `doctor --project`'s `podspecs` line lists under `resource_bundles` only the packages with a bundle rn-xtool does not
  build (one under a Ruby condition, or written as Ruby code).
- With binary pods, `install` (over USB and with `--network`, so `run` too) has xtool build the app first and runs the
  same checks on it before it installs anything: an app the checks refuse is removed and not installed. It also writes
  the empty objects the build recorded (`GTMDefines.o`), so it works after `ios-xtool/.build` was deleted, and stages
  `ios/build/pod-binaries` and the pods' bundles again from the lock and the cache when they are gone since the build
  (a hand-run `npx expo prebuild --clean`, `rm -rf ios/build`).
- The first-run checklist line about the red screen now reads: "On the first launch iOS asks for Local Network access,
  and the red screen "No script URL provided" may show behind it: tap Allow, and the app reloads by itself." For apps
  with expo-dev-client: "On the first launch the dev launcher asks for Local Network access: tap Allow, then open the
  link or QR code above, or enter the Metro URL above in the launcher." An app last built by 0.1.0-alpha.5 has no
  helper: until `rn-xtool build` runs again, `install` keeps the line "tap Allow, then Reload".
- After an rn-xtool upgrade, `rn-xtool run` rebuilds and reinstalls the app: rn-xtool's version is part of the
  dependency fingerprint, so `start` and `doctor` also report the build as out of date, as after a dependency change.
- The README asks for about 25 GB of free disk for setup and the first build, plus the Xcode.xip (was about 15 GB).
- The SDK-only check "Need at least 10 GB free in your home filesystem (~/.swiftpm) to install the Darwin SDK" is
  replaced by the setup-wide check above.
- The scaffold step scaffolds only the libraries React Native reports without a `Package.swift`, and forces nothing:
  every other library's `Package.swift`, persisted or edited by hand, stays as it is. To re-scaffold a library after
  editing its podspec, delete its `Package.swift`, its `react-native-spm-prefix.h` and its patch in `patches/`, then
  build. See [troubleshooting.md](docs/troubleshooting.md#scaffolded-libraries).
- Expo SDK 58 scaffolds through rn-xtool's driver (`scripts/rn-spm-generate.js --scaffold`), as bare apps and Expo
  SDK 57 do, with Expo's autolinking command as its config command, instead of React Native's
  `setup-apple-spm.js scaffold`.
- Scaffolded Swift compiles in the Swift 5 language mode, as CocoaPods compiles a pod, unless the podspec declares
  `swift_version` 6 or higher.
- On bare React Native, a sibling a library depends on by its pod name, installed but not listed in package.json, is
  refused early: "<package> <version>: its podspec depends on <npm>, which is installed but not listed in
  package.json, so React Native does not link it; add it to dependencies (npm i <npm>). …". The community CLI does not
  link it, so the build used to fail at compile time.
- The scaffolder's warning for a CocoaPods pod it cannot map now says where its SwiftPM package goes: `add it under
  "pods" in rn-xtool.config.json: { "pods": { "<pod>": … } }`.
- `$(SRCROOT)`, `$(PROJECT_DIR)` (both `ios/`) and `$(CONFIGURATION)` (`Debug`) in the app target's build settings
  resolve, instead of stopping a bare build with `Cannot resolve build setting`.

### Fixed
- When persisting a scaffold to `patches/` fails, "⚠ Could not persist <library>'s Package.swift to patches/
  (<reason>). …" gives patch-package's error as the reason, for example "Installing <library>@<version> with npm
  failed (status 254)", instead of its banner, "patch-package 8.0.1".
- react-native-vision-camera 4.7.3, react-native-video 6.19.3, react-native-device-info 15.0.2 and
  @react-native-community/netinfo 11.5.2 build without hand fixes on bare React Native 0.88.1, and device-info on Expo
  SDK 58 (checked by building only, on 2026-11-04). On bare React Native 0.88.1 the four also work on a device
  (checked on 2026-11-05: the camera preview, video playback, the device model and iOS version, the connection type).
  Scaffolder fixes 20–24, in [upstream/react-native-scaffolder.md](docs/upstream/react-native-scaffolder.md):
  - a dependency on a React Native library that is not autolinked for iOS is left out, as CocoaPods leaves it out,
    with the subspec that declares it: vision-camera without react-native-worklets-core builds without frame
    processors, and the scaffold says so (`Dependency "react-native-worklets-core" is not installed (or not linked for
    iOS); left out with the subspec "FrameProcessors" that declares it (its sources, headers, settings and
    dependencies), as CocoaPods leaves it out.`);
  - the Swift 5 language mode above (video and vision-camera);
  - an umbrella directory next to other directories in the public headers gets the `include/<Name>/` shim
    (device-info);
  - a library's bare `#import "<Name>Spec.h"` of its codegen header resolves (netinfo);
  - literal `SWIFT_ACTIVE_COMPILATION_CONDITIONS` reach the Swift compiler. vision-camera's location tagging stays
    compiled out: its podspec switches it with a Ruby ternary.

  react-native-video's Google IMA ads and video caching, which its podspec adds only on a Podfile flag, are not wired.
  See [libraries.md](docs/libraries.md).
- Installing a library no longer rewrites the `Package.swift` of the libraries scaffolded before it: hand edits and
  persisted scaffolds stay as they are.
- A library that fails to scaffold is reported first, with the scaffolder's reason: "✖ Scaffolding <library> failed:
  <reason>", followed by that library's warnings. Nothing is persisted for it, and React Native does not run a second
  time. That second run's error (such as `"react-native-vision-camera" has mixed Swift + Objective-C/C++ sources`)
  used to hide the cause.
- When `expo prebuild` fails during `build` (a config plugin throws), rn-xtool removes the half-written `ios/` it left,
  and the error says so: "The failed prebuild left ios/ half-written, so rn-xtool removed it; the next build runs expo
  prebuild again." The next build used to skip the prebuild and build that half state.
- A podspec dependency written as a call, `s.dependency('Pod', …)`, is read by the scaffolder (fix 26), and the pods
  React Native ships or generates (`ReactNativeDependencies`, `FBLazyVector`, `fast_float`, `ReactCodegen`,
  `SocketRocket`) are read as React Native's own, not as pods to map.
- A patch left in `patches/` after `npm uninstall` no longer stops the `patches` step. It is skipped, and the other
  patches apply: "⚠ patches/<file> is for <package>, which is not installed; skipped. Delete it if you removed the
  library." `doctor --project` prints the same line. See
  [troubleshooting.md](docs/troubleshooting.md#build-and-patches).

## [0.1.0-alpha.5] - 2026-11-04

### Upgrading from 0.1.0-alpha.4
- Run `rn-xtool setup` once to download xtool 1.24.0. Until then `rn-xtool doctor` reports
  `xtool — not found — run rn-xtool setup`.
- A project with one of the setups below that rn-xtool refuses early now stops at the start of `build`, before it
  changes anything, instead of failing later in the build. To build it anyway, as before, add its name to
  `"knownLimits": { "allow": [...] }` in `rn-xtool.config.json`.

### Added
- `rn-xtool doctor --project` and `rn-xtool build` refuse early, with the reason and a link to
  [troubleshooting.md](docs/troubleshooting.md#unsupported-setups), the setups rn-xtool knows it cannot build yet:
  CocoaPods-only libraries whose podspec ships prebuilt binaries (async-storage 3.x; Expo modules are not affected),
  Expo modules that build vendored C sources (expo-sqlite), pnpm and Yarn Plug'n'Play installs, and react-native or
  expo hoisted to a parent folder. Before, these failed minutes into the build. `doctor --project` has a new
  `known-limits` line. `"knownLimits": { "allow": [...] }` in `rn-xtool.config.json` (a package name, or `"pnpm"`,
  `"pnp"` or `"hoisted"`) turns a refusal into a warning, "⚠ known-limits — <reason> (allowed by rn-xtool.config.json
  knownLimits.allow; the build may fail later)". The checks read files only. Other unsupported setups still fail
  during the build.
- Known Apple sign-in failures on `rn-xtool auth` are explained instead of shown raw: an HTTP 503 from Apple's sign-in
  service, an anisette server that did not answer in time, and a connection timeout. A Ctrl+C at xtool's `Code:`
  prompt, for a verification code that never arrived, prints "Sign-in was interrupted. ..." with the known
  workaround, and exits with status 130. Other sign-in errors are shown as xtool prints them. See
  [troubleshooting.md](docs/troubleshooting.md#apple-sign-in-errors).
- The free App ID limit on `install` and `run` reads "Apple refused to register another App ID: a free Apple ID can
  register 10 App IDs per 7 days, and each new bundle identifier takes one." and says how to reuse an installed bundle
  identifier. See [troubleshooting.md](docs/troubleshooting.md#app-id-limit).
- When `rn-xtool install --network` fails because Apple answers "There are no current IOS devices on this team", the
  error reads "Apple has no iPhone registered on your Apple ID's team, so xtool could not sign the app for one." and
  says to install over USB once (`rn-xtool install` without --network), which registers the iPhone; after that,
  --network works again. See [troubleshooting.md](docs/troubleshooting.md#iphone-not-registered).
- `rn-xtool doctor --report` prints the checks as one block to paste into a GitHub issue. It replaces the home folder,
  Apple ID, Team ID, bundle identifiers, UDIDs, device names, IP and MAC addresses and tokens with placeholders, and
  makes no network request. Read it before you post it. See
  [troubleshooting.md](docs/troubleshooting.md#reporting-a-problem).
- Issue templates for a bug and for a library that does not build; both ask for the `doctor --report` output.
- CI (`.github/workflows/ci.yml`) runs lint, the private-names scan and the tests on every pull request to `main` and
  every push to `main`, and lists the skipped tests by name in the run summary. The tests read the patched upstream
  React Native and Expo files from pinned npm tarballs (`node scripts/fetch-test-tarballs.mjs`) instead of the
  reference app.

### Changed
- xtool 1.24.0 (was 1.23.0). Its release notes say it fixes another source of HTTP 503 errors.
- When the xtool AppImage cannot run, the hint names the FUSE package of each Ubuntu release: "sudo apt install
  libfuse2t64 on Ubuntu 24.04 and newer, sudo apt install libfuse2 on older releases".

## [0.1.0-alpha.4] - 2026-11-02

### Upgrading from 0.1.0-alpha.3
- Nothing to do for most projects: projects on the verified versions build as before. `rn-xtool doctor --project`
  shows the new lines (versions, rn-scripts, rn-artifacts, expo-plugin, expo-modules, podspecs) for your project.
- On Expo SDK 58, a package of another SDK's release line, for example expo-modules-core 59.x, got only a warning
  before; now G1 stops the build and names it. Follow G1's remedy to move it back to SDK 58's line (see Changed).

### Added
- Bare React Native accepts every patch release of a supported minor from its floor: 0.86.x from 0.86.2, 0.87.x from
  0.87.1 and 0.88.x from 0.88.0. A version that is not verified builds with "⚠ Newer than the React Native <minor>
  line this rn-xtool release was verified with: react-native <version>. ...", which names the verified versions and
  the one to move back to. A version below the floor, a prerelease or another minor stops with "React Native
  <version> is not supported; rn-xtool supports 0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0 (bare).
  Pin react-native to one of them." Hybrid apps still need React Native 0.88.1.
- `rn-xtool doctor --project` checks only the project in the current folder, with no toolchain, login or device
  checks. After the version gates it prints what rn-xtool finds in the project: the line that covers the installed
  versions (or why none does), the SwiftPM scripts the build would use, whether React Native's prebuilt artifacts are
  cached, local (`rnArtifactsDir`) or published (HEAD requests, at most 10 s), whether expo ships its SwiftPM plugin,
  whether the Expo modules are precompiled, and which tracked podspec features the dependencies use. Plain `doctor`
  is unchanged and makes no new network request. See
  [troubleshooting.md](docs/troubleshooting.md#doctor---project).
- A daily drift watch (`.github/workflows/drift-watch.yml`): each supported line gets a fresh project at its newest
  patch release, and the version gates, a dry run of the bundled patches and the portable-manifest rewrite are checked
  on it. A broken line gets one GitHub issue labelled `drift`, which is updated while it stays broken and closed when
  it is green again. A weekly, report-only exploration writes the capabilities of Expo SDK 54–56 and bare React Native
  0.81–0.85 to the run summary. Nothing is compiled, so a green line can still fail G4 or the build. See
  [RELEASING.md](docs/RELEASING.md#drift-watch).

### Changed
- Expo SDK 57 is a floor, like SDK 58: expo 57.0.31, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and
  expo-modules-jsi 57.1.3 or any newer release of SDK 57's line, with react-native exactly 0.86.3. A newer 57.x builds
  with "⚠ Newer than the Expo SDK 57 set this rn-xtool release was verified with: ...". G1 now reads "Expo SDK 57 needs
  react-native 0.86.3 and at least expo 57.0.31, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and
  expo-modules-jsi 57.1.3; installed: ...", with SDK 58's remedy (remove the pins, `npx expo install --fix`, then
  `npx expo install react-native@0.86.3`). G2 (a nested expo-modules-jsi) gives SDK 58's text: remove the pin, then
  `npm update expo-modules-jsi`. SDK 56 and older read "Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo
  57.0.31 or newer 57.x) and SDK 58 or newer." A bundled SDK 57 patch that does not apply on a newer 57.x gives the
  npm `"overrides"` remedy with the 57 set.
- On Expo SDK 57 and 58, a package of another SDK's release line (expo-modules-jsi 58.0.19 on SDK 57,
  expo-modules-core 59.0.0 on SDK 58) stops at G1 instead of counting as newer than the floor.
- Bare and hybrid projects get the vendored or the installed SwiftPM scripts according to the installed scripts'
  layout, not their version number; a layout rn-xtool does not recognise falls back to the version's line. Every
  supported version gets the same scripts as before: 0.86.x and 0.87.x the vendored copy, 0.88.x the installed one.
- Bundled patches are selected by release line: the patch for the installed version, else the highest bundled patch
  of the same line (react-native 0.88.2 gets the 0.88.1 patch, a newer 57.x expo-modules-jsi the 57.1.3 patch). An
  SDK 57 project never gets another SDK's patch.

### Fixed
- A malformed `rn-xtool.config.json` is named in the error, in every command: "rn-xtool.config.json: <JSON error>".
- rn-xtool needs Node 22.12 or newer, the floor its own dependencies declare (commander 15, execa 10); it said Node 20
  before, which was never tested and is end of life. package.json `engines`, the README and `doctor`'s node check
  ("<version> (need 22.12.0 or newer)") now say so.

## [0.1.0-alpha.3] - 2026-10-28

### Upgrading from 0.1.0-alpha.2
- Expo SDK 58 apps move to the 58.0.21 set, in the order `doctor` gives and
  [troubleshooting.md](docs/troubleshooting.md#moving-to-the-58021-set) lists: remove the expo-modules-* pins
  0.1.0-alpha.2 asked for (`npm uninstall expo-modules-jsi expo-modules-autolinking`), then
  `npx expo install expo@~58.0.21`, `npx expo install --fix` and `npx expo install react-native@0.88.1`. Do not pin
  expo-modules-* packages again.
- Hybrid apps (bare + Expo modules) do the same, but move React Native to 0.88.1 as
  [Upgrading React Native](docs/bare-react-native.md#upgrading-react-native) describes. If `doctor` then says
  expo-modules-jsi resolves from `node_modules/expo-modules-core/node_modules/`, run `npm update expo-modules-jsi`.
- Bare React Native 0.88.0 apps keep working; 0.88.1 is also supported.
- The first build can stop at `patches` with "rn-xtool could not apply its patch to <package>". This release changed
  the bundled `react-native+0.88.0.patch` and the Expo patch, and `node_modules/<package>` still holds the
  0.1.0-alpha.2 version. Run `rm -rf node_modules/<package> && npm install`, then build again.
- After a move to React Native 0.88.1, the build warns about each scaffold patch in `patches/` made for 0.88.0: delete
  the patch it names (and reinstall the library, as it says), then build again, so rn-xtool regenerates and persists
  it. Teammates who pull the new patches need to do nothing: their older copy in `node_modules` is replaced. When a
  patch also holds your own fix to that library, the build says to reinstall it (`rm -rf node_modules/<package> &&
  npm install`) instead.
- On a team with Macs, if `doctor` says `@expo/modules-macros-linux-<arch>` is not installed, run
  `npm install --include=optional` and commit `package-lock.json`.

### Added
- Expo SDK 57 projects, on exact versions only: expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24,
  expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3. They build through a vendored copy of Expo SDK 58's
  SwiftPM plugin (`vendor/expo-spm/`: expo 58.0.19's `scripts/spm/` with rn-xtool's Expo patch and six vendored-only
  edits), the vendored React Native scripts and the adapted 0.86.3 artifacts, with SDK 57's own precompiled
  ExpoModulesCore. The `jsi` step runs before `rn-spm` and also writes the `ExpoModulesJSIHeaders.xcframework` SDK 57
  does not ship. Nothing is injected into `ios/`. expo-modules-autolinking 58.0.15 and expo-modules-macros 0.22.0 are
  new exact dependencies of rn-xtool, and `patches/expo-modules-jsi+57.1.3.patch` is the only bundled patch an SDK 57
  project gets. `doctor` reports `(vendored Expo SwiftPM plugin and SwiftPM scripts)` for these projects. Verified on
  a physical iPhone on 2026-10-28: the template with Fast Refresh, and the libraries in the `Expo 57` column of
  `docs/libraries.md` (expo-router, expo-dev-client, reanimated and worklets, gesture-handler, screens and
  safe-area-context, haptics, image-picker, file-system).
- Generic fixes, on every SDK and on bare projects:
  - Expo's plugin (`patches/expo+58.0.21.patch`): headers that import the module's own `-Swift.h` stay out of its Swift
    umbrella; `add_dependency(s, "<Pod>")` counts as a pod dependency, and a generated package can depend on a React
    Native library with a `Package.swift` (expo-router on react-native-screens); a generated package that depends on a
    scaffolded mixed library gets that library's header search paths for Swift.
  - React Native's scaffolder (`patches/react-native+0.88.0.patch`, `patches/react-native+0.88.1.patch` and
    `vendor/rn-spm/`, fixes 14 to 18 in `docs/upstream/react-native-scaffolder.md`): no own `-Swift.h` in the Swift
    umbrella, `#{package['version']}` in flags and defines, subspec `header_mappings_dir` under `header_dir`, and the
    Swift importer paths recorded in each mixed manifest, and in each clang-only manifest whose header search paths go
    beyond its public headers path (found on react-native-reanimated 4.5, react-native-worklets 0.10 and
    react-native-screens 4.26 and 4.30), and a
    clang-only target's module without the headers its podspec leaves out (react-native-screens 4.30's `ios/gamma`).
  - The App target gets the Swift importer paths of every autolinked scaffolded library that records them.
- The clean-machine harness takes `e2e.sh project --sdk <n>` (template `blank-typescript@sdk-<n>`).
- The `patches` step makes the libraries' own `Package.swift` files portable to Linux, which fixes the default SDK 58
  template's first build: react-native-reanimated 4.7.1 and react-native-worklets 0.13.0 use `CFGetTypeID`, which
  Linux hosts lack. It keys on the snippet, not the version, logs one `manifest —` line per library, and leaves
  existing project patches for the same fix working. It scans the project's top-level and scoped packages, never
  edits a package linked from outside the project (it logs a `manifest — skipped` line instead), and stops with a named
  error when `node_modules` is read-only.
- Bare React Native 0.88.1, with its own bundled `patches/react-native+0.88.1.patch` (the same content as the 0.88.0
  one; a test keeps the two identical). `doctor` and `build` accept 0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1. Another
  react-native version gets one message naming both patches (`the bundled react-native patches are for 0.88.0 and
  0.88.1`).
- G4, in the `frameworks` step: before staging, `llvm-nm` (from the Swift toolchain) checks that every symbol an
  embedded framework imports from another embedded framework is exported by it. A gap stops the build naming both
  frameworks, their packages and a missing symbol, instead of an app that closes at launch with `dyld: Symbol not
  found`. It runs on every project kind, with no bypass; a missing `llvm-nm` is an error, which `doctor` reports on
  its `llvm-nm` line. It does not see C++ or Swift layout changes that keep the same symbols, or lookups by name at
  runtime (see `docs/troubleshooting.md`).

### Changed
- `install`'s first-run checklist explains the red screen "No script URL provided" that shows behind iOS's Local
  Network prompt on the first launch after an install: tap Allow, then Reload.
- Expo SDK 58 builds on the 58.0.21 set as a floor: react-native 0.88.1 exactly, and at least expo 58.0.21,
  expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, expo-modules-autolinking 58.0.16, expo-file-system 58.0.13 and
  expo-font 58.0.11. An older or missing package stops `doctor` and `build`. The remedy removes the expo-modules-*
  pins in package.json (`npm uninstall …`), moves `expo` when it is listed (`npx expo install expo@~58.0.21`), runs
  `npx expo install --fix`, and ends with `npx expo install react-native@0.88.1` (Expo's versions API lists
  react-native 0.88.0 for SDK 58, so `--fix` alone leaves it there); a hybrid app is sent to the bare docs' React
  Native upgrade sequence instead of that last command. A newer 58.x prints a warning and the build continues with
  the floor's patches. The 58.0.19 set of 0.1.0-alpha.2 is no longer accepted: npm no longer resolves it on its own.
  A nested expo-modules-jsi now stops `doctor` and `build` with "Remove any expo-modules-jsi pin or override from
  package.json", then `npm update expo-modules-jsi` (a reinstall keeps the copy where package-lock.json put it),
  instead of failing at `rn-spm` with Expo's headers message. expo-modules-macros' Linux binary is checked where
  expo-modules-core resolves it; when it is missing, the message names its version and gives
  `npm install --include=optional` (a lockfile written on macOS can lack it). Hybrid apps (bare + Expo modules) get
  the same checks, and need React Native 0.88.1 and Expo SDK 58 or newer.
- The bundled SDK 58 patches are named after the 58.0.21 set (`expo+58.0.21.patch`, `expo-modules-jsi+58.0.21.patch`,
  `expo-modules-autolinking+58.0.16.patch`); their content is unchanged.
- An Expo SDK older than 57 now gets `Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo 57.0.31) and SDK 58
  or newer.` An SDK 57 project stops in `doctor` and `build` when a pinned version differs, when the expo-modules-jsi
  the build uses is not the top-level copy, or when the expo-modules-macros the vendored plugin uses (a copy
  expo-modules-core resolves, else rn-xtool's) has no Linux binary for the host.
- `SceneDelegate.swift` is optional on every SDK; it is required only when Info.plist's `UIApplicationSceneManifest`
  names a scene delegate.
- When several bundled patches name one package, the one for the installed version is staged, else the highest
  version (on a newer 58.x, the floor's patch). When the floor's patch does not apply, the message offers an npm
  `"overrides"` block with the verified expo-modules-core, expo-modules-jsi and expo-modules-autolinking versions (and
  the failing package), or waiting for an rn-xtool release, and says not to pin expo-modules-* packages as direct
  dependencies (a pin there nests the copy expo uses); SDK 57 and react-native keep the "pin <package>" message.
- The scaffolder revision is now 3: scaffolded mixed manifests, and clang-only ones whose header search paths go beyond
  their public headers path, carry a `// rn-xtool-swift-importer-paths:` line, and the `patches` step warns about
  persisted scaffold patches written by an older revision and says which file to delete.
  Generated manifests of SDK 58 and bare apps change only where one of the fixes above applies.

### Fixed
- Expo's plugin skips every `*Tests` folder of a module, as podspecs do (`ios/*Tests/**/*`), not only `Tests`: SDK 57's
  expo-dev-menu compiled its `UITests` XCTest helpers into the app, which then closed at launch.
- SDK 57's expo-dev-launcher `Unsafe` subspec now builds, with its own compiler flags (vendored edit P6).
- A bundled patch over a package an earlier rn-xtool release patched differently (same version, other content) now
  stops with a message that names the package and `rm -rf node_modules/<package> && npm install`, instead of
  patch-package's output and "Report this". rn-xtool does not reinstall it itself.
- A scaffolded `Package.swift` in `node_modules` older than its persisted patch (a teammate committed the regenerated
  patch) is now replaced with the persisted one, and an out-of-date one without a persisted patch is removed so the
  `rn-spm` step scaffolds it again; before, both were built as they were. A persisted patch that also changes the
  library's own files is not replaced: the build warns and names `rm -rf node_modules/<package> && npm install`. The
  scaffold warnings and this check also read the pre-rename `expo-xtool-scaffold-revision` marker.

## [0.1.0-alpha.2] - 2026-10-27

### Added
- Bare React Native 0.86.2, 0.86.3 and 0.87.1, through vendored copies of React Native 0.88.0's SwiftPM scripts
  (`vendor/rn-spm/`), a `rn-artifacts` build step that downloads and, for 0.86, adapts the prebuilt artifacts, and an
  exact-version gate. 0.86.3 and 0.87.1 are verified on a physical iPhone (`doctor`, `build`, install over Wi‑Fi, Metro,
  Fast Refresh, and the library matrix in `docs/libraries.md`; reanimated/worklets only on 0.86.3); 0.86.2 is
  build-verified only.
- The `patches` step warns about persisted scaffold patches made for another React Native version (for example after
  moving from 0.86.3 to 0.87.1) and says which file to delete; it changes nothing on its own.

### Changed
- An Expo project whose `react-native` is not 0.88.0 now stops at the `patches` step with a message to pin
  `react-native` to 0.88.0 (before, a cleanly applying patch only warned).
- Persisted scaffold patches that still carry the old `expo-xtool-scaffold-revision` marker are re-scaffolded once (the
  marker became `rn-xtool-scaffold-revision` in 0.1.0-alpha.1); patches with the current marker are kept.
- A React Native version rn-xtool does not support now gets one error naming the supported list (0.86.2, 0.86.3,
  0.87.1 and 0.88.0); 0.88 prereleases and 0.88.x other than 0.88.0 are refused.
- README and docs mark WSL2 as "should work, not tested yet" instead of supported.

## [0.1.0-alpha.1] - 2026-10-26

First public release, as `react-native-xtool` (command `rn-xtool`).

### Added
- Expo SDK 58 projects: `setup`, `doctor`, `build`, `install`, `start`, `run` on Linux via xtool 1.23.0, Swift 6.4 and
  the Darwin SDK extracted from your own Xcode.xip; patches for Expo's SwiftPM plugin and React Native's `spm scaffold`.
- Bare React Native 0.88 projects and hybrids (bare + Expo modules): the Xcode project is read, never modified;
  Swift, Objective-C and C++ sources in the app target; `<Module>-Swift.h` forward for Objective-C.
- CocoaPods-only libraries: `Package.swift` generated automatically by React Native's `spm scaffold` with 13 generic
  fixes, persisted in the project's `patches/`.
- Wi‑Fi installs (`install --network`, `setup --wifi`) without the cable after a one-time USB pairing.
- Smart rebuilds: `run` rebuilds and reinstalls only when dependencies (or, for bare, native files) changed.
- `rn-xtool auth` to run xtool's login commands.
- Verified on a physical iPhone: Expo and bare templates, reanimated, worklets, gesture-handler, screens, svg, webview,
  datetimepicker, safe-area-context, expo-haptics, expo-secure-store, expo-image-picker, bottom-sheet, pager-view,
  expo-notifications (local), expo-dev-client.

### Known limits
- Expo SDK 57 and older, React Native 0.85 and older, 0.86.0, 0.87.0: not yet.
- No iOS simulator, no production builds, Linux x86_64 only (arm64 and WSL2 untested).
- No Xcode tools on Linux: asset catalogs, storyboards and Metal shaders are skipped; library resource bundles and
  vendored xcframeworks are not supported yet.

[Unreleased]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.8...HEAD
[0.1.0-alpha.8]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.7...v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.6...v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/WillyAntunez/react-native-xtool/releases/tag/v0.1.0-alpha.1
