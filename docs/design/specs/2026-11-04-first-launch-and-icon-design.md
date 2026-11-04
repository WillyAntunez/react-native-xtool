# First launch and app icon (design)

Status: short design, 2026-11-04, amended the same day by the controller's rulings on the plan (the Local Network
alert, `start` prints no QR code, the SDK 58 announcement, rows 11 and 18–23) and by Willy's rulings on the reviews
(rows 14, 19 and 24–27). Week 2 of the stabilization plan. The research notes with file:line evidence are kept
outside the repo; the facts this design rests on are restated here.

## Intent

The first minutes with rn-xtool must look right: the app opens without a red screen, a dev-client app finds its Metro
server without typing an address, the app has its icon on the home screen, and `setup` on a fresh machine says early
what it needs.

## Facts

1. **The red screen.** React Native checks whether Metro is running with a synchronous `GET /status` to the baked
   host before it loads the bundle (`RCTBundleURLProvider.guessPackagerHost`). On the first launch that request is the
   app's first local-network connection: iOS shows the Local Network prompt and, while it is open, denies the request
   at once (Apple TN3179). React Native then looks for an embedded `main.jsbundle`, finds none, and shows "No script
   URL provided". Reload after Allow works. The same happens on a Mac for an Expo app without a dev client; bare apps
   on a Mac hide it with an embedded bundle. It affects Expo without a dev client and bare apps. Dev-client apps take
   another path: the launcher disables this check and shows its own permission screen.
2. **Dev-client discovery.** expo-dev-launcher finds servers only through Bonjour `_expo._tcp` announcements; it has
   no port logic. `rn-xtool start` already announces Metro with the real port (checked from Linux with
   `avahi-browse`: port 8083). On launch the launcher opens the most recent URL first, then
   `DEV_CLIENT_DEFAULT_LAUNCHER_URL` from Info.plist, then shows its list. SDK 58 also hides servers whose announced
   bundle id differs from the app's, and xtool's `XTL-<Team ID>.` prefix makes every server differ (from the code;
   seen on a device on 2026-11-04, where the server announced under the installed id was listed and opened with
   "Match bundle identifier" on, its default).
3. **The icon.** xtool's `iconPath` copies one PNG into the app and sets `CFBundleIconFile`. On 2026-11-04 a 1024×1024
   PNG passed this way showed on the home screen of an iPhone on iOS 26. Expo prebuild already writes the resolved
   icon (square, 1024 px, alpha flattened) to `ios/<target>/Images.xcassets/AppIcon.appiconset`. A fresh bare
   template's icon set lists sizes with no files.
4. **Splash.** `UILaunchScreen` colours and images are looked up by name in a compiled asset catalog; without Xcode's
   `actool` there is none. The `UILaunchScreen = {}` rn-xtool writes today gives the system background.

## Goals

1. **The red screen clears itself.** For Debug builds of Expo apps without a dev client and of bare apps, rn-xtool
   generates a small Objective-C target into the app. When React Native reports that the bundle failed to load
   (`RCTJavaScriptDidFailToLoadNotification`), it opens a connection to the baked Metro host and port; iOS retries
   that connection by itself once the user taps Allow. When it connects, it reloads the app once
   (`RCTTriggerReloadCommandListeners`). It uses only public React Native API, looks both up at run time so a rename
   degrades to today's behaviour instead of breaking the build, runs only in the foreground, reloads at most once per
   failure and stops after 5 minutes. The red screen still flashes behind the prompt; after Allow the app loads
   without Reload. It also recovers an app opened before `rn-xtool start`. When the connection keeps waiting because
   Local Network access is denied (Don't Allow), the app shows one alert, "Local Network access is off", with an
   Open Settings button. The alert appears at most once per launch, only while the app is active (not while the
   system prompt is up), and only after 3 seconds of denial. (Amended 2026-11-04, Willy's ruling.)
2. **A dev-client app opens its Metro server.**
   - `build` bakes `DEV_CLIENT_DEFAULT_LAUNCHER_URL = http://<lanIp>:<metroPort>` into Info.plist for dev-client
     apps, unless the project sets one.
   - `install` prints the dev-client deep link `<scheme>://expo-development-client/?url=…` as a QR code and as
     text, for the first launch (when the launcher skips the default URL) and for a phone that never saw the
     server. The scheme is read from the built Info.plist. `start` prints no QR code of its own: `expo start`
     already prints one with the dev-client link. (Amended 2026-11-04, controller ruling Q2.)
   - Dev-client builds get `_expo._tcp` in `NSBonjourServices`; a bare app with the dev client runs no Expo prebuild,
     which is what adds it today.
   - **SDK 58 lists the server.** `install` records the bundle id of the app it installed (`XTL-…`) in the build
     state, and asks the iPhone nothing more: over Wi‑Fi, the id the install result reports for the uploaded app;
     over USB, the `XTL-<Team ID>.<bundle id>` it logs, which is xtool's signing prefix for an Apple ID login (with
     an App Store Connect key the prefix may differ: ruling F17, accepted). `start` announces Metro over Bonjour
     (`_expo._tcp`) under that id, with the project's own `dnssd-advertise`, as Expo CLI does. Only after that
     announcement has started does it run `expo start` with `EXPO_UNSTABLE_BONJOUR=0`. If it cannot announce, Expo's
     own announcement stays, as today, with an `ℹ` line. (Amended 2026-11-04, Willy's ruling on row 11.)
   - The troubleshooting docs also say how to turn off SDK 58's discovery filter if the list still shows "servers
     hidden".
3. **The app icon.** `build` takes the icon from `ios/<target>/Images.xcassets/AppIcon.appiconset` (Expo and bare):
   the 1024 entry without `appearances`, else the largest iPhone size. It copies it to `ios-xtool/AppIcon.png` and
   sets `iconPath`. It checks the PNG signature and header in plain Node (no new dependency):
   - no icon, or the file is not a PNG: an `ℹ` line, no icon, the build continues;
   - not square or smaller than 180 px: a `⚠` line, the icon is used;
   - Expo: `build` records the app config icon's path and sha256 each time it runs expo prebuild. When the icon's
     path or content differs from that record, a `⚠` line says to run `rn-xtool build --clean` to pick it up.
4. **Setup on a fresh machine.** `setup` checks the free space for everything it will download (Swift toolchain,
   Darwin SDK, xtool, React Native artifacts) before the first download, not only for the SDK. Running `setup` twice
   is safe and the second run downloads nothing. A clean-container run of `setup` through `build` checks it.

## Non-goals

- A custom splash colour or image (needs a compiled asset catalog). Dark, tinted and Icon Composer icons.
- Removing the red-screen flash entirely. A bounded wait inside React Native's check would do it, but it means
  swizzling a prebuilt React class and blocking the main thread at launch; deferred until goal 1 is in use.

## Failure walk

| # | Hop | Fails how | Who learns | Proposed ruling |
|---|-----|-----------|------------|-----------------|
| 1 | Auto-reload | the user taps Don't Allow | user: red screen stays | handle: the app shows one "Local Network access is off" alert with Open Settings (only while active, after 3 s of denial); the helper gives up at its cap; the red-screen docs name Settings → Privacy & Security → Local Network |
| 2 | Auto-reload | wrong IP, VPN, or Metro never starts | user: red screen stays, as today | accept: gives up after 5 minutes; `start` already refuses a changed LAN IP |
| 3 | Auto-reload | it reloads in a loop | user | handle: one reload per failure notification; none once a bundle loaded; tested |
| 4 | Auto-reload | the app is launched in the background (iOS denies without a prompt) | nobody | handle: the helper runs only in the foreground |
| 5 | Auto-reload | the ObjC target or its `+load` is not linked by SwiftPM/xtool | user: same as today | handle: device check on Expo SDK 57, SDK 58 and bare 0.88 before the PR |
| 6 | Auto-reload | React Native renames the notification or the reload function | user: same as today | handle: looked up at run time (no build break); a test reads the names from the pinned React Native headers |
| 7 | Launcher URL | the LAN IP changed since the build | user: launcher shows the list | accept: as today; `start` refuses and asks for a rebuild |
| 8 | Launcher URL | a stale "most recent" URL is tried first (10 s) | user: a short wait | accept: launcher behaviour |
| 9 | QR | the terminal is too narrow or output is piped | user | handle: the URL is printed as text too |
| 10 | QR | the scheme cannot be read from Info.plist | user | handle: no QR, the text says to type `http://<ip>:<port>` in the launcher |
| 11 | SDK 58 filter | servers are hidden by the bundle-id filter | user: empty list | handle: `install` records the id it installed (Wi‑Fi: the id the install reports; USB: `XTL-<Team ID>.<bundle id>`); `start` announces Metro under it; tested; device check with the filter on; docs say how to turn the filter off |
| 12 | Icon | iOS keeps the old blank icon after a reinstall | user | accept: docs say delete the app or restart the phone |
| 13 | Icon | the icon set is empty, missing or not a PNG | user | handle: `ℹ` line, build continues |
| 14 | Icon | the Expo icon changed without a new prebuild | user: old icon | handle: `build` records the icon's path and sha256 when it runs expo prebuild; another path or content gives a `⚠` line with `build --clean` (a touch or a same-content checkout does not); no record (an older rn-xtool's state, or a prebuild outside rn-xtool): the first `build` records the current icon without a warning, and later changes warn |
| 15 | Icon | a future xtool changes `iconPath` | user: blank icon | handle: a test pins the generated `xtool.yml`; the release device check looks at the home screen |
| 16 | Setup | the disk fills during a download | user: half-installed setup | handle: one free-space check for the whole setup before the first download |
| 17 | Setup | a second `setup` run repeats or breaks downloads | user | handle: tested; the second run skips what is present |
| 18 | Announce | `dnssd-advertise` is missing, renamed or throws | user: the list shows the plain-id server (SDK 58: hidden) | handle: Expo's announcement is kept (the env var is not set) plus an `ℹ` line; tested |
| 19 | Announce | it fails later, asynchronously (`onError`), after Expo's was turned off | user: empty list | handle: one `⚠` line with the link and filter hint, only for an error that names the LAN-IP interface (by name or address); errors about other interfaces (a Docker veth) or none are ignored, as Expo CLI ignores them all; a call that throws is row 18; tested |
| 20 | Announce | no installed id recorded (installed by an older rn-xtool, or never installed) | user | handle: `start` keeps Expo's announcement and says to run `install`; tested |
| 21 | Announce | the app was reinstalled by something other than `rn-xtool install` (another Apple ID or team) | user: hidden | accept: the next `rn-xtool install` records the new id |
| 22 | Announce | `start` is killed without a goodbye packet | user: a dead entry until the record's TTL ends | accept: Expo's announcer behaves the same |
| 23 | Discovery | a bare app with expo-dev-client has no `_expo._tcp` in `NSBonjourServices` (no prebuild) | user: the launcher cannot browse at all | handle: `build` adds `_expo._tcp` for dev-client builds; tested |
| 24 | Announce | the project's `dnssd-advertise` has another API shape (no `advertise()`, or it does not return its stop function at once) | user: the list shows the plain-id server (SDK 58: hidden) | handle: a shape check (the 1.x API Expo CLI uses); a promise it returned instead is stopped best-effort, and Expo's announcement is kept with row 18's `ℹ` line; tested |
| 25 | Announce | the user turned Bonjour off (`EXPO_UNSTABLE_BONJOUR=0`, `CI`) | user: a server announced against their wish | handle: `start` mirrors @expo/cli's rule and announces nothing then; tested. Accept: only the process environment is read, not the project's `.env` files Expo CLI also loads (the docs say so) |
| 26 | Auto-reload | the baked port answers, but it is not Metro | user: one reload, then the red screen as today | accept (Willy, 2026-11-04) |
| 27 | Auto-reload | iOS reports Don't Allow under another reason than the Local Network denial | user: no alert; the helper keeps trying to its cap | accept (Willy, 2026-11-04); checked on a device |
| 28 | Discovery | the network blocks the Bonjour announcement (Wi‑Fi client isolation, a firewall that drops UDP port 5353) | user: the launcher does not list the server | accept: the troubleshooting docs say to open the project with the link or QR code `install` printed |
| 29 | Announce | two machines on one Wi‑Fi run `start` for the same app (the same bundle id and team) | user: one name in the launcher, which can open the other machine's Metro | accept: Expo CLI announces the same way; the troubleshooting docs say to use the link or QR code `install` printed on your own machine |
| 30 | Icon | `npx expo prebuild` runs outside rn-xtool after an icon change | user: the stale-icon `⚠` stays although the app has the new icon | accept: the record is refreshed only by the prebuild `build` runs; the troubleshooting docs say the warning stays until `build --clean` |
| 31 | Run | rn-xtool is upgraded and the project is unchanged | user: the old build runs without the new version's changes | handle: rn-xtool's own version is part of the dependency fingerprint, so `run` rebuilds and reinstalls; tested (`tests/deps.test.ts`: "changes with rn-xtool's own version, so an upgrade rebuilds") |

## Verification

- Unit tests for:
  - the generated ObjC target and Package.swift entries (Debug only, not for dev-client builds);
  - the helper's policy (reload, give up, foreground, the alert), compiled and run on Linux;
  - the Info.plist keys, the deep link and QR text;
  - the installed-id lookup and the announcement;
  - the icon picking and checks;
  - the setup space estimate and the second run.
- On a device:
  - SDK 57, SDK 58 and bare 0.88 without a dev client open after Allow without Reload;
  - an app opened before `rn-xtool start` loads once Metro starts;
  - a bundling error with Metro up reloads at most once;
  - Don't Allow shows the alert once, never over the system prompt;
  - a dev-client app opens its server on a port other than 8081;
  - SDK 58's launcher lists the server with "Match bundle identifier" on;
  - the icon shows for SDK 57, SDK 58 and bare (with an icon added).
- A clean container runs `setup` twice and `build`.
