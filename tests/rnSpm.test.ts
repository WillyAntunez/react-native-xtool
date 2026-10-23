import { describe, expect, it } from "vitest";
import {
  parseMissingPackageSwift,
  persistScaffoldArgv,
  rnSpmArgs,
  runRnSpm,
  scaffoldArgv,
  type RnRunner,
} from "../src/pipeline/rnSpm.js";
import type { ProjectPaths } from "../src/paths.js";

const paths = { root: "/proj", ios: "/proj/ios" } as unknown as ProjectPaths;
const rnDir = "/proj/node_modules/react-native";
const missing = (n: string) =>
  `error: Package.swift is missing for library "${n}" — it ships no Swift Package Manager support.`;

function harness(results: { exitCode: number; output: string }[]) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const logs: string[] = [];
  const runner: RnRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd });
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
});

describe("argv helpers", () => {
  it("scaffoldArgv", () => {
    const a = scaffoldArgv(paths, {}, rnDir);
    expect(a[0]).toBe(`${rnDir}/scripts/setup-apple-spm.js`);
    expect(a[1]).toBe("scaffold");
    expect(a).toContain("--config-command");
    expect(a).not.toContain("--download");
  });
  it("scaffoldArgv forwards the offline artifact flags", () => {
    const a = scaffoldArgv(paths, { rnArtifactsDir: "/art" }, rnDir);
    expect(a[1]).toBe("scaffold");
    expect(a.slice(-4)).toEqual(["--download", "skip", "--artifacts", "/art"]);
    expect(a.slice(2)).toEqual(rnSpmArgs(paths, { rnArtifactsDir: "/art" }, rnDir).slice(2));
  });
  it("persistScaffoldArgv uses the project patches dir", () => {
    const [, args] = persistScaffoldArgv("lib");
    expect(args.slice(1)).toEqual(["lib", "--patch-dir", "patches"]);
  });
});

describe("runRnSpm", () => {
  it("runs once on success", async () => {
    const h = harness([{ exitCode: 0, output: "" }]);
    await runRnSpm(paths, {}, h.deps);
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
    await runRnSpm(paths, {}, h.deps);
    expect(h.calls).toHaveLength(5);
    expect(h.calls[1]!.args[1]).toBe("scaffold");
    expect(h.calls[1]!.cwd).toBe("/proj/ios");
    expect(h.calls[2]!.args.slice(1)).toEqual([
      "lib-a",
      "--patch-dir",
      "patches",
    ]);
    expect(h.calls[3]!.args.slice(1)).toEqual([
      "lib-b",
      "--patch-dir",
      "patches",
    ]);
    expect(h.calls[2]!.cwd).toBe("/proj");
    expect(h.calls[4]!.args[1]).toMatch(/add|update/);
    expect(h.logs[0]).toContain("lib-a, lib-b");
  });

  it("forwards artifact flags to the scaffold run", async () => {
    const h = harness([
      { exitCode: 1, output: missing("lib-a") },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "" },
    ]);
    await runRnSpm(paths, { rnArtifactsDir: "/art" }, h.deps);
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
    await expect(runRnSpm(paths, {}, h.deps)).rejects.toThrow(
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
    await expect(runRnSpm(paths, {}, h.deps)).resolves.toBeUndefined();
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
    await runRnSpm(paths, {}, { runner, log: (s) => logs.push(s), rnDir });
    expect(calls).toHaveLength(4);
    expect(logs.some((l) => l.startsWith("⚠") && l.includes("spawn ENOENT"))).toBe(true);
  });

  it("throws without scaffolding on unrelated failures", async () => {
    const h = harness([{ exitCode: 2, output: "something else" }]);
    await expect(runRnSpm(paths, {}, h.deps)).rejects.toThrow(/something else/);
    expect(h.calls).toHaveLength(1);
  });
});
