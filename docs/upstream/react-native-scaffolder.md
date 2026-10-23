# React Native SwiftPM scaffolder: two generic fixes (0.88.0)

Both bugs make `react-native spm scaffold` emit an invalid or incomplete `Package.swift` for
CocoaPods-only libraries such as `react-native-gesture-handler`. The fixes live in
`patches/react-native+0.88.0.patch` and are meant to be upstreamed to facebook/react-native.

## 1. `scripts/spm/read-podspec.js`: `getArrayField` ignores Ruby bare lists

`s.source_files = "apple/**/*.{h,m,mm}", "shared/**/*.{h,cpp}"` (no brackets) is valid Ruby, but
`getArrayField` only handles `[...]` and a single string, so only the first glob survives.

Repro (react-native-gesture-handler):

```js
require("react-native/scripts/spm/read-podspec.js")
  .readPodspecCached("node_modules/react-native-gesture-handler/RNGestureHandler.podspec")
  .sourceFiles; // ["apple/**/*.{h,m,mm}"]  (expected both globs)
```

Effect: the `shared/` C++ sources and header search paths are missing from the scaffold.

Fix: after the `[...]` form fails, match a comma-separated list of quoted strings on one line and
collect every item; otherwise fall back to the single-string path.

```diff
diff --git a/node_modules/react-native/scripts/spm/read-podspec.js b/node_modules/react-native/scripts/spm/read-podspec.js
index 8fcf04b..37d6d94 100644
--- a/node_modules/react-native/scripts/spm/read-podspec.js
+++ b/node_modules/react-native/scripts/spm/read-podspec.js
@@ -235,6 +235,7 @@ function regexPodspec(podspecPath /*: string */) /*: RawSpec */ {
   // Matches:
   //   s.<field> = ["a", "b"]            (array)
   //   s.<field> = "single"              (single value treated as 1-element array)
+  //   s.<field> = "a", "b"              (Ruby bare list, no brackets)
   function getArrayField(name /*: string */) /*: Array<string> */ {
     const reArr = new RegExp(`(?:s|spec)\\.${name}\\s*=\\s*\\[([^\\]]*)\\]`);
     const mArr = content.match(reArr);
@@ -249,6 +250,21 @@ function regexPodspec(podspecPath /*: string */) /*: RawSpec */ {
       }
       return out;
     }
+    // Ruby bare list without brackets: s.<field> = "a", "b"
+    const reList = new RegExp(
+      `(?:s|spec)\\.${name}\\s*=\\s*((?:["'][^"']+["']\\s*,\\s*)*["'][^"']+["'])`,
+    );
+    const mList = content.match(reList);
+    if (mList != null) {
+      const out /*: Array<string> */ = [];
+      const itemRe = /["']([^"']+)["']/g;
+      while (true) {
+        const m = itemRe.exec(mList[1]);
+        if (m == null) break;
+        out.push(m[1]);
+      }
+      if (out.length > 0) return out;
+    }
     const single = getStringField(name);
     return single != null ? [single] : [];
   }
```

## 2. `scripts/spm/scaffold-package-swift.js`: invalid header layout for the umbrella header

`publicHeadersPath` is inferred as the first existing prefix directory of the source globs
(`apple` for gesture-handler). When that directory contains the umbrella header `<SwiftName>.h`
next to subdirectories, SwiftPM rejects the target:

```
error: target 'RNGestureHandler' has invalid header layout: umbrella header found at
'.../apple/RNGestureHandler.h', but directories exist next to it: .../apple/Handlers,
.../apple/RNGestureHandler.xcodeproj
```

Repro: `npx react-native spm scaffold` in an app depending on react-native-gesture-handler, then
build the generated package.

Fix: reuse the existing `include/<SwiftName>/` shim (already used for root-level headers). In that
case `namespacedShimHeaders` holds every header among the sources, `publicHeadersPath` becomes
`include`, and the header search paths are unchanged so bare `#import "X.h"` still resolves. The
shim entries may now be relative paths: the shim file is named by basename and imports
`../../<relative path>`. On a basename collision the first header wins and a warning is emitted.

```diff
diff --git a/node_modules/react-native/scripts/spm/scaffold-package-swift.js b/node_modules/react-native/scripts/spm/scaffold-package-swift.js
index cf7e587..b03f9c1 100644
--- a/node_modules/react-native/scripts/spm/scaffold-package-swift.js
+++ b/node_modules/react-native/scripts/spm/scaffold-package-swift.js
@@ -497,6 +497,34 @@ function translatePodspecToSpmTarget(
     }
   }
   let namespacedShimHeaders /*: Array<string> */ = [];
+  // SwiftPM rejects a publicHeadersPath that holds the umbrella header
+  // `<SwiftName>.h` next to subdirectories ("invalid header layout: umbrella
+  // header found ... but directories exist next to it"). Fall back to the
+  // generated include/<SwiftName>/ shim, fed with every header among the
+  // sources; the header search paths above keep bare `#import "X.h"` working.
+  if (publicHeadersPath != null) {
+    const phDir = path.join(dep.root, publicHeadersPath);
+    const hasSubdir =
+      fs.existsSync(path.join(phDir, `${swiftName}.h`)) &&
+      fs.readdirSync(phDir, {withFileTypes: true}).some(e => e.isDirectory());
+    if (hasSubdir) {
+      const seen = new Map();
+      for (const h of headerFiles) {
+        const base = path.posix.basename(h);
+        if (seen.has(base)) {
+          if (seen.get(base) !== h) {
+            warnings.push(
+              `Header basename collision in include/${swiftName}/: keeping '${seen.get(base) ?? ''}', skipping '${h}'.`,
+            );
+          }
+          continue;
+        }
+        seen.set(base, h);
+      }
+      namespacedShimHeaders = [...seen.values()];
+      publicHeadersPath = 'include';
+    }
+  }
   if (publicHeadersPath == null) {
     // Root-level podspecs (`s.source_files = "*.{h,m,mm}"`) keep their
     // headers in the package root. CocoaPods exposes them to dependents as
@@ -1099,10 +1127,12 @@ function scaffoldPackageSwiftForDep(
       const shimDir = path.join(dep.root, 'include', spec.swiftName);
       fs.mkdirSync(shimDir, {recursive: true});
       for (const header of spec.namespacedShimHeaders) {
+        // Entries may be relative paths; the shim file is named by basename.
+        const name = path.posix.basename(header);
         fs.writeFileSync(
-          path.join(shimDir, header),
+          path.join(shimDir, name),
           `// AUTO-SCAFFOLDED by react-native spm scaffold — the namespaced\n` +
-            `// spelling (<${spec.swiftName}/${header}>) of the package-root header,\n` +
+            `// spelling (<${spec.swiftName}/${name}>) of the package-root header,\n` +
             `// matching how CocoaPods header maps expose it.\n` +
             `#import "../../${header}"\n`,
           'utf8',
```

## Tests

`tests/rn-scaffolder.test.ts` loads the patched modules from the reference app and checks both
fixes against fixtures (skipped when the reference app is not present).
