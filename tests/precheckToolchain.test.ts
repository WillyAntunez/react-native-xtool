/**
 * The precheck with the real `clang` and `swiftc` and the Darwin SDK, on a tiny App target built from SDK headers only
 * (SwiftPM's answers are faked: the target depends on no package).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sdkBundle } from "../src/commands/setup.js";
import type { GeneratedApp } from "../src/generate/iosXtool.js";
import { projectPaths, swiftHeadersDir, type ProjectPaths } from "../src/paths.js";
import { runPrecheck, type PrecheckDeps } from "../src/pipeline/precheck.js";
import type { SwiftRunner } from "../src/pipeline/precheckGraph.js";
import { PrecheckError } from "../src/pipeline/precheckReport.js";
import { toolEnv } from "../src/tools/exec.js";
import { SWIFT_TEST_TIMEOUT_MS, tool } from "./support/tools.js";

const IOS_SDK = path.join(sdkBundle(), "Developer", "Platforms", "iPhoneOS.platform", "Developer", "SDKs", "iPhoneOS.sdk");
const HAS_IOS_TOOLS = existsSync(IOS_SDK) && tool("clang", ["--version"], { env: toolEnv() }).status === 0;

/** SwiftPM's answers for a package whose App target depends on nothing. */
const swift: SwiftRunner = async (args) => {
  const json = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
  if (args[1] === "describe") return json({ name: "AppXtool", targets: [{ name: "App", type: "library" }] });
  if (args[1] === "show-dependencies") return json({ name: "appxtool", dependencies: [] });
  return json({
    name: "AppXtool",
    dependencies: [],
    products: [{ name: "App", targets: ["App"] }],
    targets: [{ name: "App", type: "regular", path: "Sources/App", dependencies: [] }],
  });
};

/** The compile as the precheck runs it, for a test that changes its command line. */
const compile: PrecheckDeps["compile"] = async (cmd, args, o) => {
  const r = await execa(cmd, args, { cwd: o.cwd, env: o.env, extendEnv: false, reject: false, all: true });
  return { code: r.exitCode ?? 1, output: r.all ?? "" };
};

/** A C++20 header: a `requires` clause, as React Native's headers have (F4). */
const CXX20 = "template <typename T>\n  requires(sizeof(T) > 0)\nstruct Sized {};\n";
/** A header that imports a module, as F5's library header does. */
const AT_IMPORT = "@import Foundation;\n";

describe.skipIf(!HAS_IOS_TOOLS)(
  `the precheck on the real toolchain${HAS_IOS_TOOLS ? "" : " (needs the Darwin SDK and the Swift toolchain's clang: rn-xtool setup)"}`,
  () => {
    let root = "";
    let paths: ProjectPaths;
    beforeAll(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), "xt-precheck-real-")));
      paths = projectPaths(root);
    });
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    /** The App target with `files` (relative to ios/App) copied into Sources/App; the run's terminal lines in `logs`. */
    async function precheck(files: Record<string, string>, deps: Partial<PrecheckDeps> = {}): Promise<{ logs: string[]; error?: unknown }> {
      rmSync(paths.sources, { recursive: true, force: true });
      const origins: Record<string, string> = {};
      for (const [rel, text] of Object.entries(files)) {
        for (const file of [path.join(root, "ios", "App", rel), path.join(paths.sources, rel)]) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, text);
        }
        origins[path.join(paths.sources, rel)] = path.join(root, "ios", "App", rel);
      }
      const app: GeneratedApp = {
        pkg: {
          iosDir: paths.ios,
          frameworks: [],
          iosMin: "16.4",
          app: { mixed: true, defines: [], headerSearchPaths: [], swiftHeadersDir: swiftHeadersDir(paths.iosXtool) },
        },
        origins,
      };
      const logs: string[] = [];
      const opts = { root, rnVersion: "0.88.1", clean: false, log: (s: string) => logs.push(s) };
      try {
        await runPrecheck(paths, app, opts, { swift, ...deps });
        return { logs };
      } catch (error) {
        return { logs, error };
      }
    }

    it(
      "F4: an Objective-C++ file that needs C++20 fails without the manifest's -std and passes with it",
      async () => {
        const files = { "Sized.h": CXX20, "Uses.mm": '#import <Foundation/Foundation.h>\n#import "Sized.h"\n' };
        // Swift Build's F4: the target's C++ standard not applied, clang's default instead.
        const withoutStd = await precheck(files, { compile: (cmd, args, o) => compile(cmd, args.filter((a) => !a.startsWith("-std=")), o) });
        expect(withoutStd.error).toBeInstanceOf(PrecheckError);
        expect(withoutStd.logs[0]).toMatch(/^✖ precheck — ios\/App\/Sized\.h:2: /);
        expect(withoutStd.logs[1]).toBe("  In file included from ios/App/Uses.mm:2:");

        const withStd = await precheck(files);
        expect(withStd.error).toBeUndefined();
        expect(withStd.logs).toEqual([]);
      },
      SWIFT_TEST_TIMEOUT_MS,
    );

    it(
      "F5: an @import in a header a .mm includes fails as in Swift Build",
      async () => {
        const { logs, error } = await precheck({ "Mod.h": AT_IMPORT, "Uses.mm": '#import "Mod.h"\n' });
        expect(error).toBeInstanceOf(PrecheckError);
        expect(logs).toEqual([
          expect.stringMatching(/^✖ precheck — ios\/App\/Mod\.h:1: use of '@import' when modules are disabled/),
          "  In file included from ios/App/Uses.mm:1:",
        ]);
        expect(readFileSync(path.join(paths.iosXtool, ".precheck", "precheck.log"), "utf8")).toContain("-fno-cxx-modules");
      },
      SWIFT_TEST_TIMEOUT_MS,
    );

    it(
      "writes App-Swift.h from swiftc -typecheck",
      async () => {
        const { logs, error } = await precheck({
          "Greeter.swift": "import Foundation\n\n@objc public class Greeter: NSObject {\n  @objc public func hello() -> String { \"hi\" }\n}\n",
          "Uses.m": '#import <Foundation/Foundation.h>\n#import "App-Swift.h"\n\nstatic NSString *greet(void) { return [[Greeter new] hello]; }\n',
        });
        expect(error).toBeUndefined();
        expect(logs).toEqual([]);
        const header = path.join(paths.iosXtool, ".precheck", "swift-headers", "App-Swift.h");
        expect(readFileSync(header, "utf8")).toContain("@interface Greeter");
        // swiftc's temporary folders went with the run's TMPDIR.
        expect(existsSync(path.join(paths.iosXtool, ".precheck", "tmp"))).toBe(false);
      },
      SWIFT_TEST_TIMEOUT_MS,
    );
  },
);
