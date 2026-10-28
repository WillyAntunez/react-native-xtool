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

async function tempBare(opts: { fixture?: string; rn?: string; expo?: boolean; modulesCore?: boolean; useExpoModules?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-bare-"));
  tempDirs.push(dir);
  await cp(path.join(fixtures, opts.fixture ?? "bare"), dir, { recursive: true });
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
    expect(p.rnScripts).toBe("installed");
  });

  it("says react-native is not installed, and how to install it, instead of an unknown version", async () => {
    const dir = await tempBare();
    await rm(path.join(dir, "node_modules", "react-native"), { recursive: true });
    const err = await readBareProject(dir).catch((e: unknown) => e);
    expect(String(err)).toMatch(/react-native is not installed.*npm install/);
    expect(String(err)).not.toContain("unknown");
  });

  it("accepts each supported version", async () => {
    for (const [rn, scripts] of [["0.86.2", "vendored"], ["0.86.3", "vendored"], ["0.87.1", "vendored"], ["0.88.0", "installed"]] as const) {
      const p = await readBareProject(await tempBare({ rn }));
      expect(p.rnVersion).toBe(rn);
      expect(p.rnScripts).toBe(scripts);
    }
  });

  it("accepts bare React Native 0.88.1", async () => {
    const p = await readBareProject(await tempBare({ rn: "0.88.1" }));
    expect(p.rnVersion).toBe("0.88.1");
    expect(p.rnScripts).toBe("installed");
  });

  it("rejects unsupported versions with the supported list", async () => {
    for (const rn of ["0.86.0", "0.86.1", "0.87.0", "0.85.0", "0.89.0", "0.88.2", "0.88.0-rc.1", "0.88.1-rc.1"]) {
      await expect(readBareProject(await tempBare({ rn }))).rejects.toThrow(
        `React Native ${rn} is not supported; rn-xtool supports 0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1 (bare). Pin react-native to one of them.`,
      );
    }
  });

  it("adds the Expo SDK sentence for an unsupported version with Expo modules", async () => {
    const dir = await tempBare({ rn: "0.87.0", modulesCore: true, expo: true });
    await expect(readBareProject(dir)).rejects.toThrow(
      (
        "React Native 0.87.0 is not supported; rn-xtool supports 0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1 (bare). Pin react-native to one of them. Expo SDK 58 needs React Native 0.88.0."
      ),
    );
  });

  it("rejects Expo modules on a vendored version", async () => {
    const dir = await tempBare({ rn: "0.86.3", modulesCore: true, expo: true, useExpoModules: true });
    await expect(readBareProject(dir)).rejects.toThrow(
      "React Native 0.86.3 with Expo modules is not supported. Expo SDK 58 needs React Native 0.88.0.",
    );
    const noPodfileLine = await tempBare({ rn: "0.86.3", modulesCore: true, expo: true });
    await expect(readBareProject(noPodfileLine)).rejects.toThrow(/with Expo modules is not supported/);
  });

  it.each([
    ["bare-086", "0.86.3"],
    ["bare-087", "0.87.1"],
  ])("reads the %s template (React Native %s)", async (fixture, rn) => {
    const p = await readBareProject(await tempBare({ fixture, rn }));
    expect(p.bare!.swiftSources.map((f) => f.relPath)).toEqual(["HelloWorld/AppDelegate.swift"]);
    expect(p.bundleIdentifier).toBe("org.reactjs.native.example.HelloWorld");
    expect(p.rnScripts).toBe("vendored");
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

  it("tells bare users to set PRODUCT_BUNDLE_IDENTIFIER in the Xcode project, never the expo config", async () => {
    const dir = await tempBare();
    const pbx = path.join(dir, "ios", "HelloWorld.xcodeproj", "project.pbxproj");
    await writeFile(pbx, (await readFile(pbx, "utf8")).replace(/PRODUCT_BUNDLE_IDENTIFIER = .*;\n/g, ""));
    const err = (await readBareProject(dir).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("PRODUCT_BUNDLE_IDENTIFIER");
    expect(err.message).toContain("Xcode project");
    expect(err.message).toContain("com.anonymous.helloworld");
    expect(err.message).not.toMatch(/expo config|app\.json|ios\.bundleIdentifier|rn-xtool build/);
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
