import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildVars, readExpoProject } from "../src/project.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "project");

async function tempProject(
  mutate: (app: { expo: Record<string, any> }, pkg: Record<string, any>) => void,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "expo-xtool-project-"));
  await cp(fixture, dir, { recursive: true });
  const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  mutate(app, pkg);
  await writeFile(path.join(dir, "app.json"), JSON.stringify(app));
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

describe("readExpoProject", () => {
  it("reads the fixture project", async () => {
    const p = await readExpoProject(fixture);
    expect(p.bundleIdentifier).toBe("com.willyantuneztowerhouse.app");
    expect(p.iosTargetName).toBe("app");
    expect(p.iosTargetDir).toBe(path.join(fixture, "ios", "app"));
    expect(p.sdkVersion).toBe(58);
    expect(p.version).toBe("1.0.0");
    expect(p.buildNumber).toBe("1");
    expect(p.slug).toBe("app");
  });

  it("sanitizes the target name like prebuild", async () => {
    const dir = await tempProject((app) => {
      app.expo.name = "Mi App Ñandú 2";
    });
    expect((await readExpoProject(dir)).iosTargetName).toBe("MiAppNandu2");
  });

  it("rejects sdk below 58", async () => {
    const dir = await tempProject((_app, pkg) => {
      pkg.dependencies.expo = "~57.0.0";
    });
    await expect(readExpoProject(dir)).rejects.toThrow(/58/);
  });

  it("throws when bundleIdentifier is missing", async () => {
    const dir = await tempProject((app) => {
      delete app.expo.ios.bundleIdentifier;
    });
    await expect(readExpoProject(dir)).rejects.toThrow(/bundleIdentifier/);
  });
});

describe("buildVars", () => {
  it("derives the build variables", async () => {
    const p = await readExpoProject(fixture);
    expect(buildVars(p)).toEqual({
      PRODUCT_NAME: "app",
      PRODUCT_BUNDLE_IDENTIFIER: "com.willyantuneztowerhouse.app",
      MARKETING_VERSION: "1.0.0",
      CURRENT_PROJECT_VERSION: "1",
      PRODUCT_MODULE_NAME: "App",
      EXECUTABLE_NAME: "App",
      DEVELOPMENT_LANGUAGE: "en",
      PRODUCT_BUNDLE_PACKAGE_TYPE: "APPL",
    });
  });
});
