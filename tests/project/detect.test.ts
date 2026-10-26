import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectKind } from "../../src/project/detect.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function temp(fixture: "project" | "bare"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "expo-xtool-detect-"));
  tempDirs.push(dir);
  await cp(path.join(fixtures, fixture), dir, { recursive: true });
  return dir;
}

async function addExpoDep(dir: string): Promise<void> {
  const file = path.join(dir, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8"));
  pkg.dependencies = { ...pkg.dependencies, expo: "~58.0.19" };
  await writeFile(file, JSON.stringify(pkg));
}

describe("detectProjectKind", () => {
  it("detects an Expo project (expo dep + app.json with expo key)", async () => {
    expect(detectProjectKind(await temp("project"))).toBe("expo");
  });

  it("detects app.config.js as Expo", async () => {
    const dir = await temp("project");
    await rm(path.join(dir, "app.json"));
    await writeFile(path.join(dir, "app.config.js"), "module.exports = { name: 'app', slug: 'app' };");
    expect(detectProjectKind(dir)).toBe("expo");
  });

  it("treats the template app.json as no Expo config", async () => {
    const dir = await temp("bare");
    await addExpoDep(dir);
    expect(detectProjectKind(dir)).toBe("bare");
  });

  it("detects the template as bare", async () => {
    expect(detectProjectKind(await temp("bare"))).toBe("bare");
  });

  it("honours the projectKind override", async () => {
    expect(detectProjectKind(await temp("bare"), "expo")).toBe("expo");
  });

  it("fails without ios and without expo config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "expo-xtool-detect-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: {} }));
    expect(() => detectProjectKind(dir)).toThrow(/no ios\/ directory.*@react-native-community\/cli init/);
  });

  it("points an Expo project with a flat app.json at projectKind, not at the RN CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "expo-xtool-detect-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { expo: "~58.0.19" } }));
    await writeFile(path.join(dir, "app.json"), JSON.stringify({ name: "x", slug: "x" }));
    const noIos = () => detectProjectKind(dir);
    expect(noIos).toThrow(/"projectKind": "expo".*expo-xtool\.config\.json/);
    expect(noIos).not.toThrow(/@react-native-community\/cli init/);
    await mkdir(path.join(dir, "ios"));
    expect(() => detectProjectKind(dir)).toThrow(/"projectKind": "expo".*expo-xtool\.config\.json/);
  });

  it("fails with two xcodeproj", async () => {
    const dir = await temp("bare");
    await mkdir(path.join(dir, "ios", "Other.xcodeproj"));
    expect(() => detectProjectKind(dir)).toThrow(/HelloWorld\.xcodeproj.*Other\.xcodeproj|Other\.xcodeproj.*HelloWorld\.xcodeproj/);
  });
});
