/**
 * Fake `node_modules` for an Expo SDK 58 project (or a hybrid app on its set), laid out the way npm installs the
 * 58.0.21 set: one `package.json` per package, plus the macros Linux binary. Only the layout matters; the gate
 * resolves each package and reads its version.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExpoPinName } from "../../src/versions.js";

/** The SDK 58 floor, in table order, written out here so the tests do not read it from the code under test. */
export const EXPO58_PINS: Record<ExpoPinName, string> = {
  expo: "58.0.21",
  "react-native": "0.88.1",
  "expo-modules-core": "58.0.28",
  "expo-modules-jsi": "58.0.21",
  "expo-modules-autolinking": "58.0.16",
  "expo-file-system": "58.0.13",
  "expo-font": "58.0.11",
};

const MACROS_VERSION = "0.27.1";

type FakePackage = ExpoPinName | "expo-modules-macros";

/** Where npm installs each package, relative to the root. */
const INSTALLED_AT: Record<FakePackage, string> = {
  expo: "node_modules/expo",
  "react-native": "node_modules/react-native",
  "expo-modules-core": "node_modules/expo-modules-core",
  "expo-modules-jsi": "node_modules/expo-modules-jsi",
  "expo-modules-autolinking": "node_modules/expo-modules-autolinking",
  "expo-file-system": "node_modules/expo/node_modules/expo-file-system",
  "expo-font": "node_modules/expo/node_modules/expo-font",
  "expo-modules-macros": "node_modules/expo-modules-macros",
};

/**
 * Where a `nested` copy goes: under this dir's node_modules. expo-modules-autolinking resolves from the root first, so
 * its nested copy under expo counts only when the top-level one is omitted (`overrides: { "expo-modules-autolinking": null }`).
 */
const RESOLVER: Record<ExpoPinName, string> = {
  expo: ".",
  "react-native": ".",
  "expo-modules-core": "node_modules/expo",
  "expo-modules-autolinking": "node_modules/expo",
  "expo-modules-jsi": "node_modules/expo-modules-core",
  "expo-file-system": "node_modules/expo",
  "expo-font": "node_modules/expo",
};

async function writePackage(dir: string, name: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const pkg: Record<string, unknown> = { name, version };
  // expo-modules-core 58.0.28's own ranges: G2 quotes the jsi one, G3 finds the macros through it.
  if (name === "expo-modules-core") pkg.dependencies = { "expo-modules-jsi": "~58.0.21", "expo-modules-macros": MACROS_VERSION };
  // expo-modules-macros 0.27.1's binary packages: G3 names the one for the host, at this version.
  if (name === "expo-modules-macros") {
    pkg.optionalDependencies = Object.fromEntries(
      ["linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].map((p) => [`@expo/modules-macros-${p}`, MACROS_VERSION]),
    );
  }
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
}

/**
 * Writes the SDK 58 floor set and expo-modules-macros 0.27.1 where npm installs them, and the macros Linux binary
 * for this host. `overrides` changes a version (`null` omits the package); `nested` adds a copy under its resolver's
 * `node_modules` (jsi under core); `hoisted` adds a top-level copy (a stray); `macrosBinary: false` leaves the binary out.
 */
export async function fakeExpo58Modules(
  dir: string,
  overrides: Partial<Record<FakePackage, string | null>> = {},
  nested: Partial<Record<ExpoPinName, string>> = {},
  hoisted: Partial<Record<ExpoPinName, string>> = {},
  opts: { macrosBinary?: boolean } = {},
): Promise<void> {
  const defaults: Record<FakePackage, string> = { ...EXPO58_PINS, "expo-modules-macros": MACROS_VERSION };
  for (const [name, wanted] of Object.entries(defaults) as [FakePackage, string][]) {
    const version = Object.hasOwn(overrides, name) ? overrides[name] : wanted;
    if (version !== null && version !== undefined) await writePackage(path.join(dir, INSTALLED_AT[name]), name, version);
  }
  for (const [name, version] of Object.entries(nested) as [ExpoPinName, string][]) {
    await writePackage(path.join(dir, RESOLVER[name], "node_modules", name), name, version);
  }
  for (const [name, version] of Object.entries(hoisted) as [ExpoPinName, string][]) {
    await writePackage(path.join(dir, "node_modules", name), name, version);
  }
  if (opts.macrosBinary !== false) {
    const binaryPackage = `@expo/modules-macros-linux-${process.arch}`;
    const binaryDir = path.join(dir, "node_modules", binaryPackage);
    await writePackage(binaryDir, binaryPackage, MACROS_VERSION);
    await writeFile(path.join(binaryDir, "ExpoModulesMacros"), "");
  }
}
