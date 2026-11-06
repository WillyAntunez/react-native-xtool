import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { readXcframeworkSlices } from "../pipeline/rnArtifacts.js";

/** The scaffold's per-library directory of `<Pod/Header.h>` forwards (POD_HEADERS_DIR in scaffold-package-swift.js). */
export const POD_HEADERS_DIR = "rn-spm-pod-headers";

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Each `header "<path>"` a module map names (umbrella, textual and private ones too; excluded ones not), in order. */
function moduleMapHeaders(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)(exclude\s+)?(?:(?:umbrella|textual|private)\s+)*header\s+"([^"]+)"/g)]
    .filter((m) => m[1] === undefined)
    .map((m) => m[2]!);
}

/**
 * The directories that hold React Native's public Objective-C headers in `xcframeworks` (the generated
 * `ios/build/xcframeworks`), so a bare app's `#import <RCTAppDelegate.h>` resolves as CocoaPods' per-pod header search
 * paths allow: ReactHeadersTarget's flat `include/React`, then each directory of the device slice of
 * ReactNativeHeaders.xcframework whose headers its module map names directly (`React_RCTAppDelegate/RCTAppDelegate.h`
 * → `React_RCTAppDelegate`), in module map order. Headers deeper than that (`react/debug/flags.h`) keep their path
 * spelling. Only existing directories; empty before the headers are staged.
 */
export function reactNativeBareIncludeDirs(xcframeworks: string): string[] {
  const dirs: string[] = [];
  const react = join(xcframeworks, "ReactHeadersTarget", "include", "React");
  if (isDir(react)) dirs.push(react);
  const xcframework = join(xcframeworks, "ReactNativeHeaders.xcframework");
  if (!existsSync(join(xcframework, "Info.plist"))) return dirs;
  // xtool builds for the device: the slice without a platform variant.
  const device = readXcframeworkSlices(xcframework).find((s) => s.SupportedPlatform === "ios" && s.SupportedPlatformVariant === undefined);
  if (device === undefined) return dirs;
  const headers = join(xcframework, device.LibraryIdentifier, device.HeadersPath ?? "Headers");
  let map: string;
  try {
    map = readFileSync(join(headers, "module.modulemap"), "utf8");
  } catch {
    return dirs;
  }
  const seen = new Set<string>();
  for (const header of moduleMapHeaders(map)) {
    const parts = header.split("/");
    if (parts.length !== 2 || parts[0] === "" || parts[0] === "." || parts[0] === ".." || seen.has(parts[0]!)) continue;
    seen.add(parts[0]!);
    const dir = join(headers, parts[0]!);
    if (isDir(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * The scaffold's `<Pod/Header.h>` forwards (a pod table entry's `forwardHeaders`, e.g. `<AppAuth/AppAuth.h>`) of every
 * autolinked library that has them: `<lib>/rn-spm-pod-headers`, read at React Native's `<autolinkingDir>/libs/<name>`
 * aliases and resolved to the real library directory, in lib-name order. CocoaPods puts those headers in
 * `Headers/Public/<Pod>/`, which the app sees. Empty without libs/.
 */
export async function podHeaderForwardDirs(autolinkingDir: string): Promise<string[]> {
  const libsDir = join(autolinkingDir, "libs");
  let names: string[];
  try {
    names = (await readdir(libsDir)).sort();
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    try {
      const dir = join(await realpath(join(libsDir, name)), POD_HEADERS_DIR);
      if ((await stat(dir)).isDirectory()) dirs.push(dir);
    } catch {
      continue;
    }
  }
  return dirs;
}
