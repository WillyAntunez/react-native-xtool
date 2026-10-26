import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProject } from "../../src/project/index.js";
import { readBareProject } from "../../src/project/bare.js";
import { isInstalled } from "../../src/project/expo.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function addPackage(dir: string, name: string, version = "1.0.0"): Promise<void> {
  const d = path.join(dir, "node_modules", name);
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, "package.json"), JSON.stringify({ name, version }));
}

async function tempBare(opts: { rn?: string; expo?: boolean; modulesCore?: boolean; useExpoModules?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-bare-"));
  tempDirs.push(dir);
  await cp(path.join(fixtures, "bare"), dir, { recursive: true });
  await addPackage(dir, "react-native", opts.rn ?? "0.88.0");
  if (opts.modulesCore) await addPackage(dir, "expo-modules-core");
  if (opts.expo) await addPackage(dir, "expo");
  if (opts.useExpoModules) {
    const podfile = path.join(dir, "ios", "Podfile");
    await writeFile(podfile, `${await readFile(podfile, "utf8")}\nuse_expo_modules!\n`);
  }
  return dir;
}

describe("readBareProject", () => {
  it("reads the template", async () => {
    const dir = await tempBare();
    const p = await readBareProject(dir);
    expect(p.kind).toBe("bare");
    expect(p.name).toBe("HelloWorld");
    expect(p.bundleIdentifier).toBe("org.reactjs.native.example.HelloWorld");
    expect(p.moduleName).toBe("HelloWorld");
    expect(p.version).toBe("1.0");
    expect(p.buildNumber).toBe("1");
    expect(p.infoPlistPath.endsWith("ios/HelloWorld/Info.plist")).toBe(true);
    expect(p.hasExpoModules).toBe(false);
    expect(p.bare!.swiftSources.length).toBe(2);
  });

  it("says react-native is not installed, and how to install it, instead of an unknown version", async () => {
    const dir = await tempBare();
    await rm(path.join(dir, "node_modules", "react-native"), { recursive: true });
    const err = await readBareProject(dir).catch((e: unknown) => e);
    expect(String(err)).toMatch(/react-native is not installed.*npm install/);
    expect(String(err)).not.toContain("unknown");
  });

  it("rejects react-native below 0.88", async () => {
    const dir = await tempBare({ rn: "0.87.0" });
    await expect(readBareProject(dir)).rejects.toThrow(/0\.87\.0.*0\.88/);
  });

  it("accepts a 0.88 prerelease", async () => {
    const dir = await tempBare({ rn: "0.88.0-rc.1" });
    expect((await readBareProject(dir)).rnVersion).toBe("0.88.0-rc.1");
  });

  it("detects the hybrid shape", async () => {
    const dir = await tempBare({ modulesCore: true, expo: true, useExpoModules: true });
    expect((await readBareProject(dir)).hasExpoModules).toBe(true);
  });

  it("warns when expo modules are installed but not set up in the Podfile", async () => {
    const dir = await tempBare({ modulesCore: true, expo: true });
    const log = vi.fn();
    const p = await readBareProject(dir, { log });
    expect(p.hasExpoModules).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/use_expo_modules!/));
  });

  it("requires expo next to expo-modules-core", async () => {
    const dir = await tempBare({ modulesCore: true });
    await expect(readBareProject(dir)).rejects.toThrow(/install-expo-modules/);
  });

  it("says whether @react-native-community/cli resolves from the project root", async () => {
    const dir = await tempBare();
    expect((await readBareProject(dir)).hasRnCli).toBe(false);
    await addPackage(dir, "@react-native-community/cli", "20.2.0");
    expect((await readBareProject(dir)).hasRnCli).toBe(true);
  });

  it("does not modify the ios directory when the bundle id is missing", async () => {
    const dir = await tempBare();
    const pbx = path.join(dir, "ios", "HelloWorld.xcodeproj", "project.pbxproj");
    const text = (await readFile(pbx, "utf8")).replace(/PRODUCT_BUNDLE_IDENTIFIER = .*;\n/g, "");
    await writeFile(pbx, text);
    await expect(readBareProject(dir)).rejects.toMatchObject({
      name: "MissingBundleIdentifierError",
      suggestion: "com.anonymous.helloworld",
      configFile: "project.pbxproj",
    });
    expect(await readFile(pbx, "utf8")).toBe(text);
  });
});

describe("readProject", () => {
  it("dispatches on kind", async () => {
    expect((await readProject(path.join(fixtures, "project"), { writeDefaults: false })).kind).toBe("expo");
    const dir = await tempBare();
    expect((await readProject(dir)).kind).toBe("bare");
  });
});

describe("isInstalled", () => {
  it("finds a package nested under node_modules/expo", async () => {
    const dir = await tempBare({ expo: true });
    await addPackage(path.join(dir, "node_modules", "expo"), "expo-constants");
    expect(isInstalled(dir, "expo-constants")).toBe(true);
  });

  it("is false when the package is nowhere", async () => {
    const dir = await tempBare({ expo: true });
    expect(isInstalled(dir, "expo-constants")).toBe(false);
  });
});
