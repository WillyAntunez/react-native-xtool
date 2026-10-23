import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPatchesArgv,
  findPatchMismatch,
  genericPatchFailureMessage,
  outputNamesPackage,
  parsePatchFileName,
  patchFailureMessage,
} from "../src/pipeline/patches.js";
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

  it("uses update when the marker exists inside the xcodeproj", async () => {
    const paths = await tempProject();
    const proj = path.join(paths.ios, "app.xcodeproj");
    await mkdir(proj);
    await writeFile(path.join(proj, ".spm-injected.json"), "{}");
    expect(rnSpmArgs(paths, {}, rn)[1]).toBe("update");
  });

  it("still accepts the marker directly in ios/", async () => {
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
    expect(cmd).toBe(process.execPath);
    expect(cmd).not.toBe("npx");
    expect(existsSync(args[0]!)).toBe(true);
    expect(args[1]).toBe("--patch-dir");
    expect(path.isAbsolute(args[2]!)).toBe(false);
    expect(path.resolve(root, args[2]!)).toBe(path.join(packageRoot(), "patches"));
  });
});

describe("parsePatchFileName", () => {
  it("parses plain and scoped package patches", () => {
    expect(parsePatchFileName("expo+58.0.17.patch")).toEqual({ pkg: "expo", version: "58.0.17" });
    expect(parsePatchFileName("expo-modules-autolinking+58.0.14.patch")).toEqual({
      pkg: "expo-modules-autolinking",
      version: "58.0.14",
    });
    expect(parsePatchFileName("@expo+config+58.0.7.patch")).toEqual({ pkg: "@expo/config", version: "58.0.7" });
  });
  it("rejects other files", () => {
    expect(parsePatchFileName("README.md")).toBeUndefined();
    expect(parsePatchFileName("expo.patch")).toBeUndefined();
  });
});

describe("patchFailureMessage", () => {
  it("renders the recovery text and keeps only the last 40 output lines", () => {
    const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const msg = patchFailureMessage({
      pkg: "expo",
      installed: "58.0.20",
      patchFile: "expo+58.0.17.patch",
      patched: "58.0.17",
      output,
    });
    expect(msg.split("\n").slice(0, 4)).toEqual([
      "expo-xtool could not patch expo@58.0.20 (patch file: expo+58.0.17.patch): the installed version differs from the one this release of expo-xtool patches (58.0.17).",
      "This is a known limitation of expo-xtool, not of your project.",
      'Options: pin "expo" to 58.0.17 in package.json, or report the new version at https://github.com/WillyAntunez/expo-xtool/issues so the patch can be refreshed.',
      "--- patch-package output ---",
    ]);
    expect(msg).toContain("line 50");
    expect(msg).toContain("line 11");
    expect(msg).not.toContain("line 10\n");
  });
});

describe("findPatchMismatch", () => {
  async function fakeProject(versions: Record<string, string>, nested: Record<string, string> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "xtool-patch-"));
    tempDirs.push(root);
    const put = async (dir: string, v: string) => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: v }));
    };
    for (const [n, v] of Object.entries(versions)) await put(path.join(root, "node_modules", n), v);
    for (const [n, v] of Object.entries(nested)) await put(path.join(root, "node_modules", "expo", "node_modules", n), v);
    const patchDir = path.join(root, "patches");
    await mkdir(patchDir);
    await writeFile(path.join(patchDir, "expo+58.0.17.patch"), "");
    await writeFile(path.join(patchDir, "expo-modules-autolinking+58.0.14.patch"), "");
    return { root, patchDir };
  }

  it("detects a version mismatch, including nested installs", async () => {
    const { root, patchDir } = await fakeProject({ expo: "58.0.17" }, { "expo-modules-autolinking": "58.1.0" });
    expect(findPatchMismatch(root, patchDir)).toEqual({
      pkg: "expo-modules-autolinking",
      installed: "58.1.0",
      patchFile: "expo-modules-autolinking+58.0.14.patch",
      patched: "58.0.14",
    });
  });
  it("returns undefined when versions match or packages are missing", async () => {
    const { root, patchDir } = await fakeProject({ expo: "58.0.17", "expo-modules-autolinking": "58.0.14" });
    expect(findPatchMismatch(root, patchDir)).toBeUndefined();
    const bare = await fakeProject({});
    expect(findPatchMismatch(bare.root, bare.patchDir)).toBeUndefined();
  });
  it("prefers the package named in the patch-package output", async () => {
    const { root, patchDir } = await fakeProject({ expo: "58.9.9", "expo-modules-autolinking": "58.9.9" });
    expect(findPatchMismatch(root, patchDir, "Error: Failed to apply patch for package expo-modules-autolinking at path\n    node_modules/expo-modules-autolinking")?.pkg).toBe(
      "expo-modules-autolinking",
    );
  });
  it("does not blame expo when expo-modules-jsi failed", async () => {
    const { root, patchDir } = await fakeProject({ expo: "58.9.9", "expo-modules-autolinking": "58.9.9" });
    const jsi = "Failed to apply patch for package expo-modules-jsi at path\n    node_modules/expo-modules-jsi\n(expo-modules-jsi+1.0.0.patch)";
    expect(outputNamesPackage(jsi, "expo")).toBe(false);
    const both = `${jsi}\nnode_modules/expo-modules-autolinking`;
    expect(findPatchMismatch(root, patchDir, both)?.pkg).toBe("expo-modules-autolinking");
  });
  it("matches the patch file prefix and the node_modules path", () => {
    expect(outputNamesPackage("applying expo+58.0.17.patch", "expo")).toBe(true);
    expect(outputNamesPackage("at node_modules/expo/package.json", "expo")).toBe(true);
    expect(outputNamesPackage("applying @expo+config+1.0.0.patch", "@expo/config")).toBe(true);
    expect(outputNamesPackage("node_modules/@expo/config", "@expo/config")).toBe(true);
  });
});

describe("genericPatchFailureMessage", () => {
  it("includes exit code, output tail and the report link", () => {
    const m = genericPatchFailureMessage({ exitCode: 1 }, "boom\n");
    expect(m).toContain("patch-package failed (exit 1):");
    expect(m).toContain("boom");
    expect(m).toContain("Report this at https://github.com/WillyAntunez/expo-xtool/issues with the output above.");
  });
  it("includes the spawn error when the process never ran", () => {
    const m = genericPatchFailureMessage({ shortMessage: "Command failed with ENOENT: node" }, "");
    expect(m).toContain("exit unknown");
    expect(m).toContain("Command failed with ENOENT: node");
  });
});
