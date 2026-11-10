import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeIosXtool, type GeneratedApp } from "../src/generate/iosXtool.js";
import { projectPaths, swiftHeadersDir, type ProjectPaths } from "../src/paths.js";
import { runPrecheck, type PrecheckDeps } from "../src/pipeline/precheck.js";
import { moduleCacheKey, type PrecheckToolchain } from "../src/pipeline/precheckCommands.js";
import type { SwiftRunner } from "../src/pipeline/precheckGraph.js";
import { PrecheckError } from "../src/pipeline/precheckReport.js";
import { readProject } from "../src/project/index.js";
import { objcApp } from "./support/objcApp.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempRoot = (): string => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xt-precheck-")));
  tmps.push(root);
  return root;
};

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A package of the fake graph: its regular targets, each with an `include` folder holding `headers`. */
interface FakePackage {
  name: string;
  path: string;
  /** `swift`: the target's folder holds a Swift file too (a mixed target). */
  targets: { name: string; headers: Record<string, string>; swift?: boolean }[];
}

/** React Native's headers as the fake graph gives them: `<React/…>` from a target named React. */
function reactNative(root: string, extra: Record<string, string> = {}): FakePackage {
  return {
    name: "ReactNative",
    path: path.join(root, "ios", "build", "xcframeworks"),
    targets: [{ name: "React", headers: { "React/RCTBundleURLProvider.h": "@interface RCTBundleURLProvider\n@end\n", ...extra } }],
  };
}

/**
 * SwiftPM as the precheck asks it: `describe` plans App as a library; `show-dependencies` lists `packages`; the root's
 * App depends on every product of theirs (one per target). Each call is recorded by its subcommand.
 */
function fakeSwift(paths: ProjectPaths, packages: FakePackage[], calls: string[]): SwiftRunner {
  for (const p of packages) {
    for (const t of p.targets) {
      mkdirSync(path.join(p.path, t.name, "include"), { recursive: true });
      for (const [rel, text] of Object.entries(t.headers)) write(path.join(p.path, t.name, "include", rel), text);
      if (t.swift === true) write(path.join(p.path, t.name, `${t.name}.swift`), "public let x = 1\n");
    }
  }
  const json = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
  return async (args) => {
    calls.push(args[1]!);
    if (args[1] === "describe") return json({ name: "AppXtool", targets: [{ name: "App", type: "library" }] });
    if (args[1] === "show-dependencies") {
      return json({ name: "appxtool", path: paths.iosXtool, dependencies: packages.map((p) => ({ name: p.name, path: p.path, dependencies: [] })) });
    }
    const at = args[args.indexOf("--package-path") + 1];
    if (at === paths.iosXtool) {
      return json({
        name: "AppXtool",
        dependencies: packages.map((p) => ({
          fileSystem: [{ identity: path.basename(p.path).toLowerCase(), nameForTargetDependencyResolutionOnly: p.name, path: p.path }],
        })),
        products: [{ name: "App", targets: ["App"] }],
        targets: [
          {
            name: "App",
            type: "regular",
            path: "Sources/App",
            dependencies: packages.flatMap((p) => p.targets.map((t) => ({ product: [t.name, p.name, null, null] }))),
          },
        ],
      });
    }
    const p = packages.find((q) => q.path === at)!;
    return json({
      name: p.name,
      dependencies: [],
      products: p.targets.map((t) => ({ name: t.name, targets: [t.name] })),
      targets: p.targets.map((t) => ({ name: t.name, type: "regular", path: t.name, publicHeadersPath: "include", dependencies: [] })),
    });
  };
}

/**
 * An iPhoneOS SDK with UIKit and Foundation headers and the Swift standard library's module, and a clang whose
 * `--version` names its InstalledDir, with `stdarg.h` in its resource headers (`installedDir: false`: no such line).
 */
function fakeToolchain(root: string, o: { installedDir?: boolean } = {}): PrecheckToolchain {
  const sdk = path.join(root, "sdk", "iPhoneOS.sdk");
  for (const f of ["UIKit", "Foundation"]) write(path.join(sdk, "System", "Library", "Frameworks", `${f}.framework`, "Headers", `${f}.h`), "");
  mkdirSync(path.join(sdk, "usr", "lib", "swift", "Swift.swiftmodule"), { recursive: true });
  const bin = path.join(root, "toolchain", "usr", "bin");
  write(path.join(bin, "..", "lib", "clang", "21", "include", "stdarg.h"), "");
  const versions = o.installedDir === false ? "clang version 21.0.0\nSwift version 6.4.1" : `clang version 21.0.0\nInstalledDir: ${bin}\nSwift version 6.4.1`;
  return { clang: "/t/bin/clang", swiftc: "/t/bin/swiftc", sdk, swiftResources: "/t/swift", swiftIncludes: [], swiftExtra: [], versions };
}

type Compiled = { tool: string; file: string; args: string[]; env: NodeJS.ProcessEnv };

interface Harness {
  paths: ProjectPaths;
  app: GeneratedApp;
  logs: string[];
  calls: string[];
  compiled: Compiled[];
  run: (o?: { clean?: boolean; deps?: Partial<PrecheckDeps>; packages?: FakePackage[]; installedDir?: boolean }) => Promise<void>;
  dir: string;
}

/**
 * The precheck over `app` with fake SwiftPM, compilers and toolchain. `outputs(tool, file, n)` answers the n-th compile
 * of a file (default: exit 0, no output); `calls` records the SwiftPM subcommands, then `<tool> <file name>` per compile.
 */
function harness(
  paths: ProjectPaths,
  app: GeneratedApp,
  outputs: (tool: string, file: string, n: number, args: string[]) => { code: number; output: string } | undefined = () => undefined,
): Harness {
  const logs: string[] = [];
  const calls: string[] = [];
  const compiled: Compiled[] = [];
  const h: Harness = {
    paths,
    app,
    logs,
    calls,
    compiled,
    dir: path.join(paths.iosXtool, ".precheck"),
    run: (o = {}) =>
      runPrecheck(
        paths,
        app,
        { root: paths.root, rnVersion: "0.88.1", clean: o.clean ?? false, log: (s) => logs.push(s) },
        {
          swift: fakeSwift(paths, o.packages ?? [reactNative(paths.root)], calls),
          toolchain: async () => fakeToolchain(paths.root, { installedDir: o.installedDir }),
          compile: async (cmd, args, opts) => {
            const tool = path.basename(cmd);
            const file = path.basename(args.at(-1)!);
            const n = compiled.filter((c) => c.tool === tool && c.file === file).length;
            compiled.push({ tool, file, args, env: opts.env });
            calls.push(`${tool} ${file}`);
            return outputs(tool, file, n, args) ?? { code: 0, output: "" };
          },
          ...o.deps,
        },
      ),
  };
  return h;
}

/** A hand-written bare app: `files` (relative to ios/App) copied into Sources/App, as generate copies a bare target. */
function handApp(files: Record<string, string>, o: { mixed?: boolean; bridgingHeader?: string } = {}): { paths: ProjectPaths; app: GeneratedApp } {
  const root = tempRoot();
  const paths = projectPaths(root);
  const origins: Record<string, string> = {};
  for (const [rel, text] of Object.entries(files)) {
    write(path.join(root, "ios", "App", rel), text);
    write(path.join(paths.sources, rel), text);
    origins[path.join(paths.sources, rel)] = path.join(root, "ios", "App", rel);
  }
  const app: GeneratedApp = {
    pkg: {
      iosDir: paths.ios,
      frameworks: [],
      iosMin: "16.4",
      app: {
        mixed: o.mixed ?? true,
        defines: [],
        headerSearchPaths: [],
        swiftHeadersDir: swiftHeadersDir(paths.iosXtool),
        ...(o.bridgingHeader !== undefined ? { bridgingHeader: path.join(paths.sources, o.bridgingHeader) } : {}),
      },
    },
    origins,
  };
  return { paths, app };
}

/** The project at `root` generated as `build` generates it. */
async function generated(root: string): Promise<{ paths: ProjectPaths; app: GeneratedApp }> {
  const project = await readProject(root);
  const paths = projectPaths(root);
  const app = await writeIosXtool({ project, paths, frameworks: [], metroPort: 8081, lanIp: "192.168.1.5", log: () => {} });
  return { paths, app };
}

const after = (args: string[], flag: string) => args.flatMap((a, n) => (a === flag ? [args[n + 1]] : []));

describe("runPrecheck", () => {
  it("plans, reads the graph, then compiles Swift before the C family", async () => {
    const { paths, app } = handApp({
      "AppDelegate.swift": "import UIKit\n@objc class Greeter: NSObject {}\n",
      "Native.m": '#import "App-Swift.h"\n#import <React/RCTBundleURLProvider.h>\n#include <stdarg.h>\n',
    });
    const h = harness(paths, app, (tool, _file, _n, args) => {
      // swiftc writes App-Swift.h where it is told to.
      if (tool === "swiftc") write(after(args, "-emit-objc-header-path")[0]!, "// App\n");
      return undefined;
    });
    await h.run();
    expect(h.calls).toEqual(["describe", "show-dependencies", "dump-package", "dump-package", "swiftc AppDelegate.swift", "clang Native.m"]);
    expect(h.logs).toEqual([]);
    // The synthesized module map of React's headers, the inputs and every command line are on disk.
    expect(readFileSync(path.join(h.dir, "modulemaps", "React", "module.modulemap"), "utf8")).toContain("module React");
    expect(JSON.parse(readFileSync(path.join(h.dir, "inputs.json"), "utf8")).graph.targets).toEqual(["App", "React"]);
    const log = readFileSync(path.join(h.dir, "precheck.log"), "utf8");
    expect(log).toContain("swift package describe --type json");
    expect(log).toContain(`/t/bin/clang -fno-color-diagnostics -fsyntax-only`);
    expect(log).toContain(`/t/bin/swiftc -no-color-diagnostics -typecheck`);
    // The compilers' temporary files go to .precheck/tmp, removed at the end.
    expect(h.compiled.map((c) => c.env.TMPDIR)).toEqual([path.join(h.dir, "tmp"), path.join(h.dir, "tmp")]);
    expect(existsSync(path.join(h.dir, "tmp"))).toBe(false);
  });

  it("stops on F3 in pass 2 before compiling", async () => {
    const { paths, app } = await generated(objcApp("template"));
    const h = harness(paths, app);
    const err = await h.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrecheckError);
    expect((err as Error).message).toContain("all of them in ios-xtool/.precheck/precheck.log");
    expect(h.logs).toEqual([
      expect.stringMatching(
        /^✖ precheck — ios\/ObjcApp\/AppDelegate\.h:7 imports RCTAppDelegate\.h, which is in none of the App target's \d+ include folders \(listed in ios-xtool\/\.precheck\/precheck\.log\)$/,
      ),
    ]);
    expect(h.compiled).toEqual([]);
    const log = readFileSync(path.join(h.dir, "precheck.log"), "utf8");
    expect(log).toContain(path.join(paths.root, "ios", "build", "xcframeworks", "React", "include"));
  });

  it("leaves a miss under a graph target to the compile", async () => {
    const { paths, app } = handApp({ "Native.m": "#import <ReactCodegen/RCTModuleProviders.h>\n#import <UIKit/UIKit.h>\n" });
    const h = harness(paths, app);
    const codegen: FakePackage = { name: "React-GeneratedCode", path: path.join(paths.root, "ios", "build", "generated", "ios"), targets: [{ name: "ReactCodegen", headers: {} }] };
    await h.run({ packages: [reactNative(paths.root), codegen] });
    expect(h.logs).toEqual([
      "⚠ precheck — ios/App/Native.m:1 imports ReactCodegen/RCTModuleProviders.h, which rn-xtool did not find; ReactCodegen is a target of the package, so the compile decides",
    ]);
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual(["clang Native.m"]);
  });

  it("skips Swift that imports a module SwiftPM builds", async () => {
    const { paths, app } = handApp({
      "AppDelegate.swift": "import UIKit\n@preconcurrency import Expo\n",
      "Bridge.m": '#import "Bridge.h"\n',
      "Bridge.h": '#import "App-Swift.h"\n',
      "Plain.m": "#import <UIKit/UIKit.h>\n",
    });
    const h = harness(paths, app);
    await h.run();
    expect(h.logs).toEqual([
      "ℹ precheck — ios/App/AppDelegate.swift imports Expo, which SwiftPM builds: checked by xtool-build",
      "ℹ precheck — ios/App/Bridge.m import App-Swift.h, which the Swift check did not write: checked by xtool-build",
    ]);
    expect(h.calls.filter((c) => !["describe", "show-dependencies", "dump-package"].includes(c))).toEqual(["clang Plain.m"]);
  });

  it("skips Swift that imports a mixed module of the graph", async () => {
    const { paths, app } = handApp({ "AppDelegate.swift": "import UIKit\nimport MixedLib\n", "Plain.m": "#import <UIKit/UIKit.h>\n" });
    const h = harness(paths, app);
    const mixed: FakePackage = { name: "MixedLib", path: path.join(paths.root, "mixed"), targets: [{ name: "MixedLib", headers: { "MixedLib.h": "" }, swift: true }] };
    await h.run({ packages: [reactNative(paths.root), mixed] });
    expect(h.logs).toEqual(["ℹ precheck — ios/App/AppDelegate.swift imports MixedLib, which SwiftPM builds: checked by xtool-build"]);
    expect(h.calls.filter((c) => c.startsWith("swiftc") || c.startsWith("clang"))).toEqual(["clang Plain.m"]);
  });

  it("skips a C-family file that imports a Swift-built module or one no map declares", async () => {
    const { paths, app } = handApp({
      "A.m": "@import MixedLib;\n",
      "X.m": '#import "Bridge.h"\n',
      "Bridge.h": "@import Nowhere.Sub;\n",
      "Also.m": "@import Nowhere;\n",
      "Sdk.m": "@import UIKit;\n@import React;\n",
    });
    const h = harness(paths, app);
    const mixed: FakePackage = { name: "MixedLib", path: path.join(paths.root, "mixed"), targets: [{ name: "MixedLib", headers: { "MixedLib.h": "" }, swift: true }] };
    await h.run({ packages: [reactNative(paths.root), mixed] });
    expect(h.logs).toEqual([
      "ℹ precheck — ios/App/A.m imports the module MixedLib, which SwiftPM builds; checked by xtool-build",
      "ℹ precheck — ios/App/X.m imports the module Nowhere, which SwiftPM builds; checked by xtool-build",
    ]);
    // An SDK framework and a module of the graph's maps compile; every skipped file is in the log.
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual(["clang Sdk.m"]);
    expect(readFileSync(path.join(h.dir, "precheck.log"), "utf8")).toContain(
      `# not compiled, imports the module Nowhere: ${path.join(paths.sources, "X.m")} ${path.join(paths.sources, "Also.m")}`,
    );
  });

  it("skips Swift when its bridging header imports a Swift-built module", async () => {
    const { paths, app } = handApp(
      { "AppDelegate.swift": "import UIKit\n", "Bridging.h": "@import MixedLib;\n" },
      { mixed: false, bridgingHeader: "Bridging.h" },
    );
    const h = harness(paths, app);
    const mixed: FakePackage = { name: "MixedLib", path: path.join(paths.root, "mixed"), targets: [{ name: "MixedLib", headers: { "MixedLib.h": "" }, swift: true }] };
    await h.run({ packages: [reactNative(paths.root), mixed] });
    expect(h.logs).toEqual([
      "ℹ precheck — ios/App/Bridging.h imports the module MixedLib, which SwiftPM builds; checked by xtool-build",
      "ℹ precheck — ios/App/AppDelegate.swift imports MixedLib, which SwiftPM builds: checked by xtool-build",
    ]);
    expect(h.compiled).toEqual([]);
  });

  it("runs no swiftc for a target without Swift files", async () => {
    const { paths, app } = await generated(objcApp("template"));
    const h = harness(paths, app);
    await h.run({ packages: [reactNative(paths.root, { "RCTAppDelegate.h": "@interface RCTAppDelegate\n@end\n" })] });
    expect(h.logs).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("swiftc"))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("clang")).sort()).toEqual(["clang AppDelegate.mm", "clang AppMain.m"]);
  });

  it("runs no clang for a Swift-only target", async () => {
    const root = tempRoot();
    cpSync(path.join(import.meta.dirname, "fixtures", "bare"), root, { recursive: true });
    write(path.join(root, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.88.1" }));
    const { paths, app } = await generated(root);
    expect(app.pkg.app.bridgingHeader).toBeUndefined();
    const h = harness(paths, app);
    // The template's imports: React, React_RCTAppDelegate and ReactAppDependencyProvider are modules of the graph.
    const rn = reactNative(paths.root);
    rn.targets.push({ name: "React_RCTAppDelegate", headers: {} }, { name: "ReactAppDependencyProvider", headers: {} });
    await h.run({ packages: [rn] });
    expect(h.logs).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("swiftc"))).toEqual(["swiftc SceneDelegate.swift"]);
  });

  it("retries once without a stale module cache", async () => {
    const { paths, app } = handApp({ "Native.m": "#import <UIKit/UIKit.h>\n" });
    const cache = path.join(paths.iosXtool, ".precheck", "ModuleCache", moduleCacheKey("0.88.1", fakeToolchain(paths.root).versions));
    const stale = "fatal error: module file '/c/UIKit.pcm' is out of date and needs to be rebuilt";
    const seen: boolean[] = [];
    const h = harness(paths, app, (_tool, _file, n) => {
      seen.push(existsSync(cache));
      if (n === 0) {
        mkdirSync(cache, { recursive: true });
        return { code: 1, output: `${stale}\n1 error generated.\n` };
      }
      return undefined;
    });
    await h.run();
    expect(seen).toEqual([false, false]);
    expect(h.logs).toEqual([`ℹ precheck — the module cache was stale (${stale}); checked again without it`]);
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual(["clang Native.m", "clang Native.m"]);
  });

  it("prints errors only and names the log", async () => {
    const { paths, app } = handApp({ "Native.m": "#import <UIKit/UIKit.h>\n" });
    const file = path.join(paths.sources, "Native.m");
    const output = [
      `${file}:3:1: warning: unused variable 'x' [-Wunused-variable]`,
      `${file}:5:2: error: use of undeclared identifier 'y'`,
      `${file}:7:2: error: expected ';' after expression`,
      "1 warning and 2 errors generated.",
    ].join("\n");
    const h = harness(paths, app, () => ({ code: 1, output }));
    const err = await h.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrecheckError);
    expect((err as Error).message).toMatch(/^precheck: 2 error\(s\) .* all of them in ios-xtool\/\.precheck\/precheck\.log\)/);
    expect(h.logs).toEqual([
      "✖ precheck — ios/App/Native.m:5: use of undeclared identifier 'y'",
      "✖ precheck — ios/App/Native.m:7: expected ';' after expression",
    ]);
    expect(readFileSync(path.join(paths.iosXtool, ".precheck", "precheck.log"), "utf8")).toContain("warning: unused variable 'x'");
  });

  it("empties the module cache on --clean", async () => {
    const { paths, app } = handApp({ "Native.m": "#import <UIKit/UIKit.h>\n" });
    const moduleCache = path.join(paths.iosXtool, ".precheck", "ModuleCache");
    const current = path.join(moduleCache, moduleCacheKey("0.88.1", fakeToolchain(paths.root).versions));
    const other = path.join(moduleCache, "rn0.88.0-000000000000");
    const fake = fakeToolchain(paths.root);
    const runWith = async (clean: boolean) => {
      for (const d of [current, other]) mkdirSync(d, { recursive: true });
      let atToolchain = true;
      await harness(paths, app).run({
        clean,
        deps: {
          toolchain: async () => {
            atToolchain = existsSync(moduleCache);
            return fake;
          },
        },
      });
      return atToolchain;
    };
    expect(await runWith(true)).toBe(false);
    // Without --clean the current key's cache stays; another key's goes.
    expect(await runWith(false)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it("names the dependencies the graph could not place, and goes on", async () => {
    const { paths, app } = handApp({ "Native.m": "#import <UIKit/UIKit.h>\n" });
    const h = harness(paths, app);
    const swift = fakeSwift(paths, [reactNative(paths.root)], []);
    await h.run({
      deps: {
        swift: async (args, opts) => {
          const r = await swift(args, opts);
          if (args[1] !== "dump-package" || args[args.indexOf("--package-path") + 1] !== paths.iosXtool) return r;
          const root = JSON.parse(r.stdout);
          root.targets[0].dependencies.push({ product: ["Gone", "Nowhere", null, null] });
          return { ...r, stdout: JSON.stringify(root) };
        },
      },
    });
    expect(h.logs).toEqual(["ℹ precheck — 1 dependencies of App could not be placed (Gone of Nowhere): checked by xtool-build"]);
    expect(h.calls).toEqual(["clang Native.m"]);
  });

  it("copies the module maps Swift Build wrote and drops the missing ones", async () => {
    const { paths, app } = handApp({ "Bridging.h": "#import <UIKit/UIKit.h>\n", "AppDelegate.swift": "import Expo\n" }, { mixed: false, bridgingHeader: "Bridging.h" });
    const built = swiftHeadersDir(paths.iosXtool);
    write(path.join(built, "ExpoModulesCore.modulemap"), "module ExpoModulesCore {}\n");
    app.pkg.expo = {
      compileInterfacesDir: path.join(paths.expoDir, "compile-interfaces"),
      jsiHeaders: true,
      clangImporter: {
        swiftHeadersDir: built,
        includeDirs: [],
        moduleMaps: [path.join(built, "ExpoModulesCore.modulemap"), path.join(built, "ExpoCamera.modulemap")],
      },
    };
    const h = harness(paths, app);
    await h.run();
    const dir = path.join(paths.iosXtool, ".precheck", "swift-headers");
    expect(h.logs).toEqual([
      "ℹ precheck — ios/App/AppDelegate.swift imports Expo, which SwiftPM builds: checked by xtool-build",
      "ℹ precheck — 1 module maps Swift Build writes are not there yet: files that need them are checked by xtool-build",
    ]);
    // The bridging header of a skipped Swift check is compiled by clang alone, with the copied map only.
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual(["clang Bridging.h"]);
    const maps = h.compiled[0]!.args.filter((a) => a.startsWith("-fmodule-map-file="));
    expect(maps).toContain(`-fmodule-map-file=${path.join(dir, "ExpoModulesCore.modulemap")}`);
    expect(maps.some((m) => m.includes("ExpoCamera"))).toBe(false);
    expect(readFileSync(path.join(dir, "ExpoModulesCore.modulemap"), "utf8")).toBe("module ExpoModulesCore {}\n");
  });

  it("keeps the copied module maps' headers where Swift Build wrote them", async () => {
    const { paths, app } = handApp({ "X.m": "#import <UIKit/UIKit.h>\n" });
    const built = swiftHeadersDir(paths.iosXtool);
    const maps = {
      ExpoUI: path.join(built, "ExpoUI.modulemap"),
      Folder: path.join(built, "Nested", "Folder.modulemap"),
      AppUse: path.join(built, "AppUse.modulemap"),
    };
    write(path.join(built, "ExpoUI-Swift.h"), "// ExpoUI\n");
    write(maps.ExpoUI, 'module ExpoUI {\n  header "ExpoUI-Swift.h"\n  requires objc\n}\n');
    write(
      maps.Folder,
      'module Folder [system] {\n  umbrella "."\n  private header "../Priv.h"\n  textual header "T.h"\n  exclude header "E.h"\n' +
        '  umbrella header "/abs/Folder.h"\n  extern module Ext "ext.modulemap"\n  link "Folder"\n  module * { export * }\n}\n',
    );
    write(maps.AppUse, 'module AppUse {\n  header "App-Swift.h"\n}\n');
    app.pkg.expo = {
      compileInterfacesDir: path.join(paths.expoDir, "compile-interfaces"),
      jsiHeaders: true,
      clangImporter: { swiftHeadersDir: built, includeDirs: [], moduleMaps: Object.values(maps) },
    };
    await harness(paths, app).run();
    const copies = path.join(paths.iosXtool, ".precheck", "swift-headers");
    const copy = (rel: string) => readFileSync(path.join(copies, rel), "utf8");
    // A relative header names Swift Build's file, which the copy's folder does not hold.
    expect(copy("ExpoUI.modulemap")).toBe(`module ExpoUI {\n  header "${path.join(built, "ExpoUI-Swift.h")}"\n  requires objc\n}\n`);
    expect(existsSync(path.join(built, "ExpoUI-Swift.h"))).toBe(true);
    // Every path form is rewritten against the map's own folder; absolute paths, `link` and the rest stay as they are.
    const nested = path.join(built, "Nested");
    expect(copy(path.join("Nested", "Folder.modulemap"))).toBe(
      `module Folder [system] {\n  umbrella "${nested}"\n  private header "${path.join(built, "Priv.h")}"\n` +
        `  textual header "${path.join(nested, "T.h")}"\n  exclude header "${path.join(nested, "E.h")}"\n` +
        `  umbrella header "/abs/Folder.h"\n  extern module Ext "${path.join(nested, "ext.modulemap")}"\n  link "Folder"\n` +
        "  module * { export * }\n}\n",
    );
    // The App's own Swift header is the one the precheck writes.
    expect(copy("AppUse.modulemap")).toBe(`module AppUse {\n  header "${path.join(copies, "App-Swift.h")}"\n}\n`);
  });

  it("names Swift Build's module map once it is there, the synthesized one before", async () => {
    const { paths, app } = handApp({ "X.m": "#import <UIKit/UIKit.h>\n" });
    const built = swiftHeadersDir(paths.iosXtool);
    app.pkg.expo = {
      compileInterfacesDir: path.join(paths.expoDir, "compile-interfaces"),
      jsiHeaders: true,
      clangImporter: { swiftHeadersDir: built, includeDirs: [], moduleMaps: [path.join(built, "React.modulemap")] },
    };
    const dir = path.join(paths.iosXtool, ".precheck");
    const synthesized = `-fmodule-map-file=${path.join(dir, "modulemaps", "React", "module.modulemap")}`;
    const copied = `-fmodule-map-file=${path.join(dir, "swift-headers", "React.modulemap")}`;
    const maps = (h: Harness) => h.compiled[0]!.args.filter((a) => a.startsWith("-fmodule-map-file="));

    const before = harness(paths, app);
    await before.run();
    expect(maps(before)).toEqual([synthesized]);

    write(path.join(built, "React.modulemap"), "module React {}\n");
    const after = harness(paths, app);
    await after.run();
    expect(maps(after)).toEqual([copied]);
  });

  it("leaves an angle miss to the compile when clang's own headers cannot be found", async () => {
    const { paths, app } = await generated(objcApp("template"));
    const h = harness(paths, app);
    await h.run({ installedDir: false });
    expect(h.logs).toEqual([
      "⚠ precheck — ios/ObjcApp/AppDelegate.h:7 imports RCTAppDelegate.h, which rn-xtool did not find; the compile decides",
    ]);
    expect(h.calls.filter((c) => c.startsWith("clang")).sort()).toEqual(["clang AppDelegate.mm", "clang AppMain.m"]);
  });

  it("leaves a file that imports a module whose map is not there yet to xtool-build", async () => {
    const { paths, app } = handApp({ "X.m": '#import "Bridge.h"\n', "Bridge.h": "@import Expo;\n", "Y.m": "#import <UIKit/UIKit.h>\n" });
    const built = swiftHeadersDir(paths.iosXtool);
    app.pkg.expo = {
      compileInterfacesDir: path.join(paths.expoDir, "compile-interfaces"),
      jsiHeaders: true,
      clangImporter: { swiftHeadersDir: built, includeDirs: [], moduleMaps: [path.join(built, "Expo.modulemap")] },
    };
    const h = harness(paths, app);
    await h.run();
    expect(h.logs).toEqual([
      "ℹ precheck — 1 module maps Swift Build writes are not there yet: ios/App/X.m are checked by xtool-build",
    ]);
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual(["clang Y.m"]);
    expect(h.compiled[0]!.args.some((a) => a.includes("Expo.modulemap"))).toBe(false);
  });

  it("leaves Swift to xtool-build when its bridging header waits for a module map", async () => {
    const { paths, app } = handApp(
      { "AppDelegate.swift": "import UIKit\n", "Bridging.h": "@import Expo;\n" },
      { mixed: false, bridgingHeader: "Bridging.h" },
    );
    const built = swiftHeadersDir(paths.iosXtool);
    app.pkg.expo = {
      compileInterfacesDir: path.join(paths.expoDir, "compile-interfaces"),
      jsiHeaders: true,
      clangImporter: { swiftHeadersDir: built, includeDirs: [], moduleMaps: [path.join(built, "Expo.modulemap")] },
    };
    const h = harness(paths, app);
    await h.run();
    expect(h.logs).toEqual([
      "ℹ precheck — 1 module maps Swift Build writes are not there yet: ios/App/Bridging.h, ios/App/AppDelegate.swift are checked by xtool-build",
    ]);
    expect(h.compiled).toEqual([]);
  });

  it("does not stop on a header nothing compiles", async () => {
    const { paths, app } = handApp({ "Native.m": "#import <UIKit/UIKit.h>\n", "Orphan.h": '#import "Nope.h"\n' });
    const h = harness(paths, app);
    await h.run();
    expect(h.logs).toEqual([
      "⚠ precheck — ios/App/Orphan.h:1 imports Nope.h, which nothing compiles; checked by xtool-build if it is ever included",
    ]);
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual(["clang Native.m"]);
  });

  it("does not stop on a header only an uncertain condition includes", async () => {
    const { paths, app } = handApp({
      "Native.m": '#if __has_include(<Missing/Missing.h>)\n#import "Opt.h"\n#endif\n#import <UIKit/UIKit.h>\n',
      "Opt.h": "#import <Missing/Missing.h>\n",
    });
    const h = harness(paths, app);
    await h.run();
    expect(h.logs).toEqual([
      "⚠ precheck — ios/App/Opt.h:1 imports Missing/Missing.h, which only a condition the precheck cannot evaluate includes; the compile decides",
    ]);
    expect(h.calls.filter((c) => c.startsWith("clang"))).toEqual(["clang Native.m"]);
  });

  it("names a compiler that fails without a diagnostic", async () => {
    const { paths, app } = handApp({ "Native.m": "#import <UIKit/UIKit.h>\n" });
    const lines = Array.from({ length: 25 }, (_, n) => `line ${n + 1}`);
    const h = harness(paths, app, () => ({ code: 139, output: lines.join("\n") }));
    await expect(h.run()).rejects.toThrow(/^precheck: 1 error\(s\)/);
    expect(h.logs).toEqual([
      "✖ precheck — ios/App/Native.m: compiler exited 139 without a diagnostic rn-xtool could read",
      ...lines.slice(5).map((l) => `  ${l}`),
    ]);
  });
});
