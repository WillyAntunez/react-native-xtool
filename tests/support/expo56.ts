/**
 * Fake `node_modules` for an Expo SDK 56 project, laid out the way npm installs the 56.0.24 set: every package at the
 * top level, expo-file-system and expo-font included (SDK 57 and 58 nest those two under `expo`). One `package.json`
 * per pinned package, nothing else.
 */
import type { ExpoPinName } from "../../src/versions.js";
import { fakeExpoModules } from "./expo57.js";

/** The SDK 56 floor, in table order, written out here so the tests do not read it from the code under test. */
export const EXPO56_PINS: Partial<Record<ExpoPinName, string>> = {
  expo: "56.0.24",
  "react-native": "0.85.3",
  "expo-modules-core": "56.0.27",
  "expo-modules-jsi": "56.0.14",
  "expo-modules-autolinking": "56.0.24",
  "expo-file-system": "56.0.11",
  "expo-font": "56.0.7",
};

/** `fakeExpoModules` on the SDK 56 set: `overrides` changes a version (`null` omits it), `nested` adds a nested copy. */
export async function fakeExpo56Modules(
  dir: string,
  overrides: Partial<Record<ExpoPinName, string | null>> = {},
  nested: Partial<Record<ExpoPinName, string>> = {},
): Promise<void> {
  await fakeExpoModules(dir, EXPO56_PINS, overrides, nested);
}
