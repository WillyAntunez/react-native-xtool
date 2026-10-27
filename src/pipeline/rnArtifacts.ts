import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as plist from "plist";
import { RN_HEADERS_MODULES } from "./rnHeadersModules.js";

/**
 * Pure pieces of the artifact adapter: React Native 0.86.x artifacts predate the "headers-spec" slot layout
 * (ReactNativeHeaders.xcframework, ReactNativeDependenciesHeaders.xcframework) that the vendored 0.88 SwiftPM scripts
 * expect. These helpers rebuild that layout's parts from the older slot alone.
 */

const ROOT_PATH = "${ROOT_PATH}";
const VFS_ROOT = `${ROOT_PATH}/Headers`;

/** One file of RN's clang VFS overlay: `virtual` relative to the overlay root, `external` with `${ROOT_PATH}` kept. */
export interface VfsEntry {
  virtual: string;
  external: string;
}

/** A YAML scalar as RN writes it: single-quoted (`''` escapes `'`), double-quoted, or plain. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return JSON.parse(v) as string;
  return v;
}

function assertRelative(what: string, rel: string): void {
  const bad = rel.split("/").some((s) => s === "" || s === "." || s === "..");
  if (bad) throw new Error(`React-VFS-template.yaml: ${what} "${rel}" is not a plain relative path`);
}

/**
 * Parses RN's `React-VFS-template.yaml` (a clang VFS overlay with one `${ROOT_PATH}/Headers` root of nested
 * directories) into its file entries, in file order. Throws on a layout it does not recognise.
 */
export function parseVfsTemplate(text: string): VfsEntry[] {
  const stack: { indent: number; name: string }[] = [];
  const entries: VfsEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const named = /^(\s*)- name:(.*)$/.exec(line);
    if (named) {
      const indent = (named[1] as string).length;
      while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
      stack.push({ indent, name: scalar(named[2] as string) });
      continue;
    }
    const ext = /^\s*external-contents:(.*)$/.exec(line);
    if (!ext) continue;
    const [root, ...names] = stack.map((s) => s.name);
    if (root !== VFS_ROOT || names.length === 0) {
      throw new Error(`React-VFS-template.yaml: expected entries under '${VFS_ROOT}', found '${[root, ...names].join("/")}'`);
    }
    const virtual = names.join("/");
    assertRelative("virtual path", virtual);
    const external = scalar(ext[1] as string);
    if (!external.startsWith(`${ROOT_PATH}/`)) {
      throw new Error(`React-VFS-template.yaml: ${virtual} maps outside ${ROOT_PATH}: ${external}`);
    }
    assertRelative("external path", external.slice(ROOT_PATH.length + 1));
    entries.push({ virtual, external });
  }
  return entries;
}

export type LinkFn = (from: string, to: string) => Promise<void>;

const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() === true;
const isDirectory = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

/** Files under `dir/rel`, as paths relative to `dir` with `/` separators, sorted per directory. */
function listFiles(dir: string, rel: string): string[] {
  return readdirSync(path.join(dir, rel))
    .sort()
    .flatMap((name) => {
      const child = `${rel}/${name}`;
      const abs = path.join(dir, child);
      if (isDirectory(abs)) return listFiles(dir, child);
      return isFile(abs) ? [child] : [];
    });
}

/**
 * Writes the overlay's virtual header tree as real files under `outDir`, each created by `link(from, to)` (parent
 * directories already exist). `frameworkDir` is the `React.xcframework` directory, i.e. the template's `${ROOT_PATH}`.
 *
 * clang's overlay falls through to the physical directory, so files under a physical top-level `Headers/<dir>` whose
 * name (exact case) is also a virtual top-level directory are reachable too: those not already placed are linked at
 * `outDir/<dir>/…`. Returns the virtual paths whose external file does not exist.
 */
export async function materialiseVirtualTree(
  frameworkDir: string,
  entries: VfsEntry[],
  outDir: string,
  link: LinkFn,
): Promise<{ missing: string[] }> {
  const placed = new Set<string>();
  const place = async (from: string, virtual: string) => {
    const to = path.join(outDir, virtual);
    await mkdir(path.dirname(to), { recursive: true });
    await link(from, to);
    placed.add(virtual);
  };

  const missing: string[] = [];
  for (const { virtual, external } of entries) {
    const from = path.join(frameworkDir, external.slice(ROOT_PATH.length + 1));
    if (!isFile(from)) missing.push(virtual);
    else if (!placed.has(virtual)) await place(from, virtual);
  }

  const physical = path.join(frameworkDir, "Headers");
  const virtualTops = new Set(entries.map((e) => e.virtual.split("/")[0] as string));
  if (isDirectory(physical)) {
    for (const dir of readdirSync(physical).sort()) {
      if (!virtualTops.has(dir) || !isDirectory(path.join(physical, dir))) continue;
      for (const rel of listFiles(physical, dir)) {
        if (!placed.has(rel)) await place(path.join(physical, rel), rel);
      }
    }
  }
  return { missing };
}

/**
 * The `ReactNativeHeaders` module map for `headersDir`, in RN 0.88's exact text form: the committed 0.88.0 module
 * table, each module keeping only the headers present under `headersDir`; modules left empty are omitted.
 */
export function renderHeadersModuleMap(headersDir: string): string {
  return RN_HEADERS_MODULES.map((m) => ({ name: m.name, headers: m.headers.filter((h) => isFile(path.join(headersDir, h))) }))
    .filter((m) => m.headers.length > 0)
    .map((m) => `module ${m.name} {\n${m.headers.map((h) => `  header "${h}"\n`).join("")}  export *\n}\n`)
    .join("\n");
}

/** A valid `ar` archive with no members: the placeholder library of a headers-only xcframework slice. */
export const EMPTY_AR_ARCHIVE: Buffer = Buffer.from("!<arch>\n");

export interface XcframeworkLibrary {
  LibraryIdentifier: string;
  SupportedPlatform: string;
  SupportedPlatformVariant?: string;
  SupportedArchitectures: string[];
}

/** The slices (`AvailableLibraries`) of an xcframework's `Info.plist`, platform fields only. */
export function readXcframeworkLibraries(xcframeworkDir: string): XcframeworkLibrary[] {
  const file = path.join(xcframeworkDir, "Info.plist");
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  const info = plist.parse(readFileSync(file, "utf8")) as Record<string, plist.PlistValue>;
  const libs = info?.AvailableLibraries;
  if (!Array.isArray(libs)) throw new Error(`${file}: no AvailableLibraries`);
  return libs.map((raw) => {
    const lib = raw as Record<string, plist.PlistValue>;
    const { LibraryIdentifier, SupportedPlatform, SupportedPlatformVariant, SupportedArchitectures } = lib;
    if (
      typeof LibraryIdentifier !== "string" ||
      typeof SupportedPlatform !== "string" ||
      !Array.isArray(SupportedArchitectures) ||
      !SupportedArchitectures.every((a) => typeof a === "string") ||
      (SupportedPlatformVariant !== undefined && typeof SupportedPlatformVariant !== "string")
    ) {
      throw new Error(`${file}: malformed AvailableLibraries entry ${JSON.stringify(lib)}`);
    }
    return {
      LibraryIdentifier,
      SupportedPlatform,
      ...(SupportedPlatformVariant !== undefined ? { SupportedPlatformVariant } : {}),
      SupportedArchitectures: SupportedArchitectures as string[],
    };
  });
}

/** `Info.plist` of a headers-only xcframework `name`: per slice `lib<name>-<slice>.a` plus `Headers/`. */
export function headersXcframeworkInfoPlist(name: string, libs: XcframeworkLibrary[]): string {
  return plist.build({
    AvailableLibraries: libs.map((lib) => {
      const archive = `lib${name}-${lib.LibraryIdentifier}.a`;
      return {
        BinaryPath: archive,
        HeadersPath: "Headers",
        LibraryIdentifier: lib.LibraryIdentifier,
        LibraryPath: archive,
        SupportedArchitectures: [...lib.SupportedArchitectures],
        SupportedPlatform: lib.SupportedPlatform,
        ...(lib.SupportedPlatformVariant !== undefined ? { SupportedPlatformVariant: lib.SupportedPlatformVariant } : {}),
      };
    }),
    CFBundlePackageType: "XFWK",
    XCFrameworkFormatVersion: "1.0",
  });
}
