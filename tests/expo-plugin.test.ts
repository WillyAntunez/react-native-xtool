import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";

// Exercises the PATCHED Expo SwiftPM plugin (patches/expo+58.0.17.patch) as installed in the
// reference app (override with EXPO_XTOOL_REF_APP). Skipped when that app is not on this machine.
const APP = process.env["EXPO_XTOOL_REF_APP"] ?? "/home/willy/Desktop/willy/expo-ios-linux/app";
const SPM = path.join(APP, "node_modules/expo/scripts/spm");
const MANIFESTS = path.join(SPM, "manifests.js");
const COMMITTED_PATCH = path.resolve(import.meta.dirname, "../patches/expo+58.0.17.patch");
// The functional test re-runs `setup-apple-spm.js update` and rewrites the app's ios/build, so it
// is opt-in: EXPO_XTOOL_E2E=1.
const e2e = process.env["EXPO_XTOOL_E2E"] === "1";
const available = existsSync(MANIFESTS) && existsSync(path.join(APP, "ios/build"));

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
};
type PodspecFacts = { linkage: object | null; declaresSourceFiles: boolean };
type Classify = { scanAppleSources(root: string): Sources };
type Podspec = {
  readPodspecFacts(o: { podName: string; podspecDir: string; moduleRoot: string }): PodspecFacts;
};
type Plugin = { sourceLayout(i: { sources: Sources; podspec: PodspecFacts }): string | null };
type EmitContext = { frameworkSearchPath: string; outDir: string; macroFlags: string[] };
type Emit = (
  o: { moduleRoot: string; product: string; language?: string; sources: Sources },
  ctx: EmitContext,
) => { ok: { packageDep: { path: string } } };
type Manifests = {
  emitPureSwiftSourcePackage: Emit;
  emitGeneratedSourcePackage: Emit;
  isCxxHeader(text: string): boolean;
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

  function emit(pod: string, root: string, language: string, sources: Sources) {
    const outDir = mkdtempSync(path.join(tmpdir(), "xtool-expo-out-"));
    tmp.push(outDir);
    const ctx = { frameworkSearchPath: "/fw", outDir, macroFlags: [] };
    const fn = language === "pure-swift" ? manifests.emitPureSwiftSourcePackage : manifests.emitGeneratedSourcePackage;
    const dir = fn({ moduleRoot: root, product: pod, language, sources }, ctx).ok.packageDep.path;
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
      expect(manifest).toContain(`.unsafeFlags(["-I", "${path.join(dir, "swift-headers")}"])`);
      expect(manifest).toContain('.unsafeFlags(["-std=c++20"])');
      expect(manifest).toContain(`"-import-objc-header", "${path.join(dir, "umbrella.h")}"`);
      expect(read("swift-headers/MixMod/MixMod-Swift.h")).toBe("#import <MixMod-Swift.h>\n");
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

});
