# Library compatibility matrix

Each library is tested on the reference app (`expo-ios-linux/app`, Expo SDK 58 / RN 0.88) on its own
`feature/lib-<name>` branch: `npx expo install <lib>` → smoke usage in `App.tsx` → `expo-xtool run` →
checked by hand on a physical iPhone. Dates are the test dates.

Legend: ✅ works · ⚠️ works with caveats · ❌ fails · ⏳ not tested yet

| Library | Version | Linkage seen | Build | Runtime | Notes |
|---|---|---|---|---|---|
| expo-haptics | ~58.0.7 | Expo source package (autolinked) | ✅ 2026-10-23 | ✅ 2026-10-23 | notificationAsync + impactAsync vibrate on device |
| react-native-safe-area-context | ~5.10.1 | RN lib with its own Package.swift (self-managed) | ✅ 2026-10-23 | ⏳ | linked without changes |
| react-native-screens | ~4.30.0 | CocoaPods-only → `npx react-native spm scaffold` generated Package.swift | ✅ 2026-10-23 | ⏳ | scaffold persisted with patch-package (`patches/react-native-screens+4.30.0.patch` in the app); expo-xtool should run `scaffold` automatically when RN reports a missing Package.swift |
| react-native-gesture-handler | 3.3.0 | CocoaPods-only → scaffold | ✅ 2026-10-23 (with 2 generic scaffolder fixes) | ⏳ | RN scaffolder bugs found: (1) `read-podspec` keeps only the first value of `s.source_files = "a", "b"` (lost `shared/**`); (2) `publicHeadersPath: "apple"` holds an umbrella header next to subdirs → SwiftPM rejects; using the `include/<Name>/` shim fixes it. Both are generic → patched in expo-xtool and to be upstreamed to RN |
| react-native-reanimated (+ worklets) | | | ⏳ | ⏳ | |
| expo-router | | | ⏳ | ⏳ | needs screens + safe-area-context |
| react-native-svg | | | ⏳ | ⏳ | |
| react-native-webview | | | ⏳ | ⏳ | |
| expo-notifications (local) | | | ⏳ | ⏳ | remote push needs a paid Apple account |
| expo-secure-store | | | ⏳ | ⏳ | |
| expo-image-picker | | | ⏳ | ⏳ | |
| @gorhom/bottom-sheet | | | ⏳ | ⏳ | |
| @react-native-async-storage/async-storage | | | ⏳ | ⏳ | |
| @react-native-community/datetimepicker | | | ⏳ | ⏳ | |

"Linkage seen" records how the library reached the SwiftPM graph: Expo source package, Expo
precompiled xcframework, RN library with its own Package.swift, or CocoaPods-only (→ Package.swift generated automatically by `spm scaffold` and persisted in the
project's `patches/`).
