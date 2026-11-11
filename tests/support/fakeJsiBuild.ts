/**
 * A miniature ExpoModulesJSI build for the headers synthesis: the two files the Swift build leaves in its objects dir
 * and the package's public `NativeState.h`. Contents are placeholders; only the layout and the include lines mirror a
 * real build (jsi 57 and newer: `include/Public/NativeState.h`, no quoted include; jsi 56: `include/NativeState.h`,
 * which includes `"RetainedSwiftPointer.h"` beside it).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FAKE_SWIFT_HEADER = "// ExpoModulesJSI-Swift.h\n#pragma once\n";
export const FAKE_SWIFT_INTERFACE = "// swift-interface-format-version: 1.0\n// swift-module-flags: -module-name ExpoModulesJSI\n";
export const FAKE_NATIVE_STATE = "// NativeState.h\n#pragma once\n";
/** jsi 56.0.14's `include/NativeState.h`, its include lines as upstream has them. */
export const FAKE_NATIVE_STATE_FLAT =
  '// NativeState.h\n#pragma once\n#include <memory>\n#include <swift/bridging>\n#include <jsi/jsi.h>\n#include "RetainedSwiftPointer.h"\n';
/** jsi 56.0.14's `include/RetainedSwiftPointer.h`: system headers only. */
export const FAKE_RETAINED_POINTER = "// RetainedSwiftPointer.h\n#pragma once\n#include <memory>\n#include <swift/bridging>\n";

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * Writes `<dir>/objects/{ExpoModulesJSI-Swift.h, ExpoModulesJSI.swiftinterface}` and the jsi package's headers:
 * `"public"` (default, jsi 57 and newer) `include/Public/NativeState.h`; `"flat"` (jsi 56) `include/NativeState.h` and
 * `include/RetainedSwiftPointer.h`.
 */
export function makeFakeJsiBuild(dir: string, opts: { layout?: "public" | "flat" } = {}): { objectsDir: string; jsiDir: string } {
  const objectsDir = path.join(dir, "objects");
  const jsiDir = path.join(dir, "expo-modules-jsi");
  const include = path.join(jsiDir, "apple", "Sources", "ExpoModulesJSI-Cxx", "include");
  write(path.join(objectsDir, "ExpoModulesJSI-Swift.h"), FAKE_SWIFT_HEADER);
  write(path.join(objectsDir, "ExpoModulesJSI.swiftinterface"), FAKE_SWIFT_INTERFACE);
  if (opts.layout === "flat") {
    write(path.join(include, "NativeState.h"), FAKE_NATIVE_STATE_FLAT);
    write(path.join(include, "RetainedSwiftPointer.h"), FAKE_RETAINED_POINTER);
  } else {
    write(path.join(include, "Public", "NativeState.h"), FAKE_NATIVE_STATE);
  }
  return { objectsDir, jsiDir };
}
