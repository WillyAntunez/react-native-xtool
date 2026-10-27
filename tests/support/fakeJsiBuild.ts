/**
 * A miniature ExpoModulesJSI build for the headers synthesis: the two files the Swift build leaves in its objects dir
 * and the package's public `NativeState.h`. Contents are placeholders; only the layout mirrors a real build.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FAKE_SWIFT_HEADER = "// ExpoModulesJSI-Swift.h\n#pragma once\n";
export const FAKE_SWIFT_INTERFACE = "// swift-interface-format-version: 1.0\n// swift-module-flags: -module-name ExpoModulesJSI\n";
export const FAKE_NATIVE_STATE = "// NativeState.h\n#pragma once\n";

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Writes `<dir>/objects/{ExpoModulesJSI-Swift.h, ExpoModulesJSI.swiftinterface}` and the jsi package's `NativeState.h`. */
export function makeFakeJsiBuild(dir: string): { objectsDir: string; jsiDir: string } {
  const objectsDir = path.join(dir, "objects");
  const jsiDir = path.join(dir, "expo-modules-jsi");
  write(path.join(objectsDir, "ExpoModulesJSI-Swift.h"), FAKE_SWIFT_HEADER);
  write(path.join(objectsDir, "ExpoModulesJSI.swiftinterface"), FAKE_SWIFT_INTERFACE);
  write(path.join(jsiDir, "apple", "Sources", "ExpoModulesJSI-Cxx", "include", "Public", "NativeState.h"), FAKE_NATIVE_STATE);
  return { objectsDir, jsiDir };
}
