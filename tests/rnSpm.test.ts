import { describe, expect, it } from "vitest";
import { streamingRunner } from "../src/pipeline/rnSpm.js";
import {
  parseMissingPackageSwift,
  persistScaffoldArgv,
  rnSpmArgs,
  rnSpmGenerateArgs,
  rnSpmScaffoldArgs,
  runRnSpm,
  scaffoldArgv,
  type RnRunner,
} from "../src/pipeline/rnSpm.js";
import type { ProjectPaths } from "../src/paths.js";
import { packageRoot } from "../src/tools/exec.js";
import path from "node:path";

const paths = { root: "/proj", ios: "/proj/ios", iosXtool: "/proj/ios-xtool" } as unknown as ProjectPaths;
const SWIFT_HEADERS = "/proj/ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos";
const rnDir = "/proj/node_modules/react-native";
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
  return {
    calls,
    logs,
    deps: { runner, log: (s: string) => logs.push(s), rnDir },
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
  it("scaffoldArgv", () => {
    const a = scaffoldArgv(paths, {}, rnDir);
    expect(a[0]).toBe(`${rnDir}/scripts/setup-apple-spm.js`);
    expect(a[1]).toBe("scaffold");
    expect(a).toContain("--config-command");
    expect(a).not.toContain("--download");
  });
  it("passes --yes to add/update and scaffold", () => {
    expect(rnSpmArgs(paths, {}, rnDir)).toContain("--yes");
    expect(scaffoldArgv(paths, {}, rnDir)).toContain("--yes");
  });
  it("scaffoldArgv forwards the offline artifact flags", () => {
    const a = scaffoldArgv(paths, { rnArtifactsDir: "/art" }, rnDir);
    expect(a[1]).toBe("scaffold");
    expect(a.slice(-4)).toEqual(["--download", "skip", "--artifacts", "/art"]);
    expect(a.slice(2)).toEqual(rnSpmArgs(paths, { rnArtifactsDir: "/art" }, rnDir).slice(2));
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
    const a = rnSpmGenerateArgs(paths, {}, rnDir);
    expect(a[0]).toBe(path.join(packageRoot(), "scripts", "rn-spm-generate.js"));
    expect(a.slice(1)).toEqual(["--rn-dir", rnDir, "--app-root", "/proj"]);
    expect(a).not.toContain("--artifacts");
    expect(rnSpmGenerateArgs(paths, { rnArtifactsDir: "/art" }, rnDir).slice(1)).toEqual([
      "--rn-dir",
      rnDir,
      "--app-root",
      "/proj",
      "--artifacts",
      "/art",
    ]);
  });
});

describe("runRnSpm", () => {
  it("runRnSpm uses the generate driver for bare and setup-apple-spm for expo", async () => {
    const bare = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "bare" }, bare.deps);
    expect(bare.calls).toEqual([
      {
        cmd: "node",
        args: rnSpmGenerateArgs(paths, {}, rnDir),
        cwd: "/proj/ios",
        env: { RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS },
      },
    ]);
    const expo = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "expo" }, expo.deps);
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
    await runRnSpm(paths, { kind: "bare", rnArtifactsDir: "/art" }, h.deps);
    const generate = rnSpmGenerateArgs(paths, { rnArtifactsDir: "/art" }, rnDir);
    expect(h.calls.map((c) => c.args)).toEqual([
      generate,
      [...generate, "--scaffold"],
      persistScaffoldArgv("lib-a")[1],
      generate,
    ]);
    expect(rnSpmScaffoldArgs(paths, { rnArtifactsDir: "/art" }, rnDir)).toEqual([...generate, "--scaffold"]);
    for (const c of [h.calls[0]!, h.calls[1]!, h.calls[3]!]) {
      expect(c.cwd).toBe("/proj/ios");
      expect(c.env).toEqual({ RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS });
    }
  });

  it("keeps setup-apple-spm scaffold for the expo kind", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo" }, h.deps);
    expect(h.calls.map((c) => c.args)).toEqual([
      rnSpmArgs(paths, {}, rnDir),
      scaffoldArgv(paths, {}, rnDir),
      persistScaffoldArgv("lib-a")[1],
      rnSpmArgs(paths, {}, rnDir),
    ]);
  });

  it("runs once on success", async () => {
    const h = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, { kind: "expo" }, h.deps);
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
    await runRnSpm(paths, { kind: "expo" }, h.deps);
    expect(h.calls).toHaveLength(5);
    expect(h.calls[1]!.args[1]).toBe("scaffold");
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
    await runRnSpm(paths, { kind: "expo" }, h.deps);
    const rnRuns = h.calls.filter((c) => c.cmd === "node");
    expect(rnRuns.map((c) => c.args[1])).toEqual([expect.stringMatching(/add|update/), "scaffold", expect.stringMatching(/add|update/)]);
    for (const c of rnRuns) expect(c.env).toEqual({ RN_SPM_SWIFT_HEADERS_DIR: SWIFT_HEADERS });
    expect(h.calls[1]!.args[1]).toBe("scaffold");
    expect(h.calls[2]!.args[1]).toBe("pager");
  });

  it("forwards artifact flags to the scaffold run", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo", rnArtifactsDir: "/art" }, h.deps);
    expect(h.calls[1]!.args[1]).toBe("scaffold");
    expect(h.calls[1]!.args).toContain("--artifacts");
  });

  it("throws naming the libs when the retry fails", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 1, output: "boom" },
    ]);
    await expect(runRnSpm(paths, { kind: "expo" }, h.deps)).rejects.toThrow(
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
    await expect(runRnSpm(paths, { kind: "expo" }, h.deps)).resolves.toBeUndefined();
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
    await runRnSpm(paths, { kind: "expo" }, { runner, log: (s) => logs.push(s), rnDir });
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
    await runRnSpm(paths, { kind: "expo" }, h.deps);
    expect(h.logs).toContain("✔ scaffold — persisted patches/lib-a+1.2.3.patch");
  });

  it("falls back to the computed filename when patch-package prints none", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { kind: "expo" }, h.deps);
    expect(h.logs).toContain("✔ scaffold — persisted patches/lib-a+unknown.patch");
  });

  it("throws RN's message without scaffolding when only no-podspec libs failed", async () => {
    const h = harness([{ exitCode: 1, output: noPodspec("np") }]);
    await expect(runRnSpm(paths, { kind: "expo" }, h.deps)).rejects.toThrow(/ships no podspec/);
    expect(h.calls).toHaveLength(1);
  });

  it("scaffolds only the scaffoldable libs when both variants are reported", async () => {
    const h = harness([
      { exitCode: 1, output: `${noPodspec("np")}\n${missing("lib-a")}` },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 1, output: noPodspec("np") },
    ]);
    await expect(runRnSpm(paths, { kind: "expo" }, h.deps)).rejects.toThrow(/lib-a/);
    expect(h.calls[2]!.args[1]).toBe("lib-a");
  });

  it("throws without scaffolding on unrelated failures", async () => {
    const h = harness([{ exitCode: 2, output: "something else" }]);
    await expect(runRnSpm(paths, { kind: "expo" }, h.deps)).rejects.toThrow(/something else/);
    expect(h.calls).toHaveLength(1);
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
