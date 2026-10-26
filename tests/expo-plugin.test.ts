import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";

// Exercises the PATCHED Expo SwiftPM plugin (patches/expo+58.0.19.patch) as installed in the
// reference app (override with RN_XTOOL_REF_APP). Skipped when that app is not on this machine.
const APP = process.env["RN_XTOOL_REF_APP"] ?? path.resolve(import.meta.dirname, "../../app");
const SPM = path.join(APP, "node_modules/expo/scripts/spm");
const MANIFESTS = path.join(SPM, "manifests.js");
const COMMITTED_PATCH = path.resolve(import.meta.dirname, "../patches/expo+58.0.19.patch");
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

type Sources = {
  hasSources: boolean;
  pureSwift: boolean;
  hasSwift: boolean;
  hasClang: boolean;
  hasCxx: boolean;
  ignoredDirs: string[];
  placeholderFiles: string[];
  vendorSources: string[];
  appleOnlyResources?: string[];
};
type PodspecFacts = {
  linkage: object | null;
  declaresSourceFiles: boolean;
  referencesVendor: boolean;
  headerDir?: string | null;
  moduleName?: string | null;
  dependencies?: string[];
};
type Classify = { scanAppleSources(root: string): Sources };
type Podspec = {
  readPodspecFacts(o: { podName: string; podspecDir: string; moduleRoot: string }): PodspecFacts;
};
type Refusal = { reason: string; [k: string]: unknown };
type Plugin = {
  sourceLayout(i: { sources: Sources; podspec: PodspecFacts }): string | null;
  uncoveredPod(identity: object, ...refusals: Refusal[]): { refusals: Refusal[] };
};
type EmitContext = { frameworkSearchPath: string; outDir: string; macroFlags: string[] };
type LocalDep = { podName: string; name: string; pkgDir: string; hasSwift: boolean };
type Emit = (
  o: {
    moduleRoot: string;
    product: string;
    language?: string;
    sources: Sources;
    headerDir?: string | null;
    localDeps?: LocalDep[];
  },
  ctx: EmitContext,
) => { ok: { packageDep: { path: string } } };
type Manifests = {
  emitPureSwiftSourcePackage: Emit;
  emitGeneratedSourcePackage: Emit;
  isCxxHeader(text: string): boolean;
};
type Diagnostics = {
  classifyUnsupported(o: { pending: object[]; coreAvailable: boolean }): Refusal[];
  renderUnsupportedReport(entries: object[]): string;
  renderDroppedResourceWarning(entries: object[]): string;
};

const spmAvailable = existsSync(path.join(SPM, "classify.js"));
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A module dir with the given files (relative path → contents); `ios/<pod>.podspec` included. */
function moduleFixture(pod: string, files: Record<string, string>, podspecBody = `s.source_files = "**/*.{h,m,mm,swift}"`): string {
  const root = mkdtempSync(path.join(tmpdir(), "xtool-expo-spm-"));
  tmp.push(root);
  writeFileSync(path.join(root, "package.json"), `{"name":"${pod.toLowerCase()}"}`);
  const all = { [`ios/${pod}.podspec`]: `Pod::Spec.new do |s|\n  s.name = '${pod}'\n  ${podspecBody}\nend\n`, ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe.skipIf(!spmAvailable)("patched Expo SwiftPM plugin: generated source packages", () => {
  const req = createRequire(import.meta.url);
  const load = <T>(f: string) => req(path.join(SPM, f)) as T;
  const classify = load<Classify>("classify.js");
  const podspec = load<Podspec>("podspec.js");
  const plugin = load<Plugin>("plugin.js");
  const manifests = load<Manifests>("manifests.js");

  function layoutOf(pod: string, root: string) {
    const sources = classify.scanAppleSources(root);
    const facts = podspec.readPodspecFacts({ podName: pod, podspecDir: path.join(root, "ios"), moduleRoot: root });
    return { sources, facts, layout: plugin.sourceLayout({ sources, podspec: facts }) };
  }

  function emit(
    pod: string,
    root: string,
    language: string,
    sources: Sources,
    extra: { headerDir?: string | null; localDeps?: LocalDep[] } = {},
  ) {
    const outDir = mkdtempSync(path.join(tmpdir(), "xtool-expo-out-"));
    tmp.push(outDir);
    const ctx = { frameworkSearchPath: "/fw", outDir, macroFlags: [] };
    const fn = language === "pure-swift" ? manifests.emitPureSwiftSourcePackage : manifests.emitGeneratedSourcePackage;
    const dir = fn({ moduleRoot: root, product: pod, language, sources, ...extra }, ctx).ok.packageDep.path;
    const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
    return { dir, read, manifest: read("Package.swift") };
  }

  describe("mixed Swift + Objective-C (expo-application's shape)", () => {
    const root = moduleFixture("MixMod", {
      "ios/MixModule.swift": "import Foundation\nlet x = MXProfile.self\n",
      "ios/MixMod/MXProfile.h": "#import <Foundation/Foundation.h>\n@interface MXProfile : NSObject\n@end\n",
      "ios/MixMod/MXProfile.m": '#import "MXProfile.h"\n#import <MixMod/MixMod-Swift.h>\n@implementation MXProfile\n@end\n',
      "ios/MixMod/Cxx.h": "#pragma once\n#include <string>\nnamespace mx { int f(); }\n",
      "ios/MixMod/Cxx.mm": '#import "Cxx.h"\nint mx::f() { return 1; }\n',
      "ios/MixMod/Guarded.h": "#import <Foundation/Foundation.h>\n#ifdef __cplusplus\nnamespace g {}\n#endif\n@interface MXGuarded : NSObject\n@end\n",
      "ios/Tests/MixTests.swift": "",
    });
    const { sources, layout } = layoutOf("MixMod", root);

    it("classifies as mixed with C++", () => {
      expect(layout).toBe("mixed");
      expect(sources).toMatchObject({ hasSwift: true, hasClang: true, hasCxx: true, pureSwift: false });
    });

    it("emits one experimental multi-language target with the bridging and Swift-header flags", () => {
      const { dir, manifest, read } = emit("MixMod", root, "mixed", sources);
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
      const { manifest, read } = emit("MixMod", root, "mixed", sources);
      const v65 = read("Package@swift-6.5.swift");
      expect(v65.split("\n")[0]).toBe("// swift-tools-version: 6.5");
      expect(v65).not.toContain("experimentalMultiLang");
      expect(v65.split("\n").slice(1)).toEqual(manifest.split("\n").slice(1));
    });

    it("removes a stale Swift 6.5 manifest when the package is no longer mixed", () => {
      const outDir = mkdtempSync(path.join(tmpdir(), "xtool-expo-out-"));
      tmp.push(outDir);
      const ctx = { frameworkSearchPath: "/fw", outDir, macroFlags: [] };
      const dir = manifests.emitGeneratedSourcePackage({ moduleRoot: root, product: "MixMod", language: "mixed", sources }, ctx).ok
        .packageDep.path;
      expect(existsSync(path.join(dir, "Package@swift-6.5.swift"))).toBe(true);
      manifests.emitGeneratedSourcePackage({ moduleRoot: root, product: "MixMod", language: "clang", sources }, ctx);
      expect(existsSync(path.join(dir, "Package@swift-6.5.swift"))).toBe(false);
    });

    it("lists the module's Objective-C headers in the umbrella, minus the C++ ones", () => {
      const umbrella = emit("MixMod", root, "mixed", sources).read("umbrella.h");
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
      expect(emit("Plain", plain, "mixed", scan).manifest).not.toContain("-std=c++20");
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
    const { sources, layout } = layoutOf("EXJSONUtils", root);
    expect(layout).toBe("clang");
    expect(sources.hasSwift).toBe(false);
    const { dir, manifest } = emit("EXJSONUtils", root, "clang", sources);
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
    const { layout, sources } = layoutOf("Swifty", root);
    expect(layout).toBe("pure-swift");
    const { manifest } = emit("Swifty", root, "pure-swift", sources);
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
    const { layout, sources } = layoutOf("EXUpdatesInterface", root);
    expect(layout).toBe("pure-swift");
    expect(sources.placeholderFiles).toEqual(["EXUpdatesInterface/blank.c", "EXUpdatesInterface/noop-file.m"]);
    const { manifest } = emit("EXUpdatesInterface", root, "pure-swift", sources);
    expect(manifest).toContain('exclude: ["EXUpdatesInterface/blank.c", "EXUpdatesInterface/noop-file.m"]');
    expect(manifest.split("\n")[0]).toBe("// swift-tools-version: 6.0");
  });

  it("still counts an Objective-C file with code as a source", () => {
    const root = moduleFixture("Real", { "ios/A.swift": "", "ios/Real/R.m": "// c\nint r(void) { return 1; }\n" });
    expect(layoutOf("Real", root).layout).toBe("mixed");
  });

  it("treats a meta pod (no sources, no source_files) as nothing to build", () => {
    const root = moduleFixture("expo-dev-client", {}, "s.dependency 'expo-dev-launcher'");
    const { layout, facts } = layoutOf("expo-dev-client", root);
    expect(facts.declaresSourceFiles).toBe(false);
    expect(layout).toBe("meta");
  });

  it("does not take a module whose podspec declares source_files but ships none for a meta pod", () => {
    const root = moduleFixture("Partial", {});
    expect(layoutOf("Partial", root).layout).toBe("pure-swift");
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
    const { layout, sources, facts } = layoutOf("ExpoSQLite", root);
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
    const { layout, sources, facts } = layoutOf("ExpoSQLite", root);
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
    expect(layoutOf("Swifty2", root).layout).toBe("pure-swift");
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
      expect(emit("EXDevLauncher", root, "mixed", sources).manifest).toContain(
        'exclude: ["Tests", "Assets.xcassets", "Views/Main.storyboard"]',
      );
    });

    it("excludes them from a pure-Swift target too", () => {
      const swifty = moduleFixture("SwiftAssets", { "ios/A.swift": "", "ios/Media.xcassets/Contents.json": "{}" });
      const sources = classify.scanAppleSources(swifty);
      expect(emit("SwiftAssets", swifty, "pure-swift", sources).manifest).toContain('exclude: ["Media.xcassets"]');
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

    const launcher = moduleFixture("expo-dev-launcher", {
      "ios/Launcher.swift": "",
      "ios/EXDevLauncherController.h": "#import <Foundation/Foundation.h>\n",
      "ios/EXDevLauncherController.m": '#import <EXDevLauncher/EXDevLauncherController.h>\n',
      "ios/Manifest/EXDevLauncherManifestParser.h": "@import EXManifests;\n",
    });
    const deps: LocalDep[] = [
      { podName: "EXManifests", name: "EXManifests", pkgDir: "/out/expo-source/EXManifests", hasSwift: true },
      { podName: "EXJSONUtils", name: "EXJSONUtils", pkgDir: "/out/expo-source/EXJSONUtils", hasSwift: false },
    ];

    it("depends on sibling generated packages and searches their pod-headers and Swift module maps", () => {
      const sources = classify.scanAppleSources(launcher);
      const { manifest } = emit("EXDevLauncher", launcher, "mixed", sources, { headerDir: "EXDevLauncher", localDeps: deps });
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
      const { dir, read } = emit("EXDevLauncher", launcher, "mixed", sources, { headerDir: "EXDevLauncher" });
      expect(read("pod-headers/EXDevLauncher/EXDevLauncher-Swift.h")).toBe("#import <EXDevLauncher-Swift.h>\n");
      expect(read("pod-headers/EXDevLauncher/EXDevLauncher-umbrella.h")).toBe(`#import "${path.join(dir, "umbrella.h")}"\n`);
      expect(read("pod-headers/EXDevLauncher/EXDevLauncherManifestParser.h")).toBe(
        `#import "${path.join(launcher, "ios/Manifest/EXDevLauncherManifestParser.h")}"\n`,
      );
    });

    it("gives a pure-Swift package a Swift-header forwarder and its sibling dependencies", () => {
      const root = moduleFixture("EXUpdatesInterface", { "ios/A.swift": "" });
      const { manifest, read } = emit("EXUpdatesInterface", root, "pure-swift", classify.scanAppleSources(root), { localDeps: [deps[0]!] });
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
