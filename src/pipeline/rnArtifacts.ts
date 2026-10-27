import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

/** Bumped whenever the adapted layout changes, so older adapted slots are rebuilt. */
export const ADAPTER_VERSION = 1;
/** Written last into an adapted slot: `{ adapterVersion, source, dest, artifactsJsonSha256 }`. */
export const ADAPTED_STAMP = ".rn-xtool-adapted.json";

/** A React Native artifact slot whose layout the adapter does not know; never worked around. */
export class ArtifactLayoutError extends Error {
  /** `problem` completes the sentence about `what`, e.g. "is missing" or "is not a file". */
  constructor(version: string, slot: string, what: string, problem = "is missing") {
    super(
      `React Native ${version} artifacts in ${slot} have a layout rn-xtool does not recognise: ${what} ${problem}. ` +
        "Report it at https://github.com/WillyAntunez/react-native-xtool/issues with this message.",
    );
    this.name = "ArtifactLayoutError";
  }
}

/** A headers-spec slot (RN 0.87.1+) ships ReactNativeHeaders.xcframework and needs no adapting. */
export function isHeadersSpecSlot(slot: string): boolean {
  return existsSync(path.join(slot, "ReactNativeHeaders.xcframework"));
}

interface AdaptedStamp {
  adapterVersion: number;
  source: string;
  /** Where the slot was adapted to: its `artifacts.json` holds absolute paths under it, so a moved slot is stale. */
  dest: string;
  artifactsJsonSha256: string;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** True when `dest` holds a complete adaptation of `src`, made at `dest` by this adapter version and src's `artifacts.json`. */
export async function adaptedSlotIsCurrent(src: string, dest: string): Promise<boolean> {
  try {
    const stamp = JSON.parse(await readFile(path.join(dest, ADAPTED_STAMP), "utf8")) as Partial<AdaptedStamp>;
    const artifactsJson = await readFile(path.join(src, "artifacts.json"));
    return (
      stamp.adapterVersion === ADAPTER_VERSION &&
      stamp.source === path.resolve(src) &&
      stamp.dest === path.resolve(dest) &&
      stamp.artifactsJsonSha256 === sha256(artifactsJson)
    );
  } catch {
    return false;
  }
}

const REACT_FRAMEWORK_MODULE_MAP = 'framework module React {\n  umbrella header "React-umbrella.h"\n  export *\n  module * { export * }\n}\n';
const VFS_TEMPLATE = "React.xcframework/React-VFS-template.yaml";
const UMBRELLA = "Headers/React_Core/React_Core-umbrella.h";
/** Links that may fail on a valid filesystem layout (other device, no hard links, link limit): copy instead. */
const COPY_ON = new Set(["EXDEV", "EPERM", "EMLINK"]);

interface SourceEntry {
  url: string;
}

/** Everything adaptSlot reads from the source slot, checked before anything is written. */
interface SourceLayout {
  vfs: VfsEntry[];
  reactLibs: XcframeworkLibrary[];
  depsLibs: XcframeworkLibrary[];
  artifacts: Record<"React" | "ReactNativeDependencies" | "hermes-engine", SourceEntry>;
  artifactsJsonSha256: string;
}

function inspectSource(src: string, version: string): SourceLayout {
  const fail = (what: string, problem?: string): never => {
    throw new ArtifactLayoutError(version, src, what, problem);
  };
  /** A regular file (symlinks followed); a directory in its place is named as such. */
  const needFile = (rel: string) => {
    const abs = path.join(src, rel);
    if (!isFile(abs)) fail(rel, existsSync(abs) ? "is not a file" : undefined);
  };
  const needDir = (rel: string) => {
    if (!isDirectory(path.join(src, rel))) fail(rel);
  };
  const libsOf = (xc: string) => {
    try {
      return readXcframeworkLibraries(path.join(src, xc));
    } catch {
      return fail(`a valid AvailableLibraries list in ${xc}/Info.plist`);
    }
  };

  needFile("React.xcframework/Info.plist");
  needFile(VFS_TEMPLATE);
  const reactLibs = libsOf("React.xcframework");
  for (const lib of reactLibs) needFile(`React.xcframework/${lib.LibraryIdentifier}/React.framework/${UMBRELLA}`);
  needFile("ReactNativeDependencies.xcframework/Info.plist");
  needDir("ReactNativeDependencies.xcframework/Headers");
  const depsLibs = libsOf("ReactNativeDependencies.xcframework");
  needDir("hermes-engine.xcframework");
  needDir("hermes-headers/hermes");
  needFile("artifacts.json");

  const artifactsJson = readFileSync(path.join(src, "artifacts.json"));
  let parsed: Record<string, { url?: unknown } | undefined>;
  try {
    parsed = JSON.parse(artifactsJson.toString("utf8")) as typeof parsed;
  } catch {
    return fail("a readable artifacts.json");
  }
  const entry = (name: string): SourceEntry => {
    const url = parsed?.[name]?.url;
    return typeof url === "string" ? { url } : fail(`artifacts.json's "${name}" entry`);
  };
  const artifacts = { React: entry("React"), ReactNativeDependencies: entry("ReactNativeDependencies"), "hermes-engine": entry("hermes-engine") };

  let vfs: VfsEntry[];
  try {
    vfs = parseVfsTemplate(readFileSync(path.join(src, VFS_TEMPLATE), "utf8"));
  } catch (err) {
    return fail(VFS_TEMPLATE, `is in a form rn-xtool cannot read (${(err as Error).message})`);
  }
  if (vfs.length === 0) fail(`the header list in ${VFS_TEMPLATE}`);
  if (!vfs.some((e) => e.virtual.startsWith("React/"))) fail(`the React/ directory in ${VFS_TEMPLATE}`);
  // `${ROOT_PATH}` is the React.xcframework directory (see materialiseVirtualTree).
  for (const { external } of vfs) needFile(`React.xcframework/${external.slice(ROOT_PATH.length + 1)}`);

  return { vfs, reactLibs, depsLibs, artifacts, artifactsJsonSha256: sha256(artifactsJson) };
}

/**
 * Rebuilds a pre-headers-spec slot `src` (RN 0.86.x) in the headers-spec layout the vendored SwiftPM scripts expect,
 * as `dest`: mostly hard links into `src`, generated module maps, placeholder archives and Info.plists, an
 * `artifacts.json` RN's `validateArtifactsCache` accepts, and the stamp {@link adaptedSlotIsCurrent} reads.
 *
 * The tree is assembled in `${dest}.tmp-<pid>` and renamed over `dest` only when complete, so a failed run leaves the
 * previous `dest` (if any) as it was and nothing new stamped. An unknown source layout throws
 * {@link ArtifactLayoutError} before anything is written. Nothing outside the source slot is read.
 */
export async function adaptSlot(src: string, dest: string, version: string, opts: { hardLink?: LinkFn } = {}): Promise<void> {
  const source = path.resolve(src);
  const target = path.resolve(dest);
  const layout = inspectSource(source, version);
  const hardLink = opts.hardLink ?? ((from: string, to: string) => link(from, to));

  const linkFile: LinkFn = async (from, to) => {
    try {
      await hardLink(from, to);
    } catch (err) {
      if (!COPY_ON.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await copyFile(from, to);
    }
  };
  /** Links the regular files under directory `from` into `to`. Symlinks are skipped, never followed out of the slot. */
  const linkTree = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const name of (await readdir(from)).sort()) {
      const child = path.join(from, name);
      const st = await lstat(child);
      if (st.isDirectory()) await linkTree(child, path.join(to, name));
      else if (st.isFile()) await linkFile(child, path.join(to, name));
    }
  };

  const tmp = `${target}.tmp-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    await assemble(source, tmp, target, layout, linkFile, linkTree);
    await swapIn(tmp, target, old);
  } catch (err) {
    // Cleanup is best-effort: the original error is the one worth reporting.
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function assemble(
  src: string,
  out: string,
  finalDest: string,
  layout: SourceLayout,
  linkFile: LinkFn,
  linkTree: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const reactSrc = path.join(src, "React.xcframework");
  const reactOut = path.join(out, "React.xcframework");
  const headersOut = path.join(out, "ReactNativeHeaders.xcframework");
  /** Generated files only: `wx` fails on an existing path, which may be a hard link into the source slot. */
  const writeNew = (file: string, data: string | Buffer) => writeFile(file, data, { flag: "wx" });
  const writeOut = async (file: string, data: string | Buffer) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeNew(file, data);
  };

  // React.xcframework (flat React/ headers) and ReactNativeHeaders.xcframework (the rest of the tree, plus hermes).
  await mkdir(reactOut, { recursive: true });
  await linkFile(path.join(reactSrc, "Info.plist"), path.join(reactOut, "Info.plist"));
  for (const { LibraryIdentifier: slice } of layout.reactLibs) {
    const fwSrc = path.join(reactSrc, slice, "React.framework");
    const fwOut = path.join(reactOut, slice, "React.framework");
    await mkdir(fwOut, { recursive: true });
    for (const name of (await readdir(fwSrc)).sort()) {
      if (name === "Headers" || name === "Modules" || name === "_CodeSignature") continue;
      const st = await lstat(path.join(fwSrc, name));
      if (st.isDirectory()) await linkTree(path.join(fwSrc, name), path.join(fwOut, name));
      else if (st.isFile()) await linkFile(path.join(fwSrc, name), path.join(fwOut, name));
    }

    const headers = path.join(headersOut, slice, "Headers");
    await mkdir(headers, { recursive: true });
    await materialiseVirtualTree(reactSrc, layout.vfs, headers, linkFile);
    await rename(path.join(headers, "React"), path.join(fwOut, "Headers"));
    await linkFile(path.join(fwSrc, UMBRELLA), path.join(fwOut, "Headers", "React-umbrella.h"));
    await writeOut(path.join(fwOut, "Modules", "module.modulemap"), REACT_FRAMEWORK_MODULE_MAP);

    await linkTree(path.join(src, "hermes-headers", "hermes"), path.join(headers, "hermes"));
    await writeNew(path.join(headers, "module.modulemap"), renderHeadersModuleMap(headers));
    await writeNew(path.join(headersOut, slice, `libReactNativeHeaders-${slice}.a`), EMPTY_AR_ARCHIVE);
  }
  await writeNew(path.join(headersOut, "Info.plist"), headersXcframeworkInfoPlist("ReactNativeHeaders", layout.reactLibs));

  // ReactNativeDependenciesHeaders.xcframework: the dependency headers, wrapped (no module map, as in 0.88).
  const depsHeadersOut = path.join(out, "ReactNativeDependenciesHeaders.xcframework");
  for (const { LibraryIdentifier: slice } of layout.depsLibs) {
    await linkTree(path.join(src, "ReactNativeDependencies.xcframework", "Headers"), path.join(depsHeadersOut, slice, "Headers"));
    await writeNew(path.join(depsHeadersOut, slice, `libReactNativeDependenciesHeaders-${slice}.a`), EMPTY_AR_ARCHIVE);
  }
  await writeOut(
    path.join(depsHeadersOut, "Info.plist"),
    headersXcframeworkInfoPlist("ReactNativeDependenciesHeaders", layout.depsLibs),
  );

  // Unchanged binaries: symlinks into the source slot; Hermes public headers linked.
  for (const name of ["ReactNativeDependencies.xcframework", "hermes-engine.xcframework"]) {
    await symlink(path.join(src, name), path.join(out, name));
  }
  await linkTree(path.join(src, "hermes-headers"), path.join(out, "hermes-headers"));

  const { artifacts } = layout;
  const entry = (name: string, parent: SourceEntry) => [
    name,
    { xcframeworkPath: path.join(finalDest, `${name}.xcframework`), url: parent.url },
  ];
  const artifactsJson = Object.fromEntries([
    entry("React", artifacts.React),
    entry("ReactNativeHeaders", artifacts.React),
    entry("ReactNativeDependencies", artifacts.ReactNativeDependencies),
    entry("ReactNativeDependenciesHeaders", artifacts.ReactNativeDependencies),
    entry("hermes-engine", artifacts["hermes-engine"]),
  ]);
  await writeNew(path.join(out, "artifacts.json"), JSON.stringify(artifactsJson, null, 2) + "\n");

  const stamp: AdaptedStamp = {
    adapterVersion: ADAPTER_VERSION,
    source: src,
    dest: finalDest,
    artifactsJsonSha256: layout.artifactsJsonSha256,
  };
  await writeNew(path.join(out, ADAPTED_STAMP), JSON.stringify(stamp, null, 2) + "\n");
}

/** Renames the finished `tmp` over `dest`; a previous `dest` is moved aside first and removed afterwards. */
async function swapIn(tmp: string, dest: string, old: string): Promise<void> {
  const hadDest = existsSync(dest);
  if (hadDest) {
    await rm(old, { recursive: true, force: true });
    await rename(dest, old);
  }
  try {
    await rename(tmp, dest);
  } catch (err) {
    // Put the previous tree back if possible, but report the rename that failed.
    if (hadDest) await rename(old, dest).catch(() => undefined);
    throw err;
  }
  // `dest` is complete and stamped now: a leftover old tree is not a failed adaptation (the next run clears it).
  if (hadDest) await rm(old, { recursive: true, force: true }).catch(() => undefined);
}
