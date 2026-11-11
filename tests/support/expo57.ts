/**
 * Fake `node_modules` for an Expo SDK 57 project (and, through `fakeExpoModules`, any set laid out the same way): one
 * `package.json` per pinned package; expo-file-system and expo-font are Expo modules too (`writeExpoModuleFiles`), so
 * expo-modules-autolinking lists them. Only the layout matters; the readers resolve each package and read its version.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExpoPinName } from "../../src/versions.js";

/** The exact SDK 57 pins, written out here so the tests do not read them from the code under test. */
export const EXPO57_PINS: Partial<Record<ExpoPinName, string>> = {
  expo: "57.0.31",
  "react-native": "0.86.3",
  "expo-modules-core": "57.0.24",
  "expo-modules-autolinking": "57.0.16",
  "expo-modules-jsi": "57.1.3",
};

/** Where the build resolves each package from, relative to the root: a nested copy goes under this dir's node_modules. */
const RESOLVER: Record<ExpoPinName, string> = {
  expo: ".",
  "react-native": ".",
  "expo-modules-core": "node_modules/expo",
  "expo-modules-autolinking": "node_modules/expo",
  "expo-modules-jsi": "node_modules/expo-modules-core",
  "expo-file-system": "node_modules/expo",
  "expo-font": "node_modules/expo",
};

/** The Expo modules of the sets, with their pod: autolinking lists a package that has these two files. */
const EXPO_MODULE_PODS: Record<string, string> = { "expo-file-system": "ExpoFileSystem", "expo-font": "ExpoFont" };

/**
 * Makes `dir` an Expo module for Apple the way the real package is one: an `expo-module.config.json` and a podspec in
 * `ios/`. Autolinking lists only such packages, and it reads where the pod lives from the podspec.
 */
export async function writeExpoModuleFiles(dir: string, pod: string): Promise<void> {
  await mkdir(path.join(dir, "ios"), { recursive: true });
  await writeFile(path.join(dir, "expo-module.config.json"), JSON.stringify({ platforms: ["apple"] }));
  await writeFile(path.join(dir, "ios", `${pod}.podspec`), "");
}

/** A package.json, plus the Expo module files for expo-file-system and expo-font, and expo's dependencies on both. */
async function writePackage(dir: string, name: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // expo depends on both, so autolinking reaches them through it (the app lists only expo).
  const deps = name === "expo" ? { dependencies: Object.fromEntries(Object.keys(EXPO_MODULE_PODS).map((n) => [n, "*"])) } : {};
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version, ...deps }));
  const pod = EXPO_MODULE_PODS[name];
  if (pod !== undefined) await writeExpoModuleFiles(dir, pod);
}

/**
 * Writes `<dir>/node_modules/<pkg>/package.json` for every one of `pins` (all at the top level, as npm hoists them).
 * `overrides` changes a version (`null` omits the package); `nested` adds a copy under its resolver's `node_modules`
 * (core, autolinking, file-system and font under `expo`, jsi under core).
 */
export async function fakeExpoModules(
  dir: string,
  pins: Partial<Record<ExpoPinName, string>>,
  overrides: Partial<Record<ExpoPinName, string | null>> = {},
  nested: Partial<Record<ExpoPinName, string>> = {},
): Promise<void> {
  for (const [name, pinned] of Object.entries(pins) as [ExpoPinName, string][]) {
    const version = Object.hasOwn(overrides, name) ? overrides[name] : pinned;
    if (version !== null && version !== undefined) await writePackage(path.join(dir, "node_modules", name), name, version);
  }
  for (const [name, version] of Object.entries(nested) as [ExpoPinName, string][]) {
    await writePackage(path.join(dir, RESOLVER[name], "node_modules", name), name, version);
  }
}

/** `fakeExpoModules` on the SDK 57 set. */
export async function fakeExpo57Modules(
  dir: string,
  overrides: Partial<Record<ExpoPinName, string | null>> = {},
  nested: Partial<Record<ExpoPinName, string>> = {},
): Promise<void> {
  await fakeExpoModules(dir, EXPO57_PINS, overrides, nested);
}
