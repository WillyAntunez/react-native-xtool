# react-native-reanimated / react-native-worklets: `Package.swift` fails on Linux hosts

Target: the `software-mansion/react-native-reanimated` monorepo (one PR covers both
`packages/react-native-reanimated/Package.swift` and `packages/react-native-worklets/Package.swift`).
Seen with reanimated 4.7.1 and worklets 0.13.0.

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

Persisted with patch-package in the app: `patches/react-native-reanimated+4.7.1.patch` and
`patches/react-native-worklets+0.13.0.patch`. Drop them once the upstream PR ships.
