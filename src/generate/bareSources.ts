import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BareTargetContent, TargetFile } from "../project/index.js";

/** What the copy of a bare app target gives the manifest (absolute paths). */
export interface CopiedBareTarget {
  bridgingHeader?: string;
  /** `include/` (the header forwards) first, then the project's HEADER_SEARCH_PATHS. */
  headerSearchPaths: string[];
  /** Top-level entries of the staged resources directory (files, `.lproj` and `.bundle` dirs), sorted. */
  resources: string[];
}

const INCLUDE_DIR = "include";
const KEPT_PARENT = /\.(lproj|bundle)$/i;

/** Where Xcode puts a resource in the app bundle: at the root, inside its `.lproj`/`.bundle` if it has one. */
function bundlePath(relPath: string): string {
  const parts = relPath.split("/");
  const at = parts.slice(0, -1).findIndex((p) => KEPT_PARENT.test(p));
  return at < 0 ? parts[parts.length - 1]! : parts.slice(at).join("/");
}

async function copyListed(file: TargetFile, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await cp(file.absPath, dest, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing ${file.relPath}, listed in the app target of the Xcode project: ${file.absPath}`);
    }
    throw e;
  }
}

/**
 * Copies the app target's code into `sourcesDir` (Sources/App), keeping its layout under the
 * target folder (`ios/<Target>/Native/X.m` → `Native/X.m`; files elsewhere in ios/ keep their
 * path from ios/), with one forwarding header per header in `include/` so `#import "X.h"` resolves
 * from any folder as Xcode's header maps allow. Resources are staged flat in `resourcesDir`, laid
 * out as Xcode copies them to the bundle root (xtool.yml lists each top-level entry).
 */
export async function copyBareTarget(
  bare: BareTargetContent,
  iosDir: string,
  iosTargetDir: string,
  sourcesDir: string,
  resourcesDir: string,
  log: (s: string) => void,
): Promise<CopiedBareTarget> {
  const targetRel = path.relative(iosDir, iosTargetDir).split(path.sep).join("/");
  const place = (file: TargetFile): string => {
    if (path.posix.isAbsolute(file.relPath) || file.relPath.split("/").includes("..")) {
      throw new Error(
        `${file.absPath} is outside ios/: expo-xtool copies only files under ios/ into the generated project; move it into ios/`,
      );
    }
    const inTarget = targetRel !== "" && !targetRel.startsWith("..") && file.relPath.startsWith(`${targetRel}/`);
    return inTarget ? file.relPath.slice(targetRel.length + 1) : file.relPath;
  };

  const claimed = new Map<string, string>();
  const claim = (dest: string, file: TargetFile): boolean => {
    const owner = claimed.get(dest);
    if (owner === file.relPath) return false;
    if (owner !== undefined) {
      throw new Error(`${owner} and ${file.relPath} would both be copied to Sources/App/${dest}`);
    }
    claimed.set(dest, file.relPath);
    return true;
  };

  const code = [...bare.swiftSources, ...bare.cSources, ...bare.headers, ...(bare.bridgingHeader ? [bare.bridgingHeader] : [])];
  const codeDest = new Map<TargetFile, string>();
  for (const file of code) {
    const dest = place(file);
    if (dest.split("/")[0] === INCLUDE_DIR) {
      throw new Error(`${file.relPath} would land in Sources/App/${INCLUDE_DIR}/, which holds the generated header forwards; rename its folder`);
    }
    codeDest.set(file, dest);
    if (claim(dest, file)) await copyListed(file, path.join(sourcesDir, dest));
  }

  const forwarded = new Map<string, string>();
  for (const header of bare.headers) {
    const dest = codeDest.get(header)!;
    const base = path.posix.basename(dest);
    const first = forwarded.get(base);
    if (first !== undefined) {
      log(`ℹ Two app headers are named ${base} (${first}, ${header.relPath}): #import "${base}" finds ${first}`);
      continue;
    }
    forwarded.set(base, header.relPath);
    const shim = path.join(sourcesDir, INCLUDE_DIR, base);
    await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(shim, `#import "../${dest}"\n`);
  }

  const staged = new Map<string, string>();
  for (const file of bare.resources) {
    place(file);
    const dest = bundlePath(file.relPath);
    for (const [other, owner] of staged) {
      if (other === dest || other.startsWith(`${dest}/`) || dest.startsWith(`${other}/`)) {
        throw new Error(`App resources ${owner} and ${file.relPath} would both be copied to ${dest} in the app bundle`);
      }
    }
    staged.set(dest, file.relPath);
    await copyListed(file, path.join(resourcesDir, dest));
  }

  if (bare.skippedResources.length > 0) {
    log(
      `ℹ Skipped app resources that need Xcode's tools (storyboards, asset catalogs, xibs): ${bare.skippedResources.map((f) => f.relPath).join(", ")}`,
    );
  }
  if (bare.ignoredSettings.length > 0) {
    log(`ℹ Build settings of the app target not carried over: ${bare.ignoredSettings.join(", ")}`);
  }

  return {
    bridgingHeader: bare.bridgingHeader ? path.join(sourcesDir, codeDest.get(bare.bridgingHeader)!) : undefined,
    headerSearchPaths: [...(forwarded.size > 0 ? [path.join(sourcesDir, INCLUDE_DIR)] : []), ...bare.headerSearchPaths],
    resources: [...new Set([...staged.keys()].map((d) => d.split("/")[0]!))].sort(),
  };
}
