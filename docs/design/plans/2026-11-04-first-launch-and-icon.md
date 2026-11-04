# First Launch and App Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first minutes with rn-xtool look right:
- A Debug app without a dev client reloads by itself once Metro is reachable, so the "No script URL provided" red screen clears after Allow, and an app opened before `rn-xtool start` recovers. When Local Network access stays denied, the app says so once, with a way into Settings.
- A dev-client app opens its Metro server without anyone typing an address. On Expo SDK 58, the launcher's list shows the server.
- The app shows its icon on the home screen.
- `setup` on a fresh machine checks early that it has the disk space it needs, and a second run downloads nothing.

**Architecture:**
- **Auto-reload.** rn-xtool ships three files under `templates/dev-support/`: a pure C policy, its header, and an Objective-C file that connects the policy to React Native's notifications, UIKit's app state and Network.framework. `writeIosXtool` copies them into a generated SwiftPM C-family target, `RNXtoolDevSupport`, which the App target depends on. It does so only when the project has no `expo-dev-client`. The policy decides when to connect, reload, give up and show the Local Network alert. It has no I/O, so the tests compile it with the host `cc` and run it. The Objective-C file is compiled against the iPhoneOS SDK when the Darwin SDK is installed.
- **Dev client.**
  - `transformInfoPlist` writes `DEV_CLIENT_DEFAULT_LAUNCHER_URL` and makes sure `_expo._tcp` is in `NSBonjourServices`.
  - `install` prints the dev-client deep link as text and as a QR code. The URL scheme is read from `ios-xtool/Info.plist`, and the QR code is drawn with the project's own `toqr`.
  - `install` also records the bundle id of the app it installed in the build state, without asking the iPhone anything more: over Wi‑Fi the id the install reports, over USB the `XTL-<Team ID>.<bundle id>` it logs (Task 4b).
  - `start` then announces Metro over Bonjour under that id, with the project's own `dnssd-advertise`, and turns Expo's own announcement off. Expo SDK 58's bundle-id filter therefore keeps the server.
  - `start` prints no QR code: `expo start` prints its own.
- **Icon.** A new module, `src/generate/appIcon.ts`, picks the PNG from `AppIcon.appiconset` and reads its header in plain Node. `writeIosXtool` copies the PNG to `ios-xtool/AppIcon.png`, and `renderXtoolYml` writes `iconPath`.
- **Setup.** `setup` adds up the space each pending action needs, per filesystem, before the first download. A test with a real probe and a temporary HOME proves that a second run downloads nothing.

**Tech Stack:** TypeScript (Node 22, ESM), vitest 5, Objective-C and C11 (Network.framework C API, UIKit, `dlsym`), SwiftPM C-family targets, the host `cc` and the Swift toolchain's `clang` (tests only), and two packages loaded from the project, never added as dependencies: `toqr` 0.1.1 and `dnssd-advertise` 1.1.x.

**Spec:** `docs/design/specs/2026-11-04-first-launch-and-icon-design.md` (approved, amended 2026-11-04 by the controller rulings: the Local Network alert, `start` prints no QR code, the SDK 58 announcement, rows 11 and 18–23). Its failure-walk rulings are binding. The research notes (git-ignored) are `.superpowers/research/week2/{first-launch,metro-port,icon}.md`. The preflight is `.superpowers/sdd/2026-11-04-first-launch-and-icon/preflight.md`, and the rulings are in `progress.md`.

## Facts this plan rests on (checked in code)

1. **How Metro's port reaches an Expo app today.**
   - For Expo apps, `ip.txt` holds only the IP (`src/generate/iosXtool.ts:135`). The port comes from Info.plist `RCTMetroPort` (`src/plist.ts:87`, always a string).
   - In Debug, when `EXDevLauncherController` is absent, Expo's `ExpoReactNativeFactory.adoptInfoPlistMetroPort()` reads both and sets `RCTBundleURLProvider.sharedSettings().jsLocation = "<ip>:<port>"`. See `expo/ios/Expo/ExpoReactNativeFactory.swift:51-72` (SDK 58) and `expo/ios/AppDelegates/ExpoReactNativeFactory.swift:46-67` (SDK 57). No rn-xtool patch touches it. React Native probes `jsLocation` first.
   - Bare apps carry `<ip>:<port>` in `ip.txt`; RN uses a host that contains a colon verbatim.
   - The helper reads the same pair. So the comment at `iosXtool.ts:132-134` is wrong: the dev launcher reads neither value (Task 3 fixes it).
2. **The notifications.**
   - `RCTJavaScriptDidFailToLoadNotification` is posted on main by `RCTInstance handleBundleLoadingError:` (0.86.3: line 523, 0.87.1: 528, 0.88.1: 527). Its string value equals its name.
   - RN 0.86.3 never posts `RCTJavaScriptDidLoadNotification` in the new architecture: only 0.87 (line 626) and 0.88 (625) do. All three post the literal `@"RCTInstanceDidLoadBundle"` on the JS thread (613 / 619 / 618). The helper treats either one as "a bundle loaded". If React Native renames the literal, the worst case is one extra reload after a manual Reload (ruling Q3).
   - `RCTTriggerReloadCommandListeners(NSString *)` is `RCT_EXTERN` in `React/Base/RCTReloadCommand.h:29`, and every reference app's React.framework exports it (`llvm-nm -gU`).
   - `RCTRedBox invalidate → dismiss` holds in all three versions. Not yet seen on a device (Task 10 Step 1).
3. **SwiftPM linking.** Swift Build links each target's object file directly (`App-App.LinkFileList`), so the helper's `+load` class is kept. Swift Build already passes `-fobjc-arc` and `-DDEBUG=1` to Objective-C sources of package targets. The `cSettings` in Task 2 restate that intent; they are redundant but harmless.
4. **QR library.**
   - rn-xtool has none.
   - `toqr` 0.1.1 is Expo CLI's encoder (MIT, no dependencies, 13.7 KB CJS). Its API is `toQR(text) → Uint8Array`, one byte per module, `1` = dark.
   - It is installed at the top level of both reference Expo apps. It also resolves through `expo → @expo/cli`. Every dev-client project has `expo`.
5. **Dev-client discovery.**
   - Expo CLI announces `_expo._tcp` with `dnssd-advertise`'s `advertise({ name, type: "expo", protocol: "tcp", hostname: slug, port, stack: "IPv4", txt: { name, slug, androidPackage, iosBundleIdentifier, username } })`. `iosBundleIdentifier` is the app config's id (`@expo/cli/build/src/start/server/Bonjour.js`). It is switched by `EXPO_UNSTABLE_BONJOUR` (`boolish`, default on unless headless) and off under `CI`.
   - No supported knob changes the announced id.
   - `dnssd-advertise` 1.1.6: MIT, no dependencies. `advertise(opts) → () => Promise<void>`, with `onError` for non-fatal errors. It is hoisted in both Expo apps.
   - expo-dev-launcher 58.0.17 keeps a server only when the TXT `iosBundleIdentifier` equals `Bundle.main.bundleIdentifier` exactly (`DevServerFilter.swift:31-32`), which is the signed `XTL-…` id. A missing key also hides the server. The filter is on by default; 57.0.21 has none.
   - The launcher needs `_expo._tcp` in `NSBonjourServices`. Expo prebuild adds it; a bare app with the dev client never runs prebuild.
6. **The installed bundle id.**
   - xtool rewrites `CFBundleIdentifier` to `XTL-<first segment of the signing identity, uppercased>.<id>` when it signs (`AutoSigner.swift:73`, `ProvisioningIdentifiers.swift:24-27`). That segment is the Team ID for an Apple ID login and the issuer-ID segment for an App Store Connect key.
   - `xtool dev run` signs in a temporary copy and keeps no signed bundle.
   - The iPhone's installation_proxy `Lookup` with `ApplicationType: "User"` lists the installed apps with their real ids. rn-xtool already opens that service over usbmux (`doctor.ts:211-226`) and over Wi‑Fi (`wifiInstall.ts:126-133`).
7. **Setup sizes (measured on this host):**
   - `~/.swiftpm/swift-sdks/darwin.artifactbundle`: 6.9 GB;
   - `~/.local/share/swiftly`: 3.6 GB;
   - xtool AppImage: 54 MB;
   - `~/Library/Caches/ReactNative`: 6.4 GB for several RN versions (about 1.3 GB per version);
   - `app/ios-xtool/.build`: 2.3 GB.

   `xtool sdk install` extracts the whole Xcode into `darwin.artifactbundle.tmp` before it trims it, and it removes a leftover `.tmp` at start. The peak is not known from code (ruling Q5: use the proposed figures, correct them from Task 10).
8. **Setup on a second run today.** With everything present and logged in, `setup` prints `✔ Nothing to do: toolchain already set up`. When logged out, it only prints `Run: rn-xtool auth login`. The gap: a leftover `darwin.artifactbundle.tmp` from an interrupted SDK install would count against a space check.

## Global Constraints

- Linux, Node 22.12+, Swift 6.4, `IOS_MIN` 16.4 and `XTOOL_VERSION` 1.24.0 stay unchanged.
- **No new dependency, runtime or dev.** Two commands may load packages from the project's own `node_modules`, through `requireFromProject` (Task 4), for dev-client builds only:
  - `install` loads `toqr`;
  - `start` loads `dnssd-advertise`.

  Both fall back to today's behaviour when the package is missing or broken. `build` and `doctor` never load project code beyond what they do today.
- `tests/tarballs.json` gains four test-only tarballs. Their integrity values were copied from `npm view <spec> dist.integrity` (preflight); re-check them with the same command:
  - `react-native@0.86.3` `sha512-JR5s3bM9ezud+Mw24GlNXNfthqPIKwrQgPPJcam+L97t2sKjjEavhCzBn+fyqZZRcM5+XlhYxpTxVkK7e1n38Q==`
  - `react-native@0.87.1` `sha512-DJKG6ANoD7BtrE4z9DewiSD7/RxCX73lK5Pu49aUr85P3333Dm2roTiP0rRjQNDZdVizHSOmstWfwF/o9EjCRA==`
  - `toqr@0.1.1` `sha512-FWAPzCIHZHnrE/5/w9MPk0kK25hSQSH2IKhYh9PyjS3SG/+IEMvlwIHbhz+oF7xl54I+ueZlVnMjyzdSwLmAwA==`
  - `dnssd-advertise@1.1.6` `sha512-Ndrrf6BMPalkQPd/zubL+4YghH2J9NspapQ09uDXwYbvOPkP0oaqf5CkcwJ0b50kS2O3ul6yVu+jz+RY62Cejg==`
- **No new network call** in `build`, `doctor` or `setup` (`setup` keeps its existing downloads). For dev-client builds:
  - `install` makes no new request: it records the installed id it already has (Task 4b);
  - `start`'s Bonjour announcement replaces Expo's own (the same mDNS traffic).
- `package.json` `files` gains `templates`. `templates/dev-support/` is copied byte for byte into `ios-xtool/Sources/RNXtoolDevSupport/`.
- The helper target exists only when `project.hasDevClient === false`. The Objective-C glue is wrapped in `#if DEBUG`; the policy has no I/O. rn-xtool builds only `--configuration debug`.
- **Fixture values pass `scan:private`:** IPs are `192.168.1.x`; Apple IDs use `example.com`. No real Team ID or UDID, and no absolute home-folder path appears in committed files (the planted home is `/home/me`). Installed ids in fixtures use `XTL-TEAMID0000.`.
- User-facing texts in this plan are verbatim: `ℹ`/`⚠` lines, errors, link lines, alert texts and doc headings. `${…}` marks a value. `rel(x)` is `path.relative(project.root, x)`.
- Every task ends with `npm test && npm run lint` green. Every commit runs `npm run scan:private` after `git add`.
- Commits use Conventional Commits in English, with the subject given in the task (≤ 50 characters), no body, one logical change each, and no scratch code. Task 10 is run by the controller with Willy; implementers never need the device, the Apple ID or GitHub.
- **Failure-walk owners** (spec table as amended):

  | # | Ruling | Owner |
  |---|---|---|
  | 1 | handle | Task 1 policy tests `keeps trying while access is denied, then gives up after 5 minutes` and the four alert tests; Task 9 red-screen and alert text; Task 10 Step 3 |
  | 2 | accept | Task 1 plan note; Task 9 red-screen text ("If it stays…") |
  | 3 | handle | Task 1 policy tests `reloads at most once per failure`, `never reloads after a bundle loaded` and `does not reload when Metro was reachable at once`; Task 10 Steps 1–2 (bundling error with Metro up) |
  | 4 | handle | Task 1 policy test `waits for the foreground`; the glue reads `applicationState` |
  | 5 | handle | Task 2 tests (target generated and depended on). A compile error in the helper would fail every non-dev-client build: Task 1 `compiles for iOS` (`-fobjc-arc -Wall -Wextra -Werror`; runs where the Darwin SDK exists, skipped in CI). Task 10 Steps 1–2 on SDK 57, SDK 58 and bare 0.88 |
  | 6 | handle | Task 1 test `the names exist in each pinned React Native`; names as strings plus `dlsym` (no build break); Task 1 iOS compile test |
  | 7 | accept | Task 3 plan note; `start`'s existing ip-mismatch refusal (`tests/start.test.ts` "rejects with the ip message when the LAN IP changed") |
  | 8 | accept | Task 3 plan note; Task 9 dev-client text |
  | 9 | handle | Task 4 tests `prints the link as text without a TTY` and `drops the QR code in a narrow terminal` |
  | 10 | handle | Task 4 test `without a URL scheme, says what to enter in the launcher` |
  | 11 | handle | Task 4b `records the installed id`; Task 4c `announces the installed id`; Task 10 Step 4 with the filter on |
  | 12 | accept | Task 9 icon text (delete the app or restart the phone); CHANGELOG Upgrading |
  | 13 | handle | Task 5 tests (missing set, no PNG listed, not a PNG) |
  | 14 | handle | Task 6 test `warns when the app config icon changed since build ran expo prebuild`; build.test `records the app config icon when it runs expo prebuild` |
  | 15 | handle | Task 5 test `pins xtool.yml with iconPath`; Task 9 RELEASING device item; Task 10 Step 5 |
  | 16 | handle | Task 7 tests (one check before the first download, per filesystem) |
  | 17 | handle | Task 8 test `a second run downloads nothing`; Task 7 leftover-staging test; Task 10 Step 6 |
  | 18 | handle | Task 4c test `keeps Expo's announcement when ours cannot start` |
  | 19 | handle | Task 4c tests `warns once when the announcement fails on the LAN interface later`, `ignores errors on other network interfaces (a Docker veth)`, `ignores errors that name no interface (a Docker bridge's send errors)` |
  | 20 | handle | Task 4b test `reads no id it cannot match`; Task 4c test `without an installed id, keeps Expo's announcement` |
  | 21 | accept | Task 4b plan note: only a reinstall outside `rn-xtool install` leaves the recorded id stale; the next `install` records the new one |
  | 22 | accept | Task 4c plan note: a killed `start` leaves a dead entry until the record's TTL ends, as Expo's announcer does |
  | 23 | handle | Task 3 test `adds _expo._tcp for dev-client builds` |
  | 24 | handle | devServerAnnounce.test `announces nothing with another API than the 1.x one Expo uses`; start.test `keeps Expo's announcement when the project's dnssd-advertise has another API` |
  | 25 | handle | devServerAnnounce.test `reads the switches as Expo CLI does`; start.test `announces nothing when the user turned Bonjour off`. Accept: process env only, not the project's `.env` files (Task 9 text) |
  | 26 | accept | Willy, 2026-11-04: a non-Metro program on the baked port gives one reload, then the red screen as today |
  | 27 | accept | Willy, 2026-11-04: Don't Allow reported under another reason gives no alert; Task 10 Step 3 |

## Review Focus

1. The helper can never reload in a loop. A bundling error with Metro up must not reload at all. A loaded bundle disarms the helper for the life of the process (Task 1 policy tests).
2. The Local Network alert appears at most once per process. It never appears while the system prompt is up (the app is not active) or once Metro is reachable (Task 1 alert tests; Task 10 Step 3 on a device).
3. The helper never reaches a dev-client build, and a stale `Sources/RNXtoolDevSupport` is removed when a project gains the dev client (Task 2 `leaves the helper out of dev-client builds`).
4. The glue imports no React header. It uses only notification-name strings and `dlsym`, so a React Native rename makes it a no-op, never a build error. It compiles under ARC with `-Werror` (Task 1 compile test).
5. A user's own `DEV_CLIENT_DEFAULT_LAUNCHER_URL` is never overwritten (Task 3).
6. The dev-client link is always printed as text. A missing or broken `toqr`, a pipe, a narrow terminal or a missing scheme never throws (Task 4).
7. Expo's own Bonjour announcement is turned off only after ours started. A failure to read the installed id never fails `install` (Tasks 4b–4c).
8. A broken, missing or clashing icon never fails the build. A stale `ios-xtool/AppIcon.png` and its `iconPath` go away (Task 5).
9. `setup` starts no download before the space check, and a run that only prints the login hint checks no space (Tasks 7–8).
10. Before the final verdict, the reviewer answers without hints: "Name three ways this fails in production that no test covers." Any answer not in the spec's failure table goes to Willy as a decision, not to the implementer as a fix.

---

### Task 1: The auto-reload helper sources

Plan note (row 2, accept): with a wrong IP, a VPN or a Metro that never starts, the connection never becomes ready. The helper gives up 5 minutes after the first failure and the red screen stays, as today. `start` already refuses a changed LAN IP.

**Files:**
- Create: `templates/dev-support/include/RNXtoolDevSupport.h`, `templates/dev-support/RNXAutoReloadPolicy.c`, `templates/dev-support/RNXAutoReload.m`
- Modify: `tests/tarballs.json` (add `react-native@0.86.3` and `react-native@0.87.1`, with the integrity values above)
- Test: `tests/devSupport.test.ts` (new)

**Interfaces:**
- Produces `templates/dev-support/include/RNXtoolDevSupport.h` (verbatim):
  ```c
  // rn-xtool copies this file into ios-xtool/Sources/RNXtoolDevSupport on every build; edit it in rn-xtool's
  // templates/dev-support. The public header of the RNXtoolDevSupport target: the auto-reload policy.
  #pragma once
  #include <stdbool.h>

  #define RNX_GIVE_UP_SECONDS 300.0
  #define RNX_RETRY_SECONDS 2.0
  #define RNX_ALERT_AFTER_SECONDS 3.0

  /// What happened, as RNXAutoReload.m reports it.
  typedef enum {
    RNX_EVENT_BUNDLE_FAILED,         // RCTJavaScriptDidFailToLoadNotification
    RNX_EVENT_BUNDLE_LOADED,         // RCTJavaScriptDidLoadNotification or RCTInstanceDidLoadBundle
    RNX_EVENT_METRO_READY,           // the TCP connection to Metro's host and port is ready
    RNX_EVENT_METRO_UNREACHABLE,     // the connection waits or failed for another reason (Metro down, wrong IP)
    RNX_EVENT_LOCAL_NETWORK_DENIED,  // the connection waits because Local Network access is denied
    RNX_EVENT_RETRY_DUE,             // RNX_RETRY_SECONDS passed after RNX_ACTION_RETRY_LATER
    RNX_EVENT_FOREGROUND,            // UIApplicationDidBecomeActiveNotification
    RNX_EVENT_RESIGN_ACTIVE,         // UIApplicationWillResignActiveNotification (a system prompt, the app switcher)
    RNX_EVENT_BACKGROUND,            // UIApplicationDidEnterBackgroundNotification
  } rnx_event;

  /// What RNXAutoReload.m does next.
  typedef enum {
    RNX_ACTION_NONE,
    RNX_ACTION_CONNECT,      // open a new connection to Metro (closing any other)
    RNX_ACTION_RETRY_LATER,  // send RNX_EVENT_RETRY_DUE in RNX_RETRY_SECONDS
    RNX_ACTION_DISCONNECT,   // close the connection; the failure stays pending
    RNX_ACTION_RELOAD,       // close the connection and reload once
    RNX_ACTION_STOP,         // close the connection and give up on this failure
  } rnx_action;

  typedef struct {
    bool loaded;              // a bundle loaded: never reload again in this process
    bool pending;             // a load failure waits for Metro
    bool connecting;          // a connection to Metro is open
    bool saw_unreachable;     // Metro was out of reach at some point since that failure
    bool retry_scheduled;     // an RNX_EVENT_RETRY_DUE is on its way
    bool foreground;          // the app is not in the background; set before RNX_EVENT_BUNDLE_FAILED
    bool active;              // the app is active: no system prompt over it
    bool alerted;             // the Local Network alert was shown in this process
    double first_failure_at;  // seconds; below 0 until the first failure
    double active_since;      // when the app last became active; below 0 before
    double denied_since;      // first denied report of the current denied streak; below 0 when not denied
  } rnx_state;

  void rnx_init(rnx_state *state);
  rnx_action rnx_step(rnx_state *state, rnx_event event, double now);
  /// True once per process, when Local Network access has been denied for RNX_ALERT_AFTER_SECONDS while the app was
  /// active, a load failure is pending and the 5 minutes have not passed. Marks the alert as shown.
  bool rnx_should_alert(rnx_state *state, double now);
  ```
- Produces `templates/dev-support/RNXAutoReloadPolicy.c` (verbatim, apart from formatting):
  ```c
  // rn-xtool copies this file into ios-xtool/Sources/RNXtoolDevSupport on every build; edit it in rn-xtool's
  // templates/dev-support. When to connect, reload, give up or alert. No I/O: tests/devSupport.test.ts runs it on Linux.
  #include "RNXtoolDevSupport.h"

  void rnx_init(rnx_state *s) {
    *s = (rnx_state){.foreground = true, .first_failure_at = -1, .active_since = -1, .denied_since = -1};
  }

  static bool rnx_expired(const rnx_state *s, double now) {
    return s->first_failure_at >= 0 && now - s->first_failure_at > RNX_GIVE_UP_SECONDS;
  }

  static rnx_action rnx_give_up(rnx_state *s) {
    s->pending = s->connecting = false;
    return RNX_ACTION_STOP;
  }

  rnx_action rnx_step(rnx_state *s, rnx_event event, double now) {
    switch (event) {
      case RNX_EVENT_BUNDLE_LOADED:
        s->loaded = true;
        if (!s->pending && !s->connecting) return RNX_ACTION_NONE;
        return rnx_give_up(s);
      case RNX_EVENT_BUNDLE_FAILED:
        if (s->loaded || s->pending) return RNX_ACTION_NONE;
        if (s->first_failure_at < 0) s->first_failure_at = now;
        if (rnx_expired(s, now)) return RNX_ACTION_NONE;
        s->pending = true;
        // In the background iOS denies local network access without asking (TN3179): count it as out of reach.
        s->saw_unreachable = !s->foreground;
        if (!s->foreground) return RNX_ACTION_NONE;
        s->connecting = true;
        return RNX_ACTION_CONNECT;
      case RNX_EVENT_METRO_READY:
        s->denied_since = -1;
        if (!s->connecting) return RNX_ACTION_NONE;
        s->pending = s->connecting = false;
        // Reachable at once: the load failed for another reason (a bundling error), and a reload would fail again.
        return s->saw_unreachable && s->foreground ? RNX_ACTION_RELOAD : RNX_ACTION_STOP;
      case RNX_EVENT_METRO_UNREACHABLE:
      case RNX_EVENT_LOCAL_NETWORK_DENIED:
        if (event == RNX_EVENT_LOCAL_NETWORK_DENIED) {
          if (s->denied_since < 0) s->denied_since = now;
        } else {
          s->denied_since = -1;
        }
        if (!s->connecting) return RNX_ACTION_NONE;
        s->saw_unreachable = true;
        if (rnx_expired(s, now)) return rnx_give_up(s);
        if (s->retry_scheduled) return RNX_ACTION_NONE;
        s->retry_scheduled = true;
        return RNX_ACTION_RETRY_LATER;
      case RNX_EVENT_RETRY_DUE:
        s->retry_scheduled = false;
        if (!s->pending || !s->connecting || !s->foreground) return RNX_ACTION_NONE;
        if (rnx_expired(s, now)) return rnx_give_up(s);
        return RNX_ACTION_CONNECT;
      case RNX_EVENT_RESIGN_ACTIVE:
        s->active = false;
        return RNX_ACTION_NONE;
      case RNX_EVENT_BACKGROUND:
        s->foreground = s->active = false;
        if (!s->connecting) return RNX_ACTION_NONE;
        s->connecting = false;
        return RNX_ACTION_DISCONNECT;
      case RNX_EVENT_FOREGROUND:
        s->foreground = s->active = true;
        s->active_since = now;
        if (!s->pending || s->connecting) return RNX_ACTION_NONE;
        if (rnx_expired(s, now)) return rnx_give_up(s);
        s->connecting = true;
        return RNX_ACTION_CONNECT;
    }
    return RNX_ACTION_NONE;
  }

  bool rnx_should_alert(rnx_state *s, double now) {
    if (s->alerted || s->loaded || !s->pending || !s->active || s->denied_since < 0 || rnx_expired(s, now)) return false;
    // The system's Local Network prompt makes the app inactive: count only denials seen while nothing covers the app.
    double since = s->denied_since > s->active_since ? s->denied_since : s->active_since;
    if (now - since < RNX_ALERT_AFTER_SECONDS) return false;
    s->alerted = true;
    return true;
  }
  ```
- Produces `templates/dev-support/RNXAutoReload.m` (near-verbatim: keep the names, the check order, the braces on every `case` and the comments):
  ```objc
  // rn-xtool copies this file into ios-xtool/Sources/RNXtoolDevSupport on every build; edit it in rn-xtool's
  // templates/dev-support.
  //
  // Reloads the app once when React Native could not load the JS bundle and Metro then becomes reachable. On the
  // first launch iOS denies React Native's request to Metro while the Local Network prompt is open (Apple TN3179), and
  // an app opened before `rn-xtool start` finds no Metro: both end on the red screen "No script URL provided". When
  // Local Network access stays denied, it shows one alert that leads to Settings. The decisions live in
  // RNXAutoReloadPolicy.c; this file connects them to React Native, UIKit and Network.framework.
  //
  // Only public React Native names, looked up at run time: if React Native renames one, this does nothing and the app
  // behaves as before. rn-xtool generates this target only for Debug builds without expo-dev-client.
  #if DEBUG
  #import <Foundation/Foundation.h>
  #import <Network/Network.h>
  #import <UIKit/UIKit.h>
  #include <dlfcn.h>
  #include "RNXtoolDevSupport.h"

  // React/Base/RCTConstants.h and RCTReloadCommand.h. React Native 0.86 posts RCTInstanceDidLoadBundle (a literal,
  // not a public constant) but not RCTJavaScriptDidLoadNotification in the new architecture; if it is ever renamed,
  // the worst case is one extra reload after a manual Reload. tests/devSupport.test.ts checks each name against the
  // pinned React Native releases.
  static NSString *const RNXBundleFailed = @"RCTJavaScriptDidFailToLoadNotification";
  static NSString *const RNXBundleLoaded = @"RCTJavaScriptDidLoadNotification";
  static NSString *const RNXInstanceLoaded = @"RCTInstanceDidLoadBundle";
  static const char *const RNXReloadSymbol = "RCTTriggerReloadCommandListeners";

  static NSString *const RNXAlertTitle = @"Local Network access is off";
  static NSString *const RNXAlertMessage =
      @"This debug build loads its JavaScript from Metro on your computer, which needs Local Network access. Turn it "
      @"on for this app in Settings (Privacy & Security → Local Network), then come back. If the red screen stays, "
      @"tap Reload.";

  typedef void (*RNXReloadFunction)(NSString *reason);

  static void RNXOnMain(dispatch_block_t block) {
    if (NSThread.isMainThread) block();
    else dispatch_async(dispatch_get_main_queue(), block);
  }

  @interface RNXAutoReload : NSObject
  @end

  @implementation RNXAutoReload {
    rnx_state _state;  // like everything below, used on the main queue only
    nw_connection_t _connection;
    NSString *_host;
    NSString *_port;
  }

  + (void)load {
    static RNXAutoReload *shared;
    shared = [RNXAutoReload new];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:shared selector:@selector(bundleFailed) name:RNXBundleFailed object:nil];
    [center addObserver:shared selector:@selector(bundleLoaded) name:RNXBundleLoaded object:nil];
    [center addObserver:shared selector:@selector(bundleLoaded) name:RNXInstanceLoaded object:nil];
    [center addObserver:shared selector:@selector(foreground) name:UIApplicationDidBecomeActiveNotification object:nil];
    [center addObserver:shared selector:@selector(resignActive) name:UIApplicationWillResignActiveNotification object:nil];
    [center addObserver:shared selector:@selector(background) name:UIApplicationDidEnterBackgroundNotification object:nil];
  }

  - (instancetype)init {
    if ((self = [super init])) rnx_init(&_state);
    return self;
  }

  - (void)bundleFailed {
    RNXOnMain(^{
      if (self->_host == nil && ![self readMetroAddress]) return;
      if (dlsym(RTLD_DEFAULT, RNXReloadSymbol) == NULL) {
        NSLog(@"[rn-xtool] %s not found: the app will not reload by itself once Metro is reachable", RNXReloadSymbol);
        return;
      }
      self->_state.foreground = UIApplication.sharedApplication.applicationState != UIApplicationStateBackground;
      [self step:RNX_EVENT_BUNDLE_FAILED];
    });
  }
  - (void)bundleLoaded { RNXOnMain(^{ [self step:RNX_EVENT_BUNDLE_LOADED]; }); }
  - (void)foreground { RNXOnMain(^{ [self step:RNX_EVENT_FOREGROUND]; }); }
  - (void)resignActive { RNXOnMain(^{ [self step:RNX_EVENT_RESIGN_ACTIVE]; }); }
  - (void)background { RNXOnMain(^{ [self step:RNX_EVENT_BACKGROUND]; }); }

  - (void)step:(rnx_event)event {
    double now = NSProcessInfo.processInfo.systemUptime;
    switch (rnx_step(&_state, event, now)) {
      case RNX_ACTION_NONE: {
        break;
      }
      case RNX_ACTION_CONNECT: {
        [self connect];
        break;
      }
      case RNX_ACTION_RETRY_LATER: {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(RNX_RETRY_SECONDS * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{ [self step:RNX_EVENT_RETRY_DUE]; });
        break;
      }
      case RNX_ACTION_DISCONNECT:
      case RNX_ACTION_STOP: {
        [self disconnect];
        break;
      }
      case RNX_ACTION_RELOAD: {
        [self disconnect];
        RNXReloadFunction reload = (RNXReloadFunction)dlsym(RTLD_DEFAULT, RNXReloadSymbol);
        if (reload != NULL) reload(@"rn-xtool: Metro is reachable");
        break;
      }
    }
    if (rnx_should_alert(&_state, now)) [self showLocalNetworkAlert];
  }

  // The address React Native uses. Bare apps carry host:port in ip.txt. Expo apps carry the host in ip.txt and the
  // port in Info.plist's RCTMetroPort, which ExpoReactNativeFactory turns into RCTBundleURLProvider's jsLocation.
  - (BOOL)readMetroAddress {
    NSString *file = [NSBundle.mainBundle pathForResource:@"ip" ofType:@"txt"];
    NSString *text = file ? [NSString stringWithContentsOfFile:file encoding:NSUTF8StringEncoding error:NULL] : nil;
    text = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (text.length == 0) return NO;
    NSRange colon = [text rangeOfString:@":" options:NSBackwardsSearch];
    id port;
    if (colon.location != NSNotFound) {
      _host = [text substringToIndex:colon.location];
      port = [text substringFromIndex:NSMaxRange(colon)];
    } else {
      _host = text;
      port = [NSBundle.mainBundle objectForInfoDictionaryKey:@"RCTMetroPort"];
      if ([port isKindOfClass:NSNumber.class]) port = [port stringValue];
    }
    _port = [port isKindOfClass:NSString.class] && [port length] > 0 ? port : @"8081";
    return _host.length > 0;
  }

  - (void)connect {
    [self disconnect];
    nw_endpoint_t endpoint = nw_endpoint_create_host(_host.UTF8String, _port.UTF8String);
    nw_parameters_t parameters =
        nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_connection_t connection = nw_connection_create(endpoint, parameters);
    _connection = connection;
    nw_connection_set_queue(connection, dispatch_get_main_queue());
    __weak nw_connection_t weakConnection = connection;
    nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, __unused nw_error_t error) {
      nw_connection_t current = weakConnection;
      if (current == nil || current != self->_connection) return;  // replaced or cancelled
      if (state == nw_connection_state_ready) {
        [self step:RNX_EVENT_METRO_READY];
      } else if (state == nw_connection_state_waiting || state == nw_connection_state_failed) {
        nw_path_t path = nw_connection_copy_current_path(current);
        BOOL denied = path != nil &&
                      nw_path_get_unsatisfied_reason(path) == nw_path_unsatisfied_reason_local_network_denied;
        [self step:denied ? RNX_EVENT_LOCAL_NETWORK_DENIED : RNX_EVENT_METRO_UNREACHABLE];
      }
    });
    nw_connection_start(connection);
  }

  - (void)disconnect {
    if (_connection == nil) return;
    nw_connection_t connection = _connection;
    _connection = nil;
    nw_connection_cancel(connection);
  }

  // Presented from the topmost view controller: the red box is itself presented over the key window's root.
  - (void)showLocalNetworkAlert {
    UIViewController *top = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (scene.activationState != UISceneActivationStateForegroundActive) continue;
      if (![scene isKindOfClass:UIWindowScene.class]) continue;
      top = ((UIWindowScene *)scene).keyWindow.rootViewController;
      break;
    }
    while (top.presentedViewController != nil) top = top.presentedViewController;
    if (top == nil) return;
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:RNXAlertTitle
                                                                   message:RNXAlertMessage
                                                            preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Open Settings"
                                              style:UIAlertActionStyleDefault
                                            handler:^(__unused UIAlertAction *action) {
                                              NSURL *settings = [NSURL URLWithString:UIApplicationOpenSettingsURLString];
                                              if (settings != nil) {
                                                [UIApplication.sharedApplication openURL:settings
                                                                                 options:@{}
                                                                       completionHandler:nil];
                                              }
                                            }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Not Now" style:UIAlertActionStyleCancel handler:nil]];
    [top presentViewController:alert animated:YES completion:nil];
  }

  @end
  #endif
  ```
  Notes:
  - TN3179: while access is denied, the connection waits with `localNetworkDenied`, and iOS retries it on its own once access is granted. The 2 s reconnect also covers Metro starting late.
  - `nw_path_get_unsatisfied_reason` is iOS 14.2+ and `UIWindowScene.keyWindow` is iOS 15+, both below `IOS_MIN` 16.4, so no `@available` guard is needed.
  - Every `case` body is braced: an unbraced block literal inside a `switch` is a hard error under ARC (preflight F1).

- [ ] **Step 1: Write the failing tests** in `tests/devSupport.test.ts`:
  - **Policy, run with the host `cc`** (title suffix ` (needs cc)` when `hasTool("cc")` is false).
    - The test writes a driver `main.c` into a temp dir. It reads lines `<event> <time>` from stdin. The events are `failed`, `failed-bg` (sets `foreground = false`, then `failed`), `loaded`, `ready`, `unreachable`, `denied`, `retry`, `foreground`, `resign` and `background`.
    - For each line it prints the action name (`none`, `connect`, `retry-later`, `disconnect`, `reload` or `stop`). It appends `+alert` when `rnx_should_alert` returns true after that step.
    - The test compiles it with `cc -std=c11 -Wall -Wextra -Werror -I templates/dev-support/include templates/dev-support/RNXAutoReloadPolicy.c main.c`, then feeds each script:
      - `reloads after Allow`: `failed 0, unreachable 0.1, unreachable 0.2, retry 2.1, ready 5, loaded 6` → `connect, retry-later, none, connect, reload, none`.
      - `recovers an app opened before Metro`: `failed 0, unreachable 0, retry 2, unreachable 2, retry 4, ready 4.5` → `connect, retry-later, connect, retry-later, connect, reload`.
      - `does not reload when Metro was reachable at once` (row 3, bundling error): `failed 0, ready 0.1, failed 1, ready 1.1` → `connect, stop, connect, stop`.
      - `reloads at most once per failure` (row 3): `failed 0, unreachable 0.1, retry 2, ready 3, ready 3.1, unreachable 3.2, retry 5` → `connect, retry-later, connect, reload, none, none, none`.
      - `never reloads after a bundle loaded` (row 3): `failed 0, loaded 0.5, ready 1, failed 2` → `connect, stop, none, none`.
      - `keeps trying while access is denied, then gives up after 5 minutes` (rows 1–2): `failed 0, unreachable 1, retry 299, unreachable 300.5, retry 302, foreground 303, failed 400` → `connect, retry-later, connect, stop, none, none, none`.
      - `waits for the foreground` (row 4): `failed-bg 0, retry 2, foreground 3, ready 3.1` → `none, none, connect, reload`. Also `failed 0, unreachable 0.1, background 1, retry 2, ready 2.5, foreground 10` → `connect, retry-later, disconnect, none, none, connect`.
      - `no alert while the system prompt is up` (row 1): `foreground 0, failed 0.1, resign 0.2, denied 0.3, retry 2.3, denied 2.4, retry 4.4, denied 4.5` → `none, connect, none, retry-later, connect, retry-later, connect, retry-later`.
      - `alerts once after Don't Allow` (row 1): `foreground 0, failed 0.1, resign 0.2, denied 0.3, retry 2.3, denied 2.4, retry 4.4, foreground 5, denied 5.1, retry 7.1, denied 7.2, retry 9.2, denied 9.3, retry 11.3, denied 11.4` → `none, connect, none, retry-later, connect, retry-later, connect, none, retry-later, connect, retry-later, connect+alert, retry-later, connect, retry-later`. The alert fires on the first step 3 s after the app became active while still denied (`retry 9.2`), and never again.
      - `no alert once access is allowed`: `foreground 0, failed 0.1, resign 0.2, denied 0.3, foreground 2, retry 2.3, ready 2.5, denied 6` → `none, connect, none, retry-later, none, connect, reload, none`.
      - `no alert when Metro is down but access is allowed`: `foreground 0, failed 0.1, unreachable 0.2, retry 2.2, unreachable 2.3, retry 4.3, unreachable 4.4` → `none, connect, retry-later, connect, retry-later, connect, retry-later`.
  - **`the names exist in each pinned React Native`** (row 6). `describe.each` over `react-native@0.86.3`, `react-native@0.87.1` and `react-native@0.88.1`, with `needsTarball` in the title, read through `packageFromTarball`:
    - `React/Base/RCTConstants.h` contains `RCT_EXTERN NSString *const RCTJavaScriptDidFailToLoadNotification;`;
    - `React/Base/RCTConstants.m` contains `NSString *const RCTJavaScriptDidFailToLoadNotification = @"RCTJavaScriptDidFailToLoadNotification";` and `NSString *const RCTJavaScriptDidLoadNotification = @"RCTJavaScriptDidLoadNotification";`;
    - `React/Base/RCTReloadCommand.h` contains `RCT_EXTERN void RCTTriggerReloadCommandListeners(NSString *reason);`;
    - `ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm` contains `postNotificationName:RCTJavaScriptDidFailToLoadNotification`, and at least one of `postNotificationName:RCTJavaScriptDidLoadNotification` and `postNotificationName:@"RCTInstanceDidLoadBundle"`.
  - **`the glue uses those names as strings`**:
    - `RNXAutoReload.m` contains `@"RCTJavaScriptDidFailToLoadNotification"`, `@"RCTJavaScriptDidLoadNotification"`, `@"RCTInstanceDidLoadBundle"`, `"RCTTriggerReloadCommandListeners"` and `dlsym(RTLD_DEFAULT`;
    - it has no `#import <React` and no `#include <React`;
    - its first code line is `#if DEBUG` and it ends with `#endif`.
  - **`compiles for iOS`** (row 5). Title suffix ` (needs the Darwin SDK and the Swift toolchain's clang: rn-xtool setup)` when `<sdkBundle()>/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk` or `clang` on `toolEnv().PATH` is missing.
    - For the `.m`, with `-fobjc-arc`: `clang -fsyntax-only -Wall -Wextra -Werror -target arm64-apple-ios16.4 -isysroot <sdk> -DDEBUG=1 -I templates/dev-support/include <file>` exits 0.
    - For the `.c`: the same command, without `-fobjc-arc`.
- [ ] **Step 2: Add the two tarballs** to `tests/tarballs.json`, then run `node scripts/fetch-test-tarballs.mjs`. Run `npx vitest run tests/devSupport.test.ts` → FAIL (templates missing).
- [ ] **Step 3: Write** the three template files.
- [ ] **Step 4: Run** `npx vitest run tests/devSupport.test.ts` → PASS, with the iOS compile test running on this host. Then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add templates tests && npm run scan:private && git commit -m "feat: add the Metro auto-reload helper sources"`

### Task 2: Generate the helper target

Plan note (accept, preflight G3): an app built by an older rn-xtool and installed with this one gets the new checklist line without the helper. CHANGELOG Upgrading says to rebuild.

**Files:**
- Modify:
  - `src/generate/packageSwift.ts` (`PackageSwiftInput.devSupport`, `renderPackageSwift`);
  - `src/generate/iosXtool.ts` (`writeIosXtool`);
  - `src/commands/install.ts` (`firstRunChecklist` and its two callers);
  - `package.json` (`files`).
- Test: `tests/generate.test.ts`, `tests/install.test.ts`, `tests/devSupport.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/generate/packageSwift.ts
  export const DEV_SUPPORT_TARGET = "RNXtoolDevSupport";
  export interface PackageSwiftInput { /* … */ devSupport?: boolean }   // absent or false: manifest unchanged
  // src/generate/iosXtool.ts
  export function devSupportTemplatesDir(): string;   // path.join(packageRoot(), "templates", "dev-support")
  // src/commands/install.ts
  export function firstRunChecklist(appleId: string | undefined, opts?: { devClient?: boolean }): string;
  ```
- `renderPackageSwift` with `devSupport: true`:
  - adds the line `                "RNXtoolDevSupport",` as the last entry of the App target's `dependencies`;
  - after the App target's closing `),`, adds this target, verbatim. The settings restate what Swift Build already does (`-fobjc-arc`, `DEBUG=1`). The `+load` class is kept because Swift Build links each target's object file directly.
  ```swift
          .target(
              name: "RNXtoolDevSupport",
              path: "Sources/RNXtoolDevSupport",
              cSettings: [
                  .define("DEBUG", to: "1", .when(configuration: .debug)),
                  .unsafeFlags(["-fobjc-arc"]),
              ],
              linkerSettings: [
                  .linkedFramework("Network"),
                  .linkedFramework("UIKit"),
              ]
          ),
  ```
- `writeIosXtool`:
  - always runs `rm -rf ios-xtool/Sources/RNXtoolDevSupport`;
  - when `!project.hasDevClient`, copies `templates/dev-support/` there (byte for byte, keeping `include/`) and passes `devSupport: true`.
- Checklist line (the line at `install.ts:79` today), verbatim:
  - without a dev client: `'  - On the first launch iOS asks for Local Network access, and the red screen "No script URL provided" may show behind it: tap Allow, and the app reloads by itself.'`
  - with `devClient: true`: `"  - On the first launch the dev launcher asks for Local Network access: tap Allow, then open the link or QR code above, or enter the Metro URL above in the launcher."`
  - `install` and `installNetwork` pass `{ devClient: state.hasDevClient === true }`.
- `package.json` `files` gains `"templates"`, after `"shims"`.

- [ ] **Step 1: Write the failing tests:**
  - generate.test `renders the dev-support target` → `renderPackageSwift({ …, app: noApp, devSupport: true })`:
    - the manifest contains the target block above exactly once;
    - the App `dependencies` end with `"RNXtoolDevSupport",`;
    - for a mixed app, `manifest65` contains the same block.
  - The existing `keeps the Expo manifest unchanged` snapshot still passes without `devSupport`.
  - generate.test `writes the helper for an app without the dev client` → after `writeIosXtool` on the "writes the package" project (`hasDevClient: false`):
    - `ios-xtool/Sources/RNXtoolDevSupport/{RNXAutoReload.m,RNXAutoReloadPolicy.c,include/RNXtoolDevSupport.h}` equal the templates byte for byte;
    - `Package.swift` contains `name: "RNXtoolDevSupport"`;
    - `readdir(paths.sources)` is unchanged.
  - generate.test `leaves the helper out of dev-client builds` (Review Focus 3) → write with `hasDevClient: false`, then with `hasDevClient: true`: the folder is gone and `Package.swift` has no `RNXtoolDevSupport`. Repeat for the `bareProject()` helper.
  - install.test → the two exact lines: one with `readState` returning `hasDevClient: true`, the other without.
  - devSupport.test `ships the templates` → `package.json` `files` includes `"templates"`.
- [ ] **Step 2: Run** `npx vitest run tests/generate.test.ts tests/install.test.ts tests/devSupport.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS. Then run `npm pack --dry-run 2>&1 | grep templates/dev-support` (npm prints the file list on stderr; this also runs `prepare`) → three files listed.
- [ ] **Step 5: Commit** `git add src tests package.json && npm run scan:private && git commit -m "feat: reload the app once Metro is reachable"`

### Task 3: The dev launcher's Info.plist keys

Plan notes:
- Row 7 (accept): when the LAN IP changes after a build, the launcher falls back to its list, as today, and `start` refuses and asks for a rebuild.
- Row 8 (accept): with "most recent" launch mode, a stale last URL is tried first for up to 10 s; that is launcher behaviour.
- The default URL is not used on the first launch after an install (the launcher's permission flag is still false). Task 4's link covers that launch.

**Files:**
- Modify: `src/plist.ts` (`InfoPlistOptions`, `transformInfoPlist`), `src/generate/iosXtool.ts` (`writeIosXtool`: the options and the comment at lines 132-134)
- Test: `tests/plist.test.ts`, `tests/generate.test.ts`

**Interfaces:**
- Produces: `InfoPlistOptions.devClientUrl?: string`. When it is set:
  - `transformInfoPlist` writes `DEV_CLIENT_DEFAULT_LAUNCHER_URL = devClientUrl`, unless the template already has a non-empty string there (an empty string counts as unset), so a user's `defaultLaunchURL` wins;
  - it adds `_expo._tcp` to `NSBonjourServices` when missing (row 23, preflight F16). A bare app with the dev client never runs Expo prebuild, which is what adds it.

  `writeIosXtool` passes `devClientUrl: project.hasDevClient ? \`http://${ctx.lanIp}:${ctx.metroPort}\` : undefined`.
- The comment above the `ip.txt` write becomes (verbatim):
  ```ts
  // React Native reads the packager host from ip.txt (RCTBundleURLProvider.guessPackagerHost) and uses a host with a
  // colon verbatim; otherwise it adds the compile-time RCT_METRO_PORT, 8081 in the prebuilt React framework. Bare: ip.txt
  // holds host:port. Expo: ip.txt holds the host only, and in Debug without the dev launcher Expo's
  // ExpoReactNativeFactory (adoptInfoPlistMetroPort) sets RCTBundleURLProvider's jsLocation to <ip.txt>:<RCTMetroPort>.
  // The RNXtoolDevSupport helper reads the same pair. expo-dev-launcher reads neither: it finds Metro over Bonjour, from
  // DEV_CLIENT_DEFAULT_LAUNCHER_URL or from a deep link.
  ```

- [ ] **Step 1: Write the failing tests:**
  - plist.test `bakes the dev launcher's default URL` → `transformInfoPlist(template, { vars, metroPort: 8082, devClientUrl: "http://192.168.1.20:8082" })` → `DEV_CLIENT_DEFAULT_LAUNCHER_URL === "http://192.168.1.20:8082"`.
  - plist.test `keeps the project's own default URL` → a template with `<key>DEV_CLIENT_DEFAULT_LAUNCHER_URL</key><string>http://192.168.1.2:8081</string>` keeps it. With `<string></string>`, the key is replaced.
  - plist.test `adds _expo._tcp for dev-client builds` (row 23) → with `devClientUrl`, `NSBonjourServices` holds `_expo._tcp` and `_http._tcp` once each. A template that already lists `_expo._tcp` keeps it once.
  - plist.test `adds nothing without a dev client` → no `devClientUrl` → no launcher key and no `_expo._tcp`.
  - generate.test `sets the launcher keys for dev-client projects only` → with `hasDevClient: true`, `lanIp: "192.168.1.5"` and `metroPort: 8083`, `ios-xtool/Info.plist` has `http://192.168.1.5:8083` and `_expo._tcp`. With `hasDevClient: false`, neither.
- [ ] **Step 2: Run** `npx vitest run tests/plist.test.ts tests/generate.test.ts` → FAIL.
- [ ] **Step 3: Implement** the options and the comment.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: set the dev launcher's Info.plist keys"`

### Task 4: `install` prints the dev-client link and QR code

Plan note (accept, ruling Q2 and preflight G2): `start` prints no QR code. `expo start` prints its own dev-client QR code when expo-dev-client is a direct dependency. A bare app with the dev client (`react-native start`), or a Metro that is already running, gets none from `start`; the link `install` printed still works.

**Files:**
- Create: `src/project/requireFromProject.ts`, `src/devClientLink.ts`
- Modify: `src/commands/install.ts` (`logDevLauncherUrl` → `logDevLauncherLink`, `InstallDeps.devClientLink`), `tests/tarballs.json` (add `toqr@0.1.1`)
- Test: `tests/devClientLink.test.ts` (new), `tests/install.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/project/requireFromProject.ts
  /** `pkg` as the project would load it: resolved from the root, else through expo → @expo/cli (npm may nest it there),
   *  with createRequire(<dir>/package.json) as packageDirFrom in src/project/expo.ts does. Undefined when it is not
   *  found or throws while loading. Never throws. Used by install (toqr) and start (dnssd-advertise) only. */
  export function requireFromProject(root: string, pkg: string): unknown;
  // src/devClientLink.ts
  /** CFBundleURLTypes[].CFBundleURLSchemes[] of an Info.plist: the longest exp+ scheme, else the longest; undefined
   *  when there is none or the plist does not parse (Expo CLI's rule, utils/scheme.js resolveExpoOrLongestScheme). */
  export function devClientScheme(infoPlistXml: string): string | undefined;
  /** `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`: the legacy form SDK 57 and 58 accept. */
  export function devClientDeepLink(scheme: string, metroUrl: string): string;
  export type QrEncoder = (text: string) => Uint8Array;   // one byte per module, row-major, 1 = dark
  /** toqr's toQR through requireFromProject; undefined when missing or not a function. */
  export function loadQrEncoder(root: string): QrEncoder | undefined;
  /** Half-block rendering with a 2-module light border: two module rows per text line. */
  export function renderQr(modules: Uint8Array): string[];
  export interface LinkIo {
    readInfoPlist: (root: string) => Promise<string | undefined>;   // ios-xtool/Info.plist, undefined when missing
    qrEncoder: (root: string) => QrEncoder | undefined;
    isTTY: boolean;               // process.stdout.isTTY === true
    columns: number | undefined;  // process.stdout.columns
  }
  export async function devClientLinkLines(
    root: string, state: { lanIp: string; metroPort: number }, io?: Partial<LinkIo>,
  ): Promise<string[]>;   // never throws
  // install: InstallDeps.devClientLink?: (root, state) => Promise<string[]> (default devClientLinkLines)
  ```
- `devClientLinkLines` output (verbatim). `${url}` is `http://${lanIp}:${metroPort}`; `${link}` is `devClientDeepLink(scheme, url)`.
  1. Always first: `Metro URL for the dev launcher: ${url}` (today's line, unchanged).
  2. With a scheme, an encoder, a TTY, and `columns` undefined or at least the QR width (`side + 4`): `Scan this QR code with the iPhone camera to open the app on that Metro server:`, then the `renderQr` lines, then `Or open this link on the iPhone: ${link}`.
  3. With a scheme but no QR code (no TTY, narrow terminal, no encoder, or an encoder that throws): `Open this link on the iPhone to open the app on that Metro server: ${link}`.
  4. Without a scheme (row 10): `ℹ ios-xtool/Info.plist has no URL scheme, so there is no link to open the dev client: enter ${url} in the dev launcher.`
- `renderQr` rule (Expo CLI's `createHalfblockOutput`): both modules light = `█`, both dark = space, upper dark only = `▄`, lower dark only = `▀`. An odd last row pairs with a light row.
- `install` (USB and Wi‑Fi), after the `Installed …` line:
  - with `state.hasDevClient === true`, prints the `devClientLinkLines` lines;
  - a state written before bare support (no `kind`, no `hasDevClient`) prints only line 1, as today;
  - otherwise prints nothing.

- [ ] **Step 1: Add** `toqr@0.1.1` to `tests/tarballs.json`, then run `node scripts/fetch-test-tarballs.mjs`. **Write the failing tests:**
  - devClientLink.test `picks the dev-client scheme like Expo CLI` →
    - `["myapp", "exp+my-app"]` → `exp+my-app`;
    - `["a", "longer"]` → `longer`;
    - no `CFBundleURLTypes` → `undefined`;
    - invalid XML → `undefined`.
  - devClientLink.test `builds the legacy deep link` → `devClientDeepLink("exp+app", "http://192.168.1.20:8082")` equals `exp+app://expo-development-client/?url=http%3A%2F%2F192.168.1.20%3A8082`.
  - devClientLink.test `renders half blocks with a border` → the 2×2 matrix `[1,0,0,1]` gives exactly `["██████", "██▄▀██", "██████"]`.
  - devClientLink.test `loads packages from the project` → `requireFromProject` finds a stub at `<tmp>/node_modules/toqr`, and at `<tmp>/node_modules/expo/node_modules/@expo/cli/node_modules/toqr` (with `expo/package.json` and `@expo/cli/package.json` stubs). With none → `undefined`. With a stub that throws on load → `undefined`. `loadQrEncoder` on a stub exporting `{}` → `undefined`.
  - devClientLink.test `the real toqr draws a QR code` (`needsTarball("toqr@0.1.1")`) → `loadQrEncoder(path.resolve(packageFromTarball("toqr@0.1.1")!, "..", ".."))` encodes the deep link above:
    - the length is `n*n` with `n >= 21` and `n % 4 === 1`;
    - row 0, columns 0–6 are `1`; row 1, columns 1–5 are `0`; rows 2–4, columns 2–4 are `1`.
  - devClientLink.test `prints the QR code and the link in a terminal` → injected `readInfoPlist` with the `exp+app` scheme, a fake 21×21 encoder, `isTTY: true` and `columns: 80` → line 1, the scan line, 13 QR lines, and the `Or open this link…` line.
  - devClientLink.test `prints the link as text without a TTY` (row 9) → `isTTY: false` → exactly line 1 and the `Open this link…` line.
  - devClientLink.test `drops the QR code in a narrow terminal` (row 9) → `columns: 20` → the same two lines.
  - devClientLink.test `prints the link when the encoder fails` → an encoder that throws, or no encoder → the same two lines.
  - devClientLink.test `without a URL scheme, says what to enter in the launcher` (row 10) → a plist without schemes, or a missing file → line 1 and the `ℹ` line.
  - install.test `prints the dev-client link after the Metro URL`:
    - `hasDevClient: true` and `devClientLink: async () => ["Metro URL for the dev launcher: http://192.168.1.20:8082", "Open this link…"]` → both lines, right after `Installed …`;
    - the existing `logs[1]` test still passes;
    - a state from before bare support → only line 1, and `devClientLink` is not called.
- [ ] **Step 2: Run** `npx vitest run tests/devClientLink.test.ts tests/install.test.ts` → FAIL.
- [ ] **Step 3: Implement** the two modules and the install wiring.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: print the dev-client link and QR code"`

### Task 4b: Record the installed app's bundle id

Ruling F17, simplified by the controller: `install` already knows the id it installed, so it records that id and asks
the iPhone nothing more.
- Over Wi‑Fi, the id is the one the install reports for the uploaded app (`result.app.CFBundleIdentifier`). That is the
  real signed id, whatever the login kind.
- Over USB, it is the id `install` already prints, `installedBundleId(auth.teamId, state.bundleIdentifier)` (xtool's
  `XTL-<Team ID>.` prefix).

Plan notes:
- Row 21 (accept): only a reinstall by something other than `rn-xtool install` leaves the recorded id stale. The next
  `rn-xtool install` records the new id.
- F17 (accept, USB only): with an App Store Connect key login, xtool's prefix may not be the Team ID. Then the recorded
  USB id can differ from the real one, and SDK 58's launcher keeps hiding the server as it does today. A Wi‑Fi install
  records the real id.

**Files:**
- Modify:
  - `src/state.ts` (`BuildState.installedBundleId`, `name`, `slug`; `rememberDevice`);
  - `src/commands/build.ts` (writes `name` and `slug`; keeps a matching `installedBundleId`);
  - `src/commands/install.ts`.
- Test: `tests/install.test.ts`, `tests/build.test.ts`, `tests/state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/state.ts BuildState gains:
  //   installedBundleId?: string  — the signed id of the app the last `install` put on the iPhone
  //   name?: string; slug?: string — from ProjectInfo, for start's announcement
  // rememberDevice's device argument gains installedBundleId?: string
  ```
- `build` writes `name` and `slug`. It carries over the previous state's `installedBundleId` only when it ends with
  `.${project.bundleIdentifier}`.
- `install` writes `installedBundleId` with the rest of the state, for every build (it costs no request):
  - USB: the id it logs in `Installed ${id} on …`.
  - Wi‑Fi: `result.app.CFBundleIdentifier`.

- [ ] **Step 1: Write the failing tests:**
  - install.test `records the installed id` (row 11):
    - USB: `writeState` gets `installedBundleId: "XTL-TEAMID0000.com.a.b"` for team `TEAMID0000` and bundle id `com.a.b`;
    - Wi‑Fi: `rememberDevice` gets the `CFBundleIdentifier` the install result reports.
  - build.test `keeps a matching installed id across builds` → previous state `installedBundleId:
    "XTL-TEAMID0000.com.example.app"` and the same `bundleIdentifier` → kept. A changed `bundleIdentifier` → dropped.
    `name` and `slug` are written.
  - state.test `rememberDevice records the installed id` → the field is merged.
- [ ] **Step 2: Run** `npx vitest run tests/install.test.ts tests/build.test.ts tests/state.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: record the installed app's bundle id"`

### Task 4c: Announce Metro with the installed bundle id

Plan notes:
- Row 22 (accept): when `start` is killed without a goodbye packet, the launcher may list a dead entry until the record's TTL ends. Expo's announcer behaves the same.
- The `metro-running` branch returns at once and announces nothing (accept).

**Files:**
- Create: `src/devServerAnnounce.ts`
- Modify: `src/commands/start.ts` (`StartDeps.announce`, `StartDeps.run` gains `env`), `tests/tarballs.json` (add `dnssd-advertise@1.1.6`)
- Test: `tests/devServerAnnounce.test.ts` (new), `tests/start.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/devServerAnnounce.ts
  export interface AnnounceInput {
    root: string; name: string; slug: string; port: number; iosBundleIdentifier: string;
    onError: (e: unknown) => void;
  }
  /** dnssd-advertise's advertise() through requireFromProject; undefined when missing or not a function. */
  export function loadAdvertiser(root: string): ((o: object) => () => Promise<void>) | undefined;
  /** Announces _expo._tcp as Expo CLI does: { name, type: "expo", protocol: "tcp", hostname: slug, port, stack: "IPv4",
   *  txt: { name, slug, iosBundleIdentifier }, onError }. Returns the stop function; throws when the library is
   *  missing or advertise() throws. */
  export function announceDevServer(i: AnnounceInput): () => Promise<void>;
  // start: StartDeps.announce: typeof announceDevServer; StartDeps.run(cmd, args, { cwd, env? })
  ```
- `start`, in the `ok` branch, when `state.hasDevClient === true`:
  1. Without `state.installedBundleId` (row 20): print `ℹ No installed bundle id recorded: run \`rn-xtool install\` once so \`start\` can announce Metro under the app's real id (Expo SDK 58's dev launcher hides other servers).` Then run Metro as today.
  2. With it: call `announce({ root, name: state.name ?? state.slug ?? "app", slug: state.slug ?? "app", port: state.metroPort, iosBundleIdentifier: state.installedBundleId, onError })` **before** spawning Metro.
     - **Success:** print `ℹ Announcing Metro to the dev launcher as ${installedBundleId}.` For Expo, spawn Metro with `env: toolEnv({ EXPO_UNSTABLE_BONJOUR: "0" })`, so Expo's own announcement under the app config's id is off. Bare `react-native start` announces nothing anyway, so its env stays unchanged.
     - **Failure** (row 18): print `ℹ Could not announce Metro for the dev launcher (${reason}); Expo announces it under the app config's bundle id, which Expo SDK 58's dev launcher hides unless "Match bundle identifier" is off in its Settings.` Spawn Metro as today, without the env var.
  3. `onError` (row 19) prints once: `⚠ The Metro announcement for the dev launcher failed (${reason}). Open the app with the link \`rn-xtool install\` printed, or turn off "Match bundle identifier" in the launcher's Settings.`
  4. The stop function runs in a `finally` after `d.run` settles, and through `signal-exit`'s `onExit` (not awaited) when the process ends.

- [ ] **Step 1: Add** `dnssd-advertise@1.1.6` to `tests/tarballs.json`, then run `node scripts/fetch-test-tarballs.mjs`. **Write the failing tests:**
  - devServerAnnounce.test `announces like Expo CLI, with the installed id` → a fake advertiser loaded by a stub `dnssd-advertise` in a temp project → the options are exactly `{ name: "app", type: "expo", protocol: "tcp", hostname: "app", port: 8083, stack: "IPv4", txt: { name: "app", slug: "app", iosBundleIdentifier: "XTL-TEAMID0000.com.example.app" }, onError }`, and the returned stop is the advertiser's.
  - devServerAnnounce.test `throws when the library is missing or throws` → no package, a stub exporting `{}`, or an `advertise` that throws → `announceDevServer` throws.
  - devServerAnnounce.test `the real dnssd-advertise exports advertise` (`needsTarball("dnssd-advertise@1.1.6")`) → `typeof loadAdvertiser(<tarball project>) === "function"`. Not called.
  - start.test `announces the installed id` (row 11) → `hasDevClient: true`, `installedBundleId`, Expo → `announce` is called before `run`, the `ℹ Announcing…` line is printed, and `run`'s env has `EXPO_UNSTABLE_BONJOUR: "0"`. Stop is called once after `run` resolves, and once after `run` rejects.
  - start.test `keeps Expo's announcement when ours cannot start` (row 18) → `announce` throws → the `ℹ Could not announce…` line, and `run`'s env has no `EXPO_UNSTABLE_BONJOUR`.
  - start.test `warns once when the announcement fails later` (row 19) → the fake calls `onError` twice → one `⚠` line.
  - start.test `without an installed id, keeps Expo's announcement` (row 20) → the `ℹ No installed bundle id…` line, `announce` is not called, and no env var is set.
  - start.test `no announcement without the dev client` → `announce` is not called. In the `metro-running` branch → not called either.
  - start.test `a bare dev-client app gets the announcement without the env var` → `kind: "bare"` → `announce` is called, and `run`'s env has no `EXPO_UNSTABLE_BONJOUR`.
- [ ] **Step 2: Run** `npx vitest run tests/devServerAnnounce.test.ts tests/start.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: announce Metro with the installed bundle id"`

### Task 5: Give the app its icon

Plan note (accept): rn-xtool reads only the icon set named `AppIcon`. A bare target whose `ASSETCATALOG_COMPILER_APPICON_NAME` names another set gets the "does not exist" `ℹ` line. Dark and tinted variants (entries with `appearances`) are skipped.

**Files:**
- Create: `src/generate/appIcon.ts`
- Modify: `src/generate/xtoolYml.ts` (`XtoolYmlInput.iconPath`, `renderXtoolYml`), `src/generate/iosXtool.ts` (`writeIosXtool`)
- Test: `tests/appIcon.test.ts` (new), `tests/generate.test.ts`. That includes the two existing exact-log bare tests:
  - `writeIosXtool copies bare sources and resources`: `expect(logs).toHaveLength(4)` becomes 6, one icon line per run;
  - `writes a Swift-only bare target…`: the `toEqual` list gains the exact `ℹ No app icon: ios/HelloWorld/Images.xcassets/AppIcon.appiconset does not exist. …` line.

  The Expo `writeIosXtool` tests that pass no `log` get one (`log: () => {}`), so they do not print to the console.

**Interfaces:**
- Produces:
  ```ts
  // src/generate/appIcon.ts
  export const APP_ICON_FILE = "AppIcon.png";
  export interface PngSize { width: number; height: number }
  /** PNG signature (89 50 4E 47 0D 0A 1A 0A), then IHDR width and height (big-endian at bytes 16 and 20); an
   *  Apple-crushed PNG's leading CgBI chunk is skipped. Undefined when it is not a PNG. Reads no more than 64 bytes. */
  export function readPngSize(bytes: Uint8Array): PngSize | undefined;
  /** From an appiconset Contents.json: entries with a string `filename`, no `appearances` (or an empty one), and a file
   *  that `exists`. The `size: "1024x1024"` entry first; else the iphone or universal entry with the most pixels
   *  (size × scale). */
  export function pickIconFile(contents: unknown, exists: (filename: string) => boolean): string | undefined;
  export interface AppIcon { source?: string; lines: string[] }
  export async function findAppIcon(project: ProjectInfo, opts: { bundleRootNames: string[] }): Promise<AppIcon>;
  // xtoolYml: XtoolYmlInput.iconPath?: string → `iconPath: ${iconPath}` right after `infoPath: Info.plist`
  ```
- `findAppIcon` lines, verbatim and in this order. `set` is `<iosTargetDir>/Images.xcassets/AppIcon.appiconset`.
  - set missing (row 13): `ℹ No app icon: ${rel(set)} does not exist. Add a 1024×1024 PNG to it to give the app an icon (Expo: set "icon" in the app config, then run \`rn-xtool build --clean\`).`
  - no usable entry, or `Contents.json` missing or not JSON (row 13): `ℹ No app icon: ${rel(set)} lists no PNG in its Contents.json. Add a 1024×1024 PNG to it to give the app an icon (Expo: set "icon" in the app config, then run \`rn-xtool build --clean\`).`
  - not a PNG (row 13): `ℹ No app icon: ${rel(file)} is not a PNG file. Replace it with a 1024×1024 PNG.`
  - name clash (ruling Q7), when `bundleRootNames` includes `AppIcon.png`: `⚠ No app icon: an app resource is copied to the app bundle as AppIcon.png, the name rn-xtool gives the icon. Rename that resource to give the app its icon.`
  - not square: `⚠ App icon ${rel(file)} is ${w}×${h}, not square: iOS stretches it. Use a 1024×1024 PNG.`
  - smaller than 180 on either side: `⚠ App icon ${rel(file)} is ${w}×${h}, smaller than 180×180: it looks blurry on the home screen. Use a 1024×1024 PNG.`
  - used: `ℹ App icon: ${rel(file)} (${w}×${h})`.

  The two size warnings leave the icon in use. The first four lines mean no icon; the build continues.
- `writeIosXtool`, after `writeAppSources`:
  - calls `findAppIcon(project, { bundleRootNames: resources })` and logs its lines;
  - with a `source`, copies it to `ios-xtool/AppIcon.png` and passes `iconPath: APP_ICON_FILE`;
  - without one, runs `rm -f ios-xtool/AppIcon.png` and writes no `iconPath`.
- `xtool.yml` with an icon (Expo with expo-constants), verbatim:
  ```yaml
  version: 1
  bundleID: com.example.app
  product: App
  infoPath: Info.plist
  iconPath: AppIcon.png
  skipLSP: true
  resources:
    - Frameworks
    - ip.txt
    - EXConstants.bundle
  ```

- [ ] **Step 1: Write the failing tests.** PNG bytes come from a local helper `png(w, h, { cgbi? })`: the signature, an optional `CgBI` chunk, then an IHDR chunk with zero CRCs. No binary fixture is committed.
  - appIcon.test `reads a PNG's size` → `png(1024, 1024)` → `{ width: 1024, height: 1024 }`. The CgBI form gives the same. JPEG bytes (`FF D8 FF E0…`), 10 bytes of PNG, or an empty buffer → `undefined`.
  - appIcon.test `picks the 1024 entry without appearances` → Expo's SDK 58 shape (the base `App-Icon-1024x1024@1x.png` plus dark and tinted entries with `appearances`) → the base file. Only a dark entry → `undefined`.
  - appIcon.test `falls back to the largest iPhone size` → the legacy set with files for `60x60@2x` and `60x60@3x` and no 1024 → the `@3x` file. The bare template (no `filename`) → `undefined`. A listed but missing file is skipped.
  - appIcon.test `explains a missing or empty icon set` (row 13) → no folder; a folder without `Contents.json`; `Contents.json` = `{` → no `source`, and the exact `ℹ` line for each.
  - appIcon.test `skips a file that is not a PNG` (row 13) → JPEG bytes in `icon.png` → the exact line, no `source`.
  - appIcon.test `warns about a small or stretched icon but uses it` → `png(120, 100)` → both `⚠` lines, then `ℹ App icon: … (120×100)`, and `source` is set.
  - appIcon.test `refuses the AppIcon.png name clash` → `bundleRootNames: ["AppIcon.png"]` → the `⚠` line, no `source`.
  - generate.test `pins xtool.yml with iconPath` (row 15) → an Expo project with `png(1024, 1024)` in its set:
    - `ios-xtool/AppIcon.png` equals the source bytes;
    - `xtool.yml` equals the text above exactly, and parses with `yaml` to `iconPath: "AppIcon.png"`.
  - generate.test `removes a stale icon` → build with the icon, delete the set, build again → no `ios-xtool/AppIcon.png`, and no `iconPath`.
  - generate.test `gives a bare app its icon` (bare-087 fixture copy with `png(1024, 1024)` and a single-size `Contents.json`) → icon copied. The "Skipped app resources" `ℹ` line still lists the asset catalog.
  - The two exact-log bare tests are updated as listed under Files. `renders defaults` and `honours explicit resources` stay unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/appIcon.test.ts tests/generate.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: give the app the icon from its icon set"`

### Task 6: Warn about a stale Expo icon

**Files:**
- Modify: `src/project/types.ts` (`ProjectInfo.appIconSource`), `src/project/expo.ts` (`expoIconPath`, `readExpoProject`), `src/generate/appIcon.ts` (`findAppIcon`)
- Test: `tests/project/expo.test.ts`, `tests/appIcon.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/project/types.ts: ProjectInfo gains
  /** Expo: the icon file the app config names (absolute), as expo prebuild resolves it; absent for bare. */
  appIconSource?: string;
  // src/project/expo.ts
  /** Expo's getIcons (prebuild-config withIosIcons.js:100-133, 150): a non-empty string ios.icon; else an ios.icon
   *  object's light || dark || tinted; else icon. Resolved against root. Undefined for none or an http(s) URL. */
  export function expoIconPath(exp: { icon?: unknown; ios?: { icon?: unknown } }, root: string): string | undefined;
  ```
- `findAppIcon` additions (verbatim):
  - first of all, when `appIconSource` ends with `.icon`: `ℹ No app icon: ${rel(appIconSource)} is an Icon Composer icon, which needs Xcode's actool. Set a 1024×1024 PNG as "icon" in the app config, then run \`rn-xtool build --clean\`.`
  - after picking a file (row 14), when `appIconSource` exists and its `mtimeMs` is greater than the picked file's: `⚠ ${rel(appIconSource)} is newer than the app icon expo prebuild wrote to ${rel(set)}: run \`rn-xtool build --clean\` to use it.` The icon is still used.

- [ ] **Step 1: Write the failing tests:**
  - expo.test `resolves the icon like expo prebuild` →
    - `{ icon: "./assets/icon.png" }` → that file;
    - `{ icon: "./a.png", ios: { icon: "./b.png" } }` → `b`;
    - `{ icon: "./a.png", ios: { icon: "" } }` → `a`;
    - `{ ios: { icon: { dark: "./d.png", tinted: "./t.png" } } }` → `d`;
    - `{ icon: "./a.png", ios: { icon: {} } }` → `a`;
    - `{ icon: "https://example.com/i.png" }` → `undefined`;
    - `{}` → `undefined`.

    Each result is checked as an absolute path, or `undefined`.
  - expo.test `readExpoProject sets appIconSource` → the fixture project (`"icon": "./assets/icon.png"`) → `<root>/assets/icon.png`.
  - appIcon.test `warns when the app config icon is newer than the icon set` (row 14) → the config icon's `utimes` 60 s after the set's PNG → the `⚠` line, and the icon is used. Older, or missing → no `⚠`.
  - appIcon.test `explains Icon Composer icons` → `appIconSource: "<root>/assets/app.icon"` → the `ℹ` line, no `source`.
- [ ] **Step 2: Run** `npx vitest run tests/project/expo.test.ts tests/appIcon.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: warn when the Expo icon is newer"`

### Task 7: Check the free space for the whole setup

**Files:**
- Modify: `src/commands/setup.ts`:
  - replaces `MIN_FREE_BYTES` and `freeBytesForSdk`;
  - `preflightSdk` keeps only its xip checks;
  - `SetupDeps`;
  - `setup`.
- Test: `tests/setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GB = 1024 ** 3;
  /** Measured on the dev host (plan facts 7); corrected from Task 10 Step 6 (ruling Q5). */
  export const SETUP_SPACE = { swift: 5 * GB, xtool: 0.2 * GB, sdk: 15 * GB, firstBuild: 4 * GB } as const;
  export interface SpaceNeed { label: string; dir: string; bytes: number }
  /** install-swift: "Swift toolchain" in ~/.local/share/swiftly; download-xtool: "xtool" in dirname(bin);
   *  install-sdk: "Darwin SDK" in ~/.swiftpm/swift-sdks; with install-swift or install-sdk, also "first build"
   *  in ~/Library/Caches/ReactNative (React Native artifacts, then the app's .build). login-hint: nothing. */
  export function setupSpaceNeeds(actions: SetupAction[], bin: string): SpaceNeed[];
  export interface SpaceProbes {
    /** Free bytes and device id of the filesystem holding `dir`, through its nearest existing ancestor. */
    filesystemOf: (dir: string) => Promise<{ dev: number; freeBytes: number }>;
  }
  /** Sums the needs per filesystem; throws the message below for the first one short. No-op for []. */
  export async function checkSetupSpace(needs: SpaceNeed[], probes?: SpaceProbes): Promise<void>;
  export async function preflightSdk(xip: string | undefined, probes?: { exists: (p: string) => boolean }): Promise<void>;
  // SetupDeps gains:
  //   spaceProbes?: SpaceProbes;
  //   actions?: Partial<{ installSwift: () => Promise<void>; downloadXtool: (bin: string) => Promise<void>;
  //                       installSdk: (bin: string, xip: string) => Promise<void> }>;
  //   preflightProbes becomes { exists }.
  ```
- Order in `setup`:
  1. probe;
  2. pending Swift packages;
  3. plan (nothing to do → `✔ Nothing to do: toolchain already set up`);
  4. if `install-sdk` is planned: `preflightSdk` (xip), then remove a leftover `~/.swiftpm/swift-sdks/darwin.artifactbundle.tmp`;
  5. `checkSetupSpace(setupSpaceNeeds(actions, bin))`;
  6. the actions.
- Texts (verbatim). `${where}` is the first need's nearest existing directory, with the home folder shown as `~`. `${free}` is `(freeBytes / GB).toFixed(1)`. `${need}` is `Math.ceil(sum / GB)`. `${parts}` is the needs, each `${label} ${+(bytes / GB).toFixed(1)} GB`, joined with `, `.
  - `Not enough free disk space for setup: the filesystem of ${where} has ${free} GB free, and setup needs about ${need} GB there (${parts}). Free some space, then run \`rn-xtool setup\` again.`
  - `ℹ Removing ~/.swiftpm/swift-sdks/darwin.artifactbundle.tmp, left by an interrupted Darwin SDK install.`
  - The old text `Need at least 10 GB free in your home filesystem (~/.swiftpm) to install the Darwin SDK` goes away.

- [ ] **Step 1: Write the failing tests:**
  - `setupSpaceNeeds`:
    - all four actions, with `bin = "/home/me/.cache/rn-xtool/xtool-1.24.0.AppImage"` and HOME stubbed to `/home/me` → four needs with the labels, dirs and bytes above;
    - `["download-xtool", "login-hint"]` → one need;
    - `["login-hint"]` → `[]`.
  - `checkSetupSpace`:
    - one filesystem with 8.2 GB free → exactly `Not enough free disk space for setup: the filesystem of ~ has 8.2 GB free, and setup needs about 25 GB there (Swift toolchain 5 GB, xtool 0.2 GB, Darwin SDK 15 GB, first build 4 GB). Free some space, then run \`rn-xtool setup\` again.`;
    - the xtool path on a second `dev` with 0.1 GB free → the message names only that filesystem and `xtool 0.2 GB`;
    - enough space → resolves.
  - `setup stops before any download when space is short` (row 16) → nothing installed, an existing xip, and `spaceProbes` reporting 8 GB → rejects with the message, and no `actions` spy is called.
  - `removes a leftover SDK staging folder before measuring` (row 17) → a temp HOME with `.swiftpm/swift-sdks/darwin.artifactbundle.tmp/x` → the `ℹ` line is logged, and the folder is gone before `filesystemOf` is called (spy order).
  - `a run that only hints at login checks no space` → probe `{ …all, loggedIn: false }` → `filesystemOf` is not called.
  - The old `rejects low disk space` and `passes with xip and space` tests become xip-only checks (`exists`).
- [ ] **Step 2: Run** `npx vitest run tests/setup.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `filesystemOf` walks up to the nearest existing ancestor, then uses `stat().dev` and `statfs()` (`bavail * bsize`).
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: check free space for the whole setup"`

### Task 8: A second setup run downloads nothing

If the test exposes a re-download, the fix goes into this task's commit, with the subject `fix: make a second setup run download nothing`.

**Files:**
- Test: `tests/setup.test.ts`

- [ ] **Step 1: Write the test** `a second run downloads nothing` (row 17). It uses the real `probeSetupState` and `checkPendingSwiftPackages`.
  - **Environment** (`vi.stubEnv`, restored afterwards): `HOME=<tmp>/home`, `XDG_CACHE_HOME=<tmp>/cache`, `PATH=/usr/bin:/bin` (so the host's swiftly toolchain is not found).
  - **Action fakes** create what they install:
    - `installSwift` writes `<home>/.local/share/swiftly/bin/swift`, a mode-755 script printing `Swift version 6.4.1 (swift-6.4.1-RELEASE)`;
    - `downloadXtool(bin)` writes a mode-755 script at `bin` that, for `auth status`, prints `Logged in.`, `- Apple ID: me@example.com` and `- Team ID: TEAMID0000`;
    - `installSdk` creates `<home>/.swiftpm/swift-sdks/darwin.artifactbundle/`.
  - `spaceProbes` reports 100 GB; the xip is a temp file.
  - The first run calls each fake once. The second run calls none, does not call `filesystemOf`, and logs `✔ Nothing to do: toolchain already set up`.
  - A variant where the fake xtool prints `Logged out.`: the second run logs only `Run: rn-xtool auth login`, and still calls no fake and no `filesystemOf`.
  - On a host with `swift` in `/usr/bin`, the first run would see Swift as installed. Add the title suffix ` (needs no swift in /usr/bin)` and skip there.
- [ ] **Step 2: Run** `npx vitest run tests/setup.test.ts`. If it passes, keep the test-only commit. If it fails, stop and report what re-ran before changing `src/`.
- [ ] **Step 3: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 4: Commit** `git add tests && npm run scan:private && git commit -m "test: cover a second setup run"`

### Task 9: Docs and changelog

**Files:**
- `docs/troubleshooting.md`:
  - `## First-run checklist (on the iPhone)`, item 3: `Open the app by hand, and allow Local Network access when asked. The red screen "No script URL provided" may show behind that prompt: after Allow, the app reloads by itself. A dev-client app shows the launcher's own Local Network screen instead; then open the link or QR code `install` printed.`
  - `## The app does not start or cannot reach Metro`, the "No script URL provided" bullet (rows 1–2):
    > **Red screen "No script URL provided":** the app could not reach Metro. On the first launch it shows behind iOS's Local Network prompt and clears by itself after Allow. An app opened before `rn-xtool start` also reloads by itself once Metro runs, for up to 5 minutes after the red screen appeared. If you tapped Don't Allow, the app shows "Local Network access is off" once, with an Open Settings button: turn Local Network on for the app (Settings → Privacy & Security → Local Network) and come back. If the red screen stays: check that `start` is running, that the phone is on the same Wi‑Fi, that Local Network is on for the app, and the firewall (below); then tap Reload.
  - A new `## Dev client` section, after `## Metro port`:
    - `### Opening the project in the dev client`:
      - `build` bakes `http://<lanIp>:<metroPort>` as the launcher's default URL (unless the app config sets `defaultLaunchURL`), so from the second launch the app opens the project by itself;
      - on the first launch, open the link or QR code `install` printed. `expo start` prints its own QR code too;
      - with "most recent" launch mode, a stale last URL is tried first for up to 10 seconds (row 8);
      - after a LAN IP change, rebuild (row 7).
    - `### Servers hidden by your discovery filters`:
      - xtool installs the app as `XTL-<…>.<bundle id>`. Expo SDK 58's launcher lists only servers announced under the installed id.
      - `rn-xtool install` records that id (the one it installed), and `rn-xtool start` announces Metro under it, in place of Expo's announcement.
      - If the list is still empty, or says "… hidden by your discovery filters": run `rn-xtool install` once, then `rn-xtool start`. Or open the link `install` printed. Or, in the launcher's Settings under "Server discovery", turn off "Match bundle identifier" (it stays off until the app is deleted).
      - The `ℹ` and `⚠` lines of Tasks 4b–4c are quoted here (rows 11, 18–20).
  - A new `## App icon and launch screen` section, before `## Device and signing`:
    - where the icon comes from;
    - the `ℹ`/`⚠` lines of Tasks 5–6, quoted;
    - Expo: a changed `icon` needs `rn-xtool build --clean`;
    - if the home screen keeps a blank icon after reinstalling, delete the app and install again, or restart the phone (row 12);
    - not supported: dark and tinted icons, Icon Composer `.icon` icons, and a custom splash colour or image. The launch screen is the system background colour, because those need Xcode's asset catalog compiler.
  - `## Setup and xtool` gains two bullets:
    - the free-space message, quoted, with what each part is;
    - "`setup` can be run again at any time: it skips what is installed and downloads nothing when everything is there. After an interrupted SDK install it first removes the half-written `darwin.artifactbundle.tmp`."
- `README.md`:
  - "Before you start": `About 15 GB of free disk.` → `About 25 GB of free disk for setup and the first build (Swift toolchain, Darwin SDK, React Native artifacts), plus the Xcode.xip.` The Xcode.xip size text stays as it is (ruling Q6).
  - The Commands table:
    - `install` row ends: `…then prints the Metro URL, and for apps with expo-dev-client a link and QR code that open the app on it, and the first-run checklist.`
    - `start` row adds: `With expo-dev-client it announces Metro to the dev launcher under the installed app's bundle id.`
  - Limits:
    - the `expo-dev-client` bullet: `the launcher's and dev menu's icons are missing (no actool on Linux); the app opens Metro by itself from its second launch, and the link and QR code from install cover the first one ([details](docs/troubleshooting.md#dev-client)).`
    - new bullet: `The app icon comes from the AppIcon set as one PNG; dark, tinted and Icon Composer icons and custom splash screens are not supported (no asset catalog compiler on Linux).`
- `docs/how-it-works.md`:
  - "What `setup` installs": the Task 7 figures and the per-filesystem check.
  - Step 4: `ios-xtool/` also gets `RNXtoolDevSupport` (Debug, without the dev client) and `AppIcon.png`. For dev-client apps it gets `DEV_CLIENT_DEFAULT_LAUNCHER_URL` and `_expo._tcp`.
  - A new `## First launch` section:
    - the TN3179 red screen;
    - how the helper decides: one reload per failure, none after a load, foreground only, 5 minutes;
    - the Local Network alert (once, only while the app is active, after 3 s of denial);
    - where the helper reads host and port (facts 1);
    - that a React Native rename makes it a no-op.
  - A new `## Dev-client discovery` section: the installed id read by `install`, and `start`'s announcement.
- `docs/bare-react-native.md` lines 189-190 and 231: asset catalogs are still skipped, except the app icon, which is taken from `AppIcon.appiconset`.
- `docs/libraries.md`, the expo-dev-client row (preflight F8):
  - both "Metro URL typed by hand when not on 8081" cells → "opens Metro by itself from the second launch; link and QR code for the first";
  - the Known-gaps clause "with a non-default Metro port the launcher does not find Metro on its own, so type `http://<lanIp>:<metroPort>` in it" → "the launcher finds Metro through `start`'s announcement under the installed bundle id, its default URL, or the link `install` prints".
- `docs/RELEASING.md`:
  - item 4 lists `templates/`;
  - a new item: `On a device, a fresh install of a reference app without the dev client shows its icon on the home screen and loads after Allow without Reload.` (row 15).
- `CHANGELOG.md` `[Unreleased]`:
  - Added: the auto-reload after Allow and for an app opened before Metro; the Local Network alert; the dev launcher's default URL and `_expo._tcp`; the dev-client link and QR code in `install`; `start`'s announcement under the installed bundle id; the app icon; the setup space check.
  - Changed: the first-run checklist line; the README disk figure.
  - Upgrading:
    - run `rn-xtool build` and `rn-xtool install` to get the icon and the auto-reload;
    - if the icon stays blank, delete the app from the iPhone and install again (row 12);
    - with expo-dev-client, run `rn-xtool install` once, so that `start` can announce the installed id.
- Test: `tests/docsLinks.test.ts` (unchanged; it stays green).

- [ ] **Step 1: Write** the docs. Every quoted message is copied from Tasks 1–7.
- [ ] **Step 2: Run** `grep -rn "then Reload\|About 15 GB\|typed by hand\|type \`http://<lanIp>" README.md docs/*.md src` → no hit (CHANGELOG's released sections keep their history). Then run `npm test && npm run lint` → PASS.
- [ ] **Step 3: Commit** `git add README.md CHANGELOG.md docs && npm run scan:private && git commit -m "docs: document first launch, icon and setup"`

### Task 10: Device and clean-machine check (controller with Willy)

CLI: run `npm run build` in the worktree, then `node ../expo-xtool-w1/bin/rn-xtool.js <cmd>` in each app.
- The apps are build-only inputs. Every change to them happens on a scratch git branch in that app and is reverted afterwards (ruling Q8). Nothing in them is committed.
- Record versions, timings and results in the PR body.

- [ ] **Step 1 (rows 3, 5; goal 1).** For `../app-expo-57` (SDK 57), `../app` (SDK 58) and `../app-bare` (0.88.1), without a dev client:
  - delete the app from the iPhone, then `build`, `install` and `start`;
  - open the app: the Local Network prompt appears, maybe over the red screen;
  - tap Allow → the app loads without Reload, and the red screen is gone (not left on top, fact 2). Record the time from Allow to the loaded app.
- [ ] **Step 2 (app opened before Metro; bundling error; rows 3, 5).**
  - Stop `start`, swipe the app away and open it → red screen. Within 5 minutes run `rn-xtool start` → the app reloads by itself, once.
  - Then, with Metro up, put a syntax error in the entry file (`App.tsx` / `app/index.tsx`) and relaunch the app → red screen with the bundling error, at most one reload, never a loop. Revert the edit.
- [ ] **Step 3 (Don't Allow, the alert, row 1).** On one app:
  - delete it, install it, open it, and tap Don't Allow → the red screen stays;
  - within a few seconds "Local Network access is off" appears once. It never appears while the system prompt is up (record when it appeared);
  - "Open Settings" opens the app's settings page. Turn Local Network on and come back → the app reloads within 5 minutes of the failure (otherwise Reload works).

  If the alert appears while the system prompt is up, or never appears, that is a decision for Willy (the active/inactive discriminator is not verified).
- [ ] **Step 4 (dev client on a port other than 8081, rows 11 and 18–23).**
  - In `../app-expo-57`: run `npx expo install expo-dev-client` and set `"metroPort": 8083` in its `rn-xtool.config.json`. Run `build --clean`. Check that:
    - `ios-xtool/Info.plist` has `DEV_CLIENT_DEFAULT_LAUNCHER_URL` = `http://<lanIp>:8083` and `_expo._tcp`;
    - `Package.swift` has no `RNXtoolDevSupport`.
  - Run `install`:
    - the link and the QR code are printed;
    - `.rn-xtool-state.json` has `installedBundleId` = the `XTL-…` id shown on the phone;
    - scanning the QR code with the Camera opens the app on Metro at 8083 (after the launcher's permission screen).
  - Swipe the app away and open it again → it opens the project by itself.
  - Run `start`:
    - it prints `ℹ Announcing Metro to the dev launcher as XTL-…`;
    - `avahi-browse -rt _expo._tcp` shows **one** record on port 8083 with TXT `iosBundleIdentifier=XTL-…`;
    - the SDK 57 launcher lists the server once.
  - Repeat on `../app` (SDK 58) with the dev client: the launcher lists the server **with "Match bundle identifier" on** (row 11).
- [ ] **Step 5 (icon, rows 12–15).**
  - For `../app-expo-57` and `../app` (each deleted first): `ℹ App icon: …` is printed, and the icon shows on the home screen, in Spotlight and in Settings.
  - For `../app-bare`: add a 1024×1024 PNG and a single-size `Contents.json` to `ios/BareDemo/Images.xcassets/AppIcon.appiconset`, then `build` and `install` → the icon shows.
  - Install once more without deleting the app, and note whether the icon updates (row 12 text).
- [ ] **Step 6 (clean machine; needs Willy's OK: about 25 GB of disk and 1–3 hours).**
  - `npm pack` the worktree. Run `e2e/clean-machine/e2e.sh up`, then `e2e.sh install ./react-native-xtool-<version>.tgz`.
  - Run `e2e.sh setup`. In a second terminal, sample `docker exec rn-xtool-e2e df -B1 --output=used /home/me` every 5 s, and record the peak during each of the Swift, xtool and SDK steps.
  - Run `e2e.sh setup` again → it prints only `Run: rn-xtool auth login` and downloads nothing.
  - Run `e2e.sh auth`, `e2e.sh project --sdk 58` and `e2e.sh sh rn-xtool build`, and record the peak.
  - Compare the peaks with `SETUP_SPACE`. A gap of more than 2 GB goes to Willy (ruling Q5).
  - Record the size (`ls -l`) of the xip used, against the README text (ruling Q6). Then run `e2e.sh down`.
- [ ] **Step 7.** Fixes go through the owning task's files with a red/green test, one `fix:` commit each. A gap that needs a new decision goes to Willy. Revert the reference-app branches from Steps 2, 4 and 5.

## Open questions for the controller

All of the first round (Q1–Q9) and the preflight findings are ruled. What is left can only be settled on a device:

1. **Alert discriminator (item 7, risk 1).** The alert relies on the Local Network prompt making the app inactive (`WillResignActive`). Task 10 Step 3 checks it. If the prompt does not resign active, the alert would show over it after 3 s. Proposed: then drop the alert and keep the docs text, as a decision for Willy.
2. **The installed id over USB.** Settled by the controller: `install` records the id it already derives (`XTL-<Team ID>.<bundle id>`); see Task 4b (F17 accept).
