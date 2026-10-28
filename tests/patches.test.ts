import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPatches,
  applyPatchesArgv,
  hasProjectPatches,
  projectPatchesArgv,
  findPatchMismatch,
  genericPatchFailureMessage,
  outputNamesPackage,
  parsePatchFileName,
  selectBundledPatches,
  stageBundledPatches,
  patchFailureMessage,
  patchPackageOutputFailed,
  rnPatchMismatch,
  scaffoldPatchWarnings,
  SCAFFOLD_REVISION,
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
      "--yes",
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
  it("has exactly 6 patch-package files", () => {
    const files = readdirSync(path.join(packageRoot(), "patches")).filter((f) => f.endsWith(".patch"));
    expect(files.sort()).toEqual([
      "expo+58.0.21.patch",
      "expo-modules-autolinking+58.0.16.patch",
      "expo-modules-jsi+57.1.3.patch",
      "expo-modules-jsi+58.0.21.patch",
      "react-native+0.88.0.patch",
      "react-native+0.88.1.patch",
    ]);
    for (const f of files) expect(f).toMatch(/^[^+]+\+\d+\.\d+\.\d+\.patch$/);
  });

  it("keeps the two react-native patches identical", () => {
    // A scaffolder fix edits both: bare 0.88.0 and 0.88.1 share the scaffolder files the patch touches.
    const read = (v: string) => readFileSync(path.join(packageRoot(), "patches", `react-native+${v}.patch`));
    expect(read("0.88.0").equals(read("0.88.1"))).toBe(true);
  });

  it("applyPatchesArgv passes the staged dir relative to the project root", () => {
    const root = path.join(packageRoot(), "..", "proj");
    const staged = projectPaths(root).patchesDir;
    const [cmd, args] = applyPatchesArgv(root, staged);
    expect(cmd).toBe(process.execPath);
    expect(cmd).not.toBe("npx");
    expect(existsSync(args[0]!)).toBe(true);
    expect(args[1]).toBe("--patch-dir");
    expect(path.isAbsolute(args[2]!)).toBe(false);
    expect(path.resolve(root, args[2]!)).toBe(staged);
  });
});

async function installPkg(root: string, pkg: string, version = "1.0.0") {
  const dir = path.join(root, "node_modules", pkg);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ version }));
}

describe("bundled patch selection", () => {
  const bundled = path.join(packageRoot(), "patches");

  it("selects only patches whose package is installed", async () => {
    const { root } = await tempProject();
    await installPkg(root, "react-native", "0.88.0");
    expect(selectBundledPatches(root, bundled)).toEqual(["react-native+0.88.0.patch"]);
  });

  it("stages the selection as symlinks", async () => {
    const { root, patchesDir } = await tempProject();
    await installPkg(root, "react-native", "0.88.0");
    await mkdir(patchesDir, { recursive: true });
    await writeFile(path.join(patchesDir, "stale.patch"), "");
    expect(await stageBundledPatches(root, patchesDir)).toEqual(["react-native+0.88.0.patch"]);
    expect(readdirSync(patchesDir)).toEqual(["react-native+0.88.0.patch"]);
    const link = path.join(patchesDir, "react-native+0.88.0.patch");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(path.join(bundled, "react-native+0.88.0.patch"));
  });

  it("applyPatches skips bundled patches when none apply", async () => {
    const { root, patchesDir } = await tempProject();
    const calls: string[][] = [];
    await applyPatches(root, async (_c, args) => (calls.push(args), { exitCode: 0 }));
    expect(calls).toHaveLength(0);
    expect(existsSync(patchesDir) ? readdirSync(patchesDir) : []).toEqual([]);
  });

  it("applyPatches runs patch-package on the staged dir", async () => {
    const { root, patchesDir } = await tempProject();
    await installPkg(root, "react-native", "0.88.0");
    const calls: string[][] = [];
    await applyPatches(root, async (_c, args) => (calls.push(args), { exitCode: 0 }));
    expect(calls).toHaveLength(1);
    expect(path.resolve(root, calls[0]![2]!)).toBe(patchesDir);
  });
});

describe("react-native patch scope", () => {
  const bundled = path.join(packageRoot(), "patches");

  it("bare 0.88.0 and 0.88.1 each get their own react-native patch", async () => {
    for (const [rn, expected] of [
      ["0.88.0", ["react-native+0.88.0.patch"]],
      ["0.88.1", ["react-native+0.88.1.patch"]],
      ["0.86.3", []],
    ] as const) {
      const { root } = await tempProject();
      await installPkg(root, "react-native", rn);
      expect(selectBundledPatches(root, bundled), rn).toEqual(expected);
    }
  });

  it("flags react-native only when no bundled patch matches", async () => {
    for (const rn of ["0.88.0", "0.88.1"]) {
      const { root } = await tempProject();
      await installPkg(root, "react-native", rn);
      expect(rnPatchMismatch(root, bundled), rn).toBeUndefined();
    }
    const none = await tempProject();
    expect(rnPatchMismatch(none.root, bundled)).toBeUndefined();

    const { root } = await tempProject();
    await installPkg(root, "react-native", "0.88.2");
    expect(rnPatchMismatch(root, bundled)).toEqual({
      pkg: "react-native",
      installed: "0.88.2",
      patchFile: "react-native+0.88.1.patch",
      patched: "0.88.1",
    });
    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]) => (calls.push(args), { exitCode: 0 });
    await expect(applyPatches(root, exec, { rnScripts: "installed" })).rejects.toThrow(/pin "react-native" to 0\.88\.1/);
    expect(calls).toHaveLength(0);
  });

  it("keeps staging the expo patches whatever their installed version", async () => {
    const { root } = await tempProject();
    await installPkg(root, "expo", "58.0.20");
    expect(selectBundledPatches(root, bundled)).toEqual(["expo+58.0.21.patch"]);
  });

  const FLOOR_PATCHES = [
    "expo+58.0.21.patch",
    "expo-modules-autolinking+58.0.16.patch",
    "expo-modules-jsi+58.0.21.patch",
    "react-native+0.88.1.patch",
  ];

  it("stages the 58.0.21 set's patches", async () => {
    const { root } = await tempProject();
    await installPkg(root, "expo", "58.0.21");
    await installPkg(root, "expo-modules-autolinking", "58.0.16");
    await installPkg(root, "expo-modules-jsi", "58.0.21");
    await installPkg(root, "react-native", "0.88.1");
    expect(selectBundledPatches(root, bundled)).toEqual(FLOOR_PATCHES);
  });

  it("stages the floor patches for a newer 58.x", async () => {
    const { root } = await tempProject();
    await installPkg(root, "expo", "58.0.22");
    await installPkg(root, "expo-modules-autolinking", "58.0.17");
    await installPkg(root, "expo-modules-jsi", "58.0.23");
    await installPkg(root, "react-native", "0.88.1");
    expect(selectBundledPatches(root, bundled)).toEqual(FLOOR_PATCHES);
    const exec = async () => ({
      exitCode: 1,
      all: "**ERROR** Failed to apply patch for package expo-modules-jsi\n  patch file: expo-modules-jsi+58.0.21.patch",
    });
    await expect(applyPatches(root, exec, { rnScripts: "installed", expoPlugin: "installed" })).rejects.toThrow(
      /pin "expo-modules-jsi" to 58\.0\.21/,
    );
  });

  it("stages only the jsi patch on an SDK 57 project", async () => {
    const { root } = await tempProject();
    await installPkg(root, "expo", "57.0.31");
    await installPkg(root, "expo-modules-autolinking", "57.0.16");
    await installPkg(root, "expo-modules-jsi", "57.1.3");
    await installPkg(root, "react-native", "0.86.3");
    expect(selectBundledPatches(root, bundled, { exactOnly: true })).toEqual(["expo-modules-jsi+57.1.3.patch"]);
  });

  it("applyPatches stages only exact-version patches for the vendored Expo plugin", async () => {
    const { root, patchesDir } = await tempProject();
    await installPkg(root, "expo", "57.0.31");
    await installPkg(root, "expo-modules-autolinking", "57.0.16");
    await installPkg(root, "expo-modules-jsi", "57.1.3");
    await installPkg(root, "react-native", "0.86.3");
    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]) => (calls.push(args), { exitCode: 0 });
    await applyPatches(root, exec, { rnScripts: "vendored", expoPlugin: "vendored" });
    expect(calls).toHaveLength(1);
    expect(readdirSync(patchesDir)).toEqual(["expo-modules-jsi+57.1.3.patch"]);
  });

  it("names only staged patches when the vendored plugin's patch fails", async () => {
    const { root } = await tempProject();
    await installPkg(root, "expo", "57.0.31");
    await installPkg(root, "expo-modules-jsi", "57.1.3");
    const output = "**ERROR** Failed to apply patch for package expo-modules-jsi at path\n    node_modules/expo-modules-jsi";
    const exec = async () => ({ exitCode: 1, all: output });
    const err = await applyPatches(root, exec, { rnScripts: "vendored", expoPlugin: "vendored" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^patch-package failed \(exit 1\)/);
    expect((err as Error).message).not.toMatch(/pin "/);
  });

  it("keeps a bare 0.88 hybrid unchanged", async () => {
    const { root, patchesDir } = await tempProject();
    await installPkg(root, "expo", "58.0.21");
    await installPkg(root, path.join("expo", "node_modules", "expo-modules-autolinking"), "58.0.16");
    await installPkg(root, path.join("expo", "node_modules", "expo-modules-jsi"), "58.0.21");
    await installPkg(root, "react-native", "0.88.1");
    expect(selectBundledPatches(root, bundled)).toEqual(FLOOR_PATCHES);
    await applyPatches(root, async () => ({ exitCode: 0 }), { rnScripts: "installed", expoPlugin: "installed" });
    expect(readdirSync(patchesDir).sort()).toEqual(FLOOR_PATCHES);
  });

  it("runs no bundled patch for a vendored project", async () => {
    const { root } = await tempProject();
    await installPkg(root, "react-native", "0.86.3");
    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]) => (calls.push(args), { exitCode: 0 });
    await expect(applyPatches(root, exec, { rnScripts: "installed" })).rejects.toThrow(/pin "react-native" to 0\.88\.1/);
    await expect(applyPatches(root, exec, { rnScripts: "vendored" })).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("parsePatchFileName", () => {
  it("parses plain and scoped package patches", () => {
    expect(parsePatchFileName("expo+58.0.21.patch")).toEqual({ pkg: "expo", version: "58.0.21" });
    expect(parsePatchFileName("expo-modules-autolinking+58.0.16.patch")).toEqual({
      pkg: "expo-modules-autolinking",
      version: "58.0.16",
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
      installed: "58.0.22",
      patchFile: "expo+58.0.21.patch",
      patched: "58.0.21",
      output,
    });
    expect(msg.split("\n").slice(0, 4)).toEqual([
      "rn-xtool could not patch expo@58.0.22 (patch file: expo+58.0.21.patch): the installed version differs from the one this release of rn-xtool patches (58.0.21).",
      "This is a known limitation of rn-xtool, not of your project.",
      'Options: pin "expo" to 58.0.21 in package.json, or report the new version at https://github.com/WillyAntunez/react-native-xtool/issues so the patch can be refreshed.',
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
    await writeFile(path.join(patchDir, "expo+58.0.21.patch"), "");
    await writeFile(path.join(patchDir, "expo-modules-autolinking+58.0.16.patch"), "");
    return { root, patchDir };
  }

  it("detects a version mismatch, including nested installs", async () => {
    const { root, patchDir } = await fakeProject({ expo: "58.0.21" }, { "expo-modules-autolinking": "58.1.0" });
    expect(findPatchMismatch(root, patchDir)).toEqual({
      pkg: "expo-modules-autolinking",
      installed: "58.1.0",
      patchFile: "expo-modules-autolinking+58.0.16.patch",
      patched: "58.0.16",
    });
  });
  it("returns undefined when versions match or packages are missing", async () => {
    const { root, patchDir } = await fakeProject({ expo: "58.0.21", "expo-modules-autolinking": "58.0.16" });
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
    expect(outputNamesPackage("applying expo+58.0.21.patch", "expo")).toBe(true);
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
    expect(m).toContain("Report this at https://github.com/WillyAntunez/react-native-xtool/issues with the output above.");
  });
  it("includes the spawn error when the process never ran", () => {
    const m = genericPatchFailureMessage({ shortMessage: "Command failed with ENOENT: node" }, "");
    expect(m).toContain("exit unknown");
    expect(m).toContain("Command failed with ENOENT: node");
  });
});

describe("applyPatches with project patches", () => {
  const ok = async () => ({ exitCode: 0 });
  async function bundledProject() {
    const paths = await tempProject();
    await installPkg(paths.root, "react-native", "0.88.0");
    return paths;
  }

  it("applies only the bundled patches when the project has no patches dir", async () => {
    const { root } = await bundledProject();
    const calls: string[][] = [];
    await applyPatches(root, async (_c, args) => (calls.push(args), { exitCode: 0 }));
    expect(calls).toHaveLength(1);
    expect(hasProjectPatches(root)).toBe(false);
  });

  it("ignores an empty project patches dir", async () => {
    const { root } = await bundledProject();
    await mkdir(path.join(root, "patches"));
    const calls: string[][] = [];
    await applyPatches(root, async (_c, args) => (calls.push(args), { exitCode: 0 }));
    expect(calls).toHaveLength(1);
  });

  it("applies the project's patches second, from the project root", async () => {
    const { root } = await bundledProject();
    await mkdir(path.join(root, "patches"));
    await writeFile(path.join(root, "patches", "lib+1.0.0.patch"), "");
    const calls: { args: string[]; cwd: string }[] = [];
    await applyPatches(root, async (_c, args, cwd) => (calls.push({ args, cwd }), { exitCode: 0 }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.slice(1)).toEqual(applyPatchesArgv(root, projectPaths(root).patchesDir)[1].slice(1));
    expect(calls[1]!.args.slice(1)).toEqual(["--patch-dir", "patches", "--error-on-fail"]);
    expect(calls[1]!.args).toEqual(projectPatchesArgv()[1]);
    expect(calls[1]!.cwd).toBe(root);
  });

  it("throws when the project's patches fail to apply", async () => {
    const { root } = await bundledProject();
    await mkdir(path.join(root, "patches"));
    await writeFile(path.join(root, "patches", "lib+1.0.0.patch"), "");
    let n = 0;
    await expect(
      applyPatches(root, async () => (++n === 1 ? ok() : { exitCode: 1, all: "bad patch" })),
    ).rejects.toThrow(/project's patches[\s\S]*bad patch/);
  });
});

describe("patch-package failure detection", () => {
  it("passes --error-on-fail in both apply argv builders", () => {
    expect(applyPatchesArgv("/proj", "/proj/ios-xtool/.patches")[1]).toContain("--error-on-fail");
    expect(projectPatchesArgv()[1]).toContain("--error-on-fail");
  });

  it("patchPackageOutputFailed detects failures", () => {
    expect(patchPackageOutputFailed("**ERROR** Failed to apply patch for x")).toBe(true);
    expect(patchPackageOutputFailed("patch-package finished with 1 error(s).")).toBe(true);
    expect(patchPackageOutputFailed("patch-package 8.0.0\nApplying patches...\nx@1.0.0 ✔")).toBe(false);
    expect(patchPackageOutputFailed("")).toBe(false);
  });

  it("applyPatches throws on exit 0 with failure output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xtool-pf-"));
    tempDirs.push(root);
    await installPkg(root, "react-native", "0.88.0");
    const exec = async () => ({ exitCode: 0, all: "**ERROR** Failed to apply patch for foo" });
    await expect(applyPatches(root, exec)).rejects.toThrow(/patch-package failed/);
  });

  it("applyPatches throws on exit 0 with failure output for project patches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xtool-pf-"));
    tempDirs.push(root);
    await mkdir(path.join(root, "patches"));
    await writeFile(path.join(root, "patches", "a+b+1.0.0.patch"), "x");
    await installPkg(root, "react-native", "0.88.0");
    let n = 0;
    const exec = async () => ({
      exitCode: 0,
      all: n++ === 0 ? "ok" : "patch-package finished with 1 error(s).",
    });
    await expect(applyPatches(root, exec)).rejects.toThrow(/project's patches/);
  });
});

describe("scaffold patches from another React Native version", () => {
  /** A persisted scaffold patch; `revision: null` is a hand-made patch without rn-xtool's marker. */
  const scaffoldPatch = (slot: string | null, revision: number | null = 3) =>
    [
      "diff --git a/node_modules/lib/Package.swift b/node_modules/lib/Package.swift",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/node_modules/lib/Package.swift",
      "@@ -0,0 +1,5 @@",
      "+// swift-tools-version: 6.0",
      "+// AUTO-SCAFFOLDED-VERSION: 20",
      ...(revision !== null ? [`+// rn-xtool-scaffold-revision: ${revision}`] : []),
      ...(slot !== null ? [`+// Cache slot: ${slot}/dual-flavor`] : []),
      "+import PackageDescription",
      "",
    ].join("\n");

  it("warns once per scaffold patch whose cache slot names another version", async () => {
    const { root } = await tempProject();
    await installPkg(root, "react-native", "0.87.1");
    await mkdir(path.join(root, "patches"));
    await writeFile(path.join(root, "patches", "react-native-screens+4.30.0.patch"), scaffoldPatch("0.86.3"));
    await writeFile(path.join(root, "patches", "@scope+lib+1.0.0.patch"), scaffoldPatch("0.88.0"));
    await writeFile(path.join(root, "patches", "react-native-svg+15.16.0.patch"), scaffoldPatch("0.87.1"));
    await writeFile(path.join(root, "patches", "hand-made+1.0.0.patch"), scaffoldPatch("0.86.3", null));
    const lines: string[] = [];
    await applyPatches(root, async () => ({ exitCode: 0 }), { rnScripts: "vendored", log: (l) => lines.push(l) });
    expect(lines).toEqual([
      "⚠ patches/@scope+lib+1.0.0.patch was scaffolded for React Native 0.88.0; delete it so rn-xtool regenerates it for 0.87.1 " +
        "(also remove node_modules/@scope/lib and reinstall: that copy still has the old Package.swift)",
      "⚠ patches/react-native-screens+4.30.0.patch was scaffolded for React Native 0.86.3; delete it so rn-xtool regenerates it for 0.87.1 " +
        "(also remove node_modules/react-native-screens and reinstall: that copy still has the old Package.swift)",
    ]);
  });

  it("warns about a scaffold patch from an older revision", async () => {
    const { root } = await tempProject();
    await installPkg(root, "react-native", "0.87.1");
    await mkdir(path.join(root, "patches"));
    await writeFile(path.join(root, "patches", "react-native-screens+4.30.0.patch"), scaffoldPatch("0.87.1", 1));
    await writeFile(path.join(root, "patches", "@scope+lib+1.0.0.patch"), scaffoldPatch(null, 1));
    // Revision 2 wrote no importer paths for a clang-only target.
    await writeFile(path.join(root, "patches", "react-native-screens+4.30.1.patch"), scaffoldPatch("0.87.1", 2));
    await writeFile(path.join(root, "patches", "react-native-svg+15.16.0.patch"), scaffoldPatch("0.87.1", 3));
    // Both stale: the slot warning wins, one line per patch.
    await writeFile(path.join(root, "patches", "react-native-safe-area-context+5.6.0.patch"), scaffoldPatch("0.86.3", 1));
    expect(scaffoldPatchWarnings(root)).toEqual([
      "⚠ patches/@scope+lib+1.0.0.patch was written by an older rn-xtool scaffolder (revision 1, now 3); delete it so rn-xtool " +
        "regenerates it (also remove node_modules/@scope/lib and reinstall: that copy still has the old Package.swift)",
      "⚠ patches/react-native-safe-area-context+5.6.0.patch was scaffolded for React Native 0.86.3; delete it so rn-xtool " +
        "regenerates it for 0.87.1 (also remove node_modules/react-native-safe-area-context and reinstall: that copy still has " +
        "the old Package.swift)",
      "⚠ patches/react-native-screens+4.30.0.patch was written by an older rn-xtool scaffolder (revision 1, now 3); delete it so " +
        "rn-xtool regenerates it (also remove node_modules/react-native-screens and reinstall: that copy still has the old " +
        "Package.swift)",
      "⚠ patches/react-native-screens+4.30.1.patch was written by an older rn-xtool scaffolder (revision 2, now 3); delete it so " +
        "rn-xtool regenerates it (also remove node_modules/react-native-screens and reinstall: that copy still has the old " +
        "Package.swift)",
    ]);
  });

  it("reads the pre-rename expo-xtool-scaffold-revision marker too", async () => {
    const { root } = await tempProject();
    await installPkg(root, "react-native", "0.88.1");
    await mkdir(path.join(root, "patches"));
    const legacy = (slot: string) => scaffoldPatch(slot, 1).replace("rn-xtool-scaffold-revision", "expo-xtool-scaffold-revision");
    await writeFile(path.join(root, "patches", "react-native-screens+4.30.0.patch"), legacy("0.88.0"));
    await writeFile(path.join(root, "patches", "react-native-svg+15.16.0.patch"), legacy("0.88.1"));
    expect(scaffoldPatchWarnings(root)).toEqual([
      "⚠ patches/react-native-screens+4.30.0.patch was scaffolded for React Native 0.88.0; delete it so rn-xtool regenerates " +
        "it for 0.88.1 (also remove node_modules/react-native-screens and reinstall: that copy still has the old Package.swift)",
      "⚠ patches/react-native-svg+15.16.0.patch was written by an older rn-xtool scaffolder (revision 1, now 3); delete it " +
        "so rn-xtool regenerates it (also remove node_modules/react-native-svg and reinstall: that copy still has the old " +
        "Package.swift)",
    ]);
  });

  it("keeps SCAFFOLD_REVISION in step with the scaffolder's RN_XTOOL_SCAFFOLD_REVISION", () => {
    const patch = readFileSync(path.join(packageRoot(), "patches", "react-native+0.88.0.patch"), "utf8");
    const m = /const RN_XTOOL_SCAFFOLD_REVISION = (\d+);/.exec(patch);
    expect(m).not.toBeNull();
    expect(SCAFFOLD_REVISION).toBe(Number(m![1]));
  });

  it("stays quiet when every scaffold patch matches the installed version", async () => {
    const { root } = await tempProject();
    await installPkg(root, "react-native", "0.86.3");
    await mkdir(path.join(root, "patches"));
    await writeFile(path.join(root, "patches", "react-native-screens+4.30.0.patch"), scaffoldPatch("0.86.3"));
    const lines: string[] = [];
    await applyPatches(root, async () => ({ exitCode: 0 }), { rnScripts: "vendored", log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
  });
});
