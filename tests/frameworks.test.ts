import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsiFramework, readFlavoredFrameworks, stageFrameworks } from "../src/frameworks.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "expo-xtool-frameworks-"));
  tempDirs.push(dir);
  return dir;
}

describe("readFlavoredFrameworks", () => {
  it("lists the dynamic ios-arm64 frameworks in manifest order", () => {
    const list = readFlavoredFrameworks(fixtures, "debug");
    expect(list.map((f) => f.name)).toEqual([
      "React",
      "ReactNativeDependencies",
      "hermesvm",
      "ExpoFileSystem",
      "ExpoFont",
      "ExpoModulesCore",
      "ExpoModulesWorklets",
    ]);
    const hermes = list.find((f) => f.id === "hermes")!;
    expect(hermes.searchPath.endsWith("debug/hermes-engine.xcframework/ios-arm64")).toBe(true);
    expect(hermes.frameworkDir.startsWith(hermes.searchPath)).toBe(true);
    expect(hermes.executable).toBe("hermesvm");
  });

  it("throws when the manifest is missing", async () => {
    const dir = await tempDir();
    expect(() => readFlavoredFrameworks(dir, "debug")).toThrow(/flavored-frameworks\.json not found/);
  });

  it("throws on an unsupported manifest version", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "flavored-frameworks.json"), JSON.stringify({ version: 2, frameworks: [] }));
    expect(() => readFlavoredFrameworks(dir, "debug")).toThrow(/version/);
  });
});

describe("readFlavoredFrameworks manifest validation", () => {
  it("wraps JSON parse errors with the file path", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "flavored-frameworks.json"), "{not json");
    expect(() => readFlavoredFrameworks(dir, "debug")).toThrow(/Could not parse .*flavored-frameworks\.json: /);
  });

  it("rejects a manifest without a frameworks array", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "flavored-frameworks.json"), JSON.stringify({ version: 1 }));
    expect(() => readFlavoredFrameworks(dir, "debug")).toThrow(/"frameworks" must be an array/);
  });
});

describe("jsiFramework", () => {
  it("describes the ExpoModulesJSI framework", () => {
    expect(jsiFramework("/out")).toEqual({
      id: "expo-modules-jsi",
      name: "ExpoModulesJSI",
      executable: "ExpoModulesJSI",
      searchPath: "/out",
      frameworkDir: "/out/ExpoModulesJSI.framework",
    });
  });
});

describe("stageFrameworks", () => {
  it("copies frameworks, dereferencing symlinks and clearing the destination", async () => {
    const root = await tempDir();
    const fw = path.join(root, "src", "X.framework");
    await mkdir(fw, { recursive: true });
    await writeFile(path.join(root, "real.txt"), "payload");
    await symlink(path.join(root, "real.txt"), path.join(fw, "link.txt"));
    const dest = path.join(root, "dest");
    await mkdir(dest);
    await writeFile(path.join(dest, "stale"), "old");

    await stageFrameworks(
      [{ id: "x", name: "X", executable: "X", searchPath: path.dirname(fw), frameworkDir: fw }],
      dest,
    );

    const staged = path.join(dest, "X.framework", "link.txt");
    expect((await lstat(staged)).isSymbolicLink()).toBe(false);
    expect(await readFile(staged, "utf8")).toBe("payload");
    await expect(lstat(path.join(dest, "stale"))).rejects.toThrow();
  });

  const unsafe = (dir: string) => `Refusing to stage frameworks into unsafe directory: ${dir}`;

  async function sandbox(): Promise<{ dir: string; sentinel: string }> {
    const dir = await tempDir();
    const sentinel = path.join(dir, "sentinel");
    await writeFile(sentinel, "keep");
    return { dir, sentinel };
  }

  it("refuses the filesystem root", async () => {
    const root = path.parse(tmpdir()).root;
    await expect(stageFrameworks([], root)).rejects.toThrow(unsafe(root));
  });

  it("refuses the home directory", async () => {
    const { dir, sentinel } = await sandbox();
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    await expect(stageFrameworks([], dir)).rejects.toThrow(unsafe(dir));
    await expect(lstat(sentinel)).resolves.toBeDefined();
  });

  it("refuses the working directory", async () => {
    const { dir, sentinel } = await sandbox();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await expect(stageFrameworks([], dir)).rejects.toThrow(unsafe(dir));
    await expect(lstat(sentinel)).resolves.toBeDefined();
  });

  it("refuses a relative path", async () => {
    const { dir, sentinel } = await sandbox();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    await expect(stageFrameworks([], ".")).rejects.toThrow(unsafe("."));
    await expect(lstat(sentinel)).resolves.toBeDefined();
  });
});
