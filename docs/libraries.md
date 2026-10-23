# Library compatibility matrix

Each library is tested on the reference app (`expo-ios-linux/app`, Expo SDK 58 / RN 0.88) on its own
`feature/lib-<name>` branch: `npx expo install <lib>` → smoke usage in `App.tsx` → `expo-xtool run` →
checked by hand on a physical iPhone. Dates are the test dates.

Legend: ✅ works · ⚠️ works with caveats · ❌ fails · ⏳ not tested yet

| Library | Version | Linkage seen | Build | Runtime | Notes |
|---|---|---|---|---|---|
| expo-haptics | ~58.0.7 | Expo source package (autolinked) | ✅ 2026-10-23 | ✅ 2026-10-23 | notificationAsync + impactAsync vibrate on device |
| react-native-safe-area-context | ~5.10.1 | RN lib with its own Package.swift (self-managed) | ✅ 2026-10-23 | ✅ 2026-10-23 | linked without changes |
| react-native-screens | ~4.30.0 | CocoaPods-only → `npx react-native spm scaffold` generated Package.swift | ✅ 2026-10-23 | ✅ 2026-10-23 (after scaffolder fixes 3-5) | the app crashed at startup (`Screen native module hasn't been linked`): the scaffolder could not resolve the Ruby locals in `RNScreens.podspec` (`source_files_exts`, `source_files`), so `ios/` sources were missing; see `docs/upstream/react-native-scaffolder.md` #3. Fix 4 then merges the `common` subspec (`common/cpp`, `cpp/`) that fix 3 had stopped leaking in, which `RNSTabsHostShadowNode.h` needs (#4). Fix 5 emulates the `common` subspec's `header_dir = "rnscreens"` so `<rnscreens/X.h>` resolves (#5). Scaffold persisted with patch-package (`patches/react-native-screens+4.30.0.patch` in the app); expo-xtool runs `scaffold` automatically when RN reports a missing Package.swift |
| react-native-gesture-handler | 3.3.0 | CocoaPods-only → scaffold | ✅ 2026-10-23 (auto-scaffold + patched scaffolder) | ✅ 2026-10-23 | RN scaffolder bugs found: (1) `read-podspec` keeps only the first value of `s.source_files = "a", "b"` (lost `shared/**`); (2) `publicHeadersPath: "apple"` holds an umbrella header next to subdirs → SwiftPM rejects; using the `include/<Name>/` shim fixes it. Both are generic → patched in expo-xtool and to be upstreamed to RN |
| react-native-reanimated (+ worklets) | 4.7.1 (+ worklets 0.13.0) | ships Package.swift (self-managed) | ✅ 2026-10-23 | ✅ 2026-10-23 | manifest uses CFGetTypeID → fails on Linux host; patched (project `patches/`), upstream PR pending; see `docs/upstream/reanimated-worklets-manifest.md` |
| expo-router | | | ⏳ | ⏳ | needs screens + safe-area-context |
| react-native-svg | 15.16.0 | CocoaPods-only → auto-scaffold | ✅ 2026-10-23 | ⏳ | needed scaffolder fixes 6, 8 and 9. Metal filters are unavailable: they load prebuilt `*.metallib` from `RNSVGFilters.bundle`, declared via `s.ios.resource_bundles`, which the scaffolder does not read (resource bundles are unsupported for now, on any host). The Linux-only part is just that `apple/Filters/MetalCI/*.metal` are skipped (`exclude:` in Package.swift) because SwiftPM cannot run the `metal` compiler; `RN_SPM_SKIP_METAL=1` forces the same on macOS. Other rendering is unaffected |
| react-native-webview | 14.0.1 | CocoaPods-only → auto-scaffold | ✅ 2026-10-23 | ⏳ | |
| expo-notifications (local) | | | ⏳ | ⏳ | remote push needs a paid Apple account |
| expo-secure-store | | | ⏳ | ⏳ | |
| expo-image-picker | | | ⏳ | ⏳ | |
| @gorhom/bottom-sheet | | | ⏳ | ⏳ | |
| @react-native-async-storage/async-storage | | | ⏳ | ⏳ | |
| @react-native-community/datetimepicker | | | ⏳ | ⏳ | |

"Linkage seen" records how the library reached the SwiftPM graph: Expo source package, Expo
precompiled xcframework, RN library with its own Package.swift, or CocoaPods-only (→ Package.swift generated automatically by `spm scaffold` and persisted in the
project's `patches/`).

Next generic scaffolder fix: `resource_bundles` support (read `s.resource_bundles` / `s.ios.resource_bundles` and emit the
bundle as a SwiftPM resource), which would also enable react-native-svg's Metal filters.
