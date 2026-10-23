import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { jsiFramework, readFlavoredFrameworks, stageFrameworks } from "../src/frameworks.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const tempDirs: string[] = [];

afterEach(async () => {
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

  it.each([
    ["a relative path", "."],
    ["the filesystem root", path.parse(tmpdir()).root],
    ["the home directory", homedir()],
    ["the working directory", process.cwd()],
  ])("refuses %s", async (_label, dir) => {
    await expect(stageFrameworks([], dir)).rejects.toThrow(
      `Refusing to stage frameworks into unsafe directory: ${dir}`,
    );
    await expect(lstat(dir)).resolves.toBeDefined();
  });
});
