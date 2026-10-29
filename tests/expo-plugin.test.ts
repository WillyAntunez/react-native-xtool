import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  type Classify,
  type Diagnostics,
  DEV_CLIENT_DEPS,
  EXPO58_GOLDEN,
  LAUNCHER_FILES,
  type LocalDep,
  MIXMOD_FILES,
  type Manifests,
  type Plugin,
  type Podspec,
  emit,
  expo58GoldenEmissions,
  layoutOf,
  loadSpm,
  mkTmp,
  moduleFixture,
  shared58Spm,
  vendoredSpm,
} from "./support/expoSpm.js";
import { PODSPEC_FIXTURES, VENDORED_RN_SPM, scaffoldLibraries } from "./support/rnScaffold.js";

// Exercises the PATCHED Expo SwiftPM plugin (patches/expo+58.0.21.patch) as installed in the
// reference app (override with RN_XTOOL_REF_APP). Skipped when that app is not on this machine.
const APP = process.env["RN_XTOOL_REF_APP"] ?? path.resolve(import.meta.dirname, "../../app");
const SPM = path.join(APP, "node_modules/expo/scripts/spm");
const MANIFESTS = path.join(SPM, "manifests.js");
const COMMITTED_PATCH = path.resolve(import.meta.dirname, "../patches/expo+58.0.21.patch");
// The functional test re-runs `setup-apple-spm.js update` and rewrites the app's ios/build, so it
// is opt-in: RN_XTOOL_E2E=1.
const e2e = process.env["RN_XTOOL_E2E"] === "1";
const available = existsSync(MANIFESTS) && existsSync(path.join(APP, "ios/build"));
const hasPatchBinary = spawnSync("patch", ["--version"]).error === undefined;

// Guards the committed patch against drift from the installed copy (the RN patch has the same guard).
describe.skipIf(!existsSync(MANIFESTS) || !hasPatchBinary)("committed Expo patch", () => {
  it("reverse-applies cleanly to the installed Expo files", async () => {
    const r = await execa("patch", ["-R", "-p1", "-F0", "--dry-run", "-i", COMMITTED_PATCH], { cwd: APP, reject: false });
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

describe.skipIf(!available)("patched Expo SwiftPM plugin", () => {
  it("the committed patch carries the umbrella-header hunk", () => {
    const patch = readFileSync(COMMITTED_PATCH, "utf8");
    const hunk = patch.split(/^diff --git /m).find((h) => h.includes("scripts/spm/manifests.js")) ?? "";
    expect(hunk).toContain("umbrella.h");
    expect(hunk).toContain("-import-objc-header");
  });

  it("the committed patch matches an actual bridging-header assignment and writes umbrella.h only on change", () => {
    const patch = readFileSync(COMMITTED_PATCH, "utf8");
    const m = /\+.*\/(SWIFT_OBJC_BRIDGING_HEADER\[.*?\)\/)\.test\(/.exec(patch);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]!.slice(0, -1).replace(/\/$/, ""));
    expect(re.test("s.pod_target_xcconfig = { 'SWIFT_OBJC_BRIDGING_HEADER' => 'a.h' }")).toBe(true);
    expect(re.test("SWIFT_OBJC_BRIDGING_HEADER = a.h")).toBe(true);
    expect(re.test("# SWIFT_OBJC_BRIDGING_HEADER is not set here")).toBe(false);
    expect(patch).toContain("if (current !== content) fs.writeFileSync(file, content);");
    expect(patch).toContain("writeIfChanged(umbrella, umbrellaSource);");
  });

  it("the installed copy carries the umbrella-header hunk", () => {
    const src = readFileSync(MANIFESTS, "utf8");
    expect(src).toContain("declaresBridgingHeader");
    expect(src).toContain("umbrella.h");
    expect(src).toContain("-import-objc-header");
  });

  it.skipIf(!e2e)("emits umbrella.h and the bridging-header flag for ExpoImagePicker", async () => {
    const shims = path.resolve(import.meta.dirname, "../shims");
    const env = {
      ...process.env,
      PATH: [path.join(homedir(), ".local/share/swiftly/bin"), shims, process.env["PATH"]].join(path.delimiter),
    };
    await execa(
      "node",
      [
        "../node_modules/react-native/scripts/setup-apple-spm.js",
        "update",
        "--yes",
        "--config-command",
        '["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]',
      ],
      { cwd: path.join(APP, "ios"), env },
    );
    const dir = path.join(APP, "ios/build/generated/autolinking/expo/expo-source/ExpoImagePicker");
    expect(readFileSync(path.join(dir, "umbrella.h"), "utf8")).toBe(
      "#import <Foundation/Foundation.h>\n#import <UIKit/UIKit.h>\n",
    );
    expect(readFileSync(path.join(dir, "Package.swift"), "utf8")).toContain(
      `"-import-objc-header", "${path.join(dir, "umbrella.h")}"`,
    );
  }, 120_000);
});

// --- Generated source packages for modules without a Package.swift (mixed, ObjC-only, ...) ---

const spmAvailable = existsSync(path.join(SPM, "classify.js"));

describe.skipIf(!spmAvailable)("patched Expo SwiftPM plugin: generated source packages", () => {
  const load = <T>(f: string) => loadSpm<T>(SPM, f);
  const classify = load<Classify>("classify.js");
  const podspec = load<Podspec>("podspec.js");
  const plugin = load<Plugin>("plugin.js");
  const manifests = load<Manifests>("manifests.js");

  describe("mixed Swift + Objective-C (expo-application's shape)", () => {
    const root = moduleFixture("MixMod", MIXMOD_FILES);
    const { sources, layout } = layoutOf(SPM, "MixMod", root);

    it("classifies as mixed with C++", () => {
      expect(layout).toBe("mixed");
      expect(sources).toMatchObject({ hasSwift: true, hasClang: true, hasCxx: true, pureSwift: false });
    });

    it("emits one experimental multi-language target with the bridging and Swift-header flags", () => {
      const { dir, manifest, read } = emit(SPM, "MixMod", root, "mixed", sources);
      expect(manifest.split("\n")[0]).toBe("// swift-tools-version: 6.4;(experimentalMultiLang)");
      expect(manifest).toContain('Context.environment["RN_SPM_SWIFT_HEADERS_DIR"]');
      expect(manifest).toContain('path: "root/ios"');
      expect(manifest).toContain('exclude: ["Tests"]');
      expect(manifest).toContain('publicHeadersPath: "."');
      expect(manifest).toContain('.define("RCT_NEW_ARCH_ENABLED", to: "1")');
      expect(manifest).toContain('.unsafeFlags(["-I", rnSpmSwiftHeadersDir])');
      expect(manifest).toContain(`.unsafeFlags(["-I", "${path.join(dir, "pod-headers")}"])`);
      expect(manifest).toContain('.unsafeFlags(["-std=c++20"])');
      expect(manifest).toContain(`"-import-objc-header", "${path.join(dir, "umbrella.h")}"`);
      expect(read("pod-headers/MixMod/MixMod-Swift.h")).toBe("#import <MixMod-Swift.h>\n");
    });

    it("also writes the Swift 6.5 manifest: identical, tools-version 6.5, no experimental flag", () => {
      const { manifest, read } = emit(SPM, "MixMod", root, "mixed", sources);
      const v65 = read("Package@swift-6.5.swift");
      expect(v65.split("\n")[0]).toBe("// swift-tools-version: 6.5");
      expect(v65).not.toContain("experimentalMultiLang");
      expect(v65.split("\n").slice(1)).toEqual(manifest.split("\n").slice(1));
    });

    it("removes a stale Swift 6.5 manifest when the package is no longer mixed", () => {
      const outDir = mkTmp("xtool-expo-out-");
      const ctx = { frameworkSearchPath: "/fw", outDir, macroFlags: [] };
      const dir = manifests.emitGeneratedSourcePackage({ moduleRoot: root, product: "MixMod", language: "mixed", sources }, ctx).ok
        .packageDep.path;
      expect(existsSync(path.join(dir, "Package@swift-6.5.swift"))).toBe(true);
      manifests.emitGeneratedSourcePackage({ moduleRoot: root, product: "MixMod", language: "clang", sources }, ctx);
      expect(existsSync(path.join(dir, "Package@swift-6.5.swift"))).toBe(false);
    });

    it("lists the module's Objective-C headers in the umbrella, minus the C++ ones", () => {
      const umbrella = emit(SPM, "MixMod", root, "mixed", sources).read("umbrella.h");
      expect(umbrella).toContain("#import <Foundation/Foundation.h>\n#import <UIKit/UIKit.h>\n");
      expect(umbrella).toContain(`#import "${path.join(root, "ios/MixMod/MXProfile.h")}"`);
      expect(umbrella).toContain(`#import "${path.join(root, "ios/MixMod/Guarded.h")}"`);
      expect(umbrella).not.toContain("Cxx.h");
    });

    it("omits -std=c++20 when there is no Objective-C++", () => {
      const plain = moduleFixture("Plain", {
        "ios/A.swift": "",
        "ios/Plain/P.h": "@interface P\n@end\n",
        "ios/Plain/P.m": "@implementation P\n@end\n",
      });
      const scan = classify.scanAppleSources(plain);
      expect(emit(SPM, "Plain", plain, "mixed", scan).manifest).not.toContain("-std=c++20");
    });
  });

  it("isCxxHeader ignores __cplusplus branches and comments", () => {
    expect(manifests.isCxxHeader("#ifdef __cplusplus\n#include <string>\n#endif\n@class A;\n")).toBe(false);
    expect(manifests.isCxxHeader("#if defined(__cplusplus)\nnamespace a {}\n#else\n@class A;\n#endif\n")).toBe(false);
    expect(manifests.isCxxHeader("// std::string in a comment\n@class A;\n")).toBe(false);
    expect(manifests.isCxxHeader("#import <react/renderer/core/Props.h>\n")).toBe(true);
    expect(manifests.isCxxHeader("template <typename T> struct B {};\n")).toBe(true);
  });

  it("emits a pure Objective-C module (expo-json-utils) as one Clang target", () => {
    const root = moduleFixture("EXJSONUtils", {
      "ios/EXJSONUtils/NSDictionary+EXJSONUtils.h": "#import <Foundation/Foundation.h>\n",
      "ios/EXJSONUtils/NSDictionary+EXJSONUtils.m": '#import <EXJSONUtils/NSDictionary+EXJSONUtils.h>\n',
      "ios/Tests/dummy.swift": "",
    });
    const { sources, layout } = layoutOf(SPM, "EXJSONUtils", root);
    expect(layout).toBe("clang");
    expect(sources.hasSwift).toBe(false);
    const { dir, manifest } = emit(SPM, "EXJSONUtils", root, "clang", sources);
    expect(manifest.split("\n")[0]).toBe("// swift-tools-version: 6.0");
    expect(manifest).toContain('// Objective-C source consumption package for "EXJSONUtils".');
    expect(manifest).toContain('publicHeadersPath: "."');
    expect(manifest).toContain('exclude: ["Tests"]');
    expect(manifest).toMatch(/cSettings: \[\.unsafeFlags\(\["-F", "\/fw"\]\), \.define\("RCT_NEW_ARCH_ENABLED", to: "1"\)\]/);
    expect(manifest).not.toContain("rnSpmSwiftHeadersDir");
    expect(manifest).not.toContain("-import-objc-header");
    expect(existsSync(path.join(dir, "umbrella.h"))).toBe(false);
    expect(existsSync(path.join(dir, "Package@swift-6.5.swift"))).toBe(false);
  });

  it("the committed patch carries the mixed and Objective-C emitter", () => {
    const patch = readFileSync(COMMITTED_PATCH, "utf8");
    expect(patch).toContain("+function emitGeneratedSourcePackage(");
    expect(patch).toContain("6.4;(experimentalMultiLang)");
    expect(patch).toContain("+function sourceLayout(");
  });

  it("keeps a pure-Swift module on the unchanged pure-Swift path", () => {
    const root = moduleFixture("Swifty", { "ios/A.swift": "" });
    const { layout, sources } = layoutOf(SPM, "Swifty", root);
    expect(layout).toBe("pure-swift");
    const { manifest } = emit(SPM, "Swifty", root, "pure-swift", sources);
    expect(manifest.split("\n")[0]).toBe("// swift-tools-version: 6.0");
    expect(manifest).toContain('// Pure-Swift source consumption package for "Swifty".');
    expect(manifest).not.toContain("publicHeadersPath");
    expect(manifest).not.toContain("RCT_NEW_ARCH_ENABLED");
  });

  it("takes a module whose only Objective-C file is an empty placeholder for pure Swift", () => {
    const root = moduleFixture("EXUpdatesInterface", {
      "ios/EXUpdatesInterface/UpdatesInterface.swift": "",
      "ios/EXUpdatesInterface/noop-file.m": "// noop file for cocoapods to generate modulemap file\n",
      "ios/EXUpdatesInterface/blank.c": "/* nothing */\n\n",
    });
    const { layout, sources } = layoutOf(SPM, "EXUpdatesInterface", root);
    expect(layout).toBe("pure-swift");
    expect(sources.placeholderFiles).toEqual(["EXUpdatesInterface/blank.c", "EXUpdatesInterface/noop-file.m"]);
    const { manifest } = emit(SPM, "EXUpdatesInterface", root, "pure-swift", sources);
    expect(manifest).toContain('exclude: ["EXUpdatesInterface/blank.c", "EXUpdatesInterface/noop-file.m"]');
    expect(manifest.split("\n")[0]).toBe("// swift-tools-version: 6.0");
  });

  it("still counts an Objective-C file with code as a source", () => {
    const root = moduleFixture("Real", { "ios/A.swift": "", "ios/Real/R.m": "// c\nint r(void) { return 1; }\n" });
    expect(layoutOf(SPM, "Real", root).layout).toBe("mixed");
  });

  it("treats a meta pod (no sources, no source_files) as nothing to build", () => {
    const root = moduleFixture("expo-dev-client", {}, "s.dependency 'expo-dev-launcher'");
    const { layout, facts } = layoutOf(SPM, "expo-dev-client", root);
    expect(facts.declaresSourceFiles).toBe(false);
    expect(layout).toBe("meta");
  });

  it("does not take a module whose podspec declares source_files but ships none for a meta pod", () => {
    const root = moduleFixture("Partial", {});
    expect(layoutOf(SPM, "Partial", root).layout).toBe("pure-swift");
  });

  it("the committed patch carries the placeholder and meta-pod rules", () => {
    const patch = readFileSync(COMMITTED_PATCH, "utf8");
    expect(patch).toContain("+function isPlaceholderSource(");
    expect(patch).toContain("linkedAs: 'meta'");
  });

  it("counts vendor/ C sources the podspec references and refuses the module (expo-sqlite)", () => {
    const sqlitePodspec = `def s.vendor_sqlite_src!\n    FileUtils.cp(File.join(__dir__, '..', 'vendor', 'sqlite3', 'sqlite3.c'), __dir__)\n  end\n  s.source_files = "**/*.{c,h,m,swift}"`;
    const root = moduleFixture(
      "ExpoSQLite",
      { "ios/SQLiteModule.swift": "", "vendor/sqlite3/sqlite3.c": "int x;\n", "vendor/sqlite3/sqlite3.h": "" },
      sqlitePodspec,
    );
    const { layout, sources, facts } = layoutOf(SPM, "ExpoSQLite", root);
    expect(facts.referencesVendor).toBe(true);
    expect(sources.vendorSources).toEqual(["vendor/sqlite3/sqlite3.c"]);
    expect(layout).toBe("vendored");
    const report = load<Diagnostics>("diagnostics.js").renderUnsupportedReport([
      { reason: "vendored-sources", podName: "ExpoSQLite", packageName: "expo-sqlite", moduleRoot: root, vendorSources: sources.vendorSources },
    ]);
    expect(report).toContain("builds C sources from its vendor/ directory (vendor/sqlite3/sqlite3.c)");
  });

  it("reports vendored-sources, not prebuild-available, for a module with spm.config.json and vendor/ (expo-sqlite)", () => {
    const sqlitePodspec = `s.source_files = "**/*.{c,h,m,swift}"\n  s.prepare_command = "cp ../vendor/sqlite3/sqlite3.c ."`;
    const root = moduleFixture(
      "ExpoSQLite",
      {
        "spm.config.json": JSON.stringify({ products: [{ name: "ExpoSQLite", podName: "ExpoSQLite" }] }),
        "ios/SQLiteModule.swift": "",
        "vendor/sqlite3/sqlite3.c": "int x;\n",
      },
      sqlitePodspec,
    );
    const { layout, sources, facts } = layoutOf(SPM, "ExpoSQLite", root);
    expect(layout).toBe("vendored");
    const { products } = JSON.parse(readFileSync(path.join(root, "spm.config.json"), "utf8")) as {
      products: { name: string }[];
    };
    // What podIdentity builds from the prebuilt-metadata record an spm.config.json produces.
    const identity = {
      podName: "ExpoSQLite",
      packageName: "expo-sqlite",
      moduleRoot: root,
      prebuildProduct: { name: products[0]!.name, sourceOnly: false },
      sources,
      podspec: facts,
    };
    const pending = plugin.uncoveredPod(identity, { reason: "vendored-sources", vendorSources: sources.vendorSources });
    expect(pending.refusals.map((r) => r.reason)).toContain("prebuild-available");
    const diagnostics = load<Diagnostics>("diagnostics.js");
    const [entry] = diagnostics.classifyUnsupported({ pending: [pending], coreAvailable: true });
    expect(entry!.reason).toBe("vendored-sources");
    expect(diagnostics.renderUnsupportedReport([entry!])).toContain("builds C sources from its vendor/ directory");
  });

  it("ignores vendor/ when the podspec does not reference it", () => {
    const root = moduleFixture("Swifty2", { "ios/A.swift": "", "vendor/x/x.c": "int x;\n" });
    expect(layoutOf(SPM, "Swifty2", root).layout).toBe("pure-swift");
  });

  it("the committed patch carries the vendored-sources refusal", () => {
    const patch = readFileSync(COMMITTED_PATCH, "utf8");
    expect(patch).toContain("['vendored-sources', { render: renderVendoredSources }]");
  });

  describe("resources only Xcode's tools compile (expo-dev-launcher's Assets.xcassets)", () => {
    const root = moduleFixture("EXDevLauncher", {
      "ios/Launcher.swift": "",
      "ios/EXDevLauncher.m": "int l(void) { return 1; }\n",
      "ios/Assets.xcassets/Contents.json": "{}",
      "ios/Assets.xcassets/icon.imageset/icon.png": "png",
      "ios/Views/Main.storyboard": "<xml/>",
      "ios/Tests/Fixtures.xcassets/Contents.json": "{}",
      "ios/Resources/keep.json": "{}",
    });

    it("lists them without descending into them or into ignored directories", () => {
      expect(classify.scanAppleSources(root).appleOnlyResources).toEqual(["Assets.xcassets", "Views/Main.storyboard"]);
    });

    it("excludes them from a generated mixed target", () => {
      const sources = classify.scanAppleSources(root);
      expect(emit(SPM, "EXDevLauncher", root, "mixed", sources).manifest).toContain(
        'exclude: ["Tests", "Assets.xcassets", "Views/Main.storyboard"]',
      );
    });

    it("excludes them from a pure-Swift target too", () => {
      const swifty = moduleFixture("SwiftAssets", { "ios/A.swift": "", "ios/Media.xcassets/Contents.json": "{}" });
      const sources = classify.scanAppleSources(swifty);
      expect(emit(SPM, "SwiftAssets", swifty, "pure-swift", sources).manifest).toContain('exclude: ["Media.xcassets"]');
    });

    it("warns about what is left out", () => {
      const warning = load<Diagnostics>("diagnostics.js").renderDroppedResourceWarning([
        { packageName: "expo-dev-launcher", podName: "EXDevLauncher", resources: ["Assets.xcassets"] },
      ]);
      expect(warning).toContain('warning: Expo module "expo-dev-launcher" (pod EXDevLauncher) ships resources that only Xcode');
      expect(warning).toContain("      Assets.xcassets");
      expect(warning).toContain("missing at runtime");
    });

    it("the committed patch carries the exclusion and the warning", () => {
      const patch = readFileSync(COMMITTED_PATCH, "utf8");
      expect(patch).toContain("+function scanAppleOnlyResources(");
      expect(patch).toContain("+function renderDroppedResourceWarning(");
      expect(patch).toContain("...(sources.appleOnlyResources ?? [])");
    });
  });

  describe("dev-client chain: CocoaPods module names, header_dir and sibling packages", () => {
    it("names the module after module_name, else header_dir, as a C99 identifier", () => {
      const byHeaderDir = moduleFixture("expo-dev-menu", { "ios/A.swift": "" }, `s.header_dir = 'EXDevMenu'\n  s.source_files = 'ios/**/*.{h,m,swift}'`);
      const facts = podspec.readPodspecFacts({ podName: "expo-dev-menu", podspecDir: path.join(byHeaderDir, "ios"), moduleRoot: byHeaderDir });
      expect(facts).toMatchObject({ headerDir: "EXDevMenu", moduleName: "EXDevMenu" });
      const byModuleName = moduleFixture("my-pod", { "ios/A.swift": "" }, `s.header_dir = 'H'\n  s.module_name = 'my-mod'`);
      expect(podspec.readPodspecFacts({ podName: "my-pod", podspecDir: path.join(byModuleName, "ios"), moduleRoot: byModuleName }).moduleName).toBe("my_mod");
      const interpolated = moduleFixture("Interp", { "ios/A.swift": "" }, `s.header_dir = "#{s.name}"`);
      expect(podspec.readPodspecFacts({ podName: "Interp", podspecDir: path.join(interpolated, "ios"), moduleRoot: interpolated }).moduleName).toBeNull();
    });

    it("reads subspec dependencies (expo-dev-menu's main.dependency)", () => {
      const root = moduleFixture("EXDevMenu", { "ios/A.swift": "" }, `s.subspec 'Main' do |main|\n    main.dependency "EXManifests"\n  end\n  s.dependency 'expo-dev-menu-interface'`);
      const facts = podspec.readPodspecFacts({ podName: "EXDevMenu", podspecDir: path.join(root, "ios"), moduleRoot: root });
      expect(facts.dependencies).toEqual(expect.arrayContaining(["EXManifests", "expo-dev-menu-interface"]));
    });

    const launcher = moduleFixture("expo-dev-launcher", LAUNCHER_FILES);
    const deps = DEV_CLIENT_DEPS;

    it("depends on sibling generated packages and searches their pod-headers and Swift module maps", () => {
      const sources = classify.scanAppleSources(launcher);
      const { manifest } = emit(SPM, "EXDevLauncher", launcher, "mixed", sources, { headerDir: "EXDevLauncher", localDeps: deps });
      expect(manifest).toContain('.package(name: "EXManifests", path: "/out/expo-source/EXManifests")');
      expect(manifest).toContain('.product(name: "EXManifests", package: "EXManifests")');
      expect(manifest).toContain('.unsafeFlags(["-I", "/out/expo-source/EXManifests/pod-headers"])');
      expect(manifest).toContain('.unsafeFlags(["-fmodule-map-file=" + rnSpmSwiftHeadersDir + "/EXManifests.modulemap"])');
      expect(manifest).not.toContain("EXJSONUtils.modulemap");
      expect(manifest).toContain('.unsafeFlags(["-Xcc", "-I" + rnSpmSwiftHeadersDir])');
      expect(manifest).toContain('.unsafeFlags(["-Xcc", "-fmodule-map-file=" + rnSpmSwiftHeadersDir + "/EXManifests.modulemap"])');
    });

    it("writes CocoaPods-style forwarders: Swift header, umbrella and flattened header_dir", () => {
      const sources = classify.scanAppleSources(launcher);
      const { dir, read } = emit(SPM, "EXDevLauncher", launcher, "mixed", sources, { headerDir: "EXDevLauncher" });
      expect(read("pod-headers/EXDevLauncher/EXDevLauncher-Swift.h")).toBe("#import <EXDevLauncher-Swift.h>\n");
      expect(read("pod-headers/EXDevLauncher/EXDevLauncher-umbrella.h")).toBe(`#import "${path.join(dir, "umbrella.h")}"\n`);
      expect(read("pod-headers/EXDevLauncher/EXDevLauncherManifestParser.h")).toBe(
        `#import "${path.join(launcher, "ios/Manifest/EXDevLauncherManifestParser.h")}"\n`,
      );
    });

    it("gives a pure-Swift package a Swift-header forwarder and its sibling dependencies", () => {
      const root = moduleFixture("EXUpdatesInterface", { "ios/A.swift": "" });
      const { manifest, read } = emit(SPM, "EXUpdatesInterface", root, "pure-swift", classify.scanAppleSources(root), { localDeps: [deps[0]!] });
      expect(read("pod-headers/EXUpdatesInterface/EXUpdatesInterface-Swift.h")).toBe("#import <EXUpdatesInterface-Swift.h>\n");
      expect(manifest).toContain('.product(name: "EXManifests", package: "EXManifests")');
    });

    it("the committed patch carries module naming, sibling packages and pod-headers", () => {
      const patch = readFileSync(COMMITTED_PATCH, "utf8");
      expect(patch).toContain("+function generatedPackageIndex(");
      expect(patch).toContain("+function writePodHeaders(");
      expect(patch).toContain("+function c99Identifier(");
    });
  });
});

// --- X3, X6b, X6c: shared-patch fixes found by the SDK 57 spike, on the 58 copy and the vendored one ---

type LibraryIndex = Map<string, LocalDep>;
type Identity = { podName: string; packageName?: string; podspec: { dependencies?: string[] } };
type PluginDeps = {
  libraryPackageIndex(autolinking: object, outputDir: string): LibraryIndex;
  localDependencies(identity: Identity, packages: LibraryIndex): LocalDep[];
  dependencyPackageIndex(generated: LibraryIndex, libraries: LibraryIndex): LibraryIndex;
  unmappedDependencies(
    records: { identity: Identity; emission?: { spmProductNames: string[] } }[],
    satisfied: Set<string>,
    libraries: LibraryIndex,
  ): { podName: string; pods: string[] }[];
};

const shared58 = shared58Spm();
const IMPORTER_MARKER = "// rn-xtool-swift-importer-paths: ";

/** A scaffolded react-native-screens: its root, with `Package.swift` (marker or not) and its podspec. */
function screensRoot(importerPaths: string[] | string | null): string {
  const root = mkTmp("xtool-rnscreens-");
  const json = typeof importerPaths === "string" ? importerPaths : JSON.stringify(importerPaths);
  const marker = importerPaths ? `${IMPORTER_MARKER}${json}\n` : "";
  writeFileSync(
    path.join(root, "Package.swift"),
    `// swift-tools-version: 6.0\n// rn-xtool-scaffold-revision: 2\n${marker}import PackageDescription\nlet package = Package(name: "RNScreens")\n`,
  );
  writeFileSync(path.join(root, "RNScreens.podspec"), "Pod::Spec.new do |s|\n  s.name = 'RNScreens'\nend\n");
  return root;
}

/** React Native's autolinking output for that library: `libs/RNScreens` → root, as RN aliases it. */
function autolinkedScreens(root: string) {
  const outputDir = mkTmp("xtool-autolinking-");
  mkdirSync(path.join(outputDir, "libs"));
  symlinkSync(root, path.join(outputDir, "libs", "RNScreens"), "dir");
  const autolinking = {
    dependencies: {
      "react-native-screens": { root, platforms: { ios: { podspecPath: path.join(root, "RNScreens.podspec") } } },
    },
  };
  return { outputDir, autolinking };
}

const ROUTER_PODSPEC = `s.source_files = "**/*.{h,m,swift}"\n  s.dependency 'ExpoModulesCore'\n\n  add_dependency(s, "RNScreens")`;

describe.skipIf(shared58 === undefined).each([
  ["shared 58", shared58!],
  ["vendored", vendoredSpm()],
])("Expo SwiftPM plugin fixes (%s copy)", (_label, spm) => {
  const plugin = () => loadSpm<PluginDeps>(spm, "plugin.js");

  it("X3 keeps own -Swift.h importers out of the umbrella", () => {
    const root = moduleFixture("Expo", {
      "ios/Expo.swift": "",
      "ios/Swift.h":
        "#import <React/RCTHTTPRequestHandler.h>\n#if __has_include(<Expo/Expo-Swift.h>)\n#import <Expo/Expo-Swift.h>\n#else\n#import \"Expo-Swift.h\"\n#endif\n",
      "ios/Quoted.h": '#  import "Expo-Swift.h"\n',
      "ios/Expo.h": "#import <Foundation/Foundation.h>\n@interface EXThing : NSObject\n@end\n",
      "ios/Other.h": "#import <Other/Other-Swift.h>\n",
      "ios/Expo.m": "int e(void) { return 1; }\n",
    });
    const { sources, layout } = layoutOf(spm, "Expo", root);
    expect(layout).toBe("mixed");
    const umbrella = emit(spm, "Expo", root, "mixed", sources).read("umbrella.h");
    expect(umbrella).not.toContain("Swift.h\"");
    expect(umbrella).not.toContain("Quoted.h");
    expect(umbrella).toContain(`#import "${path.join(root, "ios/Expo.h")}"`);
    expect(umbrella).toContain(`#import "${path.join(root, "ios/Other.h")}"`);
  });

  it("X6b reads Expo's add_dependency helper", () => {
    const router = moduleFixture("ExpoRouter", { "ios/Router.swift": "import RNScreens\n" }, ROUTER_PODSPEC);
    const { facts, sources, layout } = layoutOf(spm, "ExpoRouter", router);
    expect(facts.dependencies).toEqual(expect.arrayContaining(["ExpoModulesCore", "RNScreens"]));
    const single = moduleFixture("Single", { "ios/A.swift": "" }, `add_dependency(spec, 'RNScreens', :framework_name => 'X')`);
    const singleFacts = loadSpm<Podspec>(spm, "podspec.js").readPodspecFacts({
      podName: "Single",
      podspecDir: path.join(single, "ios"),
      moduleRoot: single,
    });
    expect(singleFacts.dependencies).toEqual(["RNScreens"]);

    const screens = screensRoot(null);
    const { outputDir, autolinking } = autolinkedScreens(screens);
    const libs = plugin().libraryPackageIndex(autolinking, outputDir);
    const localDeps = plugin().localDependencies({ podName: "ExpoRouter", podspec: facts }, libs);
    expect(localDeps.map((d) => d.name)).toEqual(["RNScreens"]);
    expect(layout).toBe("pure-swift");
    const { manifest } = emit(spm, "ExpoRouter", router, "pure-swift", sources, { localDeps });
    // The path React Native declares the library at, so SwiftPM sees one package.
    expect(manifest).toContain(`.package(name: "RNScreens", path: "${path.join(outputDir, "libs", "RNScreens")}")`);
    expect(manifest).toContain('.product(name: "RNScreens", package: "RNScreens")');
    expect(manifest).not.toContain("RNScreens/pod-headers");
    expect(manifest).not.toContain("RNScreens.modulemap");
  });

  it("X6c passes a scaffolded mixed dependency's importer paths to Swift", () => {
    const router = moduleFixture("ExpoRouter", { "ios/Router.swift": "import RNScreens\n" }, ROUTER_PODSPEC);
    const { facts, sources } = layoutOf(spm, "ExpoRouter", router);
    const manifestWith = (importerPaths: string[] | null, language: string) => {
      const screens = screensRoot(importerPaths);
      const { outputDir, autolinking } = autolinkedScreens(screens);
      const localDeps = plugin().localDependencies(
        { podName: "ExpoRouter", podspec: facts },
        plugin().libraryPackageIndex(autolinking, outputDir),
      );
      return { real: realpathSync(screens), manifest: emit(spm, "ExpoRouter", router, language, sources, { localDeps }).manifest };
    };
    const swiftSettings = (manifest: string) => /swiftSettings: \[(.*)\],\n/.exec(manifest)?.[1] ?? "";

    const { real, manifest } = manifestWith([".", "ios/bridging"], "pure-swift");
    expect(swiftSettings(manifest)).toContain(`.unsafeFlags(["-Xcc", "-I${real}/.", "-Xcc", "-I${real}/ios/bridging"])`);

    const mixed = manifestWith([".", "ios/bridging"], "mixed");
    expect(swiftSettings(mixed.manifest)).toContain(`"-Xcc", "-I${mixed.real}/.", "-Xcc", "-I${mixed.real}/ios/bridging"`);
    expect(mixed.manifest).not.toMatch(/[cC]x*Settings: \[[^\n]*ios\/bridging/);

    const unmarked = manifestWith(null, "pure-swift");
    expect(unmarked.manifest).not.toContain(unmarked.real);
    expect(unmarked.manifest).not.toContain('"-Xcc"');
  });

  it("X6c passes a scaffolded clang-only dependency's importer paths to Swift (screens 4.30.1)", () => {
    // React Native's scaffolder (vendor/rn-spm) on screens 4.30.1, which has no Swift: ios/RNSConvert.h, in the
    // module's umbrella, imports "RNSDefines.h" from ios/utils.
    const { roots } = scaffoldLibraries(VENDORED_RN_SPM, { "react-native-screens": path.join(PODSPEC_FIXTURES, "RNScreens-4.30.1") });
    const screens = roots["react-native-screens"]!;
    const router = moduleFixture("ExpoRouter", { "ios/Router.swift": "import RNScreens\n" }, ROUTER_PODSPEC);
    const { facts, sources } = layoutOf(spm, "ExpoRouter", router);
    const { outputDir, autolinking } = autolinkedScreens(screens);
    const localDeps = plugin().localDependencies({ podName: "ExpoRouter", podspec: facts }, plugin().libraryPackageIndex(autolinking, outputDir));
    const { manifest } = emit(spm, "ExpoRouter", router, "pure-swift", sources, { localDeps });
    const swiftSettings = /swiftSettings: \[(.*)\],\n/.exec(manifest)?.[1] ?? "";
    const real = realpathSync(screens);
    expect(swiftSettings).toContain(`"-Xcc", "-I${real}/ios/utils"`);
    expect(swiftSettings).toContain(`"-Xcc", "-I${real}/ios"`);
  });

  it("X6c refuses a marker that is not a JSON array of paths inside the package", () => {
    const router = moduleFixture("ExpoRouter", { "ios/Router.swift": "import RNScreens\n" }, ROUTER_PODSPEC);
    const { facts, sources } = layoutOf(spm, "ExpoRouter", router);
    for (const bad of ["not json", '{"a":1}', '["../outside"]', '["ios/../../x"]', '["/abs/path"]', "[1]"]) {
      const screens = screensRoot(bad);
      const { outputDir, autolinking } = autolinkedScreens(screens);
      // Indexing reads no marker; only a package that depends on the library does.
      const libs = plugin().libraryPackageIndex(autolinking, outputDir);
      const localDeps = plugin().localDependencies({ podName: "ExpoRouter", podspec: facts }, libs);
      expect(() => emit(spm, "ExpoRouter", router, "pure-swift", sources, { localDeps }), bad).toThrow(
        `${path.join(realpathSync(screens), "Package.swift")} records its Swift importer paths as ${bad}`,
      );
    }
  });

  it("X6b ignores a pod dependency that is not autolinked", () => {
    const root = moduleFixture("Lonely", { "ios/A.swift": "" }, `add_dependency(s, "NotInstalled")\n  s.dependency 'AlsoMissing'`);
    const { facts, sources } = layoutOf(spm, "Lonely", root);
    expect(facts.dependencies).toEqual(expect.arrayContaining(["NotInstalled", "AlsoMissing"]));
    const { outputDir, autolinking } = autolinkedScreens(screensRoot(null));
    const localDeps = plugin().localDependencies({ podName: "Lonely", podspec: facts }, plugin().libraryPackageIndex(autolinking, outputDir));
    expect(localDeps).toEqual([]);
    expect(emit(spm, "Lonely", root, "pure-swift", sources, { localDeps }).manifest).not.toContain("NotInstalled");
  });

  it("X6b: a generated package wins over a library of the same pod name", () => {
    const { outputDir, autolinking } = autolinkedScreens(screensRoot(null));
    const libs = plugin().libraryPackageIndex(autolinking, outputDir);
    const generated: LibraryIndex = new Map([
      ["RNScreens", { podName: "RNScreens", name: "RNScreens", pkgDir: "/out/expo-source/RNScreens", hasSwift: true }],
    ]);
    const packages = plugin().dependencyPackageIndex(generated, libs);
    const [dep] = plugin().localDependencies({ podName: "ExpoRouter", podspec: { dependencies: ["RNScreens"] } }, packages);
    expect(dep).toMatchObject({ pkgDir: "/out/expo-source/RNScreens", hasSwift: true });
    expect(dep!.library).toBeUndefined();
  });

  it("X6b: a precompiled module's library dependency is not reported unmapped", () => {
    const router = moduleFixture("ExpoRouter", { "ios/Router.swift": "" }, ROUTER_PODSPEC);
    const { facts } = layoutOf(spm, "ExpoRouter", router);
    // A precompiled record: no emission, so no spmProductNames of its own.
    const records = [{ identity: { podName: "ExpoRouter", packageName: "expo-router", podspec: facts } }];
    const { outputDir, autolinking } = autolinkedScreens(screensRoot(null));
    const libs = plugin().libraryPackageIndex(autolinking, outputDir);
    expect(plugin().unmappedDependencies(records, new Set(), libs)).toEqual([]);
    expect(plugin().unmappedDependencies(records, new Set(), new Map())).toEqual([
      { packageName: "expo-router", podName: "ExpoRouter", pods: ["RNScreens"] },
    ]);
  });

  // expo-dev-menu 57 ships XCTest helpers in ios/UITests (its podspec excludes 'ios/*Tests/**/*');
  // compiled into the app, they make it load libXCTestSwiftSupport.dylib, which aborts at launch.
  it("skips every *Tests folder, as CocoaPods' ios/*Tests/**/* does", () => {
    const tested = moduleFixture("EXDevMenu", {
      "ios/DevMenu.swift": "",
      "ios/UITests/DevMenuLooper.swift": "import XCTest\n",
      "ios/UITests/MockedBridges.m": "int mocked(void) { return 1; }\n",
      "ios/WorkletsTests/Worklets.mm": "int worklets() { return 1; }\n",
      "ios/Views/SnapshotTests/Snapshot.swift": "import XCTest\n",
      "ios/Tests/T.swift": "import XCTest\n",
      "ios/Test/T.swift": "import XCTest\n",
    });
    const { sources, layout } = layoutOf(spm, "EXDevMenu", tested);
    expect(sources.ignoredDirs).toEqual(["Test", "Tests", "UITests", "Views/SnapshotTests", "WorkletsTests"]);
    expect(sources).toMatchObject({ hasClang: false, hasCxx: false });
    expect(layout).toBe("pure-swift");
    const exclude = 'exclude: ["Test", "Tests", "UITests", "Views/SnapshotTests", "WorkletsTests"]';
    expect(emit(spm, "EXDevMenu", tested, "pure-swift", sources).manifest).toContain(exclude);
    expect(emit(spm, "EXDevMenu", tested, "mixed", sources).manifest).toContain(exclude);

    // Anchored, case-sensitive and plural: these are sources.
    const plain = moduleFixture("Contest", {
      "ios/Contest.swift": "",
      "ios/Latest/Latest.m": "int latest(void) { return 1; }\n",
      "ios/Contests/Contests.mm": "int contests() { return 1; }\n",
      "ios/TestsSupport/Support.swift": "",
      "ios/UITest/Helper.swift": "",
    });
    const scanned = layoutOf(spm, "Contest", plain);
    expect(scanned.sources.ignoredDirs).toEqual([]);
    expect(scanned.sources).toMatchObject({ hasClang: true, hasCxx: true });
    expect(scanned.layout).toBe("mixed");
    expect(emit(spm, "Contest", plain, "mixed", scanned.sources).manifest).not.toContain("exclude:");
  });
});

describe.skipIf(shared58 === undefined)("Expo 58 golden", () => {
  it("Expo 58's generated packages are unchanged", () => {
    const emitted = expo58GoldenEmissions(shared58!);
    const golden = Object.fromEntries(
      readdirSync(EXPO58_GOLDEN).flatMap((c) =>
        readdirSync(path.join(EXPO58_GOLDEN, c)).map((f) => [`${c}/${f}`, readFileSync(path.join(EXPO58_GOLDEN, c, f), "utf8")]),
      ),
    );
    expect(Object.keys(emitted).sort()).toEqual(Object.keys(golden).sort());
    for (const [rel, text] of Object.entries(golden)) expect(emitted[rel], rel).toBe(text);
  });
});
