# React Native SwiftPM scaffolder: five generic fixes (0.88.0)

These bugs make `react-native spm scaffold` emit an invalid or incomplete `Package.swift` for
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

The repro needs the regex fallback of `read-podspec.js`, i.e. no CocoaPods (`pod`) on `PATH`; with
CocoaPods available RN reads the podspec through Ruby and gets both globs.

Effect: the `shared/` C++ sources and header search paths are missing from the scaffold.

Fix: after the `[...]` form fails, match a comma-separated list of quoted strings on one line and
collect every item; otherwise fall back to the single-string path. `getArrayField` backs
`source_files` and also `frameworks`, `libraries`, `resources`, `exclude_files` and
`public_header_files`, so bare lists are now read correctly for all of them.

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
`../../<relative path>`. On a basename collision the shallowest path (fewest `/`, then lexicographic order) wins and a warning is emitted. The shim
files are `#import` stubs, not symlinks.

```diff
diff --git a/node_modules/react-native/scripts/spm/scaffold-package-swift.js b/node_modules/react-native/scripts/spm/scaffold-package-swift.js
index cf7e587..5e60de0 100644
--- a/node_modules/react-native/scripts/spm/scaffold-package-swift.js
+++ b/node_modules/react-native/scripts/spm/scaffold-package-swift.js
@@ -497,6 +497,40 @@ function translatePodspecToSpmTarget(
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
+    const umbrellaNextToSubdirs =
+      fs.existsSync(path.join(phDir, `${swiftName}.h`)) &&
+      fs.readdirSync(phDir, {withFileTypes: true}).some(e => e.isDirectory());
+    if (umbrellaNextToSubdirs) {
+      // On a basename collision keep the shallowest path (fewest '/'), then
+      // the lexicographically first, so the choice is deterministic.
+      const byDepth = [...headerFiles].sort(
+        (a, b) =>
+          a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0),
+      );
+      const seen /*: Map<string, string> */ = new Map();
+      for (const h of byDepth) {
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
@@ -1099,10 +1133,13 @@ function scaffoldPackageSwiftForDep(
       const shimDir = path.join(dep.root, 'include', spec.swiftName);
       fs.mkdirSync(shimDir, {recursive: true});
       for (const header of spec.namespacedShimHeaders) {
+        // Entries may be nested relative paths (e.g. apple/Handlers/X.h): the
+        // stub is named by basename and #imports the real header by path.
+        const name = path.posix.basename(header);
         fs.writeFileSync(
-          path.join(shimDir, header),
+          path.join(shimDir, name),
           `// AUTO-SCAFFOLDED by react-native spm scaffold — the namespaced\n` +
-            `// spelling (<${spec.swiftName}/${header}>) of the package-root header,\n` +
+            `// spelling (<${spec.swiftName}/${name}>) of the header,\n` +
             `// matching how CocoaPods header maps expose it.\n` +
             `#import "../../${header}"\n`,
           'utf8',
```

## 3. `scripts/spm/read-podspec.js`: Ruby local variables on the right-hand side are not resolved

The regex fallback only understands literal strings/arrays. `react-native-screens/RNScreens.podspec`
hoists its globs into locals:

```ruby
source_files_exts = '{h,m,mm,cpp}'
source_files = ["ios/**/*.#{source_files_exts}"]
s.source_files = source_files
s.exclude_files = "ios/gamma/**/*.#{source_files_exts}"
```

Repro (no `pod` on `PATH`):

```js
require("react-native/scripts/spm/read-podspec.js")
  .readPodspecCached("node_modules/react-native-screens/RNScreens.podspec")
  .sourceFiles; // undefined  (expected ["ios/**/*.{h,m,mm,cpp}"])
```

Effect: the scaffolded `Package.swift` has no `ios/` sources (only the `common` subspec), so the
app builds but crashes at startup with `Screen native module hasn't been linked`.

Fix: a pre-pass `resolveRubyConstants(content)` over the comment-stripped source. It collects
single-line `ident = 'str' | "str" | ["a", "b"]` assignments (first wins), replaces `#{ident}` for
known string constants, and rewrites `s.<field> = ident` (and `ss.`/`s.ios.` forms) to the literal value. Unknown
interpolations and identifiers are left untouched; `ENV[...]` and `if` conditions are not
evaluated. The existing field regexes are unchanged. See the `resolveRubyConstants` hunk in
`patches/react-native+0.88.0.patch`.

## 4. `scripts/spm/read-podspec.js`: the regex parser is blind to subspec blocks

The regex fallback reads one `s.source_files` / `s.exclude_files` and ignores
`s.subspec "common" do |ss| ... end`, while the `pod ipc` path merges the subspecs
(`flattenSubspecs`). `RNScreens.podspec` keeps its C++ in such a subspec:

```ruby
s.subspec "common" do |ss|
  ss.source_files = ["common/cpp/**/*.{cpp,h}", "cpp/**/*.{cpp,h}"]
  ss.header_dir   = "rnscreens"
  ss.pod_target_xcconfig = { "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/common/cpp\"" }
end
```

Effect: no `common/cpp` sources in the scaffolded package, and compiling
`ios/tabs/extensions/RNSTabsHostComponentView+RNSImageLoader.mm` fails with
`'RNSTabsHostShadowNode.h' file not found`.

Accidental match: before fix 3 these sources only appeared because `(?:s|spec)\.source_files`
also matches inside `ss.source_files` (`ss.` contains `s.`). Once the main assignment resolved,
that accident no longer covered the subspec. The main-spec receiver is now
`(?<![\w.])(?:s|spec)`, so it never matches `ss.<field>`.

Fix: `splitSubspecs` cuts each `(s|spec).subspec "name" do |recv|` block (matched to its `end` by
counting Ruby block openers) out of the text. `getStringField`/`getArrayField`/`getDependencies`/
`getFrameworks` take a text and a receiver pattern; the main spec is read with the subspec blocks
removed, each subspec with its own block variable. Values are merged like `flattenSubspecs`:
array fields and `HEADER_SEARCH_PATHS` are unions, `header_dir` stays the main spec's,
`header_mappings_dir`/`compiler_flags` fall back to the first subspec. All subspecs are merged
unless the spec declares `default_subspecs`/`default_subspec`, then only those. A block that
re-binds `s`/`spec` is left alone (see the shadowing warning).

Hardening: the main receiver is read from `Pod::Spec.new do |x|` (fallback `s|spec`), so
`|podspec|` works; `blockDelta` ignores a trailing `# comment` and counts a block opened and closed
on one line (`if … end`, `s.subspec "a" do |ss| … end`) as net 0; `default_subspecs = :none` merges
no subspec (also for `pod ipc` output); `ss.x = ident` and `s.ios.x = ident` get the same bare
identifier rewrite as `s.x = ident`; `#{}` is interpolated only inside double-quoted strings.

Known limits (the regex parser warns that CocoaPods gives the full result): nested subspecs (a
subspec inside a subspec is not split out and its fields read as the parent's), heredocs and
multi-line strings containing `do`/`end`/`if` words, `{ |ss| … }` brace-block subspecs (not
recognised, their fields are lost), and block openers hidden behind modifiers or conditionals other
than the leading-keyword and trailing-`do` forms.

## 5. `scripts/spm/scaffold-package-swift.js`: CocoaPods `header_dir` namespaces are not emulated

CocoaPods `header_dir` (on the main spec or a subspec) exposes ALL of that spec's headers,
flattened, under one namespace. react-native-screens sets `ss.header_dir = "rnscreens"` on its
`common` subspec, so `#import <rnscreens/RNSTabsHostComponentDescriptor.h>` works although the
file is `common/cpp/react/renderer/components/rnscreens/RNSTabsHostComponentDescriptor.h`, and
`cpp/*.h` and `common/cpp/.../rnscreens/utils/*.h` are reachable as `<rnscreens/X.h>` too. The
scaffold did not emulate this (`header_mappings_dir`, the keep-subdirs variant, was already
handled), so `ios/tabs/host/RNSTabsHostComponentView.mm` failed with
`'rnscreens/RNSTabsHostComponentDescriptor.h' file not found`.

Fix: `read-podspec.js` keeps the per-scope association as `headerDirScopes: [{headerDir,
sourceFiles}]` (a main-spec `header_dir` covers its own sources and those of subspecs that set
none; a subspec's covers only its own). `translatePodspecToSpmTarget` expands each scope to its
headers and the writer emits `include/<header_dir>/<basename>.h` stubs (`#import
"../../<path to the real header>"`, same mechanism as the umbrella-header shim). On a basename
collision the shallowest path wins and a warning is added. `include` is added to the target's
header search paths unless it is already `publicHeadersPath`; `include/` is never ingested as a
source.

Guards: a `header_dir` containing `..` or an absolute path is ignored with a warning (the stubs are
written under `include/`); two scopes sharing a stub directory, or a `header_dir` equal to the
target name (it shares `include/<name>/` with the umbrella-header shims), produce a warning; a
subspec's `header_dir = ""` is the root namespace and gets no stubs (its headers are not inherited
under the main spec's `header_dir`).

## 6. `scripts/spm/read-podspec.js`: platform-scoped fields (`s.ios.<field>`) are invisible

The field regexes only match `s.<field>`, so `s.ios.exclude_files = '**/*.macos.{h,m,mm}'`
(react-native-svg) is never read and the macOS-only sources (`*.macos.mm`, AppKit) are compiled for
iOS.

Fix: every string/array reader also tries `<recv>.ios.<field>`. Array fields (`source_files`,
`exclude_files`, `public_header_files`, `frameworks`, `weak_frameworks`, `resources`, ...) are the
union of the generic and the `ios` values; string fields (`header_dir`, `header_mappings_dir`,
`compiler_flags`, ...) take the `ios` value over the generic one. Also applies inside subspecs
(`ss.ios.<field>`). `s.osx.`, `s.macos.`, `s.tvos.`, `s.visionos.` and `s.watchos.` are never read:
the receiver pattern (`(?<![\w.])(?:s|spec)`, then `.`, optionally `ios.`, then the field name)
cannot match them.

## 7. `scripts/spm/*`: no preprocessor defines in the regex path, no `RCT_NEW_ARCH_ENABLED` anywhere

Two gaps. (a) The regex parser only returned `pod_target_xcconfig.HEADER_SEARCH_PATHS`, so
`mergePreprocessorDefines()` had nothing to lift: literal `-DNAME[=VALUE]` in `compiler_flags` and
`OTHER_CFLAGS` / `GCC_PREPROCESSOR_DEFINITIONS` string literals in an xcconfig hash (also the
`[config=*Debug*]` keys) were lost. (b) Nothing under `scripts/spm` defines `RCT_NEW_ARCH_ENABLED`
for scaffolded targets, so libraries gated on it compile their Paper path (react-native-webview's
Fabric view is missing at runtime; svg, screens, gesture-handler and others behave the same).

Fix: `regexPodspec` now also returns those xcconfig keys (string literals only; arrays, `.join`
and `#{}` values are not understood and interpolated tokens are dropped with the other
unresolved ones). `mergePreprocessorDefines` also lifts `-D` tokens from `compiler_flags`, and
`mergeCompilerFlags` no longer repeats a lifted `-D` as an unsafe flag. In
`translatePodspecToSpmTarget`, a React Native library (`coreReactNative`: React-* dependency,
`codegenConfig`, or `install_modules_dependencies`) gets `.define("RCT_NEW_ARCH_ENABLED", to: "1")`
unless the podspec already defines it globally (a per-configuration define does not count).

Why only that macro: CocoaPods' `computeFlags` (`scripts/cocoapods/new_architecture.rb`) adds
`-DRCT_NEW_ARCH_ENABLED=1` and expo's autolinking emits the same define for its own targets. The
Folly macros (`FOLLY_MOBILE`, `FOLLY_USE_LIBCPP`, `FOLLY_CFG_NO_COROUTINES`,
`FOLLY_HAVE_CLOCK_GETTIME`) come from `folly/folly-config.h`, which `folly/portability/Config.h`
includes from the prebuilt headers; defining `FOLLY_NO_CONFIG` would switch that include off.
Consequently the lifting step drops `FOLLY_NO_CONFIG` and every other `FOLLY_*` define found in
`compiler_flags` / xcconfigs (the usual `folly_compiler_flags`), also from the raw flags, and
records one warning naming what was dropped. Defining `FOLLY_NO_CONFIG` without the full CocoaPods
set breaks the build.
`REACT_NATIVE_MINOR_VERSION` is not an RN-defined macro (react-native-svg computes it in its own
podspec) and is not added blindly; see bug 8.

## 8. `scripts/spm/read-podspec.js`: `REACT_NATIVE_*_VERSION=#{...}` defines are dropped

react-native-svg sets `"OTHER_CFLAGS" => "$(inherited) -DREACT_NATIVE_MINOR_VERSION=#{svgConfig[:react_native_minor_version]}"`,
computed in Ruby from `react-native/package.json`. The regex path cannot evaluate it, so the
unresolved-token rule of bug 7 dropped the define and `RNSVGImage.mm` (`#if REACT_NATIVE_MINOR_VERSION > 84`)
compiled the old-RN branch (`no viable conversion from 'RCTImageResponseObserverProxy' to
'std::shared_ptr<const ImageResponseObserver>'`). Many community libraries use this convention, always
meaning the installed React Native.

Fix: `mergePreprocessorDefines` substitutes the number from the installed React Native version
(read from the `package.json` two levels above `scripts/spm`; 0.88.0 gives major 0, minor 88,
patch 0) when the unresolved define is named `REACT_NATIVE_MAJOR_VERSION`,
`REACT_NATIVE_MINOR_VERSION` or `REACT_NATIVE_PATCH_VERSION` and its value has no Xcode `$(...)`
token. It emits the `.define` and records a warning naming the substitution. Any other interpolated
define stays dropped.

## Tests

`tests/rn-scaffolder.test.ts` loads the patched modules from the reference app and checks the
fixes against fixtures (skipped when the reference app is not present; set `EXPO_XTOOL_REF_APP` to point at it). It also
asserts that each hunk is present in the installed RN files. Upstream, equivalent tests belong in
RN's own `__tests__` next to `read-podspec` and `scaffold-package-swift`.
