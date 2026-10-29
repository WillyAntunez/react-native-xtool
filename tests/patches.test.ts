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
    const err = (await applyPatches(root, exec, { rnScripts: "installed" }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/pin "react-native" to 0\.88\.1/);
    expect(err.message).toContain(
      "patch-package was not run: react-native 0.88.2 is installed and the bundled react-native patches are for 0.88.0 and 0.88.1.",
    );
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
    const err = (await applyPatches(root, exec, { rnScripts: "installed", expoPlugin: "installed" }).catch(
      (e: unknown) => e,
    )) as Error;
    // On the floor: npm overrides hold Expo's modules on the verified set (one copy each, checked with npm 11 on
    // 2026-10-28), or the user waits for a release. A direct expo-modules-* pin would nest the copy expo uses.
    const OVERRIDES =
      '"overrides": { "expo-modules-core": "58.0.28", "expo-modules-jsi": "58.0.21", "expo-modules-autolinking": "58.0.16" }';
    const notDirect =
      "Do not pin expo-modules-* packages as direct dependencies: npm would nest the copy expo uses. Remove any that " +
      "package.json lists before you add the block (`npm uninstall <package>`): npm refuses an override that differs " +
      "from a direct dependency (EOVERRIDE). If `rn-xtool doctor` then says expo-modules-jsi resolves from a nested " +
      "copy, run `npm update expo-modules-jsi`.";
    const options = (overrides: string, extra = "") =>
      `Options: add an "overrides" block with the set this release was verified with to package.json, ${overrides}, ` +
      `and run \`npm install\`${extra}; or wait for an rn-xtool release that supports the new version, and report it ` +
      "at https://github.com/WillyAntunez/react-native-xtool/issues.";
    expect(err.message.split("\n").slice(0, 5)).toEqual([
      "rn-xtool could not patch expo-modules-jsi@58.0.23 (patch file: expo-modules-jsi+58.0.21.patch): the installed " +
        "version differs from the one this release of rn-xtool patches (58.0.21).",
      "This is a known limitation of rn-xtool, not of your project.",
      options(OVERRIDES),
      notDirect,
      "--- patch-package output ---",
    ]);
    expect(err.message).not.toContain('pin "expo-modules-jsi"');

    // The failing package outside that trio (expo) joins the block at its floor; as a direct dependency its own entry
    // must say the same version, or npm stops with EOVERRIDE.
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { expo: "~58.0.22" } }));
    const expoFails = async () => ({
      exitCode: 1,
      all: "**ERROR** Failed to apply patch for package expo at path\n    node_modules/expo",
    });
    const expoErr = (await applyPatches(root, expoFails, { rnScripts: "installed", expoPlugin: "installed" }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(expoErr.message.split("\n").slice(2, 4)).toEqual([
      options(
        `${OVERRIDES.slice(0, -2)}, "expo": "58.0.21" }`,
        ' (expo is a direct dependency: set it to "58.0.21" in dependencies too)',
      ),
      notDirect,
    ]);
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
    // The staged jsi patch is for the installed 57.1.3, so its failure means a differently patched copy.
    expect((err as Error).message).toMatch(/^rn-xtool could not apply its patch to expo-modules-jsi@57\.1\.3 /);
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
  it("blames the package an error names, not one a version-mismatch warning names", async () => {
    const { root, patchDir } = await fakeProject({ expo: "58.9.9", "expo-modules-autolinking": "58.9.9" });
    const output = [
      versionMismatchWarning("expo", "58.0.21", "58.9.9"),
      applicationFailureError("expo-modules-autolinking", "58.0.16", "58.9.9"),
      "---",
      "patch-package finished with 1 warning(s), 1 error(s).",
    ].join("\n");
    expect(findPatchMismatch(root, patchDir, output)?.pkg).toBe("expo-modules-autolinking");
  });
  it("matches the patch file prefix and the node_modules path", () => {
    expect(outputNamesPackage("applying expo+58.0.21.patch", "expo")).toBe(true);
    expect(outputNamesPackage("at node_modules/expo/package.json", "expo")).toBe(true);
    expect(outputNamesPackage("applying @expo+config+1.0.0.patch", "@expo/config")).toBe(true);
    expect(outputNamesPackage("node_modules/@expo/config", "@expo/config")).toBe(true);
  });
});

describe("a bundled patch over a package an earlier release patched differently", () => {
  const JSI_FILE = "apple/Sources/ExpoModulesJSI/Runtime/Values/JavaScriptError.swift";
  /** The lines around rn-xtool's one-line jsi change, with `line` where the change goes. */
  const jsiSource = (line: string) =>
    [
      ...Array.from({ length: 87 }, (_, i) => `// line ${i + 1}`),
      "/// via the `SWIFT_NAME(_message)` annotation in `CppError.h`. This extension",
      "/// wraps it in a Swift `String` for cleaner call-site usage.",
      "extension expo.CppError: Error {",
      line,
      "    return String(_getMessage())",
      "  }",
      "}",
      "",
    ].join("\n");

  async function jsiProject(line: string) {
    const { root } = await tempProject();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    await installPkg(root, "expo-modules-jsi", "58.0.21");
    const file = path.join(root, "node_modules", "expo-modules-jsi", JSI_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, jsiSource(line));
    return { root, file };
  }

  it("applies to the original file", async () => {
    const { root, file } = await jsiProject("  public var message: String {");
    await applyPatches(root, undefined, { rnScripts: "vendored", expoPlugin: "installed" });
    expect(readFileSync(file, "utf8")).toContain("\n  var message: String {\n");
  }, 30_000);

  it("names the package and the reinstall when the patch applies neither way", async () => {
    // Already patched differently: neither the original line nor the one the patch writes.
    const { root } = await jsiProject("  internal var message: String {");
    const err = (await applyPatches(root, undefined, { rnScripts: "vendored", expoPlugin: "installed" }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.split("\n").slice(0, 3)).toEqual([
      "rn-xtool could not apply its patch to expo-modules-jsi@58.0.21 (patch file: expo-modules-jsi+58.0.21.patch): " +
        "node_modules/expo-modules-jsi is the version the patch is for, but its files match neither the original " +
        "package nor the patched one.",
      "This usually means an earlier rn-xtool release (such as 0.1.0-alpha.2) patched it differently, or its files " +
        "were edited by hand.",
      "Reinstall the package, then build again: rm -rf node_modules/expo-modules-jsi && npm install",
    ]);
    expect(err.message).toContain("--- patch-package output ---");
    expect(err.message).not.toContain("Report this");
  }, 30_000);

  it("blames the package patch-package failed on, not a newer expo whose patch applied", async () => {
    // A newer 58.x expo still takes the floor patch (with a warning); jsi, at the patch's version, fails because
    // alpha.2 patched it differently. The reinstall of jsi is the fix, not an overrides block for expo.
    const { root } = await tempProject();
    await installPkg(root, "expo", "58.0.22");
    await installPkg(root, "expo-modules-autolinking", "58.0.16");
    await installPkg(root, "expo-modules-jsi", "58.0.21");
    await installPkg(root, "react-native", "0.88.1");
    const output = [
      "expo-modules-autolinking@58.0.16 ✔",
      "react-native@0.88.1 ✔",
      versionMismatchWarning("expo", "58.0.21", "58.0.22"),
      brokenPatchFileError("expo-modules-jsi", "expo-modules-jsi+58.0.21.patch"),
      "---",
      "patch-package finished with 1 warning(s), 1 error(s).",
    ].join("\n");
    const err = (await applyPatches(root, async () => ({ exitCode: 1, all: output }), {
      rnScripts: "installed",
      expoPlugin: "installed",
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.split("\n").slice(0, 3)).toEqual([
      "rn-xtool could not apply its patch to expo-modules-jsi@58.0.21 (patch file: expo-modules-jsi+58.0.21.patch): " +
        "node_modules/expo-modules-jsi is the version the patch is for, but its files match neither the original " +
        "package nor the patched one.",
      "This usually means an earlier rn-xtool release (such as 0.1.0-alpha.2) patched it differently, or its files " +
        "were edited by hand.",
      "Reinstall the package, then build again: rm -rf node_modules/expo-modules-jsi && npm install",
    ]);
    expect(err.message).not.toContain('"overrides"');
  });
});

/** patch-package 8.0.1's texts (dist/applyPatches.js, no colour), so the tests read real output shapes. */
function versionMismatchWarning(pkg: string, made: string, installed: string): string {
  return `
Warning: patch-package detected a patch file version mismatch

  Don't worry! This is probably fine. The patch was still applied
  successfully. Here's the deets:

  Patch file created for

    ${pkg}@${made}

  applied to

    ${pkg}@${installed}

  At path

    node_modules/${pkg}

  This warning is just to give you a heads-up. There is a small chance of
  breakage even though the patch was applied successfully. Make sure the package
  still behaves like you expect (you wrote tests, right?) and then run

    patch-package ${pkg}

  to update the version in the patch file name and make this warning go away.
`;
}

function brokenPatchFileError(pkg: string, patchFile: string): string {
  return `
**ERROR** Failed to apply patch for package ${pkg} at path

    node_modules/${pkg}

  This error was caused because patch-package cannot apply the following patch file:

    patches/${patchFile}
`;
}

function applicationFailureError(pkg: string, made: string, installed: string): string {
  return `
**ERROR** Failed to apply patch for package ${pkg} at path

    node_modules/${pkg}

  This error was caused because ${pkg} has changed since you
  made the patch file for it.

  Info:
    Patch file: patches/${pkg}+${made}.patch
    Patch was made for version: ${made}
    Installed version: ${installed}
`;
}

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

describe("scaffolded manifests in node_modules older than the scaffolder or the persisted patch", () => {
  const BANNER = "// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.";
  /** A scaffolded Package.swift; `marker` is the revision line's name (`expo-xtool…` before the rename, null: none). */
  const manifest = (revision: number, slot: string | null, marker: string | null = "rn-xtool-scaffold-revision") =>
    [
      "// swift-tools-version: 6.0",
      BANNER,
      "// AUTO-SCAFFOLDED-VERSION: 20",
      ...(marker !== null ? [`// ${marker}: ${revision}`] : []),
      ...(slot !== null ? [`// Cache slot: ${slot}/dual-flavor`] : []),
      "import PackageDescription",
      "",
    ].join("\n");
  const stub = (name: string) => `// AUTO-SCAFFOLDED by react-native spm scaffold — the <lib/${name}>\n#import "../../ios/${name}"\n`;

  /** A persisted scaffold patch as patch-package writes it: one new file per entry. */
  const newFilesPatch = (pkg: string, files: Record<string, string>) =>
    Object.entries(files)
      .map(([rel, text]) => {
        const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
        return [
          `diff --git a/node_modules/${pkg}/${rel} b/node_modules/${pkg}/${rel}`,
          "new file mode 100644",
          "index 0000000..1111111",
          "--- /dev/null",
          `+++ b/node_modules/${pkg}/${rel}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((l) => `+${l}`),
          "",
        ].join("\n");
      })
      .join("");

  // React Native 0.87.1 has no bundled patch: only the project's patches run, through the real patch-package.
  async function project(rn = "0.87.1") {
    const { root } = await tempProject();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    await installPkg(root, "react-native", rn);
    return root;
  }
  async function put(root: string, rel: string, text: string) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  const read = (root: string, rel: string) => readFileSync(path.join(root, rel), "utf8");
  const noBundled = { rnScripts: "vendored" as const };

  it("replaces an older node_modules copy of a current persisted patch (a teammate's pull)", async () => {
    const root = await project();
    await installPkg(root, "react-native-screens", "4.30.0");
    const current = { "Package.swift": manifest(3, "0.87.1"), "include/rnscreens/RNSDefines.h": stub("RNSDefines.h") };
    await put(root, "patches/react-native-screens+4.30.0.patch", newFilesPatch("react-native-screens", current));
    // What the old patch left in node_modules: revision 1, slot 0.86.3, a stub the new scaffold no longer writes.
    await put(root, "node_modules/react-native-screens/Package.swift", manifest(1, "0.86.3"));
    await put(root, "node_modules/react-native-screens/include/rnscreens/RNSDefines.h", stub("old/RNSDefines.h"));
    await put(root, "node_modules/react-native-screens/include/rnscreens/Gone.h", stub("Gone.h"));
    const lines: string[] = [];
    await applyPatches(root, undefined, { ...noBundled, log: (l) => lines.push(l) });
    expect(read(root, "node_modules/react-native-screens/Package.swift")).toBe(current["Package.swift"]);
    expect(read(root, "node_modules/react-native-screens/include/rnscreens/RNSDefines.h")).toBe(stub("RNSDefines.h"));
    expect(existsSync(path.join(root, "node_modules/react-native-screens/include/rnscreens/Gone.h"))).toBe(true);
    expect(lines).toEqual([
      "ℹ node_modules/react-native-screens/Package.swift was scaffolded with revision 1 for React Native 0.86.3, " +
        "older than patches/react-native-screens+4.30.0.patch (revision 3, React Native 0.87.1): rn-xtool replaced it " +
        "with the persisted one",
    ]);
    // Idempotent: the next build changes nothing.
    lines.length = 0;
    await applyPatches(root, undefined, { ...noBundled, log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
    expect(read(root, "node_modules/react-native-screens/Package.swift")).toBe(current["Package.swift"]);
  }, 30_000);

  it("keeps an older copy whose persisted patch also edits the library, and names the reinstall", async () => {
    // rn-xtool persists with `patch-package <name>`, so a library that already carries the user's own fix gets one
    // combined patch: the scaffold's new files plus that fix. Removing the scaffold files would make patch-package
    // fail both ways on every build; patch-package alone accepts the combined patch as applied.
    const root = await project();
    await installPkg(root, "lib", "1.0.0");
    const fix = [
      "diff --git a/node_modules/lib/ios/Foo.m b/node_modules/lib/ios/Foo.m",
      "index 1111111..2222222 100644",
      "--- a/node_modules/lib/ios/Foo.m",
      "+++ b/node_modules/lib/ios/Foo.m",
      "@@ -1,3 +1,3 @@",
      " line 1",
      "-old",
      "+new",
      " line 3",
      "",
    ].join("\n");
    await put(root, "patches/lib+1.0.0.patch", newFilesPatch("lib", { "Package.swift": manifest(3, "0.87.1") }) + fix);
    await put(root, "node_modules/lib/Package.swift", manifest(1, "0.86.3"));
    await put(root, "node_modules/lib/ios/Foo.m", "line 1\nnew\nline 3\n");
    for (const run of [1, 2]) {
      const lines: string[] = [];
      await applyPatches(root, undefined, { ...noBundled, log: (l) => lines.push(l) });
      expect(read(root, "node_modules/lib/Package.swift"), `run ${run}`).toBe(manifest(1, "0.86.3"));
      expect(lines, `run ${run}`).toEqual([
        "⚠ node_modules/lib/Package.swift was scaffolded with revision 1 for React Native 0.86.3, older than " +
          "patches/lib+1.0.0.patch (revision 3, React Native 0.87.1), and that patch also changes the library's own " +
          "files, so rn-xtool does not replace it: run rm -rf node_modules/lib && npm install, then build again",
      ]);
    }
  }, 30_000);

  it("treats the pre-rename marker in node_modules as an older revision", async () => {
    const root = await project();
    await installPkg(root, "react-native-svg", "15.16.0");
    await put(root, "patches/react-native-svg+15.16.0.patch", newFilesPatch("react-native-svg", { "Package.swift": manifest(3, "0.87.1") }));
    await put(root, "node_modules/react-native-svg/Package.swift", manifest(1, "0.87.1", "expo-xtool-scaffold-revision"));
    const lines: string[] = [];
    await applyPatches(root, undefined, { ...noBundled, log: (l) => lines.push(l) });
    expect(read(root, "node_modules/react-native-svg/Package.swift")).toBe(manifest(3, "0.87.1"));
    expect(lines).toEqual([
      "ℹ node_modules/react-native-svg/Package.swift was scaffolded with revision 1 for React Native 0.87.1, older than " +
        "patches/react-native-svg+15.16.0.patch (revision 3, React Native 0.87.1): rn-xtool replaced it with the " +
        "persisted one",
    ]);
  }, 30_000);

  it("removes a stale scaffold with no persisted patch, so the rn-spm step scaffolds it again", async () => {
    const root = await project();
    await put(root, "node_modules/react-native-webview/Package.swift", manifest(2, "0.87.1"));
    await put(root, "node_modules/@react-native-community/datetimepicker/Package.swift", manifest(3, "0.86.3"));
    await put(root, "node_modules/legacy-lib/Package.swift", manifest(1, null, "expo-xtool-scaffold-revision"));
    const lines: string[] = [];
    await applyPatches(root, async () => ({ exitCode: 0 }), { ...noBundled, log: (l) => lines.push(l) });
    for (const pkg of ["react-native-webview", "@react-native-community/datetimepicker", "legacy-lib"]) {
      expect(existsSync(path.join(root, "node_modules", pkg, "Package.swift")), pkg).toBe(false);
    }
    expect(lines).toEqual([
      "ℹ node_modules/@react-native-community/datetimepicker/Package.swift was scaffolded for React Native 0.86.3, not " +
        "0.87.1: rn-xtool removed it so the rn-spm step scaffolds it again",
      "ℹ node_modules/legacy-lib/Package.swift was scaffolded by an older rn-xtool scaffolder (revision 1, now 3): " +
        "rn-xtool removed it so the rn-spm step scaffolds it again",
      "ℹ node_modules/react-native-webview/Package.swift was scaffolded by an older rn-xtool scaffolder (revision 2, now " +
        "3): rn-xtool removed it so the rn-spm step scaffolds it again",
    ]);
  });

  it("leaves current, foreign and stale-patch manifests alone", async () => {
    const root = await project();
    const files: Record<string, string> = {
      // Current: revision 3 on the installed React Native.
      "node_modules/current-lib/Package.swift": manifest(3, "0.87.1"),
      // Not rn-xtool's: the upstream scaffolder without rn-xtool's marker (a library may ship it), or hand-written.
      "node_modules/upstream-lib/Package.swift": manifest(0, null, null),
      "node_modules/own-lib/Package.swift": "// swift-tools-version: 6.0\nimport PackageDescription\n",
      // Its persisted patch is stale too: the warning names it, and node_modules follows the patch.
      "node_modules/react-native-screens/Package.swift": manifest(1, "0.86.3"),
      "patches/react-native-screens+4.30.0.patch": newFilesPatch("react-native-screens", { "Package.swift": manifest(1, "0.86.3") }),
      // A current patch over a current copy.
      "node_modules/react-native-svg/Package.swift": manifest(3, "0.87.1"),
      "patches/react-native-svg+15.16.0.patch": newFilesPatch("react-native-svg", { "Package.swift": manifest(3, "0.87.1") }),
    };
    for (const [rel, text] of Object.entries(files)) await put(root, rel, text);
    const lines: string[] = [];
    await applyPatches(root, async () => ({ exitCode: 0 }), { ...noBundled, log: (l) => lines.push(l) });
    for (const [rel, text] of Object.entries(files)) expect(read(root, rel), rel).toBe(text);
    expect(lines).toEqual([expect.stringMatching(/^⚠ patches\/react-native-screens\+4\.30\.0\.patch was scaffolded for React Native 0\.86\.3;/)]);
  });
});
