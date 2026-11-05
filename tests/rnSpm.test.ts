import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { streamingRunner } from "../src/pipeline/rnSpm.js";
import {
  AUTOLINKING_CONFIG_COMMAND,
  binaryInPatch,
  configCommandFor,
  parseMissingPackageSwift,
  persistScaffoldArgv,
  rnSpmArgs,
  rnSpmEnv,
  rnSpmGenerateArgs,
  vendoredExpoPlugin,
  vendoredScriptsRoot,
  rnSpmScaffoldArgs,
  runRnSpm,
  type RnRunner,
} from "../src/pipeline/rnSpm.js";
import { projectPaths, swiftHeadersEnv, type ProjectPaths } from "../src/paths.js";
import { packageRoot } from "../src/tools/exec.js";
import { mergedPodTable, type PodTable } from "../src/project/podTable.js";
import path from "node:path";

const RESULTS = "/proj/ios/build/rn-xtool-scaffold-results.json";
const paths = { root: "/proj", ios: "/proj/ios", iosXtool: "/proj/ios-xtool", scaffoldResults: RESULTS } as unknown as ProjectPaths;
const SWIFT_HEADERS = "/proj/ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos";
const POD_TABLE = "/proj/ios/build/rn-xtool-pods.json";
const rnDir = "/proj/node_modules/react-native";
const INST = { rnScripts: "installed" } as const;
const missing = (n: string) =>
  `error: Package.swift is missing for library "${n}" — it ships no Swift Package Manager support.`;

const mixed = (n: string) =>
  `error: "${n}" has mixed Swift + Objective-C/C++ sources, which Swift Package Manager cannot compile in a single target (and its Swift↔ObjC interop typically can't be split into two targets without a circular dependency).`;

const noPodspec = (n: string) =>
  `error: Package.swift is missing for library "${n}", and it ships no podspec so it cannot be scaffolded automatically.`;

function harness(results: { exitCode: number; output: string }[]) {
  const calls: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const logs: string[] = [];
  const runner: RnRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, ...(o.env ? { env: o.env } : {}) });
    return results.shift() ?? { exitCode: 0, output: "" };
  };
  const tables: PodTable[] = [];
  const writePodTable = (_p: ProjectPaths, table: PodTable) => {
    tables.push(table);
    return POD_TABLE;
  };
  return {
    calls,
    logs,
    tables,
    deps: { runner, log: (s: string) => logs.push(s), rnDir, writePodTable },
  };
}

describe("parseMissingPackageSwift", () => {
  it("dedupes and ignores other lines", () => {
    const out = [
      missing("a"),
      "noise",
      missing("b"),
      missing("a"),
      'error: other "x"',
    ].join("\n");
    expect(parseMissingPackageSwift(out)).toEqual(["a", "b"]);
  });
  it("includes libraries RN reports as mixed Swift + Objective-C", () => {
    const out = [missing("a"), mixed("pager"), mixed("pager")].join("\n");
    expect(parseMissingPackageSwift(out)).toEqual(["a", "pager"]);
  });
  it("skips the 'ships no podspec' variant", () => {
    const out = [missing("a"), noPodspec("np")].join("\n");
    expect(parseMissingPackageSwift(out)).toEqual(["a"]);
  });
});

describe("argv helpers", () => {
  it("passes --yes to add/update", () => {
    expect(rnSpmArgs(paths, {}, rnDir)).toContain("--yes");
  });
  it("persistScaffoldArgv uses the project patches dir", () => {
    const [, args] = persistScaffoldArgv("lib");
    expect(args.slice(1, 4)).toEqual(["lib", "--patch-dir", "patches"]);
  });
  it("persistScaffoldArgv excludes build artifacts and package.json", () => {
    const [, args] = persistScaffoldArgv("lib");
    const re = new RegExp(args[args.indexOf("--exclude") + 1]!);
    expect(re.test("ios/Foo/.build/.lock")).toBe(true);
    expect(re.test(".build/CACHEDIR.TAG")).toBe(true);
    expect(re.test("package.json")).toBe(true);
    expect(re.test("ios/Package.swift")).toBe(false);
    expect(re.test("src/package.json.ts")).toBe(false);
  });
});

describe("rnSpmGenerateArgs", () => {
  it("rnSpmGenerateArgs points at the driver with the artifacts flags", () => {
    const a = rnSpmGenerateArgs(paths, INST, rnDir);
    expect(a[0]).toBe(path.join(packageRoot(), "scripts", "rn-spm-generate.js"));
    expect(a.slice(1)).toEqual(["--rn-dir", rnDir, "--app-root", "/proj", "--scripts-root", path.join(rnDir, "scripts")]);
    expect(a).not.toContain("--artifacts");
    expect(rnSpmGenerateArgs(paths, { rnArtifactsDir: "/art", rnScripts: "installed" }, rnDir).slice(1)).toEqual([
      "--rn-dir",
      rnDir,
      "--app-root",
      "/proj",
      "--scripts-root",
      path.join(rnDir, "scripts"),
      "--artifacts",
      "/art",
    ]);
  });
});

describe("scripts root", () => {
  it("rnSpmGenerateArgs points at the installed scripts for 0.88.0 and the vendored copy otherwise", () => {
    const at = (a: string[]) => a[a.indexOf("--scripts-root") + 1];
    expect(at(rnSpmGenerateArgs(paths, { rnScripts: "installed" }, rnDir))).toBe(path.join(rnDir, "scripts"));
    expect(at(rnSpmGenerateArgs(paths, { rnScripts: "vendored" }, rnDir))).toBe(
      path.join(packageRoot(), "vendor", "rn-spm"),
    );
    expect(vendoredScriptsRoot()).toBe(path.join(packageRoot(), "vendor", "rn-spm"));
  });

  it("the scaffold run keeps --scripts-root and --artifacts", async () => {
    const h = harness([
      { exitCode: 2, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "bare", rnScripts: "vendored", rnArtifactsDir: "/art", expoPlugin: "installed" }, h.deps);
    for (const i of [0, 1, 3]) {
      const a = h.calls[i]!.args;
      expect(a[a.indexOf("--scripts-root") + 1]).toBe(vendoredScriptsRoot());
      expect(a[a.indexOf("--artifacts") + 1]).toBe("/art");
    }
    expect(h.calls[1]!.args).toContain("--scaffold");
  });

  it("refuses vendored scripts with the installed plugin", async () => {
    const h = harness([{ exitCode: 0, output: "" }]);
    await expect(
      runRnSpm(paths, { kind: "expo", rnScripts: "vendored", expoPlugin: "installed" }, h.deps),
    ).rejects.toThrow(
      `runRnSpm: Expo projects on vendored SwiftPM scripts need the vendored Expo plugin, got expoPlugin "installed"`,
    );
    expect(h.calls).toEqual([]);
  });

  it.each(["expo", "bare"] as const)("refuses the vendored plugin with the installed scripts (%s)", async (kind) => {
    // Only the vendored scripts read RN_SPM_EXPO_PLUGIN: React Native's own would leave every Expo module unlinked.
    const h = harness([{ exitCode: 0, output: "" }]);
    await expect(runRnSpm(paths, { kind, rnScripts: "installed", expoPlugin: "vendored" }, h.deps)).rejects.toThrow(
      'runRnSpm: the vendored Expo plugin needs the vendored SwiftPM scripts, got rnScripts "installed"',
    );
    expect(h.calls).toEqual([]);
  });
});

describe("Expo on the driver", () => {
  const DRIVER = path.join(packageRoot(), "scripts", "rn-spm-generate.js");
  const full = projectPaths("/proj");

  it("vendoredExpoPlugin is the vendored Expo 58 plugin", () => {
    expect(vendoredExpoPlugin()).toBe(path.join(packageRoot(), "vendor", "expo-spm", "spm", "plugin.js"));
  });

  it("Expo 57 runs the driver with the vendored plugin", async () => {
    const h = harness([
      { exitCode: 2, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(
      full,
      { kind: "expo", rnScripts: "vendored", expoPlugin: "vendored", rnArtifactsDir: "/a/0.86.3" },
      h.deps,
    );
    const generate = [
      DRIVER,
      "--rn-dir",
      rnDir,
      "--app-root",
      "/proj",
      "--scripts-root",
      vendoredScriptsRoot(),
      "--config-command",
      JSON.stringify(AUTOLINKING_CONFIG_COMMAND),
      "--expo-plugin",
      vendoredExpoPlugin(),
      "--artifacts",
      "/a/0.86.3",
    ];
    const env = {
      RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS,
      EXPO_PRECOMPILED_MODULES_PATH: "/proj/ios/build/expo-precompiled",
      RN_SPM_POD_TABLE: POD_TABLE,
    };
    expect(h.calls).toEqual([
      { cmd: "node", args: generate, cwd: "/proj/ios", env },
      { cmd: "node", args: [...generate, "--scaffold", "--results", RESULTS, "--only", "lib-a"], cwd: "/proj/ios", env },
      { cmd: persistScaffoldArgv("lib-a")[0], args: persistScaffoldArgv("lib-a")[1], cwd: "/proj" },
      { cmd: "node", args: generate, cwd: "/proj/ios", env },
    ]);
    expect(rnSpmEnv(full, "vendored", POD_TABLE)).toEqual(env);
  });

  it("keeps Expo 58's add|update argv and env, and scaffolds through the driver", async () => {
    const setup = `${rnDir}/scripts/setup-apple-spm.js`;
    const cfg = '["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]';
    const offline = ["--download", "skip", "--artifacts", "/art"];
    const env = { RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS, RN_SPM_POD_TABLE: POD_TABLE };
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(full, { kind: "expo", rnScripts: "installed", expoPlugin: "installed", rnArtifactsDir: "/art" }, h.deps);
    expect(h.calls).toEqual([
      { cmd: "node", args: [setup, "add", "--config-command", cfg, "--yes", ...offline], cwd: "/proj/ios", env },
      {
        cmd: "node",
        args: [
          DRIVER,
          "--rn-dir",
          rnDir,
          "--app-root",
          "/proj",
          "--scripts-root",
          `${rnDir}/scripts`,
          "--config-command",
          cfg,
          "--artifacts",
          "/art",
          "--scaffold",
          "--results",
          RESULTS,
          "--only",
          "lib-a",
        ],
        cwd: "/proj/ios",
        env,
      },
      { cmd: persistScaffoldArgv("lib-a")[0], args: persistScaffoldArgv("lib-a")[1], cwd: "/proj" },
      { cmd: "node", args: [setup, "add", "--config-command", cfg, "--yes", ...offline], cwd: "/proj/ios", env },
    ]);
    expect(rnSpmEnv(full, "installed")).toEqual(swiftHeadersEnv(full.iosXtool));
    expect(rnSpmEnv(full, "installed", POD_TABLE)).toEqual({ ...swiftHeadersEnv(full.iosXtool), RN_SPM_POD_TABLE: POD_TABLE });

    const bare = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(full, { kind: "bare", rnScripts: "vendored", expoPlugin: "installed", rnArtifactsDir: "/art" }, bare.deps);
    expect(bare.calls).toEqual([
      {
        cmd: "node",
        args: [DRIVER, "--rn-dir", rnDir, "--app-root", "/proj", "--scripts-root", vendoredScriptsRoot(), "--artifacts", "/art"],
        cwd: "/proj/ios",
        env,
      },
    ]);
  });
});

describe("runRnSpm", () => {
  it("runRnSpm uses the generate driver for bare and setup-apple-spm for expo", async () => {
    const bare = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "bare", rnScripts: "installed", expoPlugin: "installed" }, bare.deps);
    expect(bare.calls).toEqual([
      {
        cmd: "node",
        args: rnSpmGenerateArgs(paths, INST, rnDir),
        cwd: "/proj/ios",
        env: { RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS, RN_SPM_POD_TABLE: POD_TABLE },
      },
    ]);
    const expo = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, expo.deps);
    expect(expo.calls[0]!.args).toEqual(rnSpmArgs(paths, {}, rnDir));
  });

  it("refuses to run without the project kind (never `add --yes` by default)", async () => {
    const h = harness([{ exitCode: 0, output: "" }]);
    await expect(runRnSpm(paths, {} as never, h.deps)).rejects.toThrow(/project kind/);
    expect(h.calls).toEqual([]);
  });

  it("scaffolds bare libraries through the driver, then retries the generate call", async () => {
    const h = harness([
      { exitCode: 2, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "bare", rnArtifactsDir: "/art", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    const generate = rnSpmGenerateArgs(paths, { rnArtifactsDir: "/art", rnScripts: "installed" }, rnDir);
    expect(h.calls.map((c) => c.args)).toEqual([
      generate,
      [...generate, "--scaffold", "--results", RESULTS, "--only", "lib-a"],
      persistScaffoldArgv("lib-a")[1],
      generate,
    ]);
    expect(rnSpmScaffoldArgs(paths, { rnArtifactsDir: "/art", rnScripts: "installed", kind: "bare" }, ["lib-a"], rnDir)).toEqual([
      ...generate,
      "--scaffold",
      "--results",
      RESULTS,
      "--only",
      "lib-a",
    ]);
    for (const c of [h.calls[0]!, h.calls[1]!, h.calls[3]!]) {
      expect(c.cwd).toBe("/proj/ios");
      expect(c.env).toEqual({ RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS, RN_SPM_POD_TABLE: POD_TABLE });
    }
  });

  it("scaffolds only the libraries RN names", async () => {
    const h = harness([
      { exitCode: 2, output: `${missing("lib-a")}\nnoise\n${mixed("lib-b")}` },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "bare", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    expect(h.calls[1]!.args.slice(-7)).toEqual(["--scaffold", "--results", RESULTS, "--only", "lib-a", "--only", "lib-b"]);
    expect(h.calls[1]!.args.filter((a) => a === "--only")).toHaveLength(2);
  });

  it("scaffolds Expo 58 through the driver with the Expo config command", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    expect(h.calls.map((c) => c.args)).toEqual([
      rnSpmArgs(paths, {}, rnDir),
      [
        path.join(packageRoot(), "scripts", "rn-spm-generate.js"),
        "--rn-dir",
        rnDir,
        "--app-root",
        "/proj",
        "--scripts-root",
        path.join(rnDir, "scripts"),
        "--config-command",
        '["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]',
        "--scaffold",
        "--results",
        RESULTS,
        "--only",
        "lib-a",
      ],
      persistScaffoldArgv("lib-a")[1],
      rnSpmArgs(paths, {}, rnDir),
    ]);
    expect(h.calls[0]!.args[1]).toBe("add");
    expect(h.calls.map((c) => c.args.join(" ")).join("\n")).not.toContain("--expo-plugin");
  });

  it("runs once on success", async () => {
    const h = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    expect(h.calls).toHaveLength(1);
  });

  it("scaffolds, persists each lib, then retries", async () => {
    const h = harness([
      { exitCode: 1, output: `${missing("lib-a")}\n${missing("lib-b")}` },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    expect(h.calls).toHaveLength(5);
    expect(h.calls[1]!.args.slice(-7)).toEqual(["--scaffold", "--results", RESULTS, "--only", "lib-a", "--only", "lib-b"]);
    expect(h.calls[1]!.cwd).toBe("/proj/ios");
    expect(h.calls[2]!.args.slice(1, 4)).toEqual(["lib-a", "--patch-dir", "patches"]);
    expect(h.calls[3]!.args.slice(1, 4)).toEqual(["lib-b", "--patch-dir", "patches"]);
    expect(h.calls[2]!.cwd).toBe("/proj");
    expect(h.calls[4]!.args[1]).toMatch(/add|update/);
    expect(h.logs[0]).toContain("lib-a, lib-b");
  });

  it("passes the generated Swift headers dir to every React Native run", async () => {
    const h = harness([
      { exitCode: 1, output: mixed("pager") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    const rnRuns = h.calls.filter((c) => c.cmd === "node");
    expect(rnRuns.map((c) => c.args[1])).toEqual([expect.stringMatching(/add|update/), "--rn-dir", expect.stringMatching(/add|update/)]);
    for (const c of rnRuns) expect(c.env).toEqual({ RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS, RN_SPM_POD_TABLE: POD_TABLE });
    expect(h.calls[1]!.args).toContain("--scaffold");
    expect(h.calls[2]!.args[1]).toBe("pager");
  });

  it("passes the pod table file to every React Native run", async () => {
    const pods = { AppAuth: { url: "https://github.com/example/AppAuth-iOS", exact: "2.1.0", products: ["AppAuth"] } };
    for (const opts of [
      { kind: "bare", rnScripts: "installed", expoPlugin: "installed" },
      { kind: "bare", rnScripts: "vendored", expoPlugin: "installed" },
      { kind: "expo", rnScripts: "vendored", expoPlugin: "vendored" },
      { kind: "expo", rnScripts: "installed", expoPlugin: "installed" },
    ] as const) {
      const h = harness([
        { exitCode: 1, output: missing("lib-a") },
        { exitCode: 0, output: "" },
        { exitCode: 0, output: "" },
        { exitCode: 0, output: "" },
      ]);
      await runRnSpm(paths, { ...opts, pods }, h.deps);
      const rnRuns = h.calls.filter((c) => c.cmd === "node");
      expect(rnRuns, opts.kind).toHaveLength(3);
      expect(rnRuns[1]!.args).toContain("--scaffold");
      for (const c of rnRuns) expect(c.env?.["RN_SPM_POD_TABLE"]).toBe(POD_TABLE);
      // The table is written once, before the first run: the config's entry over rn-xtool's own and the scaffolder's.
      expect(h.tables).toEqual([mergedPodTable(pods)]);
      expect(h.tables[0]!.pods["AppAuth"]).toEqual({ ...pods.AppAuth, forwardHeaders: { "AppAuth/AppAuth.h": ["AppAuthCore", "AppAuth"] } });
      expect(h.tables[0]!.source["AppAuth"]).toBe("config");
    }
    // Without a config entry, still the shipped table.
    const h = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "bare", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    expect(h.tables).toEqual([mergedPodTable()]);
    expect(h.calls[0]!.env?.["RN_SPM_POD_TABLE"]).toBe(POD_TABLE);
  });

  it("passes the binary pods to the scaffolder in the table file", async () => {
    const binary = { GoogleMLKit: { product: "GoogleMLKit" } };
    const h = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "bare", rnScripts: "vendored", expoPlugin: "installed", binary }, h.deps);
    expect(h.tables).toEqual([mergedPodTable(undefined, binary)]);
    expect(h.tables[0]!.binary).toEqual(binary);
  });

  it("forwards artifact flags to the scaffold run", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", rnArtifactsDir: "/art", expoPlugin: "installed" }, h.deps);
    expect(h.calls[1]!.args).toContain("--scaffold");
    expect(h.calls[1]!.args[h.calls[1]!.args.indexOf("--artifacts") + 1]).toBe("/art");
  });

  it("throws naming the libs when the retry fails", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 1, output: "boom" },
    ]);
    await expect(runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps)).rejects.toThrow(
      /lib-a[\s\S]*boom/,
    );
    expect(h.calls).toHaveLength(4);
  });

  it("warns and still retries when persisting fails", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 1, output: "\n**ERROR** no lockfile\nmore" },
      { exitCode: 0, output: "" },
    ]);
    await expect(runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps)).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(4);
    expect(h.logs).toContain(
      "⚠ Could not persist lib-a's Package.swift to patches/ (**ERROR** no lockfile). The build continues; it will be re-scaffolded on the next fresh install.",
    );
  });

  it("warns and continues when the persist command cannot spawn", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const results = [
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
    ];
    const runner: RnRunner = async (_c, args) => {
      calls.push(args);
      if (calls.length === 3) throw new Error("spawn ENOENT\nstack");
      return results.shift() ?? { exitCode: 0, output: "" };
    };
    await runRnSpm(
      paths,
      { kind: "expo", rnScripts: "installed", expoPlugin: "installed" },
      { runner, log: (s) => logs.push(s), rnDir, writePodTable: () => POD_TABLE },
    );
    expect(calls).toHaveLength(4);
    expect(logs.some((l) => l.startsWith("⚠") && l.includes("spawn ENOENT"))).toBe(true);
  });

  it("logs the filename patch-package reports", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "✔ Created file patches/lib-a+1.2.3.patch\n" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    // The fake writes no file: the guard cannot read it, so it does not say it persisted it.
    expect(h.logs).toContain("⚠ Did not persist lib-a's scaffold: rn-xtool could not read patches/lib-a+1.2.3.patch to check it for binary files");
  });

  it("falls back to the computed filename when patch-package prints none", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps);
    expect(h.logs).toContain("⚠ Did not persist lib-a's scaffold: rn-xtool could not read patches/lib-a+unknown.patch to check it for binary files");
  });

  it("throws RN's message without scaffolding when only no-podspec libs failed", async () => {
    const h = harness([{ exitCode: 1, output: noPodspec("np") }]);
    await expect(runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps)).rejects.toThrow(/ships no podspec/);
    expect(h.calls).toHaveLength(1);
  });

  it("scaffolds only the scaffoldable libs when both variants are reported", async () => {
    const h = harness([
      { exitCode: 1, output: `${noPodspec("np")}\n${missing("lib-a")}` },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 1, output: noPodspec("np") },
    ]);
    await expect(runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps)).rejects.toThrow(/lib-a/);
    expect(h.calls[2]!.args[1]).toBe("lib-a");
  });

  it("throws without scaffolding on unrelated failures", async () => {
    const h = harness([{ exitCode: 2, output: "something else" }]);
    await expect(runRnSpm(paths, { kind: "expo", rnScripts: "installed", expoPlugin: "installed" }, h.deps)).rejects.toThrow(/something else/);
    expect(h.calls).toHaveLength(1);
  });
});

describe("a failed scaffold comes first", () => {
  const tmp: string[] = [];
  afterAll(() => {
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });
  const BANNER = "// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit.\n// swift-tools-version: 6.0\n";
  const SIBLING = "react-native spm scaffold: no resolved Swift name for the sibling 'x'. Run the autolinker first.";

  /**
   * A project whose scaffold run writes `results` (each `root` under the project) and a banner Package.swift for each
   * library in `written`, as the driver would. React Native names every library in `results`, then those in `unseen`.
   */
  function project(
    results: { depName: string; status: string; reason?: string; warnings?: string[] }[],
    written: string[],
    unseen: string[] = [],
  ) {
    const root = mkdtempSync(path.join(tmpdir(), "rn-spm-outcome-"));
    tmp.push(root);
    const full = projectPaths(root);
    const calls: string[][] = [];
    const logs: string[] = [];
    const runner: RnRunner = async (_cmd, args) => {
      calls.push(args);
      if (calls.length === 1) {
        return { exitCode: 2, output: [...results.map((r) => r.depName), ...unseen].map((n) => missing(n)).join("\n") };
      }
      if (args.includes("--scaffold")) {
        const at = args.indexOf("--results");
        if (at < 0) throw new Error("the scaffold run has no --results");
        const file = args[at + 1]!;
        const rooted = results.map((r) => ({ ...r, root: path.join(root, "node_modules", r.depName) }));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ results: rooted }));
        for (const name of written) {
          mkdirSync(path.join(root, "node_modules", name), { recursive: true });
          writeFileSync(path.join(root, "node_modules", name, "Package.swift"), BANNER);
        }
      }
      return { exitCode: 0, output: "" };
    };
    const run = () =>
      runRnSpm(full, { kind: "bare", rnScripts: "vendored", expoPlugin: "installed" }, { runner, log: (l) => logs.push(l), rnDir });
    const persisted = () => calls.filter((a) => a[0] === persistScaffoldArgv("x")[1][0]).map((a) => a[1]);
    return { run, calls, logs, persisted, full };
  }

  it("stops on a library the scaffolder could not scaffold, with its reason first", async () => {
    const p = project(
      [
        { depName: "lib-a", status: "error", reason: SIBLING },
        { depName: "lib-b", status: "written" },
      ],
      ["lib-b"],
    );
    const err = await p.run().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message.startsWith("Scaffolding lib-a failed: react-native spm scaffold: no resolved Swift name")).toBe(true);
    expect(err?.message).toBe(`Scaffolding lib-a failed: ${SIBLING}`);
    expect(p.persisted()).toEqual(["lib-b"]);
    expect(p.calls.filter((a) => a[0]!.endsWith("rn-spm-generate.js"))).toHaveLength(2);
  });

  it("prints the failed library's warnings after its error", async () => {
    const p = project(
      [
        { depName: "lib-a", status: "error", reason: SIBLING, warnings: ["first warning", "second warning"] },
        { depName: "lib-c", status: "error", reason: "no podspec readable" },
      ],
      [],
    );
    await expect(p.run()).rejects.toThrow(
      `Scaffolding lib-a failed: ${SIBLING}\n  ! first warning\n  ! second warning\n\nScaffolding lib-c failed: no podspec readable`,
    );
  });

  it("a library without a scaffolded Package.swift afterwards failed too", async () => {
    const p = project(
      [
        { depName: "lib-a", status: "written" },
        { depName: "lib-b", status: "skipped-self-managed", reason: "Package.swift has no scaffolder marker." },
      ],
      [],
    );
    await expect(p.run()).rejects.toThrow(
      "Scaffolding lib-a failed: no Package.swift was written\n\nScaffolding lib-b failed: Package.swift has no scaffolder marker.",
    );
    expect(p.persisted()).toEqual([]);
  });

  it("says so when React Native names a library the scaffolder never saw", async () => {
    const p = project([{ depName: "lib-a", status: "written" }], ["lib-a"], ["lib-z"]);
    await expect(p.run()).rejects.toThrow(
      /^Scaffolding lib-z failed: the scaffolder did not find lib-z among the autolinked iOS libraries$/,
    );
    expect(p.persisted()).toEqual(["lib-a"]);
  });

  it("persists nothing for a failed library and never runs React Native again", async () => {
    const p = project([{ depName: "lib-a", status: "error", reason: SIBLING }], []);
    await expect(p.run()).rejects.toThrow(`Scaffolding lib-a failed: ${SIBLING}`);
    expect(p.persisted()).toEqual([]);
    expect(p.calls).toHaveLength(2);
    expect(p.logs.some((l) => l.includes("Could not persist"))).toBe(false);
  });

  it("counts a library whose scaffold threw as failed, even with a bannered Package.swift", async () => {
    const reason = "EACCES: permission denied, mkdir 'node_modules/lib-a/include'";
    const p = project([{ depName: "lib-a", status: "error", reason }], ["lib-a"]);
    const err = await p.run().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toBe(`Scaffolding lib-a failed: ${reason}`);
    expect(p.persisted()).toEqual([]);
    expect(p.calls).toHaveLength(2);
  });

  it("persists and retries when every named library scaffolded", async () => {
    const p = project([{ depName: "lib-a", status: "written" }], ["lib-a"]);
    await expect(p.run()).resolves.toBeUndefined();
    expect(p.persisted()).toEqual(["lib-a"]);
    expect(p.calls).toHaveLength(4);
  });

  it("never reads a results file a previous run left", async () => {
    const p = project([], []);
    mkdirSync(path.dirname(p.full.scaffoldResults), { recursive: true });
    writeFileSync(p.full.scaffoldResults, JSON.stringify({ results: [{ depName: "lib-a", status: "error", reason: "old" }] }));
    const runner: RnRunner = async (_c, args) =>
      args.includes("--scaffold") ? { exitCode: 1, output: "scaffoldAll exploded" } : { exitCode: 2, output: missing("lib-a") };
    await expect(
      runRnSpm(p.full, { kind: "bare", rnScripts: "vendored", expoPlugin: "installed" }, { runner, log: () => {}, rnDir }),
    ).rejects.toThrow("React Native spm scaffold failed (exit 1):\nscaffoldAll exploded");
  });

  it("keeps today's message without a results file", async () => {
    const h = harness([
      { exitCode: 2, output: missing("lib-a") },
      { exitCode: 1, output: "rn-spm-generate: boom" },
    ]);
    await expect(runRnSpm(paths, { kind: "bare", rnScripts: "installed", expoPlugin: "installed" }, h.deps)).rejects.toThrow(
      "React Native spm scaffold failed (exit 1):\nrn-spm-generate: boom",
    );
    expect(h.calls).toHaveLength(2);
  });
});

describe("exclude", () => {
  const FILTER = path.join(packageRoot(), "scripts", "exclude-config-command.js");
  const EXCLUDE = ["react-native-vision-camera", "@scope/lib"];
  const wrapped = (inner: string[]) => [process.execPath, FILTER, "--exclude", JSON.stringify(EXCLUDE), "--", ...inner];
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  /** A project whose @react-native-community/cli names its bin, as the CLI's package.json does. */
  function cliProject(): string {
    const root = mkdtempSync(path.join(tmpdir(), "rn-xtool-exclude-"));
    roots.push(root);
    const cli = path.join(root, "node_modules", "@react-native-community", "cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@react-native-community/cli", bin: { "rnc-cli": "build/bin.js" } }));
    return root;
  }
  const BARE_INNER = (root: string) => [process.execPath, path.join(root, "node_modules", "@react-native-community", "cli", "build/bin.js"), "config"];
  const configOf = (args: string[]) => {
    const i = args.indexOf("--config-command");
    return i === -1 ? undefined : (JSON.parse(args[i + 1]!) as string[]);
  };

  it("configCommandFor wraps the project's config command, and keeps today's without exclude", () => {
    const root = cliProject();
    expect(configCommandFor(root, "bare", [])).toBeUndefined();
    expect(configCommandFor(root, "expo", [])).toEqual(AUTOLINKING_CONFIG_COMMAND);
    expect(configCommandFor(root, "bare", EXCLUDE)).toEqual(wrapped(BARE_INNER(root)));
    expect(configCommandFor(root, "expo", EXCLUDE)).toEqual(wrapped(AUTOLINKING_CONFIG_COMMAND));
  });

  it("wraps RN's environment override on bare, as RN would run it", () => {
    const root = cliProject();
    const before = process.env.RCT_SPM_AUTOLINKING_CONFIG_COMMAND;
    process.env.RCT_SPM_AUTOLINKING_CONFIG_COMMAND = JSON.stringify(["yarn", "react-native", "config"]);
    try {
      expect(configCommandFor(root, "bare", EXCLUDE)).toEqual(wrapped(["yarn", "react-native", "config"]));
    } finally {
      if (before === undefined) delete process.env.RCT_SPM_AUTOLINKING_CONFIG_COMMAND;
      else process.env.RCT_SPM_AUTOLINKING_CONFIG_COMMAND = before;
    }
  });

  const scaffoldRun = () => [
    { exitCode: 2, output: missing("lib-a") },
    { exitCode: 0, output: "" },
    { exitCode: 0, output: "" },
    { exitCode: 0, output: "" },
  ];

  it("wraps the config command when exclude is set, on bare and Expo", async () => {
    const root = cliProject();
    const p = projectPaths(root);
    const runs = {
      bare: { kind: "bare", rnScripts: "vendored", expoPlugin: "installed" },
      expo57: { kind: "expo", rnScripts: "vendored", expoPlugin: "vendored" },
      expo58: { kind: "expo", rnScripts: "installed", expoPlugin: "installed" },
    } as const;
    for (const [name, opts] of Object.entries(runs)) {
      const h = harness(scaffoldRun());
      await runRnSpm(p, { ...opts, exclude: EXCLUDE }, h.deps);
      const inner = name === "bare" ? BARE_INNER(root) : AUTOLINKING_CONFIG_COMMAND;
      // The generate (or Expo 58's add|update) run, the scaffold run and the retry.
      for (const i of [0, 1, 3]) expect([name, i, configOf(h.calls[i]!.args)]).toEqual([name, i, wrapped(inner)]);
      expect(h.calls[1]!.args).toContain("--scaffold");
      if (name === "expo58") expect(h.calls[0]!.args[1]).toBe("add");
    }
  });

  it("leaves every argv unchanged without exclude", async () => {
    const root = cliProject();
    const p = projectPaths(root);
    for (const opts of [
      { kind: "bare", rnScripts: "vendored", expoPlugin: "installed" },
      { kind: "bare", rnScripts: "installed", expoPlugin: "installed" },
      { kind: "expo", rnScripts: "vendored", expoPlugin: "vendored" },
      { kind: "expo", rnScripts: "installed", expoPlugin: "installed" },
    ] as const) {
      const without = harness(scaffoldRun());
      await runRnSpm(p, opts, without.deps);
      const empty = harness(scaffoldRun());
      await runRnSpm(p, { ...opts, exclude: [] }, empty.deps);
      expect(empty.calls).toEqual(without.calls);
      expect(without.calls.map((c) => c.args.join(" ")).join("\n")).not.toContain("exclude-config-command");
      if (opts.kind === "bare") expect(configOf(without.calls[0]!.args)).toBeUndefined();
    }
  });
});

describe("streamingRunner", () => {
  it("keeps multibyte characters split across chunks intact", async () => {
    const script =
      'const b=Buffer.from("héllo ✔ wörld");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),50)';
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const r = await streamingRunner(process.execPath, ["-e", script], { cwd: process.cwd() });
      expect(r.output).toBe("héllo ✔ wörld");
    } finally {
      process.stdout.write = w;
    }
  });
});

describe("binaryInPatch", () => {
  const added = (file: string, first: string) =>
    [`diff --git a/${file} b/${file}`, "new file mode 100644", "--- /dev/null", `+++ b/${file}`, "@@ -0,0 +1,2 @@", `+${first}`, "+more", ""].join("\n");
  const TEXT = added("node_modules/lib-a/Package.swift", "// swift-tools-version: 6.0");

  it.each([
    ["a GIT binary patch hunk", `${TEXT}diff --git a/node_modules/lib-a/x.a b/node_modules/lib-a/x.a\nnew file mode 100644\nGIT binary patch\nliteral 8\nPcmc~u&B@6x$;e;;0\n`, "node_modules/lib-a/x.a"],
    ["a binary file git only names", `${TEXT}diff --git a/node_modules/lib-a/y.o b/node_modules/lib-a/y.o\nnew file mode 100644\nBinary files /dev/null and b/node_modules/lib-a/y.o differ\n`, "node_modules/lib-a/y.o"],
    ["an added ar archive", `${TEXT}${added("node_modules/lib-a/libX.a", "!<arch>")}`, "node_modules/lib-a/libX.a"],
    ["an added thin archive", added("node_modules/lib-a/libY.a", "!<thin>"), "node_modules/lib-a/libY.a"],
    ["an added Mach-O object", added("node_modules/lib-a/Z", "\xcf\xfa\xed\xfe\x0c\x00\x00\x01"), "node_modules/lib-a/Z"],
    ["an added fat file", added("node_modules/lib-a/F", "\xca\xfe\xba\xbe\x00\x00\x00\x02"), "node_modules/lib-a/F"],
  ])("names the first binary file: %s", (_name, text, file) => {
    expect(binaryInPatch(text)).toBe(file);
  });

  it("passes a text-only patch, a removed archive and a text line that names the magic", () => {
    expect(binaryInPatch(TEXT)).toBeUndefined();
    const removed = ["diff --git a/x.a b/x.a", "deleted file mode 100644", "--- a/x.a", "+++ /dev/null", "@@ -1 +0,0 @@", "-!<arch>", ""].join("\n");
    expect(binaryInPatch(removed)).toBeUndefined();
    expect(binaryInPatch(added("node_modules/lib-a/README.md", "an archive starts with !<arch>"))).toBeUndefined();
  });
});

describe("the persist guard", () => {
  const tmp: string[] = [];
  afterAll(() => {
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });
  const PATCH = "patches/lib-a+1.0.0.patch";
  const TEXT_PATCH = [
    "diff --git a/node_modules/lib-a/Package.swift b/node_modules/lib-a/Package.swift",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/node_modules/lib-a/Package.swift",
    "@@ -0,0 +1 @@",
    "+// swift-tools-version: 6.0",
    "",
  ].join("\n");
  const BINARY_PATCH = `${TEXT_PATCH}diff --git a/node_modules/lib-a/libMLKitVision.a b/node_modules/lib-a/libMLKitVision.a\nnew file mode 100644\nGIT binary patch\nliteral 8\nPcmc~u&B@6x$;e;;0\n`;
  const AR_PATCH = `${TEXT_PATCH}diff --git a/node_modules/lib-a/libX.a b/node_modules/lib-a/libX.a\nnew file mode 100644\n--- /dev/null\n+++ b/node_modules/lib-a/libX.a\n@@ -0,0 +1 @@\n+!<arch>\n`;

  /**
   * A project where patch-package writes `written` as lib-a's patch (under `as`, the printed name by default) and prints
   * `printed`; `previous` is the patch file before (none: absent).
   */
  async function persisting(written: string, previous?: string, o: { as?: string; printed?: string } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "rn-spm-guard-"));
    tmp.push(root);
    if (previous !== undefined) {
      mkdirSync(path.join(root, "patches"), { recursive: true });
      writeFileSync(path.join(root, PATCH), previous);
    }
    const logs: string[] = [];
    let n = 0;
    const runner: RnRunner = async (cmd, args) => {
      n++;
      if (n === 1) return { exitCode: 1, output: missing("lib-a") };
      if (cmd === process.execPath && args.includes("--patch-dir")) {
        mkdirSync(path.join(root, "patches"), { recursive: true });
        writeFileSync(path.join(root, o.as ?? PATCH), written, "latin1");
        return { exitCode: 0, output: `✔ Created file ${o.printed ?? PATCH}\n` };
      }
      return { exitCode: 0, output: "" };
    };
    await runRnSpm(projectPaths(root), { kind: "bare", rnScripts: "vendored", expoPlugin: "installed" }, {
      runner,
      log: (l) => logs.push(l),
      rnDir,
      writePodTable: () => POD_TABLE,
    });
    const file = path.join(root, PATCH);
    const other = path.join(root, o.as ?? PATCH);
    return { logs, after: existsSync(file) ? readFileSync(file, "utf8") : undefined, other: existsSync(other) };
  }

  it("fails closed when it cannot read the patch it names (row 40)", async () => {
    const r = await persisting(TEXT_PATCH, "the previous patch\n", { as: "patches/unrelated.patch", printed: "patches/lib-a+9.9.9.patch" });
    expect(r.logs).toContain(
      "⚠ Did not persist lib-a's scaffold: rn-xtool could not read patches/lib-a+9.9.9.patch to check it for binary files",
    );
    expect(r.logs.some((l) => l.startsWith("✔ scaffold — persisted"))).toBe(false);
    expect(r.after).toBe("the previous patch\n");
  });

  it("checks every patch file of the library that changed, whatever name it printed", async () => {
    const r = await persisting(BINARY_PATCH, undefined, { as: "patches/lib-a+2.0.0.patch" });
    expect(r.logs).toContain("⚠ Did not persist lib-a's scaffold: the patch would contain a binary file (node_modules/lib-a/libMLKitVision.a)");
    expect(r.other).toBe(false);
  });

  it("does not persist a patch with a GIT binary patch hunk, and says so", async () => {
    const r = await persisting(BINARY_PATCH, "the previous patch\n");
    expect(r.after).toBe("the previous patch\n");
    expect(r.logs).toContain("⚠ Did not persist lib-a's scaffold: the patch would contain a binary file (node_modules/lib-a/libMLKitVision.a)");
    expect(r.logs.some((l) => l.startsWith("✔ scaffold — persisted"))).toBe(false);
  });

  it("does not persist an added file with ar magic", async () => {
    const r = await persisting(AR_PATCH);
    expect(r.after).toBeUndefined();
    expect(r.logs).toContain("⚠ Did not persist lib-a's scaffold: the patch would contain a binary file (node_modules/lib-a/libX.a)");
  });

  it("persists a text-only patch as before", async () => {
    const r = await persisting(TEXT_PATCH, "the previous patch\n");
    expect(r.after).toBe(TEXT_PATCH);
    expect(r.logs).toContain(`✔ scaffold — persisted ${PATCH}`);
    expect(r.logs.some((l) => l.includes("Did not persist"))).toBe(false);
  });
});
