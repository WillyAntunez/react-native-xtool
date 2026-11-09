# React Native SwiftPM scaffolder: generic fixes (0.88.0 and 0.88.1)

These bugs make `react-native spm scaffold` emit an invalid or incomplete `Package.swift` for
CocoaPods-only libraries such as `react-native-gesture-handler`. The fixes live in
`patches/react-native+0.88.0.patch` and `patches/react-native+0.88.1.patch` and are meant to be upstreamed to
facebook/react-native.

Where the fixes live in rn-xtool: in `patches/react-native+0.88.0.patch` and `patches/react-native+0.88.1.patch`
(each applied only to an installed react-native of its version; the three patched files are byte-identical in 0.88.0
and 0.88.1, so the two patches are the same file, and `tests/patches.test.ts` keeps them identical: a fix edits both)
and, for bare React Native 0.85.x, 0.86.x and 0.87.x, already applied in the vendored copy of the 0.88.0 scripts in
`vendor/rn-spm/` ([README](../../vendor/rn-spm/README.md)).

Refreshing for a new React Native 0.88.x: add `patches/react-native+0.88.<x>.patch` for it (refreshed against it, or a
copy when the patched files are unchanged, as for 0.88.1), regenerate
`vendor/rn-spm` from the new tarball plus that patch plus `vendor/rn-spm/rn-xtool-edits.patch`, and update the pinned
tarball and integrity in `tests/vendor-rn-spm.test.ts`. The supported-version list in `src/versions.ts` then needs the
new version added.

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
evaluated (except fix 19's). The existing field regexes are unchanged. Fix 28 replaced this pass with an evaluator
that runs the podspec's assignments and conditions in order (`evaluateRubyLocals`); the cases above are a subset of
it.

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

## 9. `scripts/spm/scaffold-package-swift.js`: target arguments are emitted in an order SwiftPM rejects

Pre-existing upstream bug, not caused by our patch. The target emitter writes `sources`, then
`publicHeadersPath`, then `resources`. SwiftPM requires the order `exclude`, `sources`, `resources`,
`publicHeadersPath`, `cSettings`, `cxxSettings`, `swiftSettings`, `linkerSettings`, and rejects anything
else: `error: argument 'resources' must precede argument 'publicHeadersPath'`. Any podspec with
`resources` (react-native-svg, for one) produced an invalid manifest.

Fix: emit `resources` before `publicHeadersPath` (`exclude` stays right after `path`). Verified with
`swift package dump-package` on the generated manifest.

## 10. `scripts/spm/scaffold-package-swift.js`: mixed-language libraries are skipped although SwiftPM ≥ 6.4 supports mixed targets

`scaffoldPackageSwiftForDep` returned `skipped-mixed-language` for every podspec whose sources mix Swift
and C-family files ("SPM cannot compile mixed-language sources in one target"), and the autolinker
(`generate-spm-autolinking.js`, `hasMixedLanguageSources` / `reportMissingManifests`) prints the same claim
with "opt it out or use an xcframework". That is no longer true: SwiftPM 6.4 builds one target holding
Swift and C/Objective-C sources behind the tools-version feature
`// swift-tools-version: 6.4;(experimentalMultiLang)` (swiftbuild backend only), and SE-0541 (accepted,
implemented on SwiftPM `main`) makes it standard, without the flag, in tools-version 6.5. CocoaPods and
Xcode compile such a pod as ONE module, which is what react-native-pager-view, async-storage,
expo-application and others rely on (an `.mm` file imports `<Module>-Swift.h`, Swift uses the pod's
Objective-C classes, often both).

Fix: when a library mixes languages, emit one mixed-language target instead of skipping it.

- First line `// swift-tools-version: 6.4;(experimentalMultiLang)`; single-language libraries keep
  `// swift-tools-version: 6.0` and their output is unchanged.
- Next to it, `Package@swift-6.5.swift`: the same manifest with `// swift-tools-version: 6.5` and no
  experimental flag. SwiftPM 6.5+ picks the versioned manifest (6.5 does not read `experimentalMultiLang`),
  6.4 ignores it. The scaffolder never takes it as a source and removes its own copy when a library stops
  being mixed. Untested on a 6.5 toolchain (none installed here): it still carries the 6.4 unsafe flags.
  **Deferred:** Swift 6.5 behaviour of mixed manifests (possible double import via `-import-objc-header` plus
  the SE-0541 underlying module) is unverified; needs a 6.5 toolchain.
- `sources` lists both the Swift and the C-family files; `publicHeadersPath`, the `include/` shims and the
  header search paths are computed as before.
- **Swift → Objective-C.** SwiftPM 6.4.x does not give Swift the target's own headers (6.5 does, via the
  `publicHeadersPath` underlying module or `.bridgingHeader`). The scaffolder writes
  `rn-spm-swift/umbrella.h` (Foundation, UIKit and the module's headers) and passes it with
  `swiftSettings: [.unsafeFlags(["-import-objc-header", Context.packageDirectory + "/rn-spm-swift/umbrella.h"])]`.
  The bridging header is parsed as Objective-C, so headers that reach C++ are left out (with a
  warning): a header is C++ when, after dropping `#if(def) __cplusplus` branches, it has C++ syntax
  (`namespace … {`, `template <`, `std::`, `class X :`, `<memory>`-style includes) or includes a header
  that is C++ (looked up in the module's header dirs and in the local React header trees under
  `build/xcframeworks`); an include that cannot be resolved counts as C++ only under a C++-only root
  (`react/`, `folly/`, `jsi/`, `yoga/`, …). A podspec that sets `SWIFT_OBJC_BRIDGING_HEADER` in an xcconfig
  keeps its own header instead.
- **Objective-C → Swift.** Swift Build writes the generated header, named after the TARGET
  (`react-native-pager-view-Swift.h`, not the c99 module name `react_native_pager_view`), to
  `<scratch>/out/Intermediates.noindex/GeneratedModuleMaps-<platform>/`, a flat directory shared by
  every Swift module of the build (a per-target copy also sits under
  `<Target>.build/<Config>-<platform>/<Target>-t.build/Objects-normal/<arch>/`). That directory
  belongs to the ROOT build, not to the library. The manifest reads it from the environment so the
  persisted (patch-package) manifest holds no absolute path:

  ```swift
  let rnSpmSwiftHeadersDir = Context.environment["RN_SPM_SWIFT_HEADERS_DIR"]
      ?? (Context.packageDirectory + "/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos")
  // cSettings and cxxSettings:
  .unsafeFlags(["-I", rnSpmSwiftHeadersDir])
  ```

  The fallback is only right when the package is built on its own; the scaffolder warns when the
  variable is unset at scaffold time. (`$(GENERATED_MODULEMAP_DIR)` would be the clean spelling, but
  SwiftPM rejects build-setting macros inside `unsafeFlags`; SE-0541 adds that search path itself.)
- **Header spellings.** Sources written for CocoaPods spell the header after the pod's module
  (`module_name`, else `header_dir`, else the pod name, in c99 form): `#import "<PodModule>-Swift.h"` or
  `#import <PodModule/PodModule-Swift.h>` (use_frameworks). `rn-spm-swift/<PodModule>/<PodModule>-Swift.h`
  always forwards to `<Target>-Swift.h`, and a flat `rn-spm-swift/<PodModule>-Swift.h` is added when the
  two names differ (react-native-pager-view: `react_native_pager_view-Swift.h` →
  `react-native-pager-view-Swift.h`). The forwarders use angle brackets so the lookup skips their own
  directory. `rn-spm-swift/` is on the header search path and never part of the
  public headers or the sources.
- `@import <Module>;` works from OTHER modules (SwiftPM gives every Swift target a module map), but
  inside the mixed module itself it is a no-op (clang builds that module with `-fmodule-name=<Module>`),
  exactly as in an Xcode framework target; such sources must use `#import "<Module>-Swift.h"`.
- **C++ standard.** SwiftPM 6.4's swiftbuild backend does not apply the package's
  `cxxLanguageStandard: .cxx20` to a mixed target: its `.mm`/`.cpp` files compiled with the clang
  default and failed on React's C++20 headers (`unknown type name 'concept'`, `no type named 'identity'
  in namespace 'std'`). Mixed targets get `cxxSettings: .unsafeFlags(["-std=c++20"])`.
- No `-all_load`: the products stay static/automatic and the app links with `-ObjC`. A `.dynamic`
  product would hit Swift Build's eager-linking `tapi` step, which does not exist on Linux.

Upstream, the clean version is: emit `Package.swift` with tools-version 6.5, `.bridgingHeader(...)` and
no unsafe flags, plus a `Package@swift-6.4.swift` with the form above while 6.4 toolchains are
supported; and drop or reword the "cannot compile mixed-language sources" error in
`generate-spm-autolinking.js`. Note that `experimentalMultiLang` is gone on SwiftPM `main` and unknown
features are ignored silently there, so the 6.4 form must not be the only manifest once 6.5 ships.

The autolinker still prints its "has mixed Swift + Objective-C/C++ sources" error for a mixed library
that has no manifest yet; rn-xtool treats that message like "Package.swift is missing" and runs
`scaffold`, which now writes the manifest.

Builders must export `RN_SPM_SWIFT_HEADERS_DIR` wherever SwiftPM evaluates the manifest (rn-xtool sets
it for the `rn-spm` runs and for `xtool dev build` / `dev run`). Verified on fixtures for both
directions and the circular case (compiled with Swift 6.4.1 and the swiftbuild backend for
`arm64-apple-ios16.4`; the products hold both the Objective-C and the Swift classes) and on
react-native-pager-view 9.0.7 in the reference app (direction B: builds and links; it also needed fix 11
and the SwiftUIIntrospect package, wired by fix 13; see `docs/libraries.md`).

## 11. `scripts/spm/scaffold-package-swift.js`: bare imports of React headers do not resolve

CocoaPods' header map resolves a bare `#import "RCTFoo.h"` against the public headers of the pod's
dependencies, and create-react-native-library's Fabric template writes exactly that:
`#import "RCTFabricComponentsPlugins.h"` (react-native-pager-view). Under SwiftPM, React's headers are
only reachable as `<React/RCTFoo.h>` (the `ReactHeaders` product), so the build fails with
`'RCTFabricComponentsPlugins.h' file not found`.

Fix: for React Native libraries, the scaffolder scans the C-family sources and headers for bare quoted
includes that match no header of the library itself but exist as `React/<name>` in the local React
header trees (`build/xcframeworks/ReactHeadersTarget/include`, `*.xcframework/ios-arm64/Headers`), writes
a forwarding stub `rn-spm-react-headers/<name>` (`#import <React/<name>>`) and puts that directory on the
header search path. Libraries without such includes (all the others in our matrix) are unchanged. In
remote mode the React trees are not local, so nothing is emitted.

## 12. `scripts/spm/spm-utils.js`: the per-app header farm is an umbrella module of C++ headers

`buildPerAppHeaderTree` vends `build/generated/ios/ReactAppHeaders` (autolinking headers + codegen output)
as the `ReactAppHeaders` target with `publicHeadersPath: "."` and no module map, so SwiftPM generates an
umbrella-directory module over the whole farm. An Objective-C (`.m`, not `.mm`) file that imports one
Objective-C header from it — expo-dev-launcher's `EXDevLauncherController.m` does
`#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>` — makes clang build that module, i.e. every
codegen/JSI C++ header, in Objective-C mode:
`RCTRequired.h:8:10: 'utility' file not found` → `could not build module 'ReactAppHeaders'`.
Objective-C++ consumers never noticed (the C++ headers compile there).

Fix: write a header-less `module.modulemap` into the farm
(`module ReactAppHeaders { export * }`). SwiftPM uses a module map it finds in the public headers
directory instead of generating one, and the farm's headers are then included textually — as CocoaPods'
header search paths include them. Nothing imports `ReactAppHeaders` as a module (Swift cannot: it is C++).
Verified with the full reference app (all scaffolded and Expo modules still build) plus the dev client.

**Ruling: accepted behaviour change.** The farm is no longer a Clang module; its headers are included
textually by every consumer, as CocoaPods' header search paths include them. Verified on this app's library
set only (screens, gesture-handler, svg, webview, datetimepicker, pager-view, reanimated/worklets, the Expo
modules and the dev client). A library that does `@import ReactAppHeaders;`, or whose codegen header is not
include-guarded, would break; none in that set does.

## 13. `scripts/spm/scaffold-package-swift.js`: CocoaPods pod dependencies are dropped

A podspec `s.dependency "X"` that names neither a React Native / Expo module nor an autolinked sibling is a
CocoaPods pod (react-native-pager-view 9.x: `s.dependency "SwiftUIIntrospect", '~> 1.0'`). The scaffolder
dropped it with "Unknown dependency ... Edit manually if needed", so the scaffolded package failed with
`unable to resolve module dependency: 'SwiftUIIntrospect'` and had to be edited by hand.

Fix: a pod table (pod → `{ url, exact, products, subspecs?, forwardHeaders? }`) turns a known pod into
`.package(url: "<url>", exact: "<exact>")` + one `.product(name: "<product>", package: "<identity>")` per product
(identity = the URL's last path component). A `<pod>/<subspec>` dependency takes the products `subspecs` names for it,
else the entry's; an entry with `product: "<name>"` reads as `products: ["<name>"]`. The built-in baseline,
`KNOWN_POD_SPM_PACKAGES`, holds one entry,
`SwiftUIIntrospect → https://github.com/siteline/swiftui-introspect exact "1.5.0"` (the newest 1.x, within the
podspec's `~> 1.0`; pinned because `ios-xtool/` has no committed Package.resolved, so a range would drift).
`loadPodTable` merges over it the `pods` object of the JSON file named by the environment variable
`RN_SPM_POD_TABLE` (per pod, the file's entry wins); rn-xtool writes that file with its own entries and the app's.
A file that cannot be read or has the wrong shape is an error result for each library scaffolded with it:
`react-native spm scaffold: cannot read the pod table <file>: <reason>`. A manifest that pins at least one pod records
the pins, sorted by pod, on a line after the importer-paths line (or the revision line):
`// rn-xtool-pods: AppAuth=3.0.0, SwiftUIIntrospect=1.5.0`. A pod whose SwiftPM package leaves its umbrella header
outside every target (AppAuth-iOS 3.0.0's `Sources/AppAuth.h`: `@import AppAuth;` works, `<AppAuth/AppAuth.h>` and
`"AppAuth.h"` do not, while CocoaPods copies the header into `Headers/Public/AppAuth/`) names the header in
`forwardHeaders`, with the headers the umbrella includes, as paths under the public header directories of the
package's targets (`{ "AppAuth/AppAuth.h": ["OIDAuthState.h", …, "iOS/OIDAuthState+IOS.h", …] }`). The scaffold then
writes `rn-spm-pod-headers/AppAuth/AppAuth.h` into the library, holding the banner and one `#import <header>` per
entry, and adds `.headerSearchPath("rn-spm-pod-headers")` to its C and C++ settings. The forwarder is textual:
Objective-C++ compiles with `-fmodules -fno-cxx-modules`, as Xcode does by default, so an `@import` in it stopped
every `.mm` file that included it with `use of '@import' when modules are disabled`, while in Objective-C the
`#import` of a module's header still imports the module. A header key must be a relative path ending in `.h` without
`.` or `..` segments, and so must each listed header, in letters, digits and `_+.-`; otherwise that library gets the
error `react-native spm scaffold: pods.<pod>.forwardHeaders.<header> must be a list of the pod's public headers
(relative paths ending in .h), under a relative path ending in .h`. A module name in the list (the format before the
forwarders were textual) gets `react-native spm scaffold: pods.<pod>.forwardHeaders.<header> lists the module <name>;
list the pod's public headers instead (relative paths ending in .h), which the forwarder includes textually:
Objective-C++ compiles without modules, so it cannot @import`. The textual forwarder ships with
`RN_XTOOL_SCAFFOLD_REVISION` 5. A scaffold without forwarders removes a `rn-spm-pod-headers/` whose files all carry the
banner. An unmapped pod gets one warning per pod (subspecs collapse to the root pod): `Dependency "<pod>" is a
CocoaPods pod with no known SwiftPM equivalent; the scaffolded package may fail to build — add it under "pods" in
rn-xtool.config.json: { "pods": { "<pod>": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } }
}`. Expo-named pods
(`expo-*`, `Expo*`, `EX*`) keep the old "Unknown dependency" warning. React Native's own pods are core, not
CocoaPods pods: besides the `React-`, `RCT`, `ReactCommon`, `glog`, `boost`, `fmt`, `DoubleConversion`, `Yoga` and
`hermes-engine` prefixes, the names `React`, `ReactNativeDependencies`, `FBLazyVector`, `FBReactNativeSpec`,
`fast_float`, `ReactCodegen` and `SocketRocket` (the prebuilt runtime provides them); a test reads every podspec name
in the cached react-native tarballs and expects each to be core. A remote package makes the first build
of a clean `.build` need network (SwiftPM clones it). Verified on react-native-pager-view 9.0.7: re-scaffolded
from scratch, it builds with no hand edit.

## 14. `scripts/spm/scaffold-package-swift.js`: the Swift umbrella of a mixed target imports the module's own `-Swift.h`

The Swift umbrella (`rn-spm-swift/umbrella.h`, fix 10) took every Swift-importable module header. react-native-screens
4.26's `ios/bridging/Swift-Bridging.h` imports `<RNScreens/RNScreens-Swift.h>` (or `"RNScreens-Swift.h"`), the header
Swift writes only after it has compiled the module, so the Swift compile of RNScreens failed with
`'RNScreens-Swift.h' file not found` (screens 4.30 dropped that file).

Fix: `importsOwnSwiftHeader` leaves out of the umbrella every header that imports `<Module>-Swift.h` under the target
name or the CocoaPods module name (`module_name`, else `header_dir`, else the pod name, c99), with or without a
`<Module>/` prefix. Lines inside `#if __cplusplus` branches do not count (Swift never sees them). One warning names the
headers left out. Limit: each header is checked on its own, so a header that imports one of those still pulls it in.

## 15. `scripts/spm/read-podspec.js`: `#{package['version']}` in flags and defines is dropped

react-native-worklets 0.10 sets `version_flag = "-DWORKLETS_VERSION=#{package['version']}"` and puts it in
`OTHER_CFLAGS` (reanimated 4.5 does the same with `REANIMATED_VERSION` and `reanimated_package_json`). The regex path
cannot evaluate the interpolation, so the unresolved-token rule of bug 7 dropped the define:
`WorkletsVersion.cpp:19:22: use of undeclared identifier 'WORKLETS_VERSION_STRING'`.

Fix: `resolvePackageVersion` finds the variables a podspec loads its own `package.json` into
(`<var> = JSON.parse(File.read(File.join(__dir__, "package.json")))`, or `File.dirname(__FILE__)`) and replaces
`#{<var>['version']}` and `#{<var>["version"]}` inside double-quoted strings with the version read from the
`package.json` next to the podspec, before the Ruby constants pass (fix 3) runs. Single-quoted strings are left
alone, as in Ruby. Any other interpolation stays as written and is still dropped.

## 16. `scripts/spm/*`: a subspec's `header_mappings_dir` under `header_dir` is flattened

CocoaPods exposes a header under a `header_mappings_dir` as `<header_dir>/<path below the mappings dir>`.
react-native-worklets 0.10 has `s.header_dir = "worklets"` and the subspecs `common` (`header_mappings_dir =
"Common/cpp/worklets"`) and `apple` (`"apple/worklets"`), and includes `<worklets/apple/AnimationFrameQueue.h>`.
The scaffolder flattened every `header_dir` stub to its basename, and the regex reader kept only the first
subspec's mappings dir, so the build failed with `'worklets/apple/AnimationFrameQueue.h' file not found`.

Fix: each `header_dir` scope (`headerDirScopes`, fix 5) carries the mappings dirs of its layers plus the main
spec's (subspecs inherit it), read per layer on both the regex and the `pod ipc spec` path. A header under one of
them gets its stub at `include/<header_dir>/<path below the deepest such dir>`
(`include/worklets/apple/AnimationFrameQueue.h` → `apple/worklets/apple/AnimationFrameQueue.h`,
`include/worklets/Tools/X.h` → `Common/cpp/worklets/Tools/X.h`). Other headers keep the flat stub. A mappings dir that
is absolute or contains `..` is ignored. Not covered: a subspec with `header_dir = ""` (the root namespace, reanimated's
`view` subspec) still gets no stubs. Also, the subspecs that inherit the main `header_dir` share one scope, so a header
is mapped by whichever of their mappings dirs holds it, not only by its own subspec's.

## 17. `scripts/spm/scaffold-package-swift.js`: Swift importers of a mixed target lack its header search paths

A Swift module built with a bridging header makes every Swift importer re-read that header, so the importer needs
the header search paths the header's includes resolve with. expo-router (`import RNScreens`) and the app target
failed with `'RNSReactBaseView.h' file not found` through the scaffolded RNScreens umbrella.

Fix: every scaffolded mixed manifest records them on one line right after the revision line:
`// rn-xtool-swift-importer-paths: <JSON array>`, the target's header search paths in the manifest's order,
package-relative (paths that leave the package, absolute or with a `..` segment, are left out). For example
`[…,"ios","ios/bridging",…,".","include","rn-spm-swift"]`. Pure-Swift manifests carry no marker.
rn-xtool's Expo plugin (X6c) passes them as `-Xcc -I<package>/<path>` to the Expo packages that depend on the
library, and the app target gets them the same way (X6d). Fixes 14 to 17 come with `RN_XTOOL_SCAFFOLD_REVISION` 2, so
revision-1 scaffolds are regenerated.

A clang-only target has the same problem without a bridging header: an importer builds its module from the public
headers with only `publicHeadersPath` on the search path. react-native-screens 4.30 has no Swift file, so it is
scaffolded clang-only; its `ios/RNSConvert.h` (under `publicHeadersPath: "ios"`) imports `"RNSDefines.h"`, which is in
`ios/utils`, and expo-router failed with `'RNSDefines.h' file not found` while building module `RNScreens`. So a
clang-only manifest also carries the marker, with the same list, whenever one of its header search paths is not its
`publicHeadersPath` (SwiftPM's default `include` when it has none). This comes with `RN_XTOOL_SCAFFOLD_REVISION` 3, so
revision-2 clang-only scaffolds, which lack the marker, are regenerated. On the eight libraries the reference app
persists in `patches/`, revision 3 changes only the revision line and adds the importer line to every manifest: the
mixed one (react-native-pager-view 9.0.7) and the five clang-only ones, whose search paths all include at least `.`
(golden in `tests/fixtures/scaffold-golden/`; react-native-reanimated and react-native-worklets ship their own
manifests and are not scaffolded).

## 18. `scripts/spm/scaffold-package-swift.js`: a clang-only module takes in headers the target leaves out

An importer builds a clang-only target's module from the module map SwiftPM generates, `umbrella
"<publicHeadersPath>"`, which takes in every header under that directory, whatever the target compiles.
react-native-screens 4.30 keeps `ios/gamma/**` out of its sources unless `RNS_GAMMA_ENABLED` is set, and expo-router
failed with `'RNSViewFrameChangeDelegate.h' file not found` while building module `RNScreens` from
`ios/gamma/stack/header/RNSStackHeaderConfigComponentView.h`. A mixed target never had this problem: SwiftPM's module
map for it holds only the `-Swift.h`, and importers see the Objective-C side through the generated umbrella, which is
built from the source headers (screens 4.26.2: 72 headers, none from `ios/gamma`).

Fix: when headers under `publicHeadersPath` are not among the target's headers (`exclude_files`, or a source glob
that misses them), or a kept one imports the module's own `-Swift.h` (fix 14; a clang-only target has none), the
scaffold writes `<publicHeadersPath>/module.modulemap`. SwiftPM uses it instead of its own. It is SwiftPM's module
with an `exclude header` per such header:

```
module RNScreens {
    umbrella "."
    exclude header "gamma/modals/form-sheet/RNSFormSheetConfigurationApplicator.h"
    …
    export *
}
```

Header membership stays SwiftPM's, so an importer's `#import "X.h"` of a kept header still resolves to the module. A
separate umbrella header outside the directory, as for mixed targets, would make such includes textual. None is
written when nothing is left out, when SwiftPM would use an umbrella header named after the module, or over a
module map the library ships. A stale one of the scaffolder's own is removed. Generated `include/` stubs count as
kept. Not covered: if `publicHeadersPath` changes between two scaffolds, the old directory keeps its map. On the
reference app's libraries, react-native-screens 4.30.0 gets 72 `ios/gamma` excludes, and react-native-svg gets one,
`Utils/RNSVGFabricConversions.h`. The regex reader applies that one from the podspec's old-architecture branch, and
the header is C++, so no importer could build it in Objective-C. Ships with `RN_XTOOL_SCAFFOLD_REVISION` 3.

## 19. `scripts/spm/read-podspec.js`: `ENV['RCT_HERMES_V1_ENABLED']` ternaries are not evaluated

react-native-worklets (0.8.3 and 0.10.1 alike) sets
`hermes_v1_flag = ENV['RCT_HERMES_V1_ENABLED'] == '1' ? '-DHERMES_V1_ENABLED' : ''` and puts it in `OTHER_CFLAGS`.
Under CocoaPods the define is always there: React Native's `react_native_pods.rb` sets `RCT_HERMES_V1_ENABLED` to `1`
unless the user sets `0` (0.85 and 0.86), or sets it to `1` outright (0.87 and 0.88). The regex path left `#{hermes_v1_flag}`
unresolved, so the define was dropped, and with `HERMES_ENABLE_DEBUGGER=1` (Debug) worklets 0.8.3 compiled its
legacy-Hermes branch: `WorkletHermesRuntime.h:21:10: fatal error: 'hermes/inspector-modern/chrome/Registration.h'
file not found` (on React Native 0.85.0 with reanimated 4.3.4; no prebuilt artifact slot ships that header).

Fix: the Ruby constants pass (fix 3) also resolves a single-line string ternary on an environment variable that
React Native's CocoaPods setup sets for every pod, `ident = ENV['VAR'] == 'v' ? 'a' : 'b'` (or `!=`, either quote
style), for `RCT_NEW_ARCH_ENABLED` and `RCT_HERMES_V1_ENABLED`. The value is `1` for both, whatever the environment
says: React Native 0.87 and 0.88 set both to `1` outright, and the prebuilt artifacts are V1 Hermes, so a `0` left in
the shell could only break the build, and a persisted scaffold with it. The `pod ipc` path, taken when the CocoaPods
gem is on `PATH`, runs `pod ipc spec` with the same two values in its environment; upstream it set only
`RCT_NEW_ARCH_ENABLED`, and only when the environment did not. Any other `ENV[...]` condition, and every `if`, was
not evaluated until fix 28, which reads every other variable as unset. The scaffolded worklets target then gets
`.define("HERMES_V1_ENABLED")` in its C and C++ settings, and 0.8.3 builds on React Native 0.85.0. worklets 0.10.1
(the Expo SDK 57 pin) gets the same define in a new scaffold; a scaffold persisted earlier keeps its manifest
until `RN_XTOOL_SCAFFOLD_REVISION` 4 (fixes 20 to 24) marks it as older.

## 20. `scripts/spm/*`: a dependency on a package that is not installed stops the scaffold

react-native-vision-camera 4.7.3 defines its `FrameProcessors` subspec (Objective-C++ sources and
`fp.dependency "react-native-worklets-core"`) only `if enableFrameProcessors`, and the podspec sets that to false when
react-native-worklets-core does not resolve. The regex reader evaluates no condition and merges every subspec (fix 4),
and the dependency loop makes any `react-native-*` dependency a sibling, so the emitter threw and no manifest was
written:

```
react-native spm scaffold: no resolved Swift name for the sibling 'react-native-worklets-core'. expandSpmDependencies must resolve every dep's name before a manifest is written.
```

React Native then reported `"react-native-vision-camera" has mixed Swift + Objective-C/C++ sources`, which hid the
cause.

Fix: `classifyPodDependency` names what a dependency is (a subspec of the same pod, React Native core, an Expo module,
an autolinked sibling, a sibling that is not linked for iOS, a mapped or an unmapped CocoaPods pod), in the order the
dependency loop always checked. A sibling is a pod name that the index of the autolinked podspecs maps to an npm
package, else an npm package named `react-native-*`. The index comes first because a `react-native-*` pod name can
belong to a scoped package (@react-native-community/netinfo's pod is `react-native-netinfo`). The index also holds the
packages autolinking lists without iOS, so a pod-style dependency on one of those is a sibling too, not an unknown pod.
A sibling that is not linked for iOS is left out, as CocoaPods leaves it out:

- declared by the main spec, the dependency alone is left out, and every source stays:
  `Dependency "<name>" is not installed (or not linked for iOS); left out, as CocoaPods leaves it out.`
- declared by a subspec, the subspec goes with it. The podspec is read again without that subspec
  (`readPodspecCached(path, {dropSubspecs})`, on both the regex and the `pod ipc spec` path): its sources, excludes,
  public headers, `header_dir`, `header_mappings_dir`, frameworks, libraries, xcconfig defines and dependencies, and the
  spec's `<Pod>/<subspec>` references to it.
  `Dependency "<name>" is not installed (or not linked for iOS); left out with the subspec "<subspec>" that declares it
  (its sources, headers, settings and dependencies), as CocoaPods leaves it out.`

The model keeps each selected subspec's own dependencies (`subspecDependencies`) for this. Not covered: a pod-style name
of an npm package that is not installed at all cannot be told from a CocoaPods pod, and is warned about as an unmapped
pod; CocoaPods fails on it too. Found on react-native-vision-camera 4.7.3 without react-native-worklets-core: it
scaffolds without Frame Processors, as CocoaPods builds it. Ships with `RN_XTOOL_SCAFFOLD_REVISION` 4.

## 21. `scripts/spm/*`: scaffolded Swift compiles in the Swift 6 language mode

A mixed scaffold uses `// swift-tools-version: 6.4;(experimentalMultiLang)` (6.5 in `Package@swift-6.5.swift`), and a
pure-Swift one `6.0`. Every tools version from 6.0 up defaults to the Swift 6 language mode (`-swift-version 6` on the
compile line), while CocoaPods compiles a pod in Swift 5 unless its podspec declares `swift_version`. react-native-video
6.19.3 failed with seven strict-concurrency errors:

```
AudioSessionManager.swift:5:16: error: static property 'shared' is not concurrency-safe because non-'Sendable' type 'AudioSessionManager' may have shared mutable state
```

react-native-vision-camera 4.7.3 fails the same way (`GlobalReferenceHolder.swift:11:22`, `CameraView.swift:23:40`).

Fix: the reader reads `swift_version` and `swift_versions` (a string or an array, `ios`-scoped too, from the main spec
and every selected subspec, on both the regex and the `pod ipc spec` path) into `swiftVersions`. A value Ruby would
interpolate, or an identifier the reader cannot resolve, counts as absent. A target with Swift sources (mixed or pure
Swift) gets `swiftLanguageModes: [.v5]` at package level, in both manifests, unless the highest declared major version
is 6 or higher. Not covered: a library that declares Swift 6 but is not Swift 6 clean fails as it does under CocoaPods.
Found on react-native-video 6.19.3 and react-native-vision-camera 4.7.3: with the Swift 5 mode set by hand, both built
with warnings only. On the reference app's libraries only react-native-pager-view 9.0.7 (mixed, no `swift_version`)
changes. Ships with `RN_XTOOL_SCAFFOLD_REVISION` 4.

## 22. `scripts/spm/scaffold-package-swift.js`: invalid header layout for an umbrella directory

react-native-device-info 15.0.2 gets `publicHeadersPath: "ios"`, and `ios/` holds `RNDeviceInfo/RNDeviceInfo.h`
(SwiftPM's umbrella-directory layout) next to `RNDeviceInfo.xcodeproj/`. SwiftPM refuses it:

```
target 'RNDeviceInfo' has invalid header layout: umbrella header found at '…/ios/RNDeviceInfo/RNDeviceInfo.h', but more than one directory exists next to its parent directory: …/ios/RNDeviceInfo.xcodeproj; consider reducing them to one
```

Fix 2 checks only `<publicHeadersPath>/<SwiftName>.h`. Fix: the `include/<SwiftName>/` shim of fix 2 is also used
when `<publicHeadersPath>/<SwiftName>/<SwiftName>.h` exists and the public headers directory holds any other
directory. The shim is fed with every header among the sources, and the basename-collision warning is fix 2's,
unchanged. A lone `<SwiftName>/` directory is left as it is: SwiftPM accepts it. Found on react-native-device-info
15.0.2, which built by hand with `publicHeadersPath: "ios/RNDeviceInfo"`. Ships with `RN_XTOOL_SCAFFOLD_REVISION` 4.

## 23. `scripts/spm/spm-utils.js`: a bare include of a library's codegen header does not resolve

@react-native-community/netinfo 11.5.2's `ios/RNCNetInfo.mm` does `#import "RNCNetInfoSpec.h"` under
`RCT_NEW_ARCH_ENABLED`, which the scaffold defines. Codegen writes
`build/generated/ios/ReactCodegen/RNCNetInfoSpec/RNCNetInfoSpec.h`, and the per-app header farm (`ReactAppHeaders`,
fix 12) vends it only as `<RNCNetInfoSpec/RNCNetInfoSpec.h>`, the spelling react-native-localize and
react-native-webview use. CocoaPods' header search paths make the bare spelling work too; SwiftPM failed:

```
ios/RNCNetInfo.mm:12:9: fatal error: 'RNCNetInfoSpec.h' file not found
```

Fix: `buildPerAppHeaderTree` writes a forwarder `X.h` at the root of the farm for each codegen directory
`ReactCodegen/X` that holds `X/X.h` (every library with `codegenConfig.name` X gets one), with the scaffolder banner
and `#import <X/X.h>`. A header the farm already has at its root is left as it is. When a library's own header in the
farm is named `X.h` too (`<SwiftName>/X.h`), no forwarder is written, so it cannot shadow that header on a search path,
and the build log says so: `WARNING: merged headers: no bare "X.h" forwarder to <X/X.h>: <SwiftName>/X.h has that name
and keeps it`. Every library that depends on React core already has the farm on its header search path, so the
scaffolded manifests do not change, and the forwarder, rebuilt with the farm on every run, holds no path at all.

A search path in the manifest was tried first: `Context.packageDirectory + "/../../../ios/ReactCodegen/X"`, relative
to the `libs/<SwiftName>` symlink the autolinker references the package through. SwiftPM does evaluate
`Context.packageDirectory` as the symlink path, but the compiler resolves `..` after following the symlink, from the
library's real directory in `node_modules`, so the path missed the codegen directory and the include still failed.
Found on @react-native-community/netinfo 11.5.2, which built by hand with an absolute `-I` to the codegen directory.
Ships with `RN_XTOOL_SCAFFOLD_REVISION` 4, though it changes no manifest.

## 24. `scripts/spm/*`: Swift compilation conditions are not carried

`SWIFT_ACTIVE_COMPILATION_CONDITIONS` in a podspec's xcconfig is how a pod switches Swift code on and off (`#if X`),
and the scaffold never passed it to `swiftSettings`, so such code was always compiled out.

Fix: the reader collects the tokens of literal `'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '…'` entries from any xcconfig
hash of every layer (`swiftConditions`, on both the regex and the `pod ipc spec` path). `$(inherited)`, Xcode `$(…)`
tokens and Ruby interpolations are left out, the same rule as for the C defines (fix 7). A target with Swift sources
gets `.define("<X>")` in `swiftSettings` for each: after the bridging-header flag on a mixed target, in a new
`swiftSettings:` line on a pure-Swift one. A clang-only target gets nothing. Conditions in `user_target_xcconfig` are
carried too, though CocoaPods applies that hash to the app target and not to the pod: the C defines (fix 7) are read
from it the same way. Not covered: react-native-vision-camera 4.7.3 switches its location tagging with a Ruby ternary
(`"$(inherited) #{enableLocation ? "VISION_CAMERA_ENABLE_LOCATION" : ""}"`), which the regex reader cannot evaluate, so
location tagging stays compiled out there; CocoaPods enables it by default. On the reference app's libraries nothing
changes. Found on react-native-vision-camera 4.7.3. Ships with `RN_XTOOL_SCAFFOLD_REVISION` 4.

## 25. `scripts/spm/scaffold-package-swift.js`: `scaffoldAll` cannot scaffold only the deps the autolinker reported

`scaffoldAll` walks every autolinked dep, and `setup-apple-spm.js scaffold` runs it with `force: true` ("Always force a
re-render so re-running after editing a podspec picks up the new content"). Every scaffold run therefore rewrote every
library's `Package.swift`, those the autolinker had not reported included. That breaks the promise of the marker every
scaffold carries, that the file is safe to edit and persist with patch-package: a hand fix to one library was gone as
soon as another library was installed and scaffolded. `skipDeps` names deps to leave out, but nothing names the only
deps to scaffold.

Fix: `ScaffoldAllOptions` gains `onlyDeps`, the dual of `skipDeps`. When it is set, only those npm names are scaffolded
(direct or transitive); the others get no result entry and are not touched. `skipDeps` still wins over it. The caller
passes the names the autolinker reported without a `Package.swift`, and no `force`: the skip rule still regenerates a
named dep whose scaffold has an older revision or another cache slot. The podspec-name index of siblings still covers
every autolinked dep. Found when a scaffold run for react-native-vision-camera 4.7.3 rewrote react-native-device-info
15.0.2's hand-fixed `Package.swift`. Changes no manifest, so no revision bump.

## 26. `scripts/spm/read-podspec.js`: a dependency written as a call, `s.dependency('Pod', …)`, is not read

The regex reader matches `s.dependency "Pod"` (a space after `dependency`), so the call form CocoaPods accepts as
well, `s.dependency('Pod', '~> 1.0')` or `ss.dependency("Pod")`, is not seen: a mapped pod gets no `.package`, a
sibling no wiring, and an unmapped pod no warning; the scaffolded package then fails to build on the missing module.

Fix: `getDependencies` also reads `dependency(` with optional spaces around the parenthesis, on the main spec and on
each subspec. Found while checking rn-xtool's pin check against the scaffolder (the early checks read both forms).
Libraries that use only the space form get the same manifest, so no revision bump.

## 27. `scripts/spm/scaffold-package-swift.js`: a dependency on a pod of prebuilt binaries is never linked

Repro: a podspec depends on a pod that ships prebuilt static `.framework`s and no sources, as
@react-native-ml-kit/text-recognition 2.0.0 depends on `GoogleMLKit/TextRecognition` (and four language subspecs). The
pod has no SwiftPM package, so the scaffold warns that it is unmapped and wires nothing; the library's
`@import MLKitVision;` then fails with `module 'MLKitVision' not found`.

Fix: a pod table entry may be `{ "binary": { "product": "<name>" } }`, for a pod the caller builds from its binaries
into a local package beside `build/xcframeworks`. `classifyPodDependency` returns `binary` for it, and the scaffold
emits `.package(path: "<relative path to build/pod-binaries>")` once and `.product(name: "<name>", package:
"pod-binaries")` once per pod, however many subspec lines name it. The path is relative to the `libs/<SwiftName>`
symlink, like `build/xcframeworks`. The `rn-xtool-pods` marker records `<pod>=binary` without a version (the caller's
lock holds the versions), so a version change does not make a persisted scaffold stale. A binary entry without a
product name is the library's error, naming the key. Only libraries that depend on such a pod get new content, and
every earlier scaffold of them was refused, so no revision bump.

## 28. `scripts/spm/read-podspec.js`: source globs built from Ruby locals and conditions are read in part

react-native-screens 4.24.0 builds its globs from locals assigned under conditions:

```ruby
new_arch_enabled = ENV['RCT_NEW_ARCH_ENABLED'] == '1'
source_files_exts = new_arch_enabled ? '{h,m,mm,cpp,swift}' : '{h,m,mm,swift}'
source_files = ["ios/**/*.#{source_files_exts}"]
if !new_arch_enabled
  source_files.push("cpp/RNScreensTurboModule.cpp", "cpp/RNScreensTurboModule.h")
end
...
  s.source_files = source_files
  if !gamma_project_enabled
    s.exclude_files = "ios/gamma/**/*.#{source_files_exts}"
  else
    s.exclude_files = "ios/stubs/**/*.#{source_files_exts}"
  end
```

Fix 3's pass did not evaluate a ternary on a local, so `#{source_files_exts}` stayed in the glob, which matched
nothing. The scaffolded `RNScreens` target held only the `common` subspec's `common/cpp/**` and `cpp/**` files (49
entries) and none of `ios/`: it built and linked without a single Objective-C class, and the app crashed at start with
`NSInvalidArgumentException` in `+[RCTThirdPartyComponentsProvider thirdPartyFabricComponents]` (a nil class for each
of the 20 components codegen expects). Nothing warned: a glob that matches nothing is not an error. 4.26 and 4.30
write `source_files_exts` as a literal, which fix 3 read.

Fix: `evaluateRubyLocals` runs the comment-stripped podspec's statements in order over a side-effect-free subset of
Ruby and hands the field regexes a flat text with the same line count. It evaluates locals (`=`, `+=`, `||=`, the last
assignment that runs wins), single-quoted strings verbatim and double-quoted ones with `#{expr}` interpolation, arrays
and `%w[...]`, numbers, `true`/`false`/`nil`, `ENV['X']` and `ENV.fetch('X', default)` (fix 19's two variables are
`1`, every other one is unset; the environment is never read), `==`, `!=`, `!`/`not`, `&&`/`and`, `||`/`or`, `+` on
strings and arrays, ternaries, `array.join(sep)`, `.to_s` and `.freeze`, `if`/`elsif`/`else`/`unless`/`end` blocks
and `stmt if cond` / `stmt unless cond` modifiers (at the top level and inside the spec and subspec blocks), and
`push`/`append`/`concat`/`<<` on a local array. A branch that does not run is blanked, and the control lines of a
condition it evaluated are dropped, so a subspec under `if new_arch_enabled` is read as a plain subspec and an
`exclude_files` in a dead `else` no longer applies. A `recv.<field> = expr` on the spec or a subspec (`s.`, `s.ios.`,
`ss.`) whose value is not already a literal is rewritten to the literal it evaluates to; inside a hash
(`pod_target_xcconfig`, `resource_bundles`) `=> local` is replaced by the local's value. Anything else (method calls,
hashes, symbols, `$config[...]`, blocks other than the spec's) is not evaluated: the text stays as written, a local
assigned from it or under a condition on it is unknown from there on, and both branches of such a condition stay
visible, as before (react-native-vision-camera's `if enableFrameProcessors` subspec, fix 20).

The evaluator also models what fix 3 and fix 15 read: `JSON.parse(File.read(File.join(__dir__, "package.json")))`
(also with `File.dirname(__FILE__)`) is the library's own package.json as a hash, indexed with `pkg['key']`, and
`File.read` reads only inside the podspec's directory. Hashes (`{ 'K' => v }`, `{ k: v }`) and symbols are values, so a
local hash such as screens' `rnscreens_config` reaches `pod_target_xcconfig`. A double-quoted string with an
interpolation it cannot compute keeps that `#{...}` as written (fix 3's behaviour), so
`version_flags = "-DWORKLETS_VERSION=#{package['version']} -DREACT_NATIVE_MINOR_VERSION=#{$worklets_config[...]}"`
still gives worklets 0.8.3 `WORKLETS_VERSION=0.8.3`, and fix 8 the installed React Native's minor. A local set in a
branch of a condition it cannot evaluate keeps its value for the rest of that branch (react-native-webview sets
`folly_compiler_flags` and uses it in `compiler_flags` under `defined?(install_modules_dependencies())`); after `end`
it is unknown. `name`, `module_name` and `version` are read as literals only, as before: evaluating `s.name =
package['name']` would rename react-native-app-auth's and react-native-webview's targets.

A value that uses something unknown no longer degrades silently. In `source_files`, `exclude_files`,
`compiler_flags`, `header_dir`, `header_mappings_dir`, `frameworks` and `libraries` the model carries it in
`unresolvedSources`, and `scaffoldPackageSwiftForDep` returns `status: 'error'` with a reason naming the podspec,
the field and the expression, for example ``<podspec>: `s.source_files = sources_for("ios")` cannot be evaluated: it
uses the method call `sources_for(...)`.`` Name resolution and header search paths keep
reading the model as before. In the xcconfig values the scaffolder reads (`OTHER_CFLAGS`,
`GCC_PREPROCESSOR_DEFINITIONS`, `HEADER_SEARCH_PATHS`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS` of `pod_target_xcconfig`,
`user_target_xcconfig` and `xcconfig`) each `#{...}` it cannot evaluate is left out with a warning that names it,
``Left out of s.pod_target_xcconfig OTHER_CFLAGS: `#{feature_flags}`, which the podspec reader cannot evaluate;
CocoaPods passes its value.``, except `REACT_NATIVE_{MAJOR,MINOR,PATCH}_VERSION=#{...}` (fix 8) and a token with an
Xcode `$(...)`, which the scaffolder drops anyway. They are not refused: podspecs put optional,
configuration-driven flags there that only CocoaPods computes from the app and its Podfile, and the libraries checked
(react-native-worklets 0.8.3 and 0.10.1, react-native-reanimated 4.3.4 and 4.5.1, react-native-vision-camera 4.7.3,
react-native-gesture-handler 3.3.0) built and ran with those values left out.

Effect on the libraries checked: screens 4.24.0 scaffolds 195 sources (147 under `ios/`), gamma excluded, as one
clang-only target (every Swift file is under `ios/gamma`), with `ios/bridging/Swift-Bridging.h` left out of its module
map (fix 18, it imports the module's own `-Swift.h`). react-native-svg 15.16.0 no longer excludes
`apple/Utils/RNSVGFabricConversions.h` (excluded only in its old-architecture `else` branch), so the header is in its
sources and its module map is no longer written. The other libraries of the reference app, of the bare 0.86 and 0.87
apps and of the Expo SDK 57 and 58 apps read the same sources as before; their dependencies and `exclude_files` lose
what only a dead `else` branch declared (`React-Core`, `React-jsc`, datetimepicker's `ios/fabric`). Libraries that
set `compiler_flags` from `folly_compiler_flags` (react-native-webview, @react-native-async-storage/async-storage 1.x,
react-native-keychain, react-native-video, @aws-amplify/react-native) now get its `-Wno-comma -Wno-shorten-64-to-32`;
its `FOLLY_*` defines stay dropped, as for every library. The scaffold revision moves to 6, then to 7 for the
package.json defines revision 6 lost.

## 29. `scripts/spm/read-podspec.js`: podspecs are read without React Native's helpers, or in part

`readPodspec` had two readers, and neither read a podspec as CocoaPods does. With CocoaPods installed it wrote a copy
of the podspec with `install_modules_dependencies(…)` and `use_react_native!(…)` commented out and ran `pod ipc spec`
on it. With the helpers stripped, `defined?(install_modules_dependencies())` and
`respond_to?(:install_modules_dependencies, true)` were false, so react-native-webview,
`@react-native-async-storage/async-storage`, react-native-keychain and react-native-video took their old-architecture
branch. And `flattenSubspecs`, which reads that JSON, read no `ios` key: in CocoaPods' JSON form an `s.ios.` attribute
lives under `"ios"`, so react-native-svg's `s.ios.exclude_files` did not apply there, while the regex path merged it
(fix 6). Without CocoaPods (every Linux machine), fix 28's evaluator read the subset of Ruby it models. It left out
the rest with a warning, such as react-native-gesture-handler 3.3.0's `-DRNGH_USE_WORKLETS=1`, which its own
`GestureHandlerUtils` computes by running `node`, or refused the library. So the same podspec gave a different model
on a machine with CocoaPods, and an incomplete one on a machine without.

Fix: the podspec runs in real Ruby. `read-podspec-shim.rb`, next to `read-podspec.js`, is run by the system `ruby`
(2.7 or later, standard library only) once per podspec, in the podspec's folder, with an empty stdin, a 120 s timeout
and an environment of `PATH`, `HOME`, `LANG` and fix 19's two variables (`RCT_NEW_ARCH_ENABLED=1`,
`RCT_HERMES_V1_ENABLED=1`). It evaluates the podspec inside `module Pod`, as CocoaPods-core does, against a
`Pod::Specification` with the attributes of CocoaPods 1.16's DSL (a setter and a getter each, the singular aliases
stored under their plural keys), `attributes_hash` (the attributes as stored, which Nitro's generated
`add_nitrogen_files` reads and extends), `dependency`, `subspec`, `test_spec`, `app_spec` and the platform proxies
(`s.ios`, `s.osx`, `s.tvos`, `s.visionos`, `s.watchos`; `s.macos` stores under `osx`). It writes the spec in CocoaPods'
JSON form, what `pod ipc spec` printed, so `flattenSubspecs` reads it unchanged. `ruby <shim> --probe` checks the Ruby
version before anything loads and names the interpreter that answered (`RbConfig.ruby`, an absolute path). Each read
runs that path, not `ruby` from `PATH`, so a version manager's `ruby` shim (rbenv, asdf, mise) cannot pick another
Ruby from a `.ruby-version` in the podspec's folder.

The shim models what a static scan found called in the podspecs of the reference apps, of the Expo SDK 57 and 58
references and of the podspec fixtures, and in the scripts they load. React Native's helpers:
`install_modules_dependencies` is recorded and adds nothing (the scaffold supplies React core and
`RCT_NEW_ARCH_ENABLED` from the record, which replaces the source regex `usesInstallModulesDependencies` used);
`add_dependency` adds the dependency and drops `subspec:`, as React Native's does; `get_folly_config` returns a fresh
hash of React Native's folly version, git URL and compiler flags on each call; `min_ios_version_supported` returns
`15.1`; and `spm_dependency` is recorded with its arguments. `defined?` and `respond_to?` answer for them as under
React Native's Podfile, and `use_expo_modules!` is not defined. Expo's `PackagesConfig` answers a source build
(`coreFeatures` is empty, `try_link_with_prebuilt_xcframework` is false). `Pod::UI` lines are captured, not printed.
`Pod::Config.instance` gives the app's `ios` folder as `installation_root` and `project_root` (`RN_SPM_APP_IOS_DIR`
when set, else the podspec's path cut before its first `/node_modules/` plus `/ios`, else the podspec's folder), that
folder's `Pods` as `project_pods_root`, and no `@podfile`. `Pod::VERSION` is `1.16.2`. `require` loads a name on
Ruby's own load path, the library's files by path, and a stub of `colored2`, loaded before the podspec runs as CocoaPods
has colored2 loaded; `require_relative`, backticks, `system`, `raise` and `abort` are real Ruby, so a library's own
scripts run as under CocoaPods (worklets finds React Native, and gesture-handler finds worklets, with `node`). Every
`ENV` name the podspec reads is recorded; other environment variables and globals are unset. React Native's other
helpers stay undefined, and a call to one fails as `method`.

A podspec Ruby cannot read stops the read with a `PodspecReadError`; nothing falls back. A gap of the shim names where
it stopped (`<podspec>:<line>`, or `<podspec> (<file>:<line>)` in another of the library's files): `method` (the
podspec calls `<name>(…)`, which the reader does not model), `constant`, `attribute` (one CocoaPods does not define),
`require` (a gem other than `colored2`) or `not-a-spec`. Its message, like a podspec that does not finish in 120 s,
ends with `Set RN_XTOOL_PODSPEC_READER=reduced to read it with the reduced reader for one run, and report it with
rn-xtool doctor --report.` A podspec's own `raise`, `abort`, `exit` or syntax error (`raised`) keeps Ruby's message,
and a Ruby that ends without a model says `ruby exited with <code or signal>` with its last stderr line. A failure
of the reader's own (no temp folder for the shim's out file, a podspec it cannot read) stops the read the same way,
as `<podspec>: rn-xtool could not run the podspec reader: <error>` (kind `exit`), so the autolinking callers stop on it
too. An `exit` stop ends with the same sentence when the escape changes the reader (a Ruby read), and so does a
`raised` stop that is Ruby's `key not found: "<NAME>"` from `ENV.fetch` (a name the fixed environment does not
give). Without a
usable Ruby (none, older than 2.7, no `json`, the shim missing), or with `RN_XTOOL_PODSPEC_READER=reduced`, fix 28's
evaluator reads the podspec as before, and `podspecReader()` says why; another value of the variable is named in a
warning and ignored. `name`, `module_name` and `version` stay the literal readings under both readers.
`readPodspecCached` keys on the reader too. When `RN_SPM_PODSPEC_READS` names a file, each read appends one JSON line
to it: the podspec, the reader and why, whether it was forced, the Ruby, the reader choice's warning (an unknown
`RN_XTOOL_PODSPEC_READER` value), the `ENV` names and helpers the podspec used, and whether it read, with the error.

`pod ipc spec` is never run (`patchPodspecForPodIpc`, `runPodIpcSpec` and `cleanupPatchedPodspec` are gone), so a
machine with CocoaPods reads a podspec as any machine with Ruby. `flattenSubspecs` merges each selected layer's `ios`
over it, as CocoaPods' consumer does for an iOS target: arrays concatenated, the layer's first (a string read as a
one-element array); hashes key by key, two strings joined by one space and an array on either side concatenated;
anything else the platform's value. `osx`, `tvos`, `visionos` and `watchos` are never read, and a subspec's `ios`
dependencies count when fix 20 drops a subspec. A key a CocoaPods build applies and the scaffold does not, in any
selected layer or its `ios`, gets a warning: `The podspec sets <key>, which a CocoaPods build applies and rn-xtool's
scaffold does not.` for `script_phases`, `prepare_command`, `info_plist` and `module_map`. A podspec that calls
`spm_dependency` is refused with `status: 'error'` and `<podspec>: uses spm_dependency(url: <url>, products: <a, b>),
which rn-xtool does not map yet`: the target would not link without that package.

The reader's callers caught every throw, which a reader that can fail would hide: the name facts (`podspecFor` and
`defaultReadPodspec` in `expand-spm-dependencies.js`) returned null, and the autolinking's header search paths
(`extractPodspecHeaderSearchPaths` in `generate-spm-autolinking.js`) returned `[]`. The three catches now rethrow a
`PodspecReadError` and keep their old answer for any other error, so a podspec Ruby cannot read stops autolinking with
its message. The two in `expand-spm-dependencies.js` are in the 0.88 patches. The third is edit E6 of
`vendor/rn-spm/rn-xtool-edits.patch`, in the vendored copy only: React Native 0.88.1 has no
`extractPodspecHeaderSearchPaths`, so the identical 0.88 patches cannot carry it, and on 0.88.0 the scaffold's own
read of the same podspec still stops.

Each scaffolded manifest records its reader on the last line of the marker block, after the cache slot:
`// rn-xtool-podspec-reader: ruby` or `// rn-xtool-podspec-reader: reduced`, and the scaffold's result carries it as
`reader`. Effect on the libraries checked (the golden): react-native-gesture-handler 3.3.0 gets `RNGH_USE_WORKLETS=1`
when react-native-worklets 0.8 or later is installed, as under CocoaPods. react-native-webview 14.0.1 takes its
`install_modules_dependencies` branch, so the `-Wno-comma -Wno-shorten-64-to-32` that fix 28 read from its `else`
branch no longer apply. React Native 0.88's helper adds only `-DRCT_NEW_ARCH_ENABLED=1`, which the scaffold defines.
react-native-screens 4.30.0, react-native-pager-view 9.0.7, react-native-svg 15.16.0 and
`@react-native-community/datetimepicker` 9.2.1 scaffold as before. The scaffold revision moves to 8.

## Known limitation (deferred): pure-Swift packages importing a mixed Expo module

A Swift module built with a bridging header (every mixed target) makes each Swift importer re-read that
header, so the importer needs the same `-Xcc -I` paths (`RN_SPM_SWIFT_HEADERS_DIR`, the module's
`pod-headers/`, `-fmodule-map-file=` for its Swift dependencies). rn-xtool passes them to the app target and
to generated mixed targets only. A pure-Swift package (scaffolded or generated) that imports a mixed Expo
module does not get them and fails with "`<Module>-Swift.h` file not found". No library in the reference app
does this today. **Ruling: deferred** (documented limitation; fix when a real library needs it, by giving
every generated or scaffolded Swift target that depends on a mixed module the same importer flags).

## Tests

`tests/rn-scaffolder.test.ts` loads the patched modules from the reference app and checks the fixes against fixtures
(skipped when the reference app is not present; it reads `../app-golden` beside the repo, or the app
`RN_XTOOL_REF_APP` names). It also asserts that each hunk
is present in the installed RN files. Fixes 14 to 29 are tested on the vendored copy (`vendor/rn-spm/spm`), so they
run without the reference app, against podspec fixtures from the SDK 57 pins in `tests/fixtures/podspecs/` (worklets
0.10.1, reanimated 4.5.1, screens 4.26.2, gesture-handler 2.32.0), from screens 4.30.1 (the clang-only importer paths
and module map), from worklets 0.8.3 (the `RCT_HERMES_V1_ENABLED` ternary) and from screens 4.24.0 (fix 28's locals
and conditions). Fix 29's shim is tested in `tests/podspecShim.test.ts` (also on Ruby 2.7, in CI's `shim-ruby-floor`
job), the reader's choice, its runs of the shim, `readPodspec`, the `ios` merge and the rethrows in
`tests/podspecReader.test.ts`, and the reader sweep (`tests/podspecReaderSweep.test.ts`) reads the podspecs of pinned
library tarballs with both readers against reviewed goldens. A golden test re-scaffolds the reference app's libraries,
read by Ruby, and compares them with `tests/fixtures/scaffold-golden/` (`RN_XTOOL_WRITE_GOLDEN=1` writes them
instead). Upstream, equivalent tests belong in RN's own `__tests__` next to `read-podspec` and
`scaffold-package-swift`.
