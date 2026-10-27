import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVars, defaultBundleIdentifier, MissingBundleIdentifierError, readExpoProject } from "../../src/project/index.js";
import { expoMacrosBinaryError, expoPackageDir, readExpoPins } from "../../src/project/expo.js";
import { expoPinsFor, expoPluginFor, type ExpoPinName } from "../../src/versions.js";
import { EXPO57_PINS, fakeExpo57Modules } from "../support/expo57.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = path.join(fixtures, "project");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempProject(
  mutate: (app: { expo: Record<string, any> }, pkg: Record<string, any>) => void,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-project-"));
  tempDirs.push(dir);
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
    expect(p.bundleIdentifier).toBe("com.example.app");
    expect(p.iosTargetName).toBe("app");
    expect(p.iosTargetDir).toBe(path.join(fixture, "ios", "app"));
    expect(p.sdkVersion).toBe(58);
    expect(p.version).toBe("1.0.0");
    expect(p.buildNumber).toBe("1");
    expect(p.slug).toBe("app");
  });

  it("an Expo project uses the installed scripts", async () => {
    expect((await readExpoProject(fixture)).rnScripts).toBe("installed");
  });

  it("sanitizes the target name like prebuild", async () => {
    const dir = await tempProject((app) => {
      app.expo.name = "Mi App Ñandú 2";
    });
    expect((await readExpoProject(dir)).iosTargetName).toBe("MiAppNandu2");
  });

  it.each([56, 55, 54])("rejects SDK %i", async (sdk) => {
    const dir = await tempProject((_app, pkg) => {
      pkg.dependencies.expo = `~${sdk}.0.0`;
    });
    await expect(readExpoProject(dir)).rejects.toThrow(
      new Error(`Expo SDK ${sdk} is not supported; rn-xtool supports SDK 57 (expo 57.0.31) and SDK 58 or newer.`),
    );
  });

  it.each([58, 59])("keeps SDK %i on the installed plugin", async (sdk) => {
    const dir = await tempProject((_app, pkg) => {
      pkg.dependencies.expo = `~${sdk}.0.0`;
    });
    // No pin check: these versions would all fail SDK 57's gate.
    await fakeExpo57Modules(dir, { expo: `${sdk}.0.0`, "react-native": "0.88.0", "expo-modules-core": "57.0.25", "expo-modules-jsi": null });
    const p = await readExpoProject(dir);
    expect(p).toMatchObject({ sdkVersion: sdk, expoPlugin: "installed", rnScripts: "installed" });
  });

  it("prefers exp.sdkVersion over the expo dependency", async () => {
    const dir = await tempProject((app, pkg) => {
      app.expo.sdkVersion = "58.0.0";
      delete pkg.dependencies.expo;
    });
    expect((await readExpoProject(dir)).sdkVersion).toBe(58);
  });

  it("throws when the SDK cannot be determined (non-numeric range)", async () => {
    const dir = await tempProject((_app, pkg) => {
      pkg.dependencies.expo = "latest";
    });
    await expect(readExpoProject(dir)).rejects.toThrow("Could not determine Expo SDK version");
  });

  it("throws when the SDK cannot be determined (no expo dependency)", async () => {
    const dir = await tempProject((_app, pkg) => {
      delete pkg.dependencies.expo;
    });
    await expect(readExpoProject(dir)).rejects.toThrow("Could not determine Expo SDK version");
  });

  it.each(["58.0.19", "~58", ">=58.0.0 <59", "sdk-58.0.0", "npm:expo-next2@58"])(
    "parses the major from expo range %s",
    async (range) => {
      const dir = await tempProject((_app, pkg) => {
        pkg.dependencies.expo = range;
      });
      expect((await readExpoProject(dir)).sdkVersion).toBe(58);
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

describe("Expo SDK 57", () => {
  const PIN_ERROR = (list: string) =>
    new Error(
      "Expo SDK 57 needs exactly expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24, " +
        `expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3; installed: ${list}. Pin those versions in package.json and reinstall.`,
    );

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
    expect(expoPinsFor(58)).toBeUndefined();
    expect([expoPluginFor(56), expoPluginFor(57), expoPluginFor(58), expoPluginFor(59)]).toEqual([
      undefined, "vendored", "installed", "installed",
    ]);
  });

  it("accepts SDK 57 with the exact pins", async () => {
    const dir = await expo57();
    const p = await readExpoProject(dir);
    expect(p).toMatchObject({ sdkVersion: 57, rnVersion: "0.86.3", rnScripts: "vendored", expoPlugin: "vendored" });
    expect(p.iosTargetDir).toBe(path.join(dir, "ios", "Spike57"));
    expect(readExpoPins(dir)).toEqual(EXPO57_PINS);
  });

  const NEXT_PATCH: Record<ExpoPinName, string> = {
    expo: "57.0.32",
    "react-native": "0.86.4",
    "expo-modules-core": "57.0.25",
    "expo-modules-autolinking": "57.0.17",
    "expo-modules-jsi": "57.1.4",
  };

  it.each(Object.entries(NEXT_PATCH))("names %s when it is off", async (name, version) => {
    const dir = await expo57({ [name]: version });
    await expect(readExpoProject(dir)).rejects.toThrow(PIN_ERROR(`${name} ${version}`));
  });

  it("names each pin that is off, in pin order", async () => {
    const two = await expo57({ "expo-modules-jsi": "57.1.4", expo: "57.0.32" });
    await expect(readExpoProject(two)).rejects.toThrow(PIN_ERROR("expo 57.0.32, expo-modules-jsi 57.1.4"));
    const missing = await expo57({ "expo-modules-jsi": null });
    await expect(readExpoProject(missing)).rejects.toThrow(PIN_ERROR("expo-modules-jsi not installed"));
  });

  it("reads each pin where the build resolves it", async () => {
    const nestedCore = await expo57({}, { "expo-modules-core": "57.0.25" });
    expect(expoPackageDir(nestedCore, "expo-modules-core")).toBe(
      path.join(nestedCore, "node_modules", "expo", "node_modules", "expo-modules-core"),
    );
    await expect(readExpoProject(nestedCore)).rejects.toThrow(PIN_ERROR("expo-modules-core 57.0.25"));

    const nestedAutolinking = await expo57({ "expo-modules-autolinking": null }, { "expo-modules-autolinking": "57.0.16" });
    expect(readExpoPins(nestedAutolinking)["expo-modules-autolinking"]).toBe("57.0.16");
    const rootAutolinking = await expo57({}, { "expo-modules-autolinking": "57.0.17" });
    expect(readExpoPins(rootAutolinking)["expo-modules-autolinking"]).toBe("57.0.16");

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
          "project's top-level node_modules: rn-xtool patches and builds only the top-level copy. Pin expo-modules-jsi to " +
          "57.1.3 in package.json and reinstall (npm dedupe may also fix it).",
      ),
    );
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

describe("defaultBundleIdentifier", () => {
  it("builds a valid reverse-DNS id from the slug", () => {
    expect(defaultBundleIdentifier("demo")).toBe("com.anonymous.demo");
    expect(defaultBundleIdentifier("  ¡Ñandú! app  ")).toBe("com.anonymous.nandu-app");
    expect(defaultBundleIdentifier("---")).toBe("com.anonymous.app");
  });
});

describe("buildVars", () => {
  it("derives the build variables", async () => {
    const p = await readExpoProject(fixture);
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
