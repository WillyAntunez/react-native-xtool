import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** What the app's Swift compiler needs to load mixed Swift + Objective-C Expo modules. */
export interface ClangImporterInputs {
  /** Where Swift Build writes every `<Module>-Swift.h` and `<Module>.modulemap`. */
  swiftHeadersDir: string;
  /** Each generated Expo package's `pod-headers` (CocoaPods-style include paths). */
  includeDirs: string[];
  /** `<Module>.modulemap` of each generated Expo package with Swift, for `@import <Module>;`. */
  moduleMaps: string[];
}

const EXPO_PACKAGE_RX = /\.package\(name: "([^"]+)", path: "([^"]*\/expo-source\/[^"]+)"\)/g;

/**
 * A mixed Expo module is compiled with its Objective-C headers as a bridging header, and Swift
 * re-reads that header in every module importing it: the app (ExpoModulesProvider.swift) must
 * resolve what those headers include, as CocoaPods' header search paths let it. Only the
 * packages the autolinking manifest references count (stale `expo-source` dirs are ignored).
 * Undefined when there is no mixed package, so plain apps keep their flags.
 */
export async function expoClangImporterInputs(
  autolinkingDir: string,
  swiftHeadersDir: string,
): Promise<ClangImporterInputs | undefined> {
  let manifest: string;
  try {
    manifest = await readFile(join(autolinkingDir, "Package.swift"), "utf8");
  } catch {
    return undefined;
  }
  const packages = [...manifest.matchAll(EXPO_PACKAGE_RX)]
    .map((m) => ({ name: m[1]!, dir: m[2]! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const includeDirs: string[] = [];
  const moduleMaps: string[] = [];
  let mixed = false;
  for (const { name, dir } of packages) {
    const podHeaders = join(dir, "pod-headers");
    if (!existsSync(podHeaders)) continue;
    includeDirs.push(podHeaders);
    if (existsSync(join(podHeaders, name, `${name}-Swift.h`))) {
      moduleMaps.push(join(swiftHeadersDir, `${name}.modulemap`));
    }
    if (existsSync(join(podHeaders, name, `${name}-umbrella.h`))) mixed = true;
  }
  return mixed ? { swiftHeadersDir, includeDirs, moduleMaps } : undefined;
}
