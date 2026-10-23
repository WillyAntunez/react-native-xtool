import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchesArgv } from "../src/pipeline/patches.js";
import { AUTOLINKING_CONFIG_COMMAND, rnSpmArgs } from "../src/pipeline/rnSpm.js";
import { packageRoot } from "../src/tools/exec.js";
import { projectPaths } from "../src/paths.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempProject() {
  const root = await mkdtemp(path.join(tmpdir(), "xtool-rnspm-"));
  tempDirs.push(root);
  const paths = projectPaths(root);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(paths.ios, { recursive: true });
  return paths;
}

describe("rnSpmArgs", () => {
  const rn = "/rn";
  const config = JSON.stringify(AUTOLINKING_CONFIG_COMMAND);

  it("uses add when no .spm-injected.json", async () => {
    const paths = await tempProject();
    expect(rnSpmArgs(paths, {}, rn)).toEqual([
      "/rn/scripts/setup-apple-spm.js",
      "add",
      "--config-command",
      config,
    ]);
  });

  it("uses update when .spm-injected.json exists", async () => {
    const paths = await tempProject();
    await writeFile(path.join(paths.ios, ".spm-injected.json"), "{}");
    expect(rnSpmArgs(paths, {}, rn)[1]).toBe("update");
  });

  it("adds --download skip only with rnArtifactsDir", async () => {
    const paths = await tempProject();
    expect(rnSpmArgs(paths, {}, rn)).not.toContain("--download");
    expect(rnSpmArgs(paths, { rnArtifactsDir: "/art" }, rn).slice(-4)).toEqual([
      "--download",
      "skip",
      "--artifacts",
      "/art",
    ]);
  });
});

describe("patches", () => {
  it("has exactly 3 patch-package files", () => {
    const files = readdirSync(path.join(packageRoot(), "patches")).filter((f) => f.endsWith(".patch"));
    expect(files).toHaveLength(3);
    for (const f of files) expect(f).toMatch(/^[^+]+\+\d+\.\d+\.\d+\.patch$/);
  });

  it("applyPatchesArgv uses a relative patch dir from the project root", () => {
    const root = path.join(packageRoot(), "..", "proj");
    const [cmd, args] = applyPatchesArgv(root);
    expect(cmd).toBe("node");
    expect(cmd).not.toBe("npx");
    expect(existsSync(args[0]!)).toBe(true);
    expect(args[1]).toBe("--patch-dir");
    expect(path.isAbsolute(args[2]!)).toBe(false);
    expect(path.resolve(root, args[2]!)).toBe(path.join(packageRoot(), "patches"));
  });
});
