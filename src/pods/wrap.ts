/**
 * Wraps a binary pod for SwiftPM (spec goal 2): each vendored framework becomes a headers-only library xcframework and
 * a thin arm64 `ar` archive, linked once elsewhere with `-force_load`. A headers-only pod (GoogleMLKit) becomes one
 * headers-only xcframework named by its module. The input is a folder (the cache's extracted tree), so a later block
 * can feed a library's own vendored binaries. Shapes this block does not cover stop with a text naming the pod, the
 * library and the file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { readXcframeworkSlices, swapIn } from "../pipeline/rnArtifacts.js";
import { IOS_MIN } from "../versions.js";
import { wrapObject, type ArRunner } from "./ar.js";
import { PODS_LINK, PodsError } from "./format.js";
import { treeName } from "./archive.js";
import { durable, treeIntact, treeMeasure } from "./durable.js";
import { arm64Slice, highestMinIos, platformProblem, readBinary } from "./macho.js";
import type { PodSpec, SpecLayer } from "./spec.js";
import { frameworkModuleMap, generatedModuleMap, rewriteFrameworkModuleMap, writeHeadersXcframework } from "./xcframework.js";

const micromatch = createRequire(import.meta.url)("micromatch") as {
  matcher: (patterns: string[], options?: { dot?: boolean }) => (path: string) => boolean;
};

/** Bumped when the wrapped layout changes, so stamped trees are rebuilt. */
export const WRAPPER_VERSION = 1;
export const WRAPPED_STAMP = ".rn-xtool-wrapped.json";

export interface WrappedFramework {
  name: string;
  xcframework: string;
  /** The thin arm64 archive; none for a headers-only pod. */
  archive?: string;
  /** The privacy manifests inside the framework, relative to the extracted tree; they do not reach the app. */
  privacy: string[];
}

export interface WrappedPod {
  pod: string;
  version: string;
  sha256: string;
  dir: string;
  frameworks: WrappedFramework[];
  /** Row 35's ⚠ line, when the pod needs a newer iOS than the app's minimum. */
  warnings: string[];
}

export interface WrapInput {
  pod: string;
  version: string;
  sha256: string;
  /** The library that needs the pod, for the texts. */
  neededBy: string;
  /** The pod's root folder. */
  extracted: string;
  spec: PodSpec;
  layers: SpecLayer[];
  headersOnly: boolean;
}

interface WrappedStamp {
  wrapperVersion: number;
  sha256: string;
  inputs: string;
  frameworks: { name: string; archive: boolean; privacy: string[] }[];
  /** The highest iOS minimum the binaries name. */
  minIos?: string;
  /** What the finished tree held (row 76): checked before reuse. */
  files?: number;
  bytes?: number;
}

const AR_MAGIC = "!<arch>\n";
const EXCLUDE = `Leave the library out with "exclude" in rn-xtool.config.json. See ${PODS_LINK}`;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const higher = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined ? b : b === undefined ? a : compareVersions(a, b) >= 0 ? a : b;

/** Every entry below `dir`, relative and with `/`, folders included; links are listed, not followed. */
function listTree(dir: string): { rel: string; isDir: boolean }[] {
  const out: { rel: string; isDir: boolean }[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      out.push({ rel: r, isDir: e.isDirectory() });
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
    }
  };
  walk(dir, "");
  return out;
}

/** Whether `p` is a file, or a link to one. */
const isFile = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() === true;

/** The files below `dir` (links to files included), relative. */
const filesBelow = (dir: string): string[] => listTree(dir).filter((e) => !e.isDir && isFile(path.join(dir, e.rel))).map((e) => e.rel);

/** The spec's paths and globs, matched against the extracted tree; a path without a glob stands for itself. */
function expand(patterns: readonly string[], tree: () => { rel: string; isDir: boolean }[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    const clean = p.replace(/\/+$/, "");
    if (!/[*?[\]{}]/.test(clean)) {
      out.add(clean);
      continue;
    }
    const isMatch = micromatch.matcher([clean], { dot: true });
    for (const e of tree()) if (isMatch(e.rel)) out.add(e.rel);
  }
  return [...out].sort();
}

let sequence = 0;

class Wrapper {
  readonly label: string;
  private treeCache?: { rel: string; isDir: boolean }[];

  constructor(
    private readonly i: WrapInput,
    private readonly tmp: string,
    private readonly ar: ArRunner,
  ) {
    this.label = `${i.pod} ${i.version} (needed by ${i.neededBy})`;
  }

  tree = (): { rel: string; isDir: boolean }[] => (this.treeCache ??= listTree(this.i.extracted));

  unknown(rel: string, magic: string): PodsError {
    return new PodsError(`${this.label} ships a binary rn-xtool does not recognise (${rel}, which starts with ${magic}). See ${PODS_LINK}`);
  }

  noArm64(rel: string, arches: string[]): PodsError {
    return new PodsError(
      `${this.label} ships no arm64 device slice (it has ${arches.length > 0 ? arches.join(", ") : "no architecture"}): ${rel}. rn-xtool builds for iPhones only. ${EXCLUDE}`,
    );
  }

  otherShape(what: "dynamic framework" | "Swift framework", rel: string): PodsError {
    return new PodsError(`${this.label} ships a ${what} (${rel}); rn-xtool links static CocoaPods binaries only. ${EXCLUDE}`);
  }

  /** The thin arm64 slice of `binary`: checked for its shape and platform. */
  slice(buf: Buffer, binRel: string, shapeRel: string): { slice: Buffer; object: boolean; minos?: string } {
    const shape = readBinary(buf);
    if (shape.shape === "unknown") throw this.unknown(binRel, shape.magic);
    const cut = arm64Slice(buf);
    if (!Buffer.isBuffer(cut)) throw this.noArm64(binRel, cut.arches);
    const inner = readBinary(cut);
    if (inner.shape === "macho" && inner.info.kind === "dylib") throw this.otherShape("dynamic framework", shapeRel);
    if (inner.shape !== "ar" && !(inner.shape === "macho" && inner.info.kind === "object")) {
      throw this.unknown(binRel, inner.shape === "unknown" ? inner.magic : `0x${cut.subarray(0, 4).toString("hex")}`);
    }
    const problem = platformProblem(cut);
    if (problem !== undefined) {
      throw new PodsError(
        `${this.label} ships an arm64 slice built for the ${problem.platform}, not for iPhones (${binRel}${problem.member !== undefined ? `, member ${problem.member}` : ""}). ${EXCLUDE}`,
      );
    }
    const minos = highestMinIos(cut);
    return { slice: cut, object: inner.shape === "macho", ...(minos !== undefined ? { minos } : {}) };
  }

  /** `archives/lib<name>.a` in the temporary tree: the ar slice as it is, or the object wrapped by llvm-ar. */
  async archive(name: string, s: { slice: Buffer; object: boolean }, binRel: string): Promise<void> {
    const archive = path.join(this.tmp, "archives", `lib${name}.a`);
    await mkdir(path.dirname(archive), { recursive: true });
    if (s.object) {
      const object = path.join(this.tmp, "objects", `${name}.o`);
      await mkdir(path.dirname(object), { recursive: true });
      await writeFile(object, s.slice);
      await wrapObject(object, archive, this.ar, { pod: this.i.pod, version: this.i.version, rel: binRel });
      await rm(path.join(this.tmp, "objects"), { recursive: true, force: true });
    } else {
      await writeFile(archive, s.slice);
    }
    // Row 32: every staged archive is a thin `ar` archive, whatever the input was.
    const head = (await readFile(archive)).subarray(0, AR_MAGIC.length).toString("latin1");
    if (head !== AR_MAGIC) throw new Error(`internal error: ${archive} for ${this.i.pod} ${this.i.version} does not start with !<arch>`);
  }

  /** `PrivacyInfo.xcprivacy` files below `dir`, as `<rel>/…`. */
  privacy(dir: string, rel: string): string[] {
    return listTree(dir)
      .filter((e) => !e.isDir && path.posix.basename(e.rel) === "PrivacyInfo.xcprivacy")
      .map((e) => `${rel}/${e.rel}`);
  }

  async framework(dir: string, rel: string): Promise<{ name: string; privacy: string[]; minos?: string }> {
    const name = path.basename(rel, ".framework");
    const modules = path.join(dir, "Modules");
    if (listTree(modules).some((e) => e.rel.endsWith(".swiftmodule"))) throw this.otherShape("Swift framework", rel);
    const binary = path.join(dir, name);
    if (!isFile(binary)) throw new PodsError(`${this.label} ships ${rel} without its binary ${name}. See ${PODS_LINK}`);
    const s = this.slice(await readFile(binary), `${rel}/${name}`, rel);
    const map = await frameworkModuleMap(dir, name, rel, this.label);
    await this.archive(name, s, `${rel}/${name}`);
    const headers = path.join(dir, "Headers");
    await writeHeadersXcframework(path.join(this.tmp, "xcframeworks"), name, { from: headers, files: filesBelow(headers) }, map);
    return { name, privacy: this.privacy(dir, rel), ...(s.minos !== undefined ? { minos: s.minos } : {}) };
  }

  async xcframework(dir: string, rel: string): Promise<{ name: string; privacy: string[]; minos?: string }> {
    let slices;
    try {
      slices = readXcframeworkSlices(dir);
    } catch (err) {
      throw new PodsError(`${this.label} ships ${rel}, whose Info.plist rn-xtool cannot read (${(err as Error).message}). See ${PODS_LINK}`);
    }
    const device = slices.find(
      (s) => s.SupportedPlatform === "ios" && s.SupportedPlatformVariant === undefined && s.SupportedArchitectures.includes("arm64"),
    );
    if (device === undefined) throw this.noArm64(rel, slices.map((s) => s.LibraryIdentifier));
    const sliceRel = `${rel}/${device.LibraryIdentifier}`;
    const sliceDir = path.join(dir, device.LibraryIdentifier);
    const lp = device.LibraryPath;
    if (lp === undefined) throw new PodsError(`${this.label} ships ${rel}, whose ${device.LibraryIdentifier} slice names no LibraryPath. See ${PODS_LINK}`);
    if (lp.endsWith(".framework")) return this.framework(path.join(sliceDir, lp), `${sliceRel}/${lp}`);

    // A library slice: `lib<name>.a` and its headers folder.
    const name = path.basename(rel, ".xcframework");
    if (listTree(sliceDir).some((e) => e.rel.endsWith(".swiftmodule"))) throw this.otherShape("Swift framework", rel);
    const binary = path.join(sliceDir, lp);
    if (!isFile(binary)) throw new PodsError(`${this.label} ships ${rel} without its binary ${lp}. See ${PODS_LINK}`);
    const s = this.slice(await readFile(binary), `${sliceRel}/${lp}`, rel);
    const headersRel = device.HeadersPath ?? "Headers";
    const headers = path.join(sliceDir, headersRel);
    let map: string;
    if (isFile(path.join(headers, "module.modulemap"))) {
      map = rewriteFrameworkModuleMap(
        await readFile(path.join(headers, "module.modulemap"), "utf8"),
        `${sliceRel}/${headersRel}/module.modulemap`,
        this.label,
      );
    } else if (isFile(path.join(headers, `${name}.h`))) {
      map = generatedModuleMap(name);
    } else {
      throw new PodsError(
        `${this.label}: ${sliceRel} has no ${headersRel}/module.modulemap and no ${headersRel}/${name}.h, so rn-xtool cannot make a module for it. See ${PODS_LINK}`,
      );
    }
    await this.archive(name, s, `${sliceRel}/${lp}`);
    const files = filesBelow(headers).filter((f) => f !== "module.modulemap");
    await writeHeadersXcframework(path.join(this.tmp, "xcframeworks"), name, { from: headers, files }, map);
    return { name, privacy: this.privacy(sliceDir, sliceRel), ...(s.minos !== undefined ? { minos: s.minos } : {}) };
  }

  /** A headers-only pod: one xcframework named by its module, with its header source_files flat. */
  async headersOnly(): Promise<{ name: string; privacy: string[] }> {
    const { spec, layers, extracted } = this.i;
    const name = spec.moduleName ?? this.i.pod;
    const headers = expand(layers.flatMap((l) => l.sourceFiles), this.tree).filter((h) => isFile(path.join(extracted, h)));
    const dirs = new Set(headers.map((h) => path.posix.dirname(h)));
    const explicit = layers.map((l) => l.moduleMap).find((m) => m !== undefined);
    const kept = expand(layers.flatMap((l) => l.preservePaths), this.tree).find(
      (p) => path.posix.basename(p) === "module.modulemap" && dirs.has(path.posix.dirname(p)),
    );
    const mapRel = explicit ?? kept;
    const flat = [...new Set(headers.map((h) => path.posix.basename(h)))].sort();
    let map: string;
    if (mapRel !== undefined && isFile(path.join(extracted, mapRel))) {
      map = rewriteFrameworkModuleMap(await readFile(path.join(extracted, mapRel), "utf8"), mapRel, this.label);
    } else {
      map = `module ${name} {\n${flat.map((h) => `  header "${h}"\n`).join("")}  export *\n}\n`;
    }
    const xcframeworks = path.join(this.tmp, "xcframeworks");
    const xcf = path.join(xcframeworks, `${name}.xcframework`);
    await writeHeadersXcframework(xcframeworks, name, { from: extracted, files: [] }, map);
    const into = path.join(xcf, "ios-arm64", "Headers", name);
    for (const h of headers) await writeFile(path.join(into, path.posix.basename(h)), await readFile(path.join(extracted, h)));
    return { name, privacy: [] };
  }
}

function readStamp(file: string): WrappedStamp | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WrappedStamp;
  } catch {
    return undefined;
  }
}

const sameInputs = (a: WrappedStamp | undefined, b: { wrapperVersion: number; sha256: string; inputs: string }): a is WrappedStamp =>
  a !== undefined && a.wrapperVersion === b.wrapperVersion && a.sha256 === b.sha256 && a.inputs === b.inputs;

/** The stamp of a tree at `dest` wrapped from these inputs that still holds what the stamp records. */
function currentStamp(dest: string, key: { wrapperVersion: number; sha256: string; inputs: string }): WrappedStamp | undefined {
  const found = readStamp(path.join(dest, WRAPPED_STAMP));
  return sameInputs(found, key) && treeIntact(dest, WRAPPED_STAMP, found) ? found : undefined;
}

function result(i: WrapInput, dest: string, stamp: WrappedStamp): WrappedPod {
  const need = higher(i.spec.iosMin, stamp.minIos);
  return {
    pod: i.pod,
    version: i.version,
    sha256: i.sha256,
    dir: dest,
    frameworks: stamp.frameworks.map((f) => ({
      name: f.name,
      xcframework: path.join(dest, "xcframeworks", `${f.name}.xcframework`),
      ...(f.archive ? { archive: path.join(dest, "archives", `lib${f.name}.a`) } : {}),
      privacy: f.privacy,
    })),
    warnings:
      need !== undefined && compareVersions(need, IOS_MIN) > 0
        ? [`⚠ ${i.pod} needs iOS ${need}; the app's minimum is ${IOS_MIN}; it fails to load on older iPhones`]
        : [],
  };
}

/**
 * `<cache>/wrapped/<sha256>-<stamp hash>/`, named by the archive and the wrap's inputs:
 * `xcframeworks/<Name>.xcframework`, `archives/lib<Name>.a` and the stamp `.rn-xtool-wrapped.json`. The tree is
 * assembled in `<dest>.tmp-<pid>-<n>`, stamped, and swapped in whole; a tree with the same stamp is reused, and one
 * another build stamped meanwhile wins.
 */
export async function wrapPod(i: WrapInput, cache: string, ar: ArRunner, swap: typeof swapIn = swapIn): Promise<WrappedPod> {
  const key = {
    wrapperVersion: WRAPPER_VERSION,
    sha256: i.sha256,
    inputs: JSON.stringify({
      headersOnly: i.headersOnly,
      moduleName: i.spec.moduleName ?? null,
      vendoredFrameworks: [...new Set(i.layers.flatMap((l) => l.vendoredFrameworks))].sort(),
      sourceFiles: i.headersOnly ? [...new Set(i.layers.flatMap((l) => l.sourceFiles))].sort() : [],
      preservePaths: i.headersOnly ? [...new Set(i.layers.flatMap((l) => l.preservePaths))].sort() : [],
      moduleMap: i.layers.map((l) => l.moduleMap).find((m) => m !== undefined) ?? null,
    }),
  };
  const dest = path.join(cache, "wrapped", treeName(i.sha256, key));
  const current = currentStamp(dest, key);
  if (current !== undefined) return result(i, dest, current);

  const n = sequence++;
  const tmp = `${dest}.tmp-${process.pid}-${n}`;
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const w = new Wrapper(i, tmp, ar);
    const made: { name: string; privacy: string[]; minos?: string }[] = [];
    if (i.headersOnly) {
      made.push(await w.headersOnly());
    } else {
      for (const rel of expand(i.layers.flatMap((l) => l.vendoredFrameworks), w.tree)) {
        const dir = path.join(i.extracted, rel);
        if (rel.endsWith(".xcframework")) made.push(await w.xcframework(dir, rel));
        else if (rel.endsWith(".framework")) made.push(await w.framework(dir, rel));
        else throw new PodsError(`${w.label} vendors ${rel}, which is neither a .framework nor an .xcframework. See ${PODS_LINK}`);
      }
    }
    made.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const stamp: WrappedStamp = {
      ...key,
      frameworks: made.map((m) => ({ name: m.name, archive: !i.headersOnly, privacy: m.privacy })),
      ...(() => {
        const minIos = made.reduce<string | undefined>((acc, m) => higher(acc, m.minos), undefined);
        return minIos !== undefined ? { minIos } : {};
      })(),
    };
    Object.assign(stamp, treeMeasure(tmp, WRAPPED_STAMP));
    await writeFile(path.join(tmp, WRAPPED_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
    await durable.syncFile(path.join(tmp, WRAPPED_STAMP));
    await durable.syncDir(tmp);
    const won = currentStamp(dest, key);
    if (won !== undefined) return result(i, dest, won);
    try {
      await swap(tmp, dest, `${dest}.old-${process.pid}-${n}`);
    } catch (err) {
      // Another build swapped its tree in between the check and the swap: the stamped tree wins.
      const other = currentStamp(dest, key);
      if (other !== undefined) return result(i, dest, other);
      throw err;
    }
    await durable.syncDir(path.dirname(dest));
    return result(i, dest, stamp);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
