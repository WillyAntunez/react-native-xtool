import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVars, defaultBundleIdentifier, MissingBundleIdentifierError, readExpoProject } from "../../src/project/index.js";
import { VersionGateError } from "../../src/project/detect.js";
import { checkExpoPackages, expoIconPath, expoMacrosBinaryError, expoPackageDir, readExpoPins } from "../../src/project/expo.js";
import { checkPins, expoPinPolicyFor, expoPinsFor, expoPluginFor } from "../../src/versions.js";
import { EXPO56_PINS, fakeExpo56Modules } from "../support/expo56.js";
import { EXPO57_PINS, fakeExpo57Modules, writeExpoModuleFiles } from "../support/expo57.js";
import { EXPO58_PINS, fakeExpo58Modules, realAutolinkingCli } from "../support/expo58.js";
import { EXPO_SKIP_NOTE, loadSpm, shared58Spm, vendoredSpm, type Plugin } from "../support/expoSpm.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = path.join(fixtures, "project");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A copy of the SDK 58 fixture, on the floor set unless `modules` is false. */
async function tempProject(
  mutate: (app: { expo: Record<string, any> }, pkg: Record<string, any>) => void = () => {},
  modules = true,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-project-"));
  tempDirs.push(dir);
  await cp(fixture, dir, { recursive: true });
  if (modules) await fakeExpo58Modules(dir);
  const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  mutate(app, pkg);
  await writeFile(path.join(dir, "app.json"), JSON.stringify(app));
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

/** Merges `entries` into `<dir>/package.json`'s `field` ("dependencies" unless given). */
async function addToPackageJson(dir: string, entries: Record<string, unknown>, field = "dependencies"): Promise<void> {
  const file = path.join(dir, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
  pkg[field] = { ...pkg[field], ...entries };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(pkg));
}

/** A patch two below `version`'s: "56.0.7" → "56.0.5". */
const twoBelow = (version: string): string => version.replace(/\d+$/, (n) => String(Number(n) - 2));

describe("readExpoProject", () => {
  it("reads the fixture project", async () => {
    const dir = await tempProject();
    const p = await readExpoProject(dir);
    expect(p.bundleIdentifier).toBe("com.example.app");
    expect(p.iosTargetName).toBe("app");
    expect(p.iosTargetDir).toBe(path.join(dir, "ios", "app"));
    expect(p.sdkVersion).toBe(58);
    expect(p.version).toBe("1.0.0");
    expect(p.buildNumber).toBe("1");
    expect(p.slug).toBe("app");
  });

  it("readExpoProject sets appIconSource", async () => {
    const dir = await tempProject();
    expect((await readExpoProject(dir)).appIconSource).toBe(path.join(dir, "assets", "icon.png"));
  });

  it("resolves the icon like expo prebuild", () => {
    const root = path.join(path.sep, "proj");
    const at = (f: string) => path.join(root, f);
    expect(expoIconPath({ icon: "./assets/icon.png" }, root)).toBe(at("assets/icon.png"));
    expect(expoIconPath({ icon: "./a.png", ios: { icon: "./b.png" } }, root)).toBe(at("b.png"));
    expect(expoIconPath({ icon: "./a.png", ios: { icon: "" } }, root)).toBe(at("a.png"));
    expect(expoIconPath({ ios: { icon: { dark: "./d.png", tinted: "./t.png" } } }, root)).toBe(at("d.png"));
    expect(expoIconPath({ icon: "./a.png", ios: { icon: {} } }, root)).toBe(at("a.png"));
    expect(expoIconPath({ icon: "https://example.com/i.png" }, root)).toBeUndefined();
    expect(expoIconPath({}, root)).toBeUndefined();
  });

  it("an Expo project uses the installed scripts", async () => {
    expect((await readExpoProject(await tempProject())).rnScripts).toBe("installed");
  });

  it("sanitizes the target name like prebuild", async () => {
    const dir = await tempProject((app) => {
      app.expo.name = "Mi App Ñandú 2";
    });
    expect((await readExpoProject(dir)).iosTargetName).toBe("MiAppNandu2");
  });

  it.each([55, 54])("rejects SDK %i", async (sdk) => {
    const dir = await tempProject((_app, pkg) => {
      pkg.dependencies.expo = `~${sdk}.0.0`;
    }, false);
    await expect(readExpoProject(dir)).rejects.toThrow(
      new Error(
        `Expo SDK ${sdk} is not supported; rn-xtool supports SDK 56 (expo 56.0.24 or newer 56.x), SDK 57 (expo 57.0.31 ` +
          "or newer 57.x) and SDK 58 or newer.",
      ),
    );
  });

  it("keeps SDK 59 ungated", async () => {
    const dir = await tempProject((_app, pkg) => {
      pkg.dependencies.expo = "~59.0.0";
    }, false);
    const p = await readExpoProject(dir);
    expect(p).toMatchObject({ sdkVersion: 59, expoPlugin: "installed", rnScripts: "installed" });
  });

  it("prefers exp.sdkVersion over the expo dependency", async () => {
    // No node_modules (Expo would read the SDK from the installed expo) and SDK 59 (ungated): only app.json says 59.
    const dir = await tempProject((app, pkg) => {
      app.expo.sdkVersion = "59.0.0";
      pkg.dependencies.expo = "~58.0.21";
    }, false);
    expect((await readExpoProject(dir)).sdkVersion).toBe(59);
  });

  it("throws when the SDK cannot be determined (non-numeric range)", async () => {
    const dir = await tempProject((_app, pkg) => {
      pkg.dependencies.expo = "latest";
    }, false);
    await expect(readExpoProject(dir)).rejects.toThrow("Could not determine Expo SDK version");
  });

  it("throws when the SDK cannot be determined (no expo dependency)", async () => {
    const dir = await tempProject((_app, pkg) => {
      delete pkg.dependencies.expo;
    }, false);
    await expect(readExpoProject(dir)).rejects.toThrow("Could not determine Expo SDK version");
  });

  it.each(["58.0.19", "~58", ">=58.0.0 <59", "sdk-58.0.0", "npm:expo-next2@58"])(
    "parses the major from expo range %s",
    async (range) => {
      // No node_modules, so Expo cannot read the SDK from the installed expo: it comes from the range, and the
      // SDK 58 gate it selects names the missing packages.
      const dir = await tempProject((_app, pkg) => {
        pkg.dependencies.expo = range;
      }, false);
      await expect(readExpoProject(dir)).rejects.toThrow(/^Expo SDK 58 needs react-native 0\.88\.1 .*; installed: expo not installed, /);
      await expect(readExpoProject(dir)).rejects.toBeInstanceOf(VersionGateError);
    },
  );

  it("writes a default bundleIdentifier into app.json when it is missing", async () => {
    const dir = await tempProject((app) => {
      delete app.expo.ios.bundleIdentifier;
      app.expo.slug = "My Demo_app";
    });
    const log = vi.fn();
    const p = await readExpoProject(dir, { log });
    expect(p.bundleIdentifier).toBe("com.anonymous.my-demo-app");
    const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    expect(app.expo.ios.bundleIdentifier).toBe("com.anonymous.my-demo-app");
    expect(app.expo.ios.supportsTablet).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("com.anonymous.my-demo-app"));
  });

  it("keeps a flat app.json (no expo wrapper) flat and intact", async () => {
    const dir = await tempProject((app) => {
      delete app.expo.ios.bundleIdentifier;
    });
    const wrapped = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    await writeFile(path.join(dir, "app.json"), JSON.stringify({ ...wrapped.expo, scheme: "demo" }));
    const p = await readExpoProject(dir, { log: vi.fn() });
    expect(p.bundleIdentifier).toBe(`com.anonymous.${wrapped.expo.slug}`);
    const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    expect(app.expo).toBeUndefined();
    expect(app.name).toBe(wrapped.expo.name);
    expect(app.scheme).toBe("demo");
    expect(app.ios).toMatchObject({ supportsTablet: true, bundleIdentifier: p.bundleIdentifier });
  });

  it("does not duplicate arrays under ios when writing the default", async () => {
    const dir = await tempProject((app) => {
      delete app.expo.ios.bundleIdentifier;
      app.expo.ios.associatedDomains = ["applinks:example.com"];
      app.expo.ios.infoPlist = { UIBackgroundModes: ["audio"] };
    });
    await readExpoProject(dir, { log: vi.fn() });
    const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    expect(app.expo.ios.associatedDomains).toEqual(["applinks:example.com"]);
    expect(app.expo.ios.infoPlist.UIBackgroundModes).toEqual(["audio"]);
    expect(app.expo.ios.supportsTablet).toBe(true);
  });

  it("accepts a JSON5 app.json (comments, trailing commas)", async () => {
    const dir = await tempProject((app) => {
      delete app.expo.ios.bundleIdentifier;
    });
    const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    const json5 = `{\n  // the app\n  "expo": ${JSON.stringify(app.expo)},\n}\n`;
    await writeFile(path.join(dir, "app.json"), json5);
    const p = await readExpoProject(dir, { log: vi.fn() });
    expect(p.bundleIdentifier).toBe(`com.anonymous.${app.expo.slug}`);
    expect(JSON.parse(await readFile(path.join(dir, "app.json"), "utf8")).expo.ios.bundleIdentifier).toBe(p.bundleIdentifier);
  });

  it("throws a MissingBundleIdentifierError instead of writing when asked to be read-only", async () => {
    const dir = await tempProject((app) => {
      delete app.expo.ios.bundleIdentifier;
    });
    const err = await readExpoProject(dir, { writeDefaults: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingBundleIdentifierError);
    expect((err as MissingBundleIdentifierError).suggestion).toBe("com.anonymous.app");
    expect((err as Error).message).toMatch(/bundleIdentifier/);
    expect((err as Error).message).toContain("to the expo config, or run `rn-xtool build`");
    expect((err as Error).message).not.toContain("expo-xtool");
  });

  it("throws with instructions when the config is dynamic", async () => {
    const dir = await tempProject((app) => {
      delete app.expo.ios.bundleIdentifier;
    });
    const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    await rm(path.join(dir, "app.json"));
    await writeFile(path.join(dir, "app.config.js"), `module.exports = ${JSON.stringify(app)};`);
    await expect(readExpoProject(dir)).rejects.toThrow(/bundleIdentifier.*app\.config\.js/s);
  });
});

describe("Expo SDK 56", () => {
  const PREFIX =
    "Expo SDK 56 needs react-native 0.85.3 and at least expo 56.0.24, expo-modules-core 56.0.27, expo-modules-jsi " +
    "56.0.14, expo-modules-autolinking 56.0.24, expo-file-system 56.0.11 and expo-font 56.0.7; installed: ";
  const FIX_REMEDY =
    "Remove any pin or override on these packages from package.json, then run `npx expo install --fix`; then run " +
    "`npx expo install react-native@0.85.3`, since `--fix` alone can leave react-native on another version.";
  const EXPO_REMEDY =
    "Remove any pin or override on these packages from package.json, then run `npx expo install expo@~56.0.24` and " +
    "`npx expo install --fix`; then run `npx expo install react-native@0.85.3`, since `--fix` alone can leave " +
    "react-native on another version.";
  const RN_REMEDY = "Run `npx expo install react-native@0.85.3`.";
  const PIN_ERROR = (list: string, remedy = FIX_REMEDY, tail = "") =>
    new VersionGateError(`${PREFIX}${list}. ${remedy}${tail}`);

  async function expo56(
    overrides?: Parameters<typeof fakeExpo56Modules>[1],
    nested?: Parameters<typeof fakeExpo56Modules>[2],
  ): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-expo56-"));
    tempDirs.push(dir);
    await cp(path.join(fixtures, "expo-56"), dir, { recursive: true });
    await fakeExpo56Modules(dir, overrides, nested);
    return dir;
  }

  it("has the SDK 56 pins in the supported table", () => {
    expect(expoPinsFor(56)).toEqual(EXPO56_PINS);
    expect(Object.keys(expoPinsFor(56)!)).toEqual(Object.keys(EXPO56_PINS));
    expect(expoPinPolicyFor(56)).toBe("floor");
  });

  it("accepts the SDK 56 floor set", async () => {
    const dir = await expo56();
    const log = vi.fn();
    const p = await readExpoProject(dir, { log });
    expect(p).toMatchObject({ sdkVersion: 56, rnVersion: "0.85.3", rnScripts: "vendored", expoPlugin: "vendored" });
    expect(p.iosTargetDir).toBe(path.join(dir, "ios", "Expo56"));
    expect(readExpoPins(dir, 56)).toEqual(EXPO56_PINS);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["expo", "56.0.23"],
    ["expo-modules-core", "56.0.26"],
    ["expo-modules-jsi", "56.0.13"],
    ["expo-modules-autolinking", "56.0.23"],
    ["expo-file-system", "56.0.10"],
    ["expo-font", "56.0.6"],
  ])("names each SDK 56 pin below the floor: %s %s", async (name, version) => {
    const dir = await expo56({ [name]: version });
    const err = (await readExpoProject(dir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(VersionGateError);
    expect(err.message.startsWith(`${PREFIX}${name} ${version}. `)).toBe(true);
    expect(err).toEqual(PIN_ERROR(`${name} ${version}`, name === "expo" ? EXPO_REMEDY : FIX_REMEDY));
  });

  it("refuses react-native other than 0.85.3", async () => {
    const older = await expo56({ "react-native": "0.85.2" });
    await expect(readExpoProject(older)).rejects.toThrow(PIN_ERROR("react-native 0.85.2", RN_REMEDY));
    const newer = await expo56({ "react-native": "0.85.4" });
    await expect(readExpoProject(newer)).rejects.toThrow(
      PIN_ERROR(
        "react-native 0.85.4",
        RN_REMEDY,
        " React Native 0.85.4 is newer than this rn-xtool release supports: pin react-native to 0.85.3, or update rn-xtool.",
      ),
    );
  });

  it("warns and continues on a newer 56.x", async () => {
    const dir = await expo56({ expo: "56.0.25", "expo-modules-jsi": "56.0.15" });
    const log = vi.fn();
    await expect(readExpoProject(dir, { log })).resolves.toMatchObject({ sdkVersion: 56, expoPlugin: "vendored" });
    expect(log.mock.calls).toEqual([
      [
        "⚠ Newer than the Expo SDK 56 set this rn-xtool release was verified with: expo 56.0.25, expo-modules-jsi " +
          "56.0.15. Verified: expo 56.0.24, react-native 0.85.3, expo-modules-core 56.0.27, expo-modules-jsi 56.0.14, " +
          "expo-modules-autolinking 56.0.24, expo-file-system 56.0.11 and expo-font 56.0.7. The build continues; if it " +
          "fails or the app crashes at launch, report it at https://github.com/WillyAntunez/react-native-xtool/issues.",
      ],
    ]);
  });

  it("refuses a package of another SDK's line on SDK 56", async () => {
    const dir = await expo56({ "expo-modules-jsi": "57.1.3" });
    const log = vi.fn();
    await expect(readExpoProject(dir, { log })).rejects.toThrow(PIN_ERROR("expo-modules-jsi 57.1.3"));
    expect(log).not.toHaveBeenCalled();
  });

  it("reads expo-file-system and expo-font where autolinking links them on SDK 56", async () => {
    // SDK 56 hoists both; the default set is the hoisted one.
    const hoisted = await expo56();
    expect(readExpoPins(hoisted, 56)).toMatchObject({ "expo-file-system": "56.0.11", "expo-font": "56.0.7" });
    await expect(readExpoProject(hoisted)).resolves.toMatchObject({ sdkVersion: 56 });
    // Nothing the app lists reaches the top-level copy: autolinking finds only expo's nested one, through expo.
    const nested = await expo56({}, { "expo-font": "56.0.6" });
    expect(readExpoPins(nested, 56)["expo-font"]).toBe("56.0.6");
    await expect(readExpoProject(nested)).rejects.toThrow(PIN_ERROR("expo-font 56.0.6"));
  });

  it("names expo-font not installed when autolinking links no copy on SDK 56", async () => {
    const dir = await expo56({ "expo-font": null });
    await expect(readExpoProject(dir)).rejects.toThrow(PIN_ERROR("expo-font not installed"));
  });

  it.each(["expo-file-system", "expo-font"] as const)("gates the %s copy the app lists on SDK 56", async (name) => {
    // The app's own dependency is autolinking's shallowest (depth 0): its top-level copy is linked, not expo's nested one.
    const floor = EXPO56_PINS[name]!;
    const older = twoBelow(floor);
    const topBelow = await expo56({ [name]: older }, { [name]: floor });
    await addToPackageJson(topBelow, { [name]: `~${floor}` });
    await expect(readExpoProject(topBelow)).rejects.toThrow(PIN_ERROR(`${name} ${older}`));
    const topFloor = await expo56({}, { [name]: older });
    await addToPackageJson(topFloor, { [name]: `~${floor}` });
    expect(readExpoPins(topFloor, 56)[name]).toBe(floor);
    await expect(readExpoProject(topFloor)).resolves.toMatchObject({ sdkVersion: 56 });
  });

  describe("reads the expo-font copy autolinking's own CLI links", () => {
    // Every tree: expo's nested copy at the floor, a second copy below it elsewhere; autolinking picks the second.
    const OLDER = "56.0.5";

    /** expo56() with expo-font nested under expo at the floor and no top-level copy. */
    async function nestedFloor(): Promise<string> {
      return expo56({ "expo-font": null }, { "expo-font": EXPO56_PINS["expo-font"]! });
    }

    /** A package.json at `dir` (an Expo module with its pod when `pod` is given). */
    async function writePkg(dir: string, pkg: Record<string, unknown>, pod?: string): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
      if (pod !== undefined) await writeExpoModuleFiles(dir, pod);
    }

    const expoFont = (dir: string, version = OLDER) => writePkg(dir, { name: "expo-font", version }, "ExpoFont");

    it("a file:-linked local library with its own copy (D)", async () => {
      const root = await nestedFloor();
      const lib = await mkdtemp(path.join(tmpdir(), "rn-xtool-local-lib-"));
      tempDirs.push(lib);
      await writePkg(lib, { name: "my-lib", version: "1.0.0", peerDependencies: { "expo-font": "*" } });
      await expoFont(path.join(lib, "node_modules", "expo-font"));
      await symlink(lib, path.join(root, "node_modules", "my-lib"));
      await addToPackageJson(root, { "my-lib": `file:${lib}` });
      expect(readExpoPins(root, 56)["expo-font"]).toBe(OLDER);
      await expect(readExpoProject(root)).rejects.toThrow(PIN_ERROR(`expo-font ${OLDER}`));
    });

    it("an app dependency with a nested copy (A)", async () => {
      const root = await nestedFloor();
      const asset = path.join(root, "node_modules", "expo-asset");
      await writePkg(asset, { name: "expo-asset", version: "56.0.0", dependencies: { "expo-font": "*" } });
      await expoFont(path.join(asset, "node_modules", "expo-font"));
      await addToPackageJson(root, { "expo-asset": "*" });
      expect(readExpoPins(root, 56)["expo-font"]).toBe(OLDER);
      await expect(readExpoProject(root)).rejects.toThrow(PIN_ERROR(`expo-font ${OLDER}`));
    });

    it.each([
      ["searchPaths", { searchPaths: ["./node_modules"] }],
      ["nativeModulesDir", { nativeModulesDir: "./node_modules" }],
    ])("a top-level copy %s scans (B)", async (_name, autolinking) => {
      const root = await nestedFloor();
      await expoFont(path.join(root, "node_modules", "expo-font"));
      await addToPackageJson(root, { autolinking }, "expo");
      expect(readExpoPins(root, 56)["expo-font"]).toBe(OLDER);
      await expect(readExpoProject(root)).rejects.toThrow(PIN_ERROR(`expo-font ${OLDER}`));
    });

    it("not the copy only a dependency autolinking skips reaches (C)", async () => {
      // jest-expo is one of autolinking's default exclusions: its dependencies are never scanned.
      const root = await nestedFloor();
      await expoFont(path.join(root, "node_modules", "expo-font"));
      await writePkg(path.join(root, "node_modules", "jest-expo"), { name: "jest-expo", version: "56.0.0", dependencies: { "expo-font": "*" } });
      await addToPackageJson(root, { "jest-expo": "*" }, "devDependencies");
      expect(readExpoPins(root, 56)["expo-font"]).toBe(EXPO56_PINS["expo-font"]);
      await expect(readExpoProject(root)).resolves.toMatchObject({ sdkVersion: 56 });
    });

    it("the copy a package in expo.autolinking.exclude reaches: the exclusion drops that package, not its dependencies", async () => {
      const root = await nestedFloor();
      await expoFont(path.join(root, "node_modules", "expo-font"));
      await writePkg(path.join(root, "node_modules", "some-lib"), { name: "some-lib", version: "1.0.0", dependencies: { "expo-font": "*" } }, "SomeLib");
      await addToPackageJson(root, { "some-lib": "*" });
      await addToPackageJson(root, { autolinking: { exclude: ["some-lib"] } }, "expo");
      expect(readExpoPins(root, 56)["expo-font"]).toBe(OLDER);
    });
  });

  it("refuses a nested expo-modules-jsi on SDK 56", async () => {
    const dir = await expo56({ "expo-modules-jsi": "57.1.3" }, { "expo-modules-jsi": "56.0.14" });
    const err = (await readExpoProject(dir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(
      err.message.startsWith(
        "expo-modules-jsi 56.0.14 resolves from node_modules/expo-modules-core/node_modules/expo-modules-jsi, not from " +
          "the project's top-level node_modules",
      ),
    ).toBe(true);
  });

  it("checks the expo-modules-macros copy the vendored plugin finds on SDK 56", async () => {
    // expo-modules-core 56.0.27 depends on the macOS-only @expo/expo-modules-macros-plugin, so G3 checks rn-xtool's copy
    // (the vendored plugin's fallback; the installed plugin would ask core for one). The SDK 56 row decides the path.
    const root = await expo56();
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { ...arch, value: "riscv64" });
    try {
      expect(() => checkExpoPackages(root, 56)).toThrow(
        new Error(
          "expo-modules-macros 0.22.0 has no Linux binary for riscv64 (@expo/modules-macros-linux-riscv64); reinstall " +
            "react-native-xtool without --omit=optional.",
        ),
      );
    } finally {
      Object.defineProperty(process, "arch", arch);
    }
  });
});

describe("Expo SDK 57", () => {
  const PREFIX =
    "Expo SDK 57 needs react-native 0.86.3 and at least expo 57.0.31, expo-modules-core 57.0.24, " +
    "expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3; installed: ";
  const FIX_REMEDY =
    "Remove any pin or override on these packages from package.json, then run `npx expo install --fix`; then run " +
    "`npx expo install react-native@0.86.3`, since `--fix` alone can leave react-native on another version.";
  const EXPO_REMEDY =
    "Remove any pin or override on these packages from package.json, then run `npx expo install expo@~57.0.31` and " +
    "`npx expo install --fix`; then run `npx expo install react-native@0.86.3`, since `--fix` alone can leave " +
    "react-native on another version.";
  const PIN_ERROR = (list: string, remedy = FIX_REMEDY) => new VersionGateError(`${PREFIX}${list}. ${remedy}`);

  async function expo57(
    overrides?: Parameters<typeof fakeExpo57Modules>[1],
    nested?: Parameters<typeof fakeExpo57Modules>[2],
  ): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-expo57-"));
    tempDirs.push(dir);
    await cp(path.join(fixtures, "expo-57"), dir, { recursive: true });
    await fakeExpo57Modules(dir, overrides, nested);
    return dir;
  }

  it("has the SDK 57 pins and plugin in the supported table", () => {
    expect(expoPinsFor(57)).toEqual(EXPO57_PINS);
    expect([expoPluginFor(55), expoPluginFor(56), expoPluginFor(57), expoPluginFor(58), expoPluginFor(59)]).toEqual([
      undefined, "vendored", "vendored", "installed", "installed",
    ]);
  });

  it("accepts the SDK 57 floor set", async () => {
    const dir = await expo57();
    const log = vi.fn();
    const p = await readExpoProject(dir, { log });
    expect(p).toMatchObject({ sdkVersion: 57, rnVersion: "0.86.3", rnScripts: "vendored", expoPlugin: "vendored" });
    expect(p.iosTargetDir).toBe(path.join(dir, "ios", "Spike57"));
    expect(readExpoPins(dir, 57)).toEqual(EXPO57_PINS);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["expo", "57.0.30"],
    ["expo-modules-core", "57.0.23"],
    ["expo-modules-autolinking", "57.0.15"],
    ["expo-modules-jsi", "57.1.2"],
  ])("names each SDK 57 pin below the floor: %s %s", async (name, version) => {
    const dir = await expo57({ [name]: version });
    const err = (await readExpoProject(dir).catch((e: unknown) => e)) as Error;
    expect(err.message.startsWith(`${PREFIX}${name} ${version}. `)).toBe(true);
    expect(err).toEqual(PIN_ERROR(`${name} ${version}`, name === "expo" ? EXPO_REMEDY : FIX_REMEDY));
  });

  it("names a missing SDK 57 pin", async () => {
    const dir = await expo57({ "expo-modules-jsi": null });
    await expect(readExpoProject(dir)).rejects.toThrow(PIN_ERROR("expo-modules-jsi not installed"));
  });

  it("gives the full G1 text for expo below the floor", async () => {
    const dir = await expo57({ expo: "57.0.30" });
    await expect(readExpoProject(dir)).rejects.toThrow(
      new VersionGateError(
        "Expo SDK 57 needs react-native 0.86.3 and at least expo 57.0.31, expo-modules-core 57.0.24, " +
          "expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3; installed: expo 57.0.30. Remove any pin or " +
          "override on these packages from package.json, then run `npx expo install expo@~57.0.31` and `npx expo " +
          "install --fix`; then run `npx expo install react-native@0.86.3`, since `--fix` alone can leave react-native " +
          "on another version.",
      ),
    );
  });

  it("refuses react-native other than 0.86.3", async () => {
    const dir = await expo57({ "react-native": "0.86.4" });
    await expect(readExpoProject(dir)).rejects.toThrow(
      new VersionGateError(
        `${PREFIX}react-native 0.86.4. Run \`npx expo install react-native@0.86.3\`. React Native 0.86.4 is newer than ` +
          "this rn-xtool release supports: pin react-native to 0.86.3, or update rn-xtool.",
      ),
    );
  });

  it("warns and continues on a newer 57.x", async () => {
    const dir = await expo57({ expo: "57.0.32", "expo-modules-jsi": "57.1.4" });
    const log = vi.fn();
    await expect(readExpoProject(dir, { log })).resolves.toMatchObject({ sdkVersion: 57, expoPlugin: "vendored" });
    expect(log.mock.calls).toEqual([
      [
        "⚠ Newer than the Expo SDK 57 set this rn-xtool release was verified with: expo 57.0.32, expo-modules-jsi " +
          "57.1.4. Verified: expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24, expo-modules-autolinking " +
          "57.0.16 and expo-modules-jsi 57.1.3. The build continues; if it fails or the app crashes at launch, report it " +
          "at https://github.com/WillyAntunez/react-native-xtool/issues.",
      ],
    ]);
  });

  it("refuses a package of another SDK's line instead of warning", async () => {
    const dir = await expo57({ "expo-modules-jsi": "58.0.19" });
    const log = vi.fn();
    await expect(readExpoProject(dir, { log })).rejects.toThrow(PIN_ERROR("expo-modules-jsi 58.0.19"));
    expect(log).not.toHaveBeenCalled();
  });

  it("reads each pin where the build resolves it", async () => {
    const nestedCore = await expo57({}, { "expo-modules-core": "57.0.25" });
    expect(expoPackageDir(nestedCore, "expo-modules-core")).toBe(
      path.join(nestedCore, "node_modules", "expo", "node_modules", "expo-modules-core"),
    );
    const log = vi.fn();
    await expect(readExpoProject(nestedCore, { log })).resolves.toMatchObject({ expoPlugin: "vendored" });
    expect(log.mock.calls[0]![0]).toContain("with: expo-modules-core 57.0.25. ");
    const nestedOldCore = await expo57({}, { "expo-modules-core": "57.0.23" });
    await expect(readExpoProject(nestedOldCore)).rejects.toThrow(PIN_ERROR("expo-modules-core 57.0.23"));

    const nestedAutolinking = await expo57({ "expo-modules-autolinking": null }, { "expo-modules-autolinking": "57.0.16" });
    expect(readExpoPins(nestedAutolinking, 57)["expo-modules-autolinking"]).toBe("57.0.16");
    const rootAutolinking = await expo57({}, { "expo-modules-autolinking": "57.0.17" });
    expect(readExpoPins(rootAutolinking, 57)["expo-modules-autolinking"]).toBe("57.0.16");

    // Hoisted core's own jsi is the top-level copy.
    const hoisted = await expo57();
    expect(expoPackageDir(hoisted, "expo-modules-jsi")).toBe(path.join(hoisted, "node_modules", "expo-modules-jsi"));
    await expect(readExpoProject(hoisted)).resolves.toMatchObject({ expoPlugin: "vendored" });
  });

  it("refuses a nested expo-modules-jsi", async () => {
    const dir = await expo57({ "expo-modules-jsi": "58.0.19" }, { "expo-modules-jsi": "57.1.3" });
    await expect(readExpoProject(dir)).rejects.toThrow(
      new Error(
        "expo-modules-jsi 57.1.3 resolves from node_modules/expo-modules-core/node_modules/expo-modules-jsi, not from the " +
          "project's top-level node_modules: rn-xtool patches and builds only the top-level copy. Remove any " +
          "expo-modules-jsi pin or override from package.json (`npm uninstall expo-modules-jsi` removes a pin), then run " +
          "`npm update expo-modules-jsi`: it moves the copy to the top level, which a reinstall does not do while " +
          "package-lock.json keeps it nested.",
      ),
    );
  });

  it("checks the expo-modules-macros copy the vendored plugin finds first: from core, then its own", async () => {
    // expo-modules-core 57.0.24 depends on @expo/expo-modules-macros-plugin, so a stock app has no expo-modules-macros
    // and the plugin falls back to rn-xtool's. A copy reachable from core (another package's, a parent's) wins.
    const plugin = loadSpm<Plugin>(vendoredSpm(), "plugin.js");
    const stock = await expo57();
    expect(plugin.macroPluginFlags(expoPackageDir(stock, "expo-modules-core")!).join(" ")).not.toContain(stock);
    await expect(readExpoProject(stock)).resolves.toMatchObject({ expoPlugin: "vendored" });

    // Another project: Node caches a resolution per request and paths, so the plugin would keep its first answer.
    const dir = await expo57();
    const coreDir = expoPackageDir(dir, "expo-modules-core")!;
    const macrosDir = path.join(dir, "node_modules", "expo-modules-macros");
    await mkdir(macrosDir, { recursive: true });
    const optionalDependencies = Object.fromEntries(
      ["linux-arm64", "linux-x64"].map((p) => [`@expo/modules-macros-${p}`, "0.27.1"]),
    );
    await writeFile(
      path.join(macrosDir, "package.json"),
      JSON.stringify({ name: "expo-modules-macros", version: "0.27.1", optionalDependencies }),
    );
    const binaryError =
      `expo-modules-macros 0.27.1 (from expo-modules-core 57.0.24) has no Linux binary for ${process.arch}: ` +
      `@expo/modules-macros-linux-${process.arch} 0.27.1 is not installed. Run \`npm install --include=optional\` and ` +
      "commit package-lock.json: `npm ci` installs only what the lockfile lists, and a lockfile written on macOS can " +
      "leave this package out (so does --omit=optional).";
    expect(() => plugin.macroPluginFlags(coreDir)).toThrow();
    await expect(readExpoProject(dir)).rejects.toThrow(new Error(binaryError));

    const binaryDir = path.join(dir, "node_modules", "@expo", `modules-macros-linux-${process.arch}`);
    await mkdir(binaryDir, { recursive: true });
    await writeFile(path.join(binaryDir, "package.json"), JSON.stringify({ version: "0.27.1" }));
    await writeFile(path.join(binaryDir, "ExpoModulesMacros"), "");
    expect(plugin.macroPluginFlags(coreDir)).toContain(`${path.join(binaryDir, "ExpoModulesMacros")}#ExpoModulesMacros`);
    await expect(readExpoProject(dir)).resolves.toMatchObject({ expoPlugin: "vendored" });
  });

  it("reports a missing macros binary", () => {
    expect(
      expoMacrosBinaryError({
        arch: "riscv64",
        resolve: () => {
          throw new Error("x");
        },
      }),
    ).toBe(
      "expo-modules-macros 0.22.0 has no Linux binary for riscv64 (@expo/modules-macros-linux-riscv64); reinstall react-native-xtool without --omit=optional.",
    );
    const asked: string[] = [];
    expect(expoMacrosBinaryError({ arch: "arm64", resolve: (spec) => (asked.push(spec), "/bin") })).toBeUndefined();
    expect(asked).toEqual(["@expo/modules-macros-linux-arm64/ExpoModulesMacros"]);
    // The real resolver finds the binary npm installed for this host.
    expect(expoMacrosBinaryError()).toBeUndefined();
  });
});

describe("Expo SDK 58 floor model", () => {
  it("SDK 58 pins the 58.0.21 set as a floor", () => {
    expect(expoPinsFor(58)).toEqual(EXPO58_PINS);
    expect(Object.keys(expoPinsFor(58)!)).toEqual(Object.keys(EXPO58_PINS));
    expect([55, 56, 57, 58, 59].map(expoPinPolicyFor)).toEqual([undefined, "floor", "floor", "floor", undefined]);
    expect(expoPinsFor(59)).toBeUndefined();
  });

  it("checkPins classifies a floor set", () => {
    const installed = {
      expo: "58.0.22",
      "react-native": "0.88.0",
      "expo-modules-core": "58.0.26",
      "expo-modules-jsi": "58.0.21",
      "expo-modules-autolinking": "58.0.16",
      "expo-file-system": undefined,
      "expo-font": "58.0.11",
    };
    const checks = checkPins(58, installed)!;
    expect(checks.map((c) => c.status)).toEqual(["newer", "off", "below", "ok", "ok", "missing", "ok"]);
    expect(checks[2]).toEqual({ name: "expo-modules-core", wanted: "58.0.28", installed: "58.0.26", status: "below" });
    expect(checks[5]).toEqual({ name: "expo-file-system", wanted: "58.0.13", installed: undefined, status: "missing" });
    expect(checkPins(58, { ...installed, "react-native": "0.88.2" })![1]!.status).toBe("off");
    const sdk57 = checkPins(57, { ...EXPO57_PINS, "expo-modules-core": "57.0.25" })!;
    expect(sdk57.map((c) => c.status)).toEqual(["ok", "ok", "newer", "ok", "ok"]);
    expect(checkPins(59, installed)).toBeUndefined();
  });

  it("reads each SDK 58 pin where the build resolves it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-expo58-"));
    tempDirs.push(dir);
    const write = async (rel: string, name: string, version: string) => {
      await mkdir(path.join(dir, rel), { recursive: true });
      await writeFile(path.join(dir, rel, "package.json"), JSON.stringify({ name, version }));
    };
    await write("node_modules/expo", "expo", "58.0.21");
    await write("node_modules/expo-file-system", "expo-file-system", "58.0.11");
    await write("node_modules/expo/node_modules/expo-file-system", "expo-file-system", "58.0.13");
    await write("node_modules/expo-font", "expo-font", "58.0.11");
    expect(expoPackageDir(dir, "expo-file-system")).toBe(path.join(dir, "node_modules", "expo", "node_modules", "expo-file-system"));
    expect(readExpoPins(dir, 58)["expo-file-system"]).toBe("58.0.13");
    expect(readExpoPins(dir, 58)["expo-font"]).toBe("58.0.11");
    expect(Object.keys(readExpoPins(dir, 57))).toEqual([
      "expo", "react-native", "expo-modules-core", "expo-modules-autolinking", "expo-modules-jsi",
    ]);
    expect(readExpoPins(dir, 59)).toEqual({});
  });
});

describe("Expo SDK 58 gate", () => {
  /** Any package other than react-native is off: `--fix` for them, then react-native explicitly (--fix may move it). */
  const FIX_REMEDY =
    "Remove any pin or override on these packages from package.json, then run `npx expo install --fix`; then run " +
    "`npx expo install react-native@0.88.1`, since `--fix` alone can leave react-native on another version.";
  /** expo itself is off: it moves first, as docs/bare-react-native.md and troubleshooting say. */
  const EXPO_REMEDY =
    "Remove any pin or override on these packages from package.json, then run `npx expo install expo@~58.0.21` and " +
    "`npx expo install --fix`; then run `npx expo install react-native@0.88.1`, since `--fix` alone can leave " +
    "react-native on another version.";
  /** Only react-native is off. */
  const RN_REMEDY = "Run `npx expo install react-native@0.88.1`.";
  const PIN_ERROR = (list: string, remedy = FIX_REMEDY, tail = "") =>
    new VersionGateError(
      "Expo SDK 58 needs react-native 0.88.1 and at least expo 58.0.21, expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, " +
        `expo-modules-autolinking 58.0.16, expo-file-system 58.0.13 and expo-font 58.0.11; installed: ${list}. ${remedy}` +
        tail,
    );
  const WARNING = (list: string) =>
    `⚠ Newer than the Expo SDK 58 set this rn-xtool release was verified with: ${list}. Verified: expo 58.0.21, ` +
    "react-native 0.88.1, expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, expo-modules-autolinking 58.0.16, " +
    "expo-file-system 58.0.13 and expo-font 58.0.11. The build continues; if it fails or the app crashes at launch, " +
    "report it at https://github.com/WillyAntunez/react-native-xtool/issues.";
  /** The binary package expo-modules-macros lists for the host is not installed (a macOS lockfile, --omit=optional). */
  const BINARY_ERROR = (arch: string) =>
    `expo-modules-macros 0.27.1 (from expo-modules-core 58.0.28) has no Linux binary for ${arch}: ` +
    `@expo/modules-macros-linux-${arch} 0.27.1 is not installed. Run \`npm install --include=optional\` and commit ` +
    "package-lock.json: `npm ci` installs only what the lockfile lists, and a lockfile written on macOS can leave this " +
    "package out (so does --omit=optional).";
  /** expo-modules-macros lists no binary for the host's architecture. */
  const NO_ARCH_ERROR = (arch: string) =>
    `expo-modules-macros 0.27.1 (from expo-modules-core 58.0.28) ships no Linux binary for ${arch} ` +
    `(it lists no @expo/modules-macros-linux-${arch}); Expo publishes one for x64 and arm64.`;

  async function expo58(...args: Parameters<typeof fakeExpo58Modules> extends [string, ...infer R] ? R : never): Promise<string> {
    const dir = await tempProject(() => {}, false);
    await fakeExpo58Modules(dir, ...args);
    return dir;
  }

  it("accepts the SDK 58 floor set", async () => {
    const dir = await expo58();
    const log = vi.fn();
    const p = await readExpoProject(dir, { log });
    expect(p).toMatchObject({ sdkVersion: 58, rnVersion: "0.88.1", rnScripts: "installed", expoPlugin: "installed" });
    expect(readExpoPins(dir, 58)).toEqual(EXPO58_PINS);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["expo", "58.0.20"],
    ["expo-modules-core", "58.0.27"],
    ["expo-modules-jsi", "58.0.20"],
    ["expo-modules-autolinking", "58.0.15"],
    ["expo-file-system", "58.0.12"],
    ["expo-font", "58.0.10"],
  ])("names each SDK 58 pin below the floor: %s %s", async (name, version) => {
    const dir = await expo58({ [name]: version });
    await expect(readExpoProject(dir)).rejects.toThrow(
      PIN_ERROR(`${name} ${version}`, name === "expo" ? EXPO_REMEDY : FIX_REMEDY),
    );
  });

  it("names the expo-modules-* pins in package.json and the command that removes them", async () => {
    const dir = await expo58({ expo: "58.0.19", "expo-modules-autolinking": "58.0.15" });
    const pkgFile = path.join(dir, "package.json");
    const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
    pkg.dependencies = { ...pkg.dependencies, "expo-modules-jsi": "58.0.19", "expo-font": "~58.0.11" };
    pkg.devDependencies = { "expo-modules-autolinking": "58.0.15" };
    await writeFile(pkgFile, JSON.stringify(pkg));
    await expect(readExpoProject(dir)).rejects.toThrow(
      PIN_ERROR(
        "expo 58.0.19, expo-modules-autolinking 58.0.15",
        "Remove the expo-modules-jsi and expo-modules-autolinking pins (`npm uninstall expo-modules-jsi " +
          "expo-modules-autolinking`), then run `npx expo install expo@~58.0.21` and `npx expo install --fix`; then run " +
          "`npx expo install react-native@0.88.1`, since `--fix` alone can leave react-native on another version.",
      ),
    );
  });

  it("names each pin below the floor, in table order, and a missing one", async () => {
    const two = await expo58({ "expo-font": "58.0.10", "expo-modules-core": "58.0.27" });
    await expect(readExpoProject(two)).rejects.toThrow(PIN_ERROR("expo-modules-core 58.0.27, expo-font 58.0.10"));
    const missing = await expo58({ "expo-font": null });
    await expect(readExpoProject(missing)).rejects.toThrow(PIN_ERROR("expo-font not installed"));
  });

  it("refuses react-native other than 0.88.1", async () => {
    const older = await expo58({ "react-native": "0.88.0" });
    await expect(readExpoProject(older)).rejects.toThrow(PIN_ERROR("react-native 0.88.0", RN_REMEDY));
    const missing = await expo58({ "react-native": null });
    await expect(readExpoProject(missing)).rejects.toThrow(PIN_ERROR("react-native not installed", RN_REMEDY));
    const withCore = await expo58({ "react-native": "0.88.0", "expo-modules-core": "58.0.27" });
    await expect(readExpoProject(withCore)).rejects.toThrow(PIN_ERROR("react-native 0.88.0, expo-modules-core 58.0.27"));
    const newer = await expo58({ "react-native": "0.88.2" });
    await expect(readExpoProject(newer)).rejects.toThrow(
      PIN_ERROR(
        "react-native 0.88.2",
        RN_REMEDY,
        " React Native 0.88.2 is newer than this rn-xtool release supports: pin react-native to 0.88.1, or update rn-xtool.",
      ),
    );
  });

  it("warns and continues on a newer 58.x", async () => {
    const dir = await expo58({ expo: "58.0.22", "expo-modules-core": "58.0.29" });
    const log = vi.fn();
    await expect(readExpoProject(dir, { log })).resolves.toMatchObject({ sdkVersion: 58, expoPlugin: "installed" });
    expect(log.mock.calls).toEqual([[WARNING("expo 58.0.22, expo-modules-core 58.0.29")]]);
  });

  it("refuses a package of another SDK's line instead of warning", async () => {
    const dir = await expo58({ "expo-modules-core": "59.0.0" });
    const log = vi.fn();
    await expect(readExpoProject(dir, { log })).rejects.toThrow(PIN_ERROR("expo-modules-core 59.0.0"));
    expect(log).not.toHaveBeenCalled();
  });

  it("a package below the floor wins over a newer one", async () => {
    const dir = await expo58({ expo: "58.0.22", "expo-modules-core": "58.0.27" });
    const log = vi.fn();
    await expect(readExpoProject(dir, { log })).rejects.toThrow(PIN_ERROR("expo-modules-core 58.0.27"));
    expect(log).not.toHaveBeenCalled();
  });

  describe.each([
    ["the fallback rule (the fake autolinking has no CLI)", false],
    ["the app's autolinking CLI", true],
  ])("the expo-file-system and expo-font copies, through %s", (_how, cli) => {
    async function app(...args: Parameters<typeof expo58>): Promise<string> {
      const dir = await expo58(...args);
      if (cli) await realAutolinkingCli(dir);
      return dir;
    }

    it.each(["expo-file-system", "expo-font"] as const)("reads %s under expo when nothing the app lists reaches a top-level copy", async (name) => {
      // A top-level stray no dependency names is never scanned by autolinking: expo's nested copy is the one linked.
      const floor = EXPO58_PINS[name];
      const older = twoBelow(floor);
      const nestedOld = await app({}, { [name]: older }, { [name]: floor });
      await expect(readExpoProject(nestedOld)).rejects.toThrow(PIN_ERROR(`${name} ${older}`));
      const nestedFloor = await app({}, {}, { [name]: older });
      await expect(readExpoProject(nestedFloor)).resolves.toMatchObject({ sdkVersion: 58 });
    });

    it.each(["expo-file-system", "expo-font"] as const)("gates the %s copy the app lists on SDK 58", async (name) => {
      // The app's own dependency is autolinking's shallowest (depth 0): its top-level copy is linked, not expo's nested one.
      const floor = EXPO58_PINS[name];
      const older = twoBelow(floor);
      const topBelow = await app({}, {}, { [name]: older });
      await addToPackageJson(topBelow, { [name]: `~${floor}` });
      await expect(readExpoProject(topBelow)).rejects.toThrow(PIN_ERROR(`${name} ${older}`));
      const topFloor = await app({ [name]: older }, {}, { [name]: floor });
      await addToPackageJson(topFloor, { [name]: `~${floor}` }, "devDependencies");
      expect(readExpoPins(topFloor, 58)[name]).toBe(floor);
      await expect(readExpoProject(topFloor)).resolves.toMatchObject({ sdkVersion: 58 });
    });

    it.each(["expo-file-system", "expo-font"] as const)("gates the top-level %s another app dependency reaches", async (name) => {
      // A package the app lists that depends on it reaches the top-level copy at expo's depth; the shorter path wins the tie.
      const floor = EXPO58_PINS[name];
      const older = twoBelow(floor);
      const icons = (dir: string) => path.join(dir, "node_modules", "@expo", "vector-icons");
      const viaPeer = await app({}, {}, { [name]: older });
      await addToPackageJson(icons(viaPeer), { [name]: "*" }, "peerDependencies");
      await addToPackageJson(viaPeer, { "@expo/vector-icons": "^15.0.0" });
      await expect(readExpoProject(viaPeer)).rejects.toThrow(PIN_ERROR(`${name} ${older}`));
      // An optional peer is not followed, so expo's nested copy (at the floor) stays the linked one.
      await addToPackageJson(icons(viaPeer), { [name]: { optional: true } }, "peerDependenciesMeta");
      await expect(readExpoProject(viaPeer)).resolves.toMatchObject({ sdkVersion: 58 });
    });
  });

  describe("a file:-linked local library with its own expo-font (D)", () => {
    const OLDER = "58.0.9";

    /** expo58() plus a symlinked local library that peers on expo-font and has its own copy below the floor. */
    async function withLocalLib(): Promise<string> {
      const root = await expo58();
      const lib = await mkdtemp(path.join(tmpdir(), "rn-xtool-local-lib-"));
      tempDirs.push(lib);
      await writeFile(path.join(lib, "package.json"), JSON.stringify({ name: "my-lib", version: "1.0.0", peerDependencies: { "expo-font": "*" } }));
      const font = path.join(lib, "node_modules", "expo-font");
      await mkdir(font, { recursive: true });
      await writeFile(path.join(font, "package.json"), JSON.stringify({ name: "expo-font", version: OLDER }));
      await writeExpoModuleFiles(font, "ExpoFont");
      await symlink(lib, path.join(root, "node_modules", "my-lib"));
      await addToPackageJson(root, { "my-lib": `file:${lib}` });
      return root;
    }

    /** Replaces the app's autolinking CLI with `body`. */
    async function cliThat(root: string, body: string): Promise<void> {
      await writeFile(path.join(root, "node_modules", "expo-modules-autolinking", "bin", "expo-modules-autolinking.js"), body);
    }

    it("gates the library's copy the app's autolinking links on SDK 58", async () => {
      const root = await withLocalLib();
      await realAutolinkingCli(root);
      expect(readExpoPins(root, 58)["expo-font"]).toBe(OLDER);
      await expect(readExpoProject(root)).rejects.toThrow(PIN_ERROR(`expo-font ${OLDER}`));
    });

    it.each([
      ["is missing", undefined],
      ["exits non-zero", "process.exit(3);\n"],
      ["prints no JSON", "console.log('not json');\n"],
    ])("falls back to the two-copy rule when the CLI %s", async (_how, body) => {
      // The rule reads expo's nested copy (at the floor) here; the CLI, had it run, would name the library's.
      const root = await withLocalLib();
      if (body !== undefined) {
        await realAutolinkingCli(root);
        await cliThat(root, body);
      }
      expect(readExpoPins(root, 58)["expo-font"]).toBe(EXPO58_PINS["expo-font"]);
      await expect(readExpoProject(root)).resolves.toMatchObject({ sdkVersion: 58 });
    });
  });

  it("refuses a nested expo-modules-jsi on SDK 58", async () => {
    const dir = await expo58({}, { "expo-modules-jsi": "58.0.21" }, { "expo-modules-jsi": "58.0.19" });
    const where =
      "expo-modules-jsi 58.0.21 resolves from node_modules/expo-modules-core/node_modules/expo-modules-jsi, not from the " +
      "project's top-level node_modules: rn-xtool patches and builds only the top-level copy. Remove any expo-modules-jsi " +
      "pin or override from package.json";
    // A reinstall keeps the copy where package-lock.json put it, and dedupe has one copy only: `npm update` moves it.
    const hoist =
      " (`npm uninstall expo-modules-jsi` removes a pin), then run `npm update expo-modules-jsi`: it moves the copy to " +
      "the top level, which a reinstall does not do while package-lock.json keeps it nested.";
    const err = (await readExpoProject(dir).catch((e: unknown) => e)) as Error;
    expect(err).toEqual(new Error(`${where} (expo-modules-core 58.0.28 needs ~58.0.21)${hoist}`));
    expect(err.message).not.toContain("Pin expo-modules-jsi");
    expect(err.message).not.toContain("dedupe");
    // Without a range in core's package.json the parenthesis is left out.
    const core = path.join(dir, "node_modules", "expo-modules-core", "package.json");
    await writeFile(core, JSON.stringify({ name: "expo-modules-core", version: "58.0.28" }));
    await expect(readExpoProject(dir)).rejects.toThrow(new Error(`${where}${hoist}`));
  });

  it.skipIf(shared58Spm() === undefined)(`checks the expo-modules-macros copy expo 58's plugin uses${shared58Spm() === undefined ? EXPO_SKIP_NOTE : ""}`, async () => {
    // The installed plugin resolves the macros from core only (paths: [coreModuleRoot]); G3 must agree with it.
    const plugin = loadSpm<Plugin>(shared58Spm()!, "plugin.js");
    const ok = await expo58();
    expect(plugin.macroPluginFlags(expoPackageDir(ok, "expo-modules-core")!)).toContain(
      `${path.join(ok, "node_modules", "@expo", `modules-macros-linux-${process.arch}`, "ExpoModulesMacros")}#ExpoModulesMacros`,
    );
    expect(expoMacrosBinaryError({ root: ok })).toBeUndefined();
    for (const broken of [await expo58({}, {}, {}, { macrosBinary: false }), await expo58({ "expo-modules-macros": null })]) {
      expect(() => plugin.macroPluginFlags(expoPackageDir(broken, "expo-modules-core")!)).toThrow();
      expect(expoMacrosBinaryError({ root: broken })).toBeDefined();
    }
  });

  it("checks the macros binary through core on SDK 58", async () => {
    const dir = await expo58();
    const asked: string[] = [];
    expect(
      expoMacrosBinaryError({
        root: dir,
        arch: "riscv64",
        resolve: (spec) => {
          asked.push(spec);
          throw new Error("x");
        },
      }),
    ).toBe(NO_ARCH_ERROR("riscv64"));
    expect(asked).toEqual(["@expo/modules-macros-linux-riscv64/ExpoModulesMacros"]);
    // An architecture expo-modules-macros lists, with its binary package missing: the lockfile command and its version.
    expect(
      expoMacrosBinaryError({
        root: dir,
        arch: "arm64",
        resolve: () => {
          throw new Error("x");
        },
      }),
    ).toBe(BINARY_ERROR("arm64"));
    expect(expoMacrosBinaryError({ root: dir })).toBeUndefined();

    const noMacros = await expo58({ "expo-modules-macros": null });
    expect(expoMacrosBinaryError({ root: noMacros })).toBe(
      "expo-modules-macros is not installed next to expo-modules-core 58.0.28, which depends on it; run `npx expo install --fix` and reinstall.",
    );

    const noBinary = await expo58({}, {}, {}, { macrosBinary: false });
    expect(expoMacrosBinaryError({ root: noBinary })).toBe(BINARY_ERROR(process.arch));
    await expect(readExpoProject(noBinary)).rejects.toThrow(new Error(BINARY_ERROR(process.arch)));
  });
});

describe("defaultBundleIdentifier", () => {
  it("builds a valid reverse-DNS id from the slug", () => {
    expect(defaultBundleIdentifier("demo")).toBe("com.anonymous.demo");
    expect(defaultBundleIdentifier("  ¡Ñandú! app  ")).toBe("com.anonymous.nandu-app");
    expect(defaultBundleIdentifier("---")).toBe("com.anonymous.app");
  });
});

describe("buildVars", () => {
  it("derives the build variables", async () => {
    const p = await readExpoProject(await tempProject());
    expect(buildVars(p)).toEqual({
      PRODUCT_NAME: "app",
      PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
      MARKETING_VERSION: "1.0.0",
      CURRENT_PROJECT_VERSION: "1",
      PRODUCT_MODULE_NAME: "App",
      EXECUTABLE_NAME: "App",
      DEVELOPMENT_LANGUAGE: "en",
      PRODUCT_BUNDLE_PACKAGE_TYPE: "APPL",
    });
  });
});
