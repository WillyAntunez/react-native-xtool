# react-native-reanimated / react-native-worklets: `Package.swift` fails on Linux hosts

Target: the `software-mansion/react-native-reanimated` monorepo (one PR covers both
`packages/react-native-reanimated/Package.swift` and `packages/react-native-worklets/Package.swift`).
Seen with reanimated 4.7.1 and worklets 0.13.0 and 0.13.1.

## Bug

SwiftPM evaluates `Package.swift` on the **host** that runs the build, not on the iOS target. Both
manifests contain:

```swift
func stringifyFlagValue(_ value: Any) -> String? {
    if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() { ... }
```

`CFGetTypeID` and `CFBooleanGetTypeID` do not exist in swift-corelibs-foundation, so on a Linux host
the manifest does not compile.

## Repro

On Linux with a Swift toolchain, in a project that depends on either package:

```
swift package dump-package
error: cannot find 'CFGetTypeID' in scope
```

(with rn-xtool this appears as soon as the app manifest graph is loaded).

## Fix

Keep the CF check on Darwin and use `NSNumber.objCType` elsewhere. On Linux, JSON booleans
decode as `__NSCFBoolean` with `objCType == "c"`, while integers are `"i"`/`"q"` and doubles `"d"`.
Do not use `value as? Bool`: on Linux it also succeeds for `NSNumber(1)`.

```diff
-// NSNumber needs the CFBoolean check to tell booleans apart from integers.
+// NSNumber needs a boolean check to tell booleans apart from integers.
+// CFGetTypeID/CFBooleanGetTypeID only exist on Darwin; this manifest is also
+// evaluated on Linux hosts (swift-corelibs-foundation), where JSON booleans
+// are NSNumbers with objCType "c".
 func stringifyFlagValue(_ value: Any) -> String? {
     if let number = value as? NSNumber {
-        if CFGetTypeID(number) == CFBooleanGetTypeID() {
+#if canImport(Darwin)
+        let isBoolean = CFGetTypeID(number) == CFBooleanGetTypeID()
+#else
+        let isBoolean = String(cString: number.objCType) == "c"
+#endif
+        if isBoolean {
             return number.boolValue ? "true" : "false"
         }
         return number.stringValue
```

Verified on Linux: `{"a":true,"b":1,"c":0,"d":false}` stringifies to `true`, `1`, `0`, `false`, and
`swift package dump-package` succeeds for both manifests.

## Local workaround

rn-xtool applies this fix itself. On every build, after patch-package and before `rn-spm`, the `patches` step scans
the `Package.swift` (and any `Package@swift-*.swift`) of each top-level and scoped package in the project's
`node_modules` (`node_modules/<pkg>`, `node_modules/@scope/<pkg>`). Where the snippet occurs, it rewrites it and prints
`manifest — made <library>'s Package.swift portable to Linux (CFGetTypeID)`. It matches the content, not a version, so
a later release that keeps the snippet is covered too. Checked against reanimated 4.7.1 and worklets 0.13.0 and 0.13.1.
The result is byte-identical to the diff above, comment included. CRLF files keep their line endings.

Limits:
- The manifest is left untouched when the snippet appears in a form rn-xtool does not recognise: more than once, in a
  comment or string, under an `#if`, next to another use of `CFGetTypeID`, or with mixed line endings.
- Packages nested deeper, or hoisted to a monorepo root outside the project, are not scanned.
- A package that is a symlink out of the project's `node_modules` (`npm link`, `file:`, workspaces) is never edited.
  rn-xtool prints `manifest — skipped <library>: it is a link to <path>; apply the portable manifest in its source`.
- A read-only `node_modules` stops the build with `Could not write node_modules/<library>/Package.swift …`.

Projects that followed the earlier advice and persisted the fix with patch-package
(`patches/react-native-reanimated+4.7.1.patch`, `patches/react-native-worklets+0.13.0.patch`) need no change. The patch
applies first, and rn-xtool then finds nothing to fix. If rn-xtool fixed the file first, patch-package sees the patch as
already applied. Once you use an rn-xtool release that includes this fix, these patches can be deleted. With an
older rn-xtool they are still needed.

A patch made with `npx patch-package react-native-reanimated` after an rn-xtool build contains the rewrite too. If such
a patch fails to apply, see [troubleshooting](../troubleshooting.md#build-and-patches).
