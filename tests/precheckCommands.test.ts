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
import { tool } from "./support/tools.js";

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
    expect(mm).toContain(`-fmodules-cache-path=${CACHE}`);
    expect(mm.at(-1)).toBe("/p/app/ios-xtool/Sources/App/AppDelegate.mm");

    const m = clangArgs(inputs(), "/p/app/ios-xtool/Sources/App/main.m");
    expect(after(m, "-x")).toEqual(["objective-c"]);
    expect(m).toContain("-fobjc-arc");
    expect(m).toContain("-fmodules");
    expect(m.some((a) => a.startsWith("-std="))).toBe(false);
    expect(m).not.toContain("-fno-cxx-modules");

    const cpp = clangArgs(inputs(), "/p/app/ios-xtool/Sources/App/x.cpp");
    expect(after(cpp, "-x")).toEqual(["c++"]);
    expect(cpp).not.toContain("-fobjc-arc");
    expect(cpp).toContain("-fno-cxx-modules");
    expect(cpp).toContain("-std=c++20");
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
    expect(after(swiftc, "-I")).toContain("/p/pkgs/React/include");
    expect(after(swiftc, "-Xcc")).toContain("-I/p/pkgs/React/include");
    expect(after(swiftc, "-Xcc")).toContain(`-fmodule-map-file=${synthesized}`);
  });

  it("typechecks Swift with the bridging header and writes App-Swift.h", () => {
    const args = swiftcArgs(inputs(), ["/p/a/AppDelegate.swift", "/p/a/View.swift"]);
    expect(args[0]).toBe("-typecheck");
    expect(after(args, "-module-name")).toEqual(["App"]);
    expect(after(args, "-target")).toEqual(["arm64-apple-ios16.4"]);
    expect(after(args, "-sdk")).toEqual(["/t/sdk/iPhoneOS.sdk"]);
    expect(after(args, "-swift-version")).toEqual(["5"]);
    expect(after(args, "-module-cache-path")).toEqual([CACHE]);
    expect(after(args, "-import-objc-header")).toEqual(["/p/app/ios-xtool/Sources/App/App-Bridging-Header.h"]);
    expect(after(args, "-emit-objc-header-path")).toEqual([`${DIR}/swift-headers/App-Swift.h`]);
    expect(args).toContain("-enable-cross-import-overlays");
    expect(args.slice(-2)).toEqual(["/p/a/AppDelegate.swift", "/p/a/View.swift"]);
  });

  it("gives a Swift-only target's bridging header what Swift gives it", () => {
    const i = inputs({ mixed: false });
    const args = clangArgs(i, "/p/app/ios-xtool/Sources/App/App-Bridging-Header.h");
    expect(after(args, "-x")).toEqual(["objective-c"]);
    expect(args).toContain("-I/p/My Apps/inc");
    expect(args).toContain("-DCOCOAPODS=1");
    expect(args).not.toContain("-Xcc");
    expect(args).not.toContain("-import-objc-header");
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
    const triple = (root: string) => ({ sdkRootPath: root, toolsetPaths: ["toolset.json"] });
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

  it("reads the SDK, the toolset's Swift options and the versions", async () => {
    const { env, bundle } = fakeSetup("Platforms/iPhoneOS.platform/SDKs/iPhoneOS27.1.sdk", true);
    const tc = await precheckToolchain(env);
    expect(tc.clang).toBe(path.join(env.PATH!, "clang"));
    expect(tc.swiftc).toBe(path.join(env.PATH!, "swiftc"));
    expect(tc.sdk).toBe(path.join(bundle, "Platforms/iPhoneOS.platform/SDKs/iPhoneOS27.1.sdk"));
    expect(tc.swiftExtra).toEqual(["-Xfrontend", "-enable-cross-import-overlays"]);
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
  },
);
