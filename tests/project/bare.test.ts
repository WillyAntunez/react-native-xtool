import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProject } from "../../src/project/index.js";
import { readBareProject } from "../../src/project/bare.js";
import { isInstalled } from "../../src/project/expo.js";
import { fakeExpo58Modules } from "../support/expo58.js";

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
    expect(String(err)).toContain(
      "react-native is not installed in " + dir + ": run `npm install` (a fresh clone has no node_modules yet). To add it, " +
        "or to move to another React Native version, follow " +
        "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native " +
        "(a single `npm install react-native@<version>` can fail with ERESOLVE on the template's exact @react-native/* peers).",
    );
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
        "React Native 0.87.0 is not supported; rn-xtool supports 0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1 (bare). Pin react-native to one of them. Expo SDK 58 needs React Native 0.88.1."
      ),
    );
  });

  it("rejects Expo modules on a vendored version", async () => {
    const dir = await tempBare({ rn: "0.86.3", modulesCore: true, expo: true, useExpoModules: true });
    await expect(readBareProject(dir)).rejects.toThrow(
      "React Native 0.86.3 with Expo modules is not supported. Expo SDK 58 needs React Native 0.88.1.",
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
    const dir = await tempBare({ rn: "0.88.1", useExpoModules: true });
    await fakeExpo58Modules(dir);
    expect((await readBareProject(dir)).hasExpoModules).toBe(true);
  });

  it("gates a hybrid app on the SDK 58 set", async () => {
    // A hybrid's react-native moves with the template's @react-native/* packages: the docs' sequence, not one command.
    const UPGRADE =
      "move react-native to 0.88.1 as " +
      "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native " +
      "describes (`npx expo install react-native@0.88.1` alone leaves the template's @react-native/* packages on the old " +
      "version).";
    const G1 = (list: string) =>
      "Expo SDK 58 needs react-native 0.88.1 and at least expo 58.0.21, expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, " +
      `expo-modules-autolinking 58.0.16, expo-file-system 58.0.13 and expo-font 58.0.11; installed: ${list}. ` +
      (list.startsWith("react-native ") && !list.includes(",")
        ? `M${UPGRADE.slice(1)}`
        : "Remove any pin or override on these packages from package.json, then run `npx expo install --fix`; then " +
          UPGRADE);
    const oldCore = await tempBare({ rn: "0.88.1", useExpoModules: true });
    await fakeExpo58Modules(oldCore, { "expo-modules-core": "58.0.26" });
    await expect(readBareProject(oldCore)).rejects.toThrow(new Error(G1("expo-modules-core 58.0.26")));

    const floor = await tempBare({ rn: "0.88.1", useExpoModules: true });
    await fakeExpo58Modules(floor);
    const log = vi.fn();
    await expect(readBareProject(floor, { log })).resolves.toMatchObject({ rnVersion: "0.88.1", hasExpoModules: true });
    expect(log).not.toHaveBeenCalled();

    const rn0880 = await tempBare({ rn: "0.88.0", useExpoModules: true });
    await fakeExpo58Modules(rn0880, { "react-native": "0.88.0" });
    const err = (await readBareProject(rn0880).catch((e: unknown) => e)) as Error;
    expect(err).toEqual(new Error(G1("react-native 0.88.0")));
    expect(err.message).not.toContain("Run `npx expo install react-native@0.88.1`");

    const rnAndCore = await tempBare({ rn: "0.88.0", useExpoModules: true });
    await fakeExpo58Modules(rnAndCore, { "react-native": "0.88.0", "expo-modules-core": "58.0.26" });
    await expect(readBareProject(rnAndCore)).rejects.toThrow(new Error(G1("react-native 0.88.0, expo-modules-core 58.0.26")));

    const vendored = await tempBare({ rn: "0.86.3", useExpoModules: true });
    await fakeExpo58Modules(vendored, { "react-native": "0.86.3" });
    await expect(readBareProject(vendored)).rejects.toThrow(
      "React Native 0.86.3 with Expo modules is not supported. Expo SDK 58 needs React Native 0.88.1.",
    );
  });

  it.each([
    ["57", "57.0.31"],
    ["56", "56.0.4"],
  ])("refuses a hybrid app on Expo SDK %s", async (sdk, expo) => {
    const dir = await tempBare({ rn: "0.88.1", useExpoModules: true });
    await fakeExpo58Modules(dir, { expo });
    await expect(readBareProject(dir)).rejects.toThrow(
      `Expo SDK ${sdk} (expo ${expo}) with Expo modules is not supported in a bare app. Expo modules in a bare app need ` +
        "Expo SDK 58 or newer: install expo ~58.0.21 and run `npx expo install --fix`, then move react-native to 0.88.1 as " +
        "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native describes.",
    );
  });

  it("still gates a hybrid app on Expo SDK 58", async () => {
    const dir = await tempBare({ rn: "0.88.1", useExpoModules: true });
    await fakeExpo58Modules(dir, { expo: "58.0.20" });
    await expect(readBareProject(dir)).rejects.toThrow(/^Expo SDK 58 needs react-native 0\.88\.1 .*; installed: expo 58\.0\.20\. /);
  });

  it.each(["0.88.0", "0.88.1"])("does not gate React Native %s without Expo modules", async (rn) => {
    await expect(readBareProject(await tempBare({ rn }))).resolves.toMatchObject({ rnVersion: rn, hasExpoModules: false });
    // Installed but inactive (no use_expo_modules! in the Podfile): still no gate, below-floor packages included.
    const inactive = await tempBare({ rn });
    await fakeExpo58Modules(inactive, { "react-native": rn, "expo-modules-core": "58.0.26" });
    await expect(readBareProject(inactive, { log: vi.fn() })).resolves.toMatchObject({ rnVersion: rn, hasExpoModules: false });
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
    const expo = await mkdtemp(path.join(tmpdir(), "rn-xtool-expo58-"));
    tempDirs.push(expo);
    await cp(path.join(fixtures, "project"), expo, { recursive: true });
    await fakeExpo58Modules(expo);
    expect((await readProject(expo, { writeDefaults: false })).kind).toBe("expo");
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
