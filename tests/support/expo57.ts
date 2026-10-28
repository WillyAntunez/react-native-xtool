/**
 * Fake `node_modules` for an Expo SDK 57 project: one `package.json` per pinned package, nothing else.
 * Only the layout matters; the readers resolve each package and read its version.
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

async function writePackage(dir: string, name: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version }));
}

/**
 * Writes `<dir>/node_modules/<pkg>/package.json` for every pin. `overrides` changes a version (`null` omits the
 * package); `nested` adds a copy under its resolver's `node_modules` (core and autolinking under `expo`, jsi under core).
 */
export async function fakeExpo57Modules(
  dir: string,
  overrides: Partial<Record<ExpoPinName, string | null>> = {},
  nested: Partial<Record<ExpoPinName, string>> = {},
): Promise<void> {
  for (const [name, pinned] of Object.entries(EXPO57_PINS) as [ExpoPinName, string][]) {
    const version = Object.hasOwn(overrides, name) ? overrides[name] : pinned;
    if (version !== null && version !== undefined) await writePackage(path.join(dir, "node_modules", name), name, version);
  }
  for (const [name, version] of Object.entries(nested) as [ExpoPinName, string][]) {
    await writePackage(path.join(dir, RESOLVER[name], "node_modules", name), name, version);
  }
}
