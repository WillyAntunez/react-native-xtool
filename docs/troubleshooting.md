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
- **A committed project patch no longer applies** (after a library upgrade): delete it from `patches/` and let
  `rn-xtool build` re-scaffold it.
- **"rn-xtool could not patch <package>":** your project has a different version of an Expo package than the one this
  release of rn-xtool patches. The message names the versions: pin the package to the patched version, or report the
  new version in the issue tracker so the patch can be refreshed.

## Device and signing

- **"Developer Mode required":** enable it on the phone (see the checklist above) and reboot.
- **"Untrusted Developer":** trust the certificate under VPN & Device Management.
- **App stops opening after a week:** free-account signatures expire after 7 days. Run `rn-xtool install` again.
- **`xtool launch` fails with `DebugserverClient.Error`:** known on current iOS. Open the app by hand.
- **Anything else:** run `rn-xtool doctor` first.

Bare React Native build errors (`Cannot resolve build setting`, `unsupported source type in the app target`) are
explained in [bare-react-native.md](bare-react-native.md).
