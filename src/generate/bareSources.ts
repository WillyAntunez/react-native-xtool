import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compiledName, type BareTargetContent, type TargetFile } from "../project/index.js";

/** What the copy of a bare app target gives the manifest (absolute paths). */
export interface CopiedBareTarget {
  bridgingHeader?: string;
  /** `include/` (the header forwards) first, then the project's HEADER_SEARCH_PATHS. */
  headerSearchPaths: string[];
  /** Top-level entries of the staged resources directory (files, `.lproj` and `.bundle` dirs), sorted. */
  resources: string[];
  /** Each copied code file's copy path → its source path. */
  origins: Record<string, string>;
}

/** Where the copy of a bare app target puts its code; every path relative to Sources/App. */
export interface BareCopyLayout {
  /** One entry per copied code file, in the order Swift sources, C-family sources, headers, bridging header. */
  files: { file: TargetFile; dest: string }[];
  /** A header's base name → the `dest` its `include/` forward imports (the first header of a name wins). */
  forwards: Map<string, string>;
  /** Headers the project references that do not exist: not copied. */
  missingHeaders: TargetFile[];
  /** `<ProductModuleName>-Swift.h` when `include/` holds a forward of that name to `App-Swift.h`. */
  swiftHeaderForward?: string;
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
 * Where `copyBareTarget` puts the app target's code under Sources/App: the layout under the target folder
 * (`ios/<Target>/Native/X.m` → `Native/X.m`; files elsewhere in ios/ keep their path from ios/), a C-family `main.m`
 * (any `main.<ext>`) as `AppMain.<ext>` in its folder, one `include/` forward per header name, as Xcode's header maps
 * allow `#import "X.h"` from any folder, plus `<ProductModuleName>-Swift.h` forwarding to `App-Swift.h` in a mixed target.
 * A referenced header that does not exist is left out. Throws for a file outside ios/, a file landing in `include/`
 * and two files landing on one path.
 */
export function bareCopyLayout(
  bare: BareTargetContent,
  iosDir: string,
  iosTargetDir: string,
  exists: (p: string) => boolean = existsSync,
): BareCopyLayout {
  const targetRel = path.relative(iosDir, iosTargetDir).split(path.sep).join("/");
  const place = (file: TargetFile): string => {
    if (path.posix.isAbsolute(file.relPath) || file.relPath.split("/").includes("..")) {
      throw new Error(
        `${file.absPath} is outside ios/: rn-xtool copies only sources under ios/ into the generated project; move it into ios/`,
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
  const cSources = new Set(bare.cSources);
  const headers = new Set(bare.headers);
  const files: BareCopyLayout["files"] = [];
  const missingHeaders: TargetFile[] = [];
  for (const file of code) {
    // Xcode builds with a referenced header missing until a source imports it; so does the generated target.
    if (headers.has(file) && !exists(file.absPath)) {
      missingHeaders.push(file);
      continue;
    }
    let dest = place(file);
    if (cSources.has(file)) dest = path.posix.join(path.posix.dirname(dest), compiledName(dest));
    if (dest.split("/")[0] === INCLUDE_DIR) {
      throw new Error(`${file.relPath} would land in Sources/App/${INCLUDE_DIR}/, which holds the generated header forwards; rename its folder`);
    }
    if (claim(dest, file)) files.push({ file, dest });
  }

  const forwards = new Map<string, string>();
  for (const { file, dest } of files) {
    const base = path.posix.basename(dest);
    if (headers.has(file) && !forwards.has(base)) forwards.set(base, dest);
  }

  // Xcode names the generated Swift header after the module (BareDemo-Swift.h); the SwiftPM target is App.
  const swiftHeader = `${bare.productModuleName}-Swift.h`;
  const swiftHeaderForward = bare.mixed && bare.productModuleName !== "App" && !forwards.has(swiftHeader) ? swiftHeader : undefined;
  return { files, forwards, missingHeaders, swiftHeaderForward };
}

/**
 * Copies the app target's code into `sourcesDir` (Sources/App) as `bareCopyLayout` places it, writing the `include/`
 * forwards, and says so for each renamed `main.<ext>`, skipped header and header name clash: `main.m` is copied as
 * `AppMain.m` so SwiftPM keeps App a library target. Resources are staged flat in `resourcesDir`, laid out as Xcode
 * copies them to the bundle root (xtool.yml lists each top-level entry).
 */
export async function copyBareTarget(
  bare: BareTargetContent,
  iosDir: string,
  iosTargetDir: string,
  sourcesDir: string,
  resourcesDir: string,
  log: (s: string) => void,
): Promise<CopiedBareTarget> {
  const layout = bareCopyLayout(bare, iosDir, iosTargetDir);
  const origins: Record<string, string> = {};
  for (const { file, dest } of layout.files) {
    const name = path.posix.basename(dest);
    if (name !== path.posix.basename(file.relPath)) {
      log(
        `ℹ ${file.relPath} is compiled as ${name}: SwiftPM takes a target with a file named main for an executable, ` +
          "and xtool links the app's entry point from the App library",
      );
    }
    origins[path.join(sourcesDir, dest)] = file.absPath;
    await copyListed(file, path.join(sourcesDir, dest));
  }
  for (const file of layout.missingHeaders) {
    log(`ℹ Skipped ${file.relPath}: the Xcode project references this header, but the file does not exist`);
  }

  const ownerOf = new Map(layout.files.map(({ file, dest }) => [dest, file.relPath]));
  const missing = new Set(layout.missingHeaders);
  for (const header of bare.headers) {
    if (missing.has(header)) continue;
    const base = path.posix.basename(header.relPath);
    const first = ownerOf.get(layout.forwards.get(base)!)!;
    if (first !== header.relPath) {
      log(`ℹ Two app headers are named ${base} (${first}, ${header.relPath}): #import "${base}" finds ${first}`);
      continue;
    }
    const shim = path.join(sourcesDir, INCLUDE_DIR, base);
    await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(shim, `#import "../${layout.forwards.get(base)}"\n`);
  }

  if (layout.swiftHeaderForward !== undefined) {
    await mkdir(path.join(sourcesDir, INCLUDE_DIR), { recursive: true });
    await writeFile(path.join(sourcesDir, INCLUDE_DIR, layout.swiftHeaderForward), `#import "App-Swift.h"\n`);
  } else if (bare.mixed && bare.productModuleName !== "App") {
    const name = `${bare.productModuleName}-Swift.h`;
    log(`ℹ The app header ${ownerOf.get(layout.forwards.get(name)!)} is named like Xcode's generated Swift header: #import "${name}" finds it, not App-Swift.h`);
  }

  const staged = new Map<string, string>();
  // Resources may live outside ios/ (react-native-asset adds ../assets/fonts/*): bundlePath() keeps only the name.
  for (const file of bare.resources) {
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

  const bridging = bare.bridgingHeader && layout.files.find(({ file }) => file.relPath === bare.bridgingHeader!.relPath);
  return {
    bridgingHeader: bridging ? path.join(sourcesDir, bridging.dest) : undefined,
    headerSearchPaths: [
      ...(layout.forwards.size > 0 || layout.swiftHeaderForward !== undefined ? [path.join(sourcesDir, INCLUDE_DIR)] : []),
      ...bare.headerSearchPaths,
    ],
    resources: [...new Set([...staged.keys()].map((d) => d.split("/")[0]!))].sort(),
    origins,
  };
}
