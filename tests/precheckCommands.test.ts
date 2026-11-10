import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isExecutable, sdkBundle } from "../src/commands/setup.js";
import type { AppTargetInputs, ExpoPackageInputs } from "../src/generate/packageSwift.js";
import type { GeneratedApp } from "../src/generate/iosXtool.js";
import {
  clangArgs,
  moduleCacheKey,
  precheckIncludeDirs,
  precheckToolchain,
  swiftcArgs,
  type PrecheckInputs,
} from "../src/pipeline/precheckCommands.js";
import type { PrecheckGraph } from "../src/pipeline/precheckGraph.js";
import { toolEnv } from "../src/tools/exec.js";
import { SWIFT_TEST_TIMEOUT_MS, SWIFT_TIMEOUT_MS, tool } from "./support/tools.js";

const HEADERS = "/p/app/ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos";
const DIR = "/p/app/ios-xtool/.precheck";
const CACHE = `${DIR}/ModuleCache/rn0.88.1-0123456789ab`;

function inputs(app: Partial<AppTargetInputs> = {}, expo?: ExpoPackageInputs): PrecheckInputs {
  const target: AppTargetInputs = {
    mixed: true,
    bridgingHeader: "/p/app/ios-xtool/Sources/App/App-Bridging-Header.h",
    defines: ["COCOAPODS=1"],
    headerSearchPaths: ["/p/app/ios/App", "/p/My Apps/inc"],
    swiftHeadersDir: HEADERS,
    ...app,
  };
  const generated: GeneratedApp = {
    pkg: { iosDir: "/p/app/ios", frameworks: [], iosMin: "16.4", app: target, expo },
    origins: {},
  };
  const graph: PrecheckGraph = {
    headerDirs: ["/p/pkgs/React/include"],
    moduleMaps: ["/p/pkgs/React/include/module.modulemap"],
    synthesized: [{ module: "ReactCodegen", text: "module ReactCodegen {}\n" }],
    targets: ["React", "ReactCodegen"],
    modules: ["React", "ReactCodegen"],
    unresolved: [],
  };
  return {
    app: generated,
    graph,
    toolchain: {
      clang: "/t/bin/clang",
      swiftc: "/t/bin/swiftc",
      sdk: "/t/sdk/iPhoneOS.sdk",
      swiftResources: "/t/sdk/swift",
      swiftIncludes: ["/t/sdk/Platform Lib"],
      swiftExtra: ["-Xfrontend", "-enable-cross-import-overlays"],
      versions: "v",
    },
    dir: DIR,
    moduleCache: CACHE,
  };
}

/** The value after each `flag` element. */
const after = (args: string[], flag: string) => args.flatMap((a, n) => (a === flag ? [args[n + 1]] : []));

describe("the precheck's command lines", () => {
  it("compiles Objective-C++ as Swift Build does", () => {
    const mm = clangArgs(inputs(), "/p/app/ios-xtool/Sources/App/AppDelegate.mm");
    for (const flag of ["-fsyntax-only", "-fobjc-arc", "-fmodules", "-fno-cxx-modules", "-std=c++20", "-DDEBUG=1"]) {
      expect(mm).toContain(flag);
    }
    expect(after(mm, "-x")).toEqual(["objective-c++"]);
    expect(after(mm, "-target")).toEqual(["arm64-apple-ios16.4"]);
    expect(after(mm, "-isysroot")).toEqual(["/t/sdk/iPhoneOS.sdk"]);
    // -fno-cxx-modules leaves the module cache unused: clang warns about the flag.
    expect(mm.some((a) => a.startsWith("-fmodules-cache-path="))).toBe(false);
    expect(mm.at(-1)).toBe("/p/app/ios-xtool/Sources/App/AppDelegate.mm");
    expect(mm).toContain("-fmodule-name=App");
    expect(after(mm, "-iframework")).toEqual(["/t/Library/Frameworks", "/t/sdk/iPhoneOS.sdk/Developer/Library/Frameworks"]);

    const m = clangArgs(inputs(), "/p/app/ios-xtool/Sources/App/main.m");
    expect(after(m, "-x")).toEqual(["objective-c"]);
    expect(m).toContain("-fobjc-arc");
    expect(m).toContain("-fmodules");
    expect(m.some((a) => a.startsWith("-std="))).toBe(false);
    expect(m).not.toContain("-fno-cxx-modules");
    expect(m).toContain(`-fmodules-cache-path=${CACHE}`);

    const cpp = clangArgs(inputs(), "/p/app/ios-xtool/Sources/App/x.cpp");
    expect(after(cpp, "-x")).toEqual(["c++"]);
    expect(cpp).not.toContain("-fobjc-arc");
    expect(cpp).toContain("-fno-cxx-modules");
    expect(cpp).toContain("-std=c++20");
    expect(cpp.some((a) => a.startsWith("-fmodules-cache-path="))).toBe(false);
    expect(after(clangArgs(inputs(), "/p/a/x.c"), "-x")).toEqual(["c"]);
    expect(after(clangArgs(inputs(), "/p/a/x.h"), "-x")).toEqual(["objective-c"]);
  });

  it("uses the precheck's Swift header folder", () => {
    const i = inputs();
    for (const args of [clangArgs(i, "/p/a/x.m"), precheckIncludeDirs(i)]) {
      expect(args.some((a) => a.includes(HEADERS))).toBe(false);
    }
    expect(after(clangArgs(i, "/p/a/x.m"), "-I")).toContain(`${DIR}/swift-headers`);
    expect(precheckIncludeDirs(i)).toEqual([
      "/p/app/ios/App",
      "/p/My Apps/inc",
      `${DIR}/swift-headers`,
      "/p/pkgs/React/include",
    ]);
  });

  it("moves the Swift header folder inside joined arguments", () => {
    const expo: ExpoPackageInputs = {
      compileInterfacesDir: "/p/app/ios-xtool/.expo/interfaces",
      jsiHeaders: false,
      clangImporter: {
        swiftHeadersDir: HEADERS,
        includeDirs: ["/p/expo/pod-headers"],
        moduleMaps: [`${HEADERS}/ExpoModulesCore.modulemap`],
      },
    };
    const i = inputs({}, expo);
    const clang = clangArgs(i, "/p/a/x.m");
    const swiftc = swiftcArgs(i, ["/p/a/AppDelegate.swift"]);
    for (const args of [clang, swiftc]) expect(args.some((a) => a.includes(HEADERS))).toBe(false);
    expect(clang).toContain(`-fmodule-map-file=${DIR}/swift-headers/ExpoModulesCore.modulemap`);
    expect(after(swiftc, "-Xcc")).toContain(`-I${DIR}/swift-headers`);
    expect(after(swiftc, "-Xcc")).toContain(`-fmodule-map-file=${DIR}/swift-headers/ExpoModulesCore.modulemap`);
    // A path that only starts with the same characters is another folder.
    const sibling = inputs({ headerSearchPaths: [`${HEADERS}-other`] });
    expect(after(clangArgs(sibling, "/p/a/x.m"), "-I")).toContain(`${HEADERS}-other`);
  });

  it("names the graph's folders and module maps, synthesized ones included", () => {
    const i = inputs();
    const synthesized = `${DIR}/modulemaps/ReactCodegen/module.modulemap`;
    const clang = clangArgs(i, "/p/a/x.m");
    expect(after(clang, "-I")).toContain("/p/pkgs/React/include");
    expect(clang).toContain("-fmodule-map-file=/p/pkgs/React/include/module.modulemap");
    expect(clang).toContain(`-fmodule-map-file=${synthesized}`);
    const swiftc = swiftcArgs(i, ["/p/a/AppDelegate.swift"]);
    // Swift Build gives the importer a clang target's headers, and Swift no search path for them.
    expect(after(swiftc, "-I")).not.toContain("/p/pkgs/React/include");
    expect(after(swiftc, "-Xcc")).toContain("-I/p/pkgs/React/include");
    expect(after(swiftc, "-Xcc")).toContain(`-fmodule-map-file=${synthesized}`);
  });

  it("names one module map per module, Swift Build's own before a synthesized one", () => {
    // Task 13's third false stop: Expo's ExpoUI, a mixed target, had its synthesized map and Swift Build's copied one.
    const expoUI = "/p/expo/ExpoUI/root/ios";
    const expo: ExpoPackageInputs = {
      compileInterfacesDir: "/p/app/ios-xtool/.expo/interfaces",
      jsiHeaders: false,
      clangImporter: { swiftHeadersDir: HEADERS, includeDirs: [], moduleMaps: [`${HEADERS}/ExpoUI.modulemap`, `${HEADERS}/React.modulemap`] },
    };
    const i = inputs({}, expo);
    i.graph = {
      ...i.graph,
      headerDirs: [...i.graph.headerDirs, expoUI],
      synthesized: [...i.graph.synthesized, { module: "ExpoUI", text: `module ExpoUI {\n    umbrella "${expoUI}"\n    export *\n}\n` }],
      modules: [...i.graph.modules, "ExpoUI"],
    };
    const maps = (args: string[]) => args.filter((a) => a.startsWith("-fmodule-map-file="));
    for (const args of [clangArgs(i, "/p/a/x.m"), swiftcArgs(i, ["/p/a/A.swift"])]) {
      // React's map on disk wins over Swift Build's importer map; ExpoUI's importer map over its synthesized one.
      expect(maps(args)).toEqual([
        `-fmodule-map-file=${DIR}/swift-headers/ExpoUI.modulemap`,
        "-fmodule-map-file=/p/pkgs/React/include/module.modulemap",
        `-fmodule-map-file=${DIR}/modulemaps/ReactCodegen/module.modulemap`,
      ]);
      // Swift Build gives the App no header folder for a module whose map it writes.
      expect(args.some((a) => a.endsWith(expoUI))).toBe(false);
      expect(args.filter((a) => a.endsWith("/p/pkgs/React/include")).length).toBeGreaterThan(0);
    }
    // The importer map left out takes its -Xcc with it.
    expect(after(swiftcArgs(i, ["/p/a/A.swift"]), "-Xcc")).not.toContain("-Xcc");

    // Not written yet (the precheck drops Swift Build's map from the command): the synthesized one stands in.
    const waiting = clangArgs(i, "/p/a/x.m", new Set(["ExpoUI"]));
    expect(maps(waiting)).toContain(`-fmodule-map-file=${DIR}/modulemaps/ExpoUI/module.modulemap`);
    expect(after(waiting, "-I")).toContain(expoUI);
  });

  it("typechecks Swift with the bridging header and writes App-Swift.h", () => {
    const args = swiftcArgs(inputs(), ["/p/a/AppDelegate.swift", "/p/a/View.swift"]);
    expect(args[0]).toBe("-typecheck");
    // Task 13's first false stop: a one-file App is not its main file ('main' attribute … top-level code).
    expect(args).toContain("-parse-as-library");
    expect(after(args, "-module-name")).toEqual(["App"]);
    expect(after(args, "-target")).toEqual(["arm64-apple-ios16.4"]);
    expect(after(args, "-sdk")).toEqual(["/t/sdk/iPhoneOS.sdk"]);
    const sdk = args.indexOf("-sdk");
    expect(args.slice(sdk + 2, sdk + 8)).toEqual(["-resource-dir", "/t/sdk/swift", "-Xcc", "-resource-dir", "-Xcc", "/t/sdk/swift/clang"]);
    // The triple's include paths and the developer frameworks come after the target's own flags, as in Swift Build.
    expect(after(args, "-Isystem")).toEqual(["/t/sdk/Platform Lib"]);
    expect(args.indexOf("-Isystem")).toBeGreaterThan(args.indexOf("-import-objc-header"));
    expect(after(args, "-F")).toEqual(["/t/Library/Frameworks", "/t/sdk/iPhoneOS.sdk/Developer/Library/Frameworks"]);
    expect(after(args, "-enable-experimental-feature")).toEqual(["DebugDescriptionMacro"]);
    // The generated package's identity, as SwiftPM spells it (`ios-xtool` → `ios_xtool`).
    expect(after(args, "-package-name")).toEqual(["ios_xtool"]);
    expect(after(args, "-swift-version")).toEqual(["5"]);
    expect(after(args, "-module-cache-path")).toEqual([CACHE]);
    expect(after(args, "-import-objc-header")).toEqual(["/p/app/ios-xtool/Sources/App/App-Bridging-Header.h"]);
    expect(after(args, "-emit-objc-header-path")).toEqual([`${DIR}/swift-headers/App-Swift.h`]);
    expect(args).toContain("-enable-cross-import-overlays");
    expect(args.slice(-2)).toEqual(["/p/a/AppDelegate.swift", "/p/a/View.swift"]);
  });

  it("defines what Swift Build defines for a package target in Debug", () => {
    const xcc = (args: string[]) => after(args, "-Xcc").filter((a) => a.startsWith("-D"));
    const importer = ["-DSWIFT_PACKAGE", "-DDEBUG=1", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG"];
    // Task 13's second false stop: React Native's headers hide RCTDevMenuConfiguration's initializer without DEBUG=1.
    const swiftOnly = swiftcArgs(inputs({ mixed: false, bridgingHeader: undefined }), ["/p/a/A.swift"]);
    expect(xcc(swiftOnly)).toEqual(importer);
    for (const d of ["-DSWIFT_PACKAGE", "-DDEBUG", "-DSWIFT_MODULE_RESOURCE_BUNDLE_UNAVAILABLE", "-DXcode"]) expect(swiftOnly).toContain(d);
    // A mixed target's cSettings give Swift Build the App's own macros; its bridging header gives them again.
    expect(xcc(swiftcArgs(inputs(), ["/p/a/A.swift"]))).toEqual([...importer, "-DCOCOAPODS=1", "-DCOCOAPODS=1"]);

    const clang = ["-DSWIFT_PACKAGE", "-DDEBUG=1", "-DOBJC_OLD_DISPATCH_PROTOTYPES=1", "-DXcode"];
    const defines = (args: string[]) => args.filter((a) => a.startsWith("-D"));
    expect(defines(clangArgs(inputs(), "/p/a/x.m"))).toEqual([...clang, "-DCOCOAPODS=1"]);
    expect(defines(clangArgs(inputs(), "/p/a/x.mm"))).toEqual([...clang, "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG", "-DCOCOAPODS=1"]);
    // A Swift-only target's bridging header gets what the importer gets.
    expect(defines(clangArgs(inputs({ mixed: false }), "/p/a/B.h"))).toEqual([...importer, "-DCOCOAPODS=1"]);
  });

  it("gives a Swift-only target's bridging header what Swift gives it", () => {
    const i = inputs({ mixed: false });
    const args = clangArgs(i, "/p/app/ios-xtool/Sources/App/App-Bridging-Header.h");
    expect(after(args, "-x")).toEqual(["objective-c"]);
    expect(args).toContain("-I/p/My Apps/inc");
    expect(args).toContain("-DCOCOAPODS=1");
    expect(args).not.toContain("-Xcc");
    expect(args).not.toContain("-import-objc-header");
    // Swift's clang importer compiles no file of module App.
    expect(args.some((a) => a.startsWith("-fmodule-name="))).toBe(false);
  });

  it("gives an Expo Swift-only target's bridging header the compile-interfaces frameworks", () => {
    const expo: ExpoPackageInputs = { compileInterfacesDir: "/p/app/ios-xtool/.expo/My Interfaces", jsiHeaders: false };
    const args = clangArgs(inputs({ mixed: false }, expo), "/p/app/ios-xtool/Sources/App/App-Bridging-Header.h");
    expect(after(args, "-F")).toEqual(["/p/app/ios-xtool/.expo/My Interfaces"]);
    expect(args).toContain("-DCOCOAPODS=1");
    expect(args).not.toContain("-Xcc");
  });

  it("keeps a folder with spaces one argument", () => {
    const i = inputs();
    expect(after(clangArgs(i, "/p/a/x.m"), "-I")).toContain("/p/My Apps/inc");
    expect(after(swiftcArgs(i, ["/p/a/A.swift"]), "-Xcc")).toContain("-I/p/My Apps/inc");
    expect(clangArgs(i, "/p/My Apps/x.m").at(-1)).toBe("/p/My Apps/x.m");
  });

  it("keys the module cache by React Native and the toolchain", () => {
    const key = moduleCacheKey("0.88.1", "clang 21\nswift 6.4\nepoch=4");
    expect(key).toMatch(/^rn0\.88\.1-[0-9a-f]{12}$/);
    expect(moduleCacheKey("0.88.1", "clang 21\nswift 6.4\nepoch=4")).toBe(key);
    expect(moduleCacheKey("0.88.1", "clang 22\nswift 6.4\nepoch=4")).not.toBe(key);
    expect(moduleCacheKey("0.88.0", "clang 21\nswift 6.4\nepoch=4")).not.toBe(key);
  });
});

describe("precheckToolchain", () => {
  let t = "";
  afterEach(() => {
    vi.unstubAllEnvs();
    if (t) rmSync(t, { recursive: true, force: true });
    t = "";
  });

  /** A temp Darwin SDK bundle (through XDG_CONFIG_HOME) and a bin folder with fake clang and swiftc. */
  function fakeSetup(sdkRoot: string, makeSdk: boolean): { env: NodeJS.ProcessEnv; bundle: string } {
    t = mkdtempSync(path.join(tmpdir(), "precheck-toolchain-"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(t, "config"));
    const bundle = sdkBundle();
    mkdirSync(path.join(bundle, "toolset"), { recursive: true });
    if (makeSdk) mkdirSync(path.join(bundle, sdkRoot), { recursive: true });
    if (makeSdk) mkdirSync(path.join(bundle, "Toolchain/usr/lib/swift"), { recursive: true });
    const triple = (root: string) => ({
      sdkRootPath: root,
      toolsetPaths: ["toolset.json"],
      swiftResourcesPath: "Toolchain/usr/lib/swift",
      includeSearchPaths: ["Platforms/iPhoneOS.platform/usr/lib"],
    });
    writeFileSync(
      path.join(bundle, "swift-sdk.json"),
      JSON.stringify({
        schemaVersion: "4.0",
        targetTriples: { "arm64-apple-macosx": triple("Mac/MacOSX.sdk"), "arm64-apple-ios": triple(sdkRoot) },
      }),
    );
    writeFileSync(
      path.join(bundle, "toolset.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        rootPath: "toolset/bin",
        swiftCompiler: { extraCLIOptions: ["-Xfrontend", "-enable-cross-import-overlays", "-use-ld=lld"] },
      }),
    );
    writeFileSync(path.join(bundle, "darwin-sdk-version.txt"), "epoch=4,darwinTools=1.1.0\n");
    const bin = path.join(t, "bin");
    mkdirSync(bin);
    for (const name of ["clang", "swiftc"]) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\necho "fake ${name} 1.0"\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    return { env: { PATH: bin }, bundle };
  }

  it("names a missing compiler and a missing SDK", async () => {
    await expect(precheckToolchain({ PATH: "" })).rejects.toThrow(
      "precheck — clang was not found on the Swift toolchain's PATH; run rn-xtool setup",
    );
    const { env, bundle } = fakeSetup("Platforms/iPhoneOS.platform/SDKs/iPhoneOS27.1.sdk", false);
    const sdk = path.join(bundle, "Platforms/iPhoneOS.platform/SDKs/iPhoneOS27.1.sdk");
    await expect(precheckToolchain(env)).rejects.toThrow(
      `precheck — the iPhoneOS SDK was not found in the Darwin SDK (${sdk}); run rn-xtool setup --xcode-xip <path>`,
    );
    rmSync(path.join(env.PATH!, "swiftc"));
    await expect(precheckToolchain(env)).rejects.toThrow(
      "precheck — swiftc was not found on the Swift toolchain's PATH; run rn-xtool setup",
    );
  });

  it("names a Darwin SDK without an iPhoneOS entry", async () => {
    const { env, bundle } = fakeSetup("x.sdk", true);
    writeFileSync(path.join(bundle, "swift-sdk.json"), JSON.stringify({ schemaVersion: "4.0", targetTriples: {} }));
    await expect(precheckToolchain(env)).rejects.toThrow(
      `precheck — the iPhoneOS SDK was not found in the Darwin SDK (${path.join(bundle, "swift-sdk.json")})`,
    );
  });

  it("names missing Swift resources", async () => {
    const { env, bundle } = fakeSetup("x.sdk", true);
    const resources = path.join(bundle, "Toolchain/usr/lib/swift");
    rmSync(resources, { recursive: true });
    await expect(precheckToolchain(env)).rejects.toThrow(
      `precheck — the Swift resources were not found in the Darwin SDK (${resources}); run rn-xtool setup --xcode-xip <path>`,
    );
  });

  it("reads the SDK, the toolset's Swift options and the versions", async () => {
    const { env, bundle } = fakeSetup("Platforms/iPhoneOS.platform/SDKs/iPhoneOS27.1.sdk", true);
    const tc = await precheckToolchain(env);
    expect(tc.clang).toBe(path.join(env.PATH!, "clang"));
    expect(tc.swiftc).toBe(path.join(env.PATH!, "swiftc"));
    expect(tc.sdk).toBe(path.join(bundle, "Platforms/iPhoneOS.platform/SDKs/iPhoneOS27.1.sdk"));
    expect(tc.swiftExtra).toEqual(["-Xfrontend", "-enable-cross-import-overlays"]);
    expect(tc.swiftResources).toBe(path.join(bundle, "Toolchain/usr/lib/swift"));
    expect(tc.swiftIncludes).toEqual([path.join(bundle, "Platforms/iPhoneOS.platform/usr/lib")]);
    expect(tc.versions).toBe("fake clang 1.0\nfake swiftc 1.0\nepoch=4,darwinTools=1.1.0");
  });
});

const IOS_SDK = path.join(sdkBundle(), "Developer", "Platforms", "iPhoneOS.platform", "Developer", "SDKs", "iPhoneOS.sdk");
const HAS_IOS_TOOLS = existsSync(IOS_SDK) && tool("clang", ["--version"], { env: toolEnv() }).status === 0;

describe.skipIf(!HAS_IOS_TOOLS)(
  `the installed toolchain${HAS_IOS_TOOLS ? "" : " (needs the Darwin SDK and the Swift toolchain's clang: rn-xtool setup)"}`,
  () => {
    it("finds the compilers and the iPhoneOS SDK", async () => {
      const tc = await precheckToolchain();
      expect(isExecutable(tc.clang)).toBe(true);
      expect(isExecutable(tc.swiftc)).toBe(true);
      expect(existsSync(tc.sdk)).toBe(true);
      expect(tc.swiftExtra.some((o) => o.startsWith("-use-ld="))).toBe(false);
      expect(tc.versions).toMatch(/clang version/);
      expect(tc.versions).toMatch(/Swift version/);
    });

    it(
      "typechecks Swift and compiles Objective-C against the iPhoneOS SDK",
      async () => {
        const tc = await precheckToolchain();
        const t = mkdtempSync(path.join(tmpdir(), "precheck-real-"));
        try {
          const dir = path.join(t, ".precheck");
          const i = (mixed: boolean): PrecheckInputs => ({
            ...inputs(),
            app: {
              pkg: {
                iosDir: path.join(t, "ios"),
                frameworks: [],
                iosMin: "16.4",
                app: { mixed, defines: [], headerSearchPaths: [], swiftHeadersDir: path.join(t, "build-headers") },
              },
              origins: {},
            },
            graph: { headerDirs: [], moduleMaps: [], synthesized: [], targets: [], modules: [], unresolved: [] },
            toolchain: tc,
            dir,
            moduleCache: path.join(dir, "ModuleCache", moduleCacheKey("0.88.1", tc.versions)),
          });
          const swift = path.join(t, "A.swift");
          writeFileSync(swift, "import Foundation\n");
          const typecheck = tool(tc.swiftc, swiftcArgs(i(false), [swift]), { env: toolEnv(), timeout: SWIFT_TIMEOUT_MS });
          expect(typecheck.stderr).toBe("");
          expect(typecheck.status).toBe(0);
          expect(existsSync(path.join(dir, "swift-headers", "App-Swift.h"))).toBe(true);

          // One file with an @main type, as the bare template's AppDelegate.swift: a library's file, not main.swift.
          const main = path.join(t, "AppDelegate.swift");
          writeFileSync(main, "import UIKit\n\n@main\nclass AppDelegate: UIResponder, UIApplicationDelegate {}\n");
          const library = tool(tc.swiftc, swiftcArgs(i(false), [main]), { env: toolEnv(), timeout: SWIFT_TIMEOUT_MS });
          expect(library.stderr).toBe("");
          expect(library.status).toBe(0);

          // A `package` declaration needs the package's name, as Swift Build passes it.
          const pkg = path.join(t, "Access.swift");
          writeFileSync(pkg, "package func packageOnly() {}\n");
          const packageCheck = tool(tc.swiftc, swiftcArgs(i(false), [pkg]), { env: toolEnv(), timeout: SWIFT_TIMEOUT_MS });
          expect(packageCheck.stderr).toBe("");
          expect(packageCheck.status).toBe(0);

          // A bridging header's debug-only declaration, as React Native's headers keep theirs under DEBUG.
          const bridging = path.join(t, "Bridging.h");
          writeFileSync(bridging, "#if DEBUG\nstatic inline int precheckDebugOnly(void) { return 1; }\n#endif\n");
          const debug = path.join(t, "Debug.swift");
          writeFileSync(debug, "func debugOnly() -> Int32 { precheckDebugOnly() }\n");
          const withBridging: PrecheckInputs = { ...i(false), app: { ...i(false).app } };
          withBridging.app.pkg = { ...withBridging.app.pkg, app: { ...withBridging.app.pkg.app, bridgingHeader: bridging } };
          const debugCheck = tool(tc.swiftc, swiftcArgs(withBridging, [debug]), { env: toolEnv(), timeout: SWIFT_TIMEOUT_MS });
          expect(debugCheck.stderr).toBe("");
          expect(debugCheck.status).toBe(0);

          const objc = path.join(t, "B.m");
          writeFileSync(objc, "#import <Foundation/Foundation.h>\n");
          const compile = tool(tc.clang, clangArgs(i(true), objc), { env: toolEnv(), timeout: SWIFT_TIMEOUT_MS });
          expect(compile.stderr).toBe("");
          expect(compile.status).toBe(0);
        } finally {
          rmSync(t, { recursive: true, force: true });
        }
      },
      SWIFT_TEST_TIMEOUT_MS,
    );
  },
);
