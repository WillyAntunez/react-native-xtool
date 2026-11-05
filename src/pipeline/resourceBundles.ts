/**
 * Podspec `resource_bundles` as `.bundle` folders at the app root (spec goal 4): each key `K` becomes `K.bundle`, holding
 * the files its globs match and the `Info.plist` CocoaPods writes for a resource bundle. A glob ending in `/**` keeps
 * the layout below its literal folder; a folder any other glob matches is copied whole under its name, and a file it
 * matches goes to the bundle root under its basename, inside its nearest `.lproj` folder when it has one, as CocoaPods
 * copies matched files flat and keeps localizations (NSBundle's `URLForResource:withExtension:` looks at the root:
 * react-native-svg's filters; row 86). Files
 * are copied, never symlinked (xtool copies a symlink as a symlink) nor hard-linked (row 85: an edit in the app's copy
 * never reaches the cache or the package).
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import * as plist from "plist";
import { PODS_LINK, PodsError } from "../pods/format.js";
import { copyKeepingTime } from "../pods/stage.js";

const micromatch = createRequire(import.meta.url)("micromatch") as {
  isMatch: (path: string, patterns: string | string[], options?: { dot?: boolean }) => boolean;
  scan: (pattern: string) => { base: string; isGlob: boolean };
};

export interface BundleSource {
  /** The `resource_bundles` key: the bundle is `<key>.bundle`. */
  key: string;
  /** The folder the globs are relative to: the pod's extracted tree, or the podspec's folder. */
  baseDir: string;
  globs: string[];
  /** Who declares it, for the texts: "MLKitTextRecognition 6.0.0", "react-native-svg". */
  owner: string;
}

export interface BuiltBundle {
  name: string;
  owner: string;
  files: number;
}

/** Resources Xcode compiles (asset catalogs, storyboards, xibs): rn-xtool has no tool for them. */
const COMPILED_DIR = /\.xcassets$/;
const COMPILED_FILE = /\.(storyboard|xib)$/;

/** Every file below `dir` (symlinks to files included), relative with `/`, sorted. */
function walk(dir: string, rel = ""): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
    else if (e.isSymbolicLink() && statSync(path.join(dir, r), { throwIfNoEntry: false })?.isFile() === true) out.push(r);
  }
  return out.sort();
}

/** Every folder below `dir` (not through symlinks), relative with `/`, sorted. */
function walkDirs(dir: string, rel = ""): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    out.push(r, ...walkDirs(dir, r));
  }
  return out.sort();
}

const clean = (glob: string): string => glob.replace(/^(\.\/)+/, "");

/** A flattened file's place: its basename, inside its nearest `.lproj` folder when it has one (row 86). */
function flatDest(rel: string): string {
  const parts = rel.split("/");
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i]!.endsWith(".lproj")) return `${parts[i]}/${parts.at(-1)}`;
  }
  return parts.at(-1)!;
}

/** The compiled resource a file belongs to (its asset catalog, or itself), or undefined. */
function compiledOf(rel: string): string | undefined {
  const parts = rel.split("/");
  const at = parts.findIndex((p) => COMPILED_DIR.test(p));
  if (at !== -1) return parts.slice(0, at + 1).join("/");
  return COMPILED_FILE.test(rel) ? rel : undefined;
}

/** The matches of every glob, with their place in the bundle, and the compiled resources left out. */
function matches(s: BundleSource): { files: { dest: string; src: string; rel: string }[]; compiled: string[] } {
  const all = walk(s.baseDir);
  const dirs = walkDirs(s.baseDir);
  const files: { dest: string; src: string; rel: string }[] = [];
  const compiled = new Set<string>();
  for (const raw of s.globs) {
    const glob = clean(raw);
    const keepsLayout = glob.endsWith("/**");
    // A folder the glob matches is copied whole, under its name, as CocoaPods adds it; one inside another matched
    // folder is in that copy already. A `/**` glob keeps the layout below its folder instead.
    const matched = keepsLayout ? [] : dirs.filter((d) => micromatch.isMatch(d, glob));
    const folders = matched.filter((d) => !matched.some((o) => d.startsWith(`${o}/`)));
    for (const rel of all) {
      const dests: string[] = [];
      for (const f of folders) if (rel.startsWith(`${f}/`)) dests.push(`${path.posix.basename(f)}/${rel.slice(f.length + 1)}`);
      if (micromatch.isMatch(rel, glob)) {
        if (keepsLayout) {
          const folder = micromatch.scan(glob.slice(0, -3)).base;
          dests.push(folder === "" ? rel : rel.slice(folder.length + 1));
        } else {
          dests.push(flatDest(rel));
        }
      }
      if (dests.length === 0) continue;
      const c = compiledOf(rel);
      if (c !== undefined) {
        compiled.add(c);
        continue;
      }
      for (const dest of dests) files.push({ dest, src: path.join(s.baseDir, rel), rel });
    }
  }
  return { files, compiled: [...compiled].sort() };
}

/** Two files for one place in a bundle. */
export class DuplicateBundleFileError extends PodsError {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateBundleFileError";
  }
}

/** One destination per file: the same file matched twice is taken once, two files for one destination stop. */
function placed(s: BundleSource, found: { dest: string; src: string; rel: string }[]): { dest: string; src: string }[] {
  const byDest = new Map<string, { src: string; rel: string }>();
  for (const f of found) {
    const first = byDest.get(f.dest);
    if (first === undefined) byDest.set(f.dest, f);
    else if (first.src !== f.src) {
      throw new DuplicateBundleFileError(`${s.key}.bundle (${s.owner}) would hold ${f.dest} twice: ${first.rel} and ${f.rel}. See ${PODS_LINK}`);
    }
  }
  return [...byDest]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dest, { src }]) => ({ dest: dest.split("/").join(path.sep), src }));
}

/**
 * The files under `baseDir` the globs match (CocoaPods' glob syntax, through micromatch), with their path in the
 * bundle; compiled resources are left out. Two files for one destination throw.
 */
export function bundleFiles(s: BundleSource): { dest: string; src: string }[] {
  return placed(s, matches(s).files);
}

/** The keys CocoaPods writes into a resource bundle's Info.plist. */
export function resourceBundleInfoPlist(key: string): string {
  return plist.build({
    CFBundleDevelopmentRegion: "en",
    CFBundleIdentifier: `org.cocoapods.${key.replace(/[^A-Za-z0-9.-]/g, "-")}`,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: key,
    CFBundlePackageType: "BNDL",
  });
}

/** Whether `key` can name a folder: no separator, not `.` or `..`. */
function usableKey(key: string): boolean {
  return key !== "" && key !== "." && key !== ".." && !/[/\\\0]/.test(key);
}

/**
 * `<resourcesDir>/<key>.bundle/` with the matched files copied (any earlier copy replaced) and its
 * Info.plist. Logs the ℹ line for compiled resources it leaves out; with no file left, logs the ⚠ line and builds
 * nothing.
 */
export async function writeResourceBundle(s: BundleSource, resourcesDir: string, log: (l: string) => void): Promise<BuiltBundle | undefined> {
  if (!usableKey(s.key)) {
    throw new PodsError(`The resource bundle name "${s.key}" (${s.owner}) is not a file name rn-xtool can use. See ${PODS_LINK}`);
  }
  const { files: found, compiled } = matches(s);
  const files = placed(s, found);
  if (compiled.length > 0) {
    log(`ℹ Left out of ${s.key}.bundle (${s.owner}), as they need Xcode's tools (asset catalogs, storyboards, xibs): ${compiled.join(", ")}`);
  }
  const bundle = path.join(resourcesDir, `${s.key}.bundle`);
  await rm(bundle, { recursive: true, force: true });
  if (files.length === 0) {
    log(`⚠ ${s.key}.bundle (${s.owner}) matches no file (${s.globs.join(", ")}); it is not built`);
    return undefined;
  }
  for (const f of files) {
    const dest = path.join(bundle, f.dest);
    await mkdir(path.dirname(dest), { recursive: true });
    // A symlink's target, so the bundle holds a regular file; with its time, so an unchanged file is not copied again.
    await copyKeepingTime(realpathSync(f.src), dest);
  }
  // A matched Info.plist gives way to the bundle's own.
  const info = path.join(bundle, "Info.plist");
  await rm(info, { force: true });
  await writeFile(info, resourceBundleInfoPlist(s.key));
  return { name: `${s.key}.bundle`, owner: s.owner, files: files.length };
}
