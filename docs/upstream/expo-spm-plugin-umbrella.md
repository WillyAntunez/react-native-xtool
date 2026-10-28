# Expo SwiftPM plugin: Swift files without imports lose UIKit

Target: `expo/expo`, `packages/expo/scripts/spm/manifests.js` (`emitPackage`). Seen with expo 58.0.17; still present in 58.0.19
and 58.0.21 (whose `scripts/spm/` is byte-identical to 58.0.19's).

## Bug

`expo-image-picker/ios/StatusBarVisibilityController.swift` has no `import` lines but uses
`UIApplication` and `NSSelectorFromString`. Under CocoaPods every Expo module is a Clang module with an
umbrella header (`<Pod>-umbrella.h`, importing Foundation and UIKit), and Swift implicitly imports that
underlying module, so UIKit is visible in every Swift file. The SPM plugin emits pure-Swift SwiftPM targets,
which have no underlying module, so the build fails on Linux and is expected to fail on macOS as well (not verified):

```
error: cannot find 'UIApplication' in scope
```

## Repro

Expo SDK 58 app with `expo-image-picker`, SwiftPM pipeline (`setup-apple-spm`), then build.

## Fix

For each pure-Swift package the plugin writes a bridging header next to `Package.swift` (not under `root/`,
so it is not a source) and passes it to the Swift compiler. A module whose podspec assigns
`SWIFT_OBJC_BRIDGING_HEADER` (`=` or `=>`) is left alone. Limitation: this is a text scan of the `*.podspec`
files in the module root, `ios/` and `apple/`; the podspec is not evaluated, so a dynamic or out-of-tree assignment is
missed. `umbrella.h` is rewritten only when its content differs, to avoid mtime churn.

```js
const umbrella = path.join(pkgDir, 'umbrella.h');
fs.writeFileSync(umbrella, '#import <Foundation/Foundation.h>\n#import <UIKit/UIKit.h>\n');
umbrellaFlags.push('-import-objc-header', umbrella);   // appended to the swiftSettings unsafeFlags
```

The mechanism emulates Swift's implicit import of the pod's underlying Clang module.

The full diff is the `manifests.js` hunks of `patches/expo+58.0.21.patch`.
