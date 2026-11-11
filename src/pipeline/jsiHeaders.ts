import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EMPTY_AR_ARCHIVE, headersXcframeworkInfoPlist, swapIn, type XcframeworkLibrary } from "./rnArtifacts.js";

/**
 * The npm packages of the SDKs on the vendored Expo plugin ship no `ExpoModulesJSIHeaders.xcframework`, which that
 * plugin (Expo 58's SwiftPM plugin) reads from `EXPO_PRECOMPILED_MODULES_PATH`. This module makes it from rn-xtool's
 * own ExpoModulesJSI build, in the layout of 58's published tarball.
 */

/** Bumped whenever the synthesised layout changes, so older trees are rewritten. */
export const JSI_HEADERS_GENERATOR_VERSION = 1;

/** The module map Expo 58 ships in each slice's `Headers/ExpoModulesJSI` (MIT data). */
export const JSI_HEADERS_MODULE_MAP =
  'module ExpoModulesJSI {\n  header "ExpoModulesJSI-Swift.h"\n  export *\n\n  explicit module Cxx {\n    requires cplusplus\n' +
  '    header "NativeState.h"\n    export *\n  }\n}\n';

const NAME = "ExpoModulesJSIHeaders";
const ARCHIVE = `lib${NAME}.a`;
const SWIFT_HEADER = "ExpoModulesJSI-Swift.h";
const SWIFT_INTERFACE = "ExpoModulesJSI.swiftinterface";
const NATIVE_STATE = "NativeState.h";
const STAMP = ".rn-xtool-jsi-headers.json";

const SLICES: XcframeworkLibrary[] = [
  { LibraryIdentifier: "ios-arm64", SupportedPlatform: "ios", SupportedArchitectures: ["arm64"] },
  {
    LibraryIdentifier: "ios-arm64_x86_64-simulator",
    SupportedPlatform: "ios",
    SupportedPlatformVariant: "simulator",
    SupportedArchitectures: ["arm64", "x86_64"],
  },
];

/** Where `scripts/build-expo-modules-jsi.sh` (output `jsiOut`) leaves the Swift header and interface it generates. */
export function jsiObjectsDir(jsiOut: string): string {
  return path.join(
    jsiOut,
    ".jsi-build",
    ".build",
    "out",
    "Intermediates.noindex",
    "ExpoModulesJSI.build",
    "Debug-iphoneos",
    "ExpoModulesJSI-t.build",
    "Objects-normal",
    "arm64",
  );
}

const headersDir = (precompiledRoot: string) => path.join(precompiledRoot, "expo-modules-jsi", "output", "headers");

/** The headers xcframework under `EXPO_PRECOMPILED_MODULES_PATH`, where the vendored plugin looks for it. */
export function jsiHeadersXcframeworkDir(precompiledRoot: string): string {
  return path.join(headersDir(precompiledRoot), "xcframeworks", `${NAME}.xcframework`);
}

interface JsiHeadersStamp {
  generatorVersion: number;
  jsiVersion: string;
  interfaceSha256: string;
}

async function readStamp(file: string): Promise<Partial<JsiHeadersStamp> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Partial<JsiHeadersStamp>;
  } catch {
    return undefined;
  }
}

const isFile = (file: string) => statSync(file, { throwIfNoEntry: false })?.isFile() === true;

/** The headers a C++ header includes with quotes (`#include "x.h"`, `#import "x.h"`), in order. */
function quotedIncludes(text: string): string[] {
  return [...text.matchAll(/^[ \t]*#[ \t]*(?:include|import)[ \t]*"([^"]+)"/gm)].map((m) => m[1]!);
}

/**
 * The public C++ headers of expo-modules-jsi `jsiVersion` at `jsiDir`: `dir` is
 * `<jsiDir>/apple/Sources/ExpoModulesJSI-Cxx/include/Public` when it holds NativeState.h (jsi 57 and newer), else
 * `…/include` (jsi 56); `files` is "NativeState.h", then each header it includes with quotes, transitively, found in
 * `dir`, in include order, each once. Throws when NativeState.h is in neither, or a quoted include is not in `dir`.
 */
export function nativeStateHeaders(jsiDir: string, jsiVersion: string): { dir: string; files: string[] } {
  const include = path.join(jsiDir, "apple", "Sources", "ExpoModulesJSI-Cxx", "include");
  const dir = [path.join(include, "Public"), include].find((d) => isFile(path.join(d, NATIVE_STATE)));
  if (dir === undefined) {
    throw new Error(
      `The ExpoModulesJSI build produced no ${NATIVE_STATE} (expected in ${include}/Public or ${include}); ` +
        `cannot make ${NAME}.xcframework for expo-modules-jsi ${jsiVersion}.`,
    );
  }
  const files: string[] = [];
  const visit = (rel: string) => {
    if (files.includes(rel)) return;
    files.push(rel);
    for (const name of quotedIncludes(readFileSync(path.join(dir, rel), "utf8"))) {
      // As the compiler does: next to the including header first. Only headers inside `dir` are copied.
      const found = path.relative(dir, path.resolve(dir, path.dirname(rel), name));
      const outside = found === ".." || found.startsWith(`..${path.sep}`) || path.isAbsolute(found);
      if (outside || !isFile(path.join(dir, found))) {
        throw new Error(
          `${NATIVE_STATE} of expo-modules-jsi ${jsiVersion} includes "${name}", which is not next to it in ${dir}; ` +
            `cannot make ${NAME}.xcframework.`,
        );
      }
      visit(found);
    }
  };
  visit(NATIVE_STATE);
  return { dir, files };
}

/**
 * Writes `ExpoModulesJSIHeaders.xcframework` for expo-modules-jsi `jsiVersion` from its build's `objectsDir` and the
 * package's public `NativeState.h` with the headers it includes (under `jsiDir`, see {@link nativeStateHeaders}).
 * Returns "current" without writing when the stamp matches this generator, version and interface. Otherwise the tree
 * is assembled beside the destination, the stamp deleted, the tree swapped in whole, and the stamp written last: a
 * failed run never leaves a stamped partial tree, and one that fails before the swap leaves the previous tree and its
 * stamp as they were.
 */
export async function writeJsiHeadersXcframework(i: {
  objectsDir: string;
  jsiDir: string;
  jsiVersion: string;
  precompiledRoot: string;
}): Promise<"written" | "current"> {
  for (const file of [SWIFT_HEADER, SWIFT_INTERFACE]) {
    if (!isFile(path.join(i.objectsDir, file))) {
      throw new Error(
        `The ExpoModulesJSI build produced no ${file} (expected in ${i.objectsDir}); ` +
          `cannot make ${NAME}.xcframework for expo-modules-jsi ${i.jsiVersion}.`,
      );
    }
  }
  const cxx = nativeStateHeaders(i.jsiDir, i.jsiVersion);

  const dest = jsiHeadersXcframeworkDir(i.precompiledRoot);
  const stampFile = path.join(headersDir(i.precompiledRoot), STAMP);
  const interfaceSha256 = createHash("sha256")
    .update(await readFile(path.join(i.objectsDir, SWIFT_INTERFACE)))
    .digest("hex");
  const stamp: JsiHeadersStamp = { generatorVersion: JSI_HEADERS_GENERATOR_VERSION, jsiVersion: i.jsiVersion, interfaceSha256 };
  const prev = await readStamp(stampFile);
  if (
    prev?.generatorVersion === stamp.generatorVersion &&
    prev.jsiVersion === stamp.jsiVersion &&
    prev.interfaceSha256 === stamp.interfaceSha256 &&
    existsSync(path.join(dest, "Info.plist"))
  ) {
    return "current";
  }

  const tmp = `${dest}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  try {
    for (const { LibraryIdentifier: slice } of SLICES) {
      const headers = path.join(tmp, slice, "Headers", "ExpoModulesJSI");
      await mkdir(headers, { recursive: true });
      await copyFile(path.join(i.objectsDir, SWIFT_HEADER), path.join(headers, SWIFT_HEADER));
      for (const file of cxx.files) {
        await mkdir(path.dirname(path.join(headers, file)), { recursive: true });
        await copyFile(path.join(cxx.dir, file), path.join(headers, file));
      }
      await writeFile(path.join(headers, "module.modulemap"), JSI_HEADERS_MODULE_MAP);
      await writeFile(path.join(tmp, slice, ARCHIVE), EMPTY_AR_ARCHIVE);
    }
    // Only the device slice gets an interface: rn-xtool builds for devices alone.
    const swiftmodule = path.join(tmp, "ios-arm64", "ExpoModulesJSI.swiftmodule");
    await mkdir(swiftmodule, { recursive: true });
    await copyFile(path.join(i.objectsDir, SWIFT_INTERFACE), path.join(swiftmodule, "arm64-apple-ios.swiftinterface"));
    await writeFile(path.join(tmp, "Info.plist"), headersXcframeworkInfoPlist(NAME, SLICES, { archive: ARCHIVE }));
    await writeFile(path.join(tmp, "expo-package.json"), JSON.stringify({ name: "expo-modules-jsi", version: i.jsiVersion }) + "\n");
    await rm(stampFile, { force: true });
    await swapIn(tmp, dest, `${dest}.old-${process.pid}`);
  } catch (err) {
    // Cleanup is best-effort: the original error is the one worth reporting.
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await writeFile(stampFile, JSON.stringify(stamp, null, 2) + "\n");
  return "written";
}
