import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { devEnv } from "../tools/xtool.js";
import { PrecheckError } from "./precheckReport.js";
import { readXcframeworkSlices } from "./rnArtifacts.js";

/** `swift` (from `toolEnv()`'s PATH) with `args`; a non-zero exit resolves. */
export type SwiftRunner = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What the precheck reads of `swift package dump-package`, with the package's folder. */
export interface DumpedPackage {
  name: string;
  path: string;
  /**
   * The packages the manifest depends on: SwiftPM's identity, the name the manifest gives it
   * (`nameForTargetDependencyResolutionOnly`, what a `package:` reference names) and its folder when it has one.
   */
  dependencies: { identity: string; name?: string; path?: string }[];
  products: { name: string; targets: string[] }[];
  targets: {
    name: string;
    type: string;
    path?: string | null;
    publicHeadersPath?: string | null;
    /** The manifest's `sources` (relative to the target's folder); absent: the whole folder. */
    sources?: string[];
    /** The manifest's `exclude`, relative to the target's folder. */
    exclude?: string[];
    dependencies: unknown[];
  }[];
}

type Graph = { root: DumpedPackage; packages: DumpedPackage[] };
type Target = DumpedPackage["targets"][number];

export interface PrecheckGraph {
  /** The public header folders of the targets App reaches, in dependency order. */
  headerDirs: string[];
  /** The module maps on disk in those folders. */
  moduleMaps: string[];
  /** The module maps SwiftPM synthesizes for those folders (written by the precheck). */
  synthesized: { module: string; text: string }[];
  /**
   * Every target name and every product name of every package in the graph (per package: its targets, then its
   * products), each once: the names that could provide an angle include's first path component (row 37).
   */
  targets: string[];
  /** Every module the module maps declare, then the synthesized ones. */
  modules: string[];
  /**
   * The modules of the targets SwiftPM builds from Swift: each reached target whose sources hold a `.swift` file, by
   * its C99 name and the modules its own module map declares. Their clang half alone (in `modules`) is not the module
   * Swift Build gives an importer.
   */
  swiftModules: string[];
  /** The references the walk could not place (`<product> of <package>`, or a by-name reference), each once. */
  unresolved: string[];
}

const MANIFEST = "ios-xtool/Package.swift";

/** `head`, then SwiftPM's `error:` lines of `stderr` (all of its lines when it has none). */
function withSwiftLines(head: string, stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim() !== "");
  const errors = lines.filter((l) => /\berror:/.test(l));
  const shown = errors.length > 0 ? errors : lines;
  return shown.length > 0 ? `${head}:\n${shown.join("\n")}` : head;
}

/** The JSON object SwiftPM printed, or undefined when there is none. */
function parseJson(stdout: string): unknown {
  const start = stdout.search(/^\{/m);
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

/**
 * `swift package describe --type json` in `iosXtool`: SwiftPM plans the generated package. A `main` file makes App an
 * executable target (SwiftPM prints the plan and exits non-zero): named first; any other refusal with SwiftPM's lines.
 */
export async function planManifest(iosXtool: string, run: SwiftRunner): Promise<void> {
  const r = await run(["package", "describe", "--type", "json"], { cwd: iosXtool, env: devEnv(iosXtool) });
  const plan = parseJson(r.stdout) as { targets?: { name?: unknown; type?: unknown }[] } | undefined;
  const app = Array.isArray(plan?.targets) ? plan.targets.find((t) => t?.name === "App") : undefined;
  if (app?.type === "executable") {
    throw new PrecheckError(
      "precheck — SwiftPM plans the App target as an executable target (a file named main); xtool links the app's entry point from the App library",
    );
  }
  if (r.code !== 0) throw new PrecheckError(withSwiftLines(`precheck — SwiftPM refused the generated package (${MANIFEST})`, r.stderr));
  if (plan === undefined) throw new PrecheckError(withSwiftLines(`precheck — SwiftPM gave no plan for the generated package (${MANIFEST})`, r.stderr));
  if (app === undefined) throw new PrecheckError(`precheck — SwiftPM's plan of the generated package (${MANIFEST}) has no App target`);
}

interface ListedPackage {
  name: string;
  path: string;
}

/** The packages `show-dependencies --format json` lists under the root, each once, in its order. */
function listedPackages(tree: unknown): ListedPackage[] {
  const seen = new Map<string, ListedPackage>();
  const walk = (node: unknown) => {
    const deps = (node as { dependencies?: unknown })?.dependencies;
    if (!Array.isArray(deps)) return;
    for (const d of deps as { name?: unknown; path?: unknown }[]) {
      if (typeof d?.path !== "string" || seen.has(d.path)) continue;
      seen.set(d.path, { name: typeof d.name === "string" ? d.name : path.basename(d.path), path: d.path });
      walk(d);
    }
  };
  walk(tree);
  return [...seen.values()];
}

/**
 * One package dependency of a dump-package output (`{ fileSystem: [..] }`, `{ sourceControl: [..] }`, `{ registry: [..] }`):
 * its identity, the manifest's name for it, and its folder (a file-system path, or a local source-control location).
 */
function packageDependency(raw: unknown): DumpedPackage["dependencies"][number] | undefined {
  const kinds = raw !== null && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : [];
  const entry = (Array.isArray(kinds[0]) ? kinds[0][0] : undefined) as
    | { identity?: unknown; nameForTargetDependencyResolutionOnly?: unknown; path?: unknown; location?: { local?: unknown } }
    | undefined;
  if (typeof entry?.identity !== "string") return undefined;
  const name = entry.nameForTargetDependencyResolutionOnly;
  const local = Array.isArray(entry.location?.local) ? entry.location.local[0] : undefined;
  const dir = typeof entry.path === "string" ? entry.path : typeof local === "string" ? local : undefined;
  return { identity: entry.identity, ...(typeof name === "string" ? { name } : {}), ...(dir !== undefined ? { path: dir } : {}) };
}

/** The fields the precheck reads of one dump-package output; undefined when it is not one. */
function dumpedPackage(json: unknown, dir: string): DumpedPackage | undefined {
  const raw = json as { name?: unknown; dependencies?: unknown; products?: unknown; targets?: unknown } | undefined;
  if (typeof raw?.name !== "string" || !Array.isArray(raw.targets)) return undefined;
  const products = Array.isArray(raw.products) ? (raw.products as { name?: unknown; targets?: unknown }[]) : [];
  return {
    name: raw.name,
    path: dir,
    dependencies: (Array.isArray(raw.dependencies) ? raw.dependencies : []).flatMap((d) => packageDependency(d) ?? []),
    products: products
      .filter((p) => typeof p?.name === "string")
      .map((p) => ({ name: p.name as string, targets: Array.isArray(p.targets) ? p.targets.filter((n): n is string => typeof n === "string") : [] })),
    targets: (raw.targets as Record<string, unknown>[])
      .filter((t) => typeof t?.name === "string" && typeof t.type === "string")
      .map((t) => ({
        name: t.name as string,
        type: t.type as string,
        ...(typeof t.path === "string" ? { path: t.path } : {}),
        ...(typeof t.publicHeadersPath === "string" ? { publicHeadersPath: t.publicHeadersPath } : {}),
        ...(Array.isArray(t.sources) ? { sources: t.sources.filter((x): x is string => typeof x === "string") } : {}),
        ...(Array.isArray(t.exclude) ? { exclude: t.exclude.filter((x): x is string => typeof x === "string") } : {}),
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
      })),
  };
}

/** `fn` over `items`, at most `limit` at a time; results in `items`' order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The generated package and every package it depends on, as `dump-package` gives them. `show-dependencies` lists the
 * packages; each is dumped with its own `--scratch-path <scratch>/<n>` (the root is 0), so nothing is written into a
 * library's folder, `os.availableParallelism()` at a time.
 */
export async function readPackageGraph(iosXtool: string, scratch: string, run: SwiftRunner): Promise<Graph> {
  const env = devEnv(iosXtool);
  const shown = await run(["package", "show-dependencies", "--format", "json"], { cwd: iosXtool, env });
  const tree = shown.code === 0 ? parseJson(shown.stdout) : undefined;
  if (tree === undefined) {
    throw new PrecheckError(withSwiftLines(`precheck — SwiftPM could not list the dependencies of the generated package (${MANIFEST})`, shown.stderr));
  }
  const listed = [{ name: path.basename(iosXtool), path: iosXtool }, ...listedPackages(tree)];
  const dumped = await mapLimit(listed, availableParallelism(), async (p, n) => {
    const r = await run(["package", "dump-package", "--package-path", p.path, "--scratch-path", path.join(scratch, String(n))], { cwd: iosXtool, env });
    const pkg = r.code === 0 ? dumpedPackage(parseJson(r.stdout), p.path) : undefined;
    if (pkg === undefined) throw new PrecheckError(withSwiftLines(`precheck — SwiftPM could not read the package ${p.name} (${p.path})`, r.stderr));
    return pkg;
  });
  return { root: dumped[0]!, packages: dumped.slice(1) };
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** SwiftPM's C99 name of a target (its module name) or of a package identity (Swift's `-package-name`). */
export function c99name(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

/**
 * The module map SwiftPM synthesizes for a clang target's public headers folder `include` without one:
 * `<c99name>/<c99name>.h`, else `<c99name>.h`, as the umbrella header; else the folder as the umbrella.
 */
function synthesizedModuleMap(module: string, include: string): string {
  const nested = path.join(include, module, `${module}.h`);
  const flat = path.join(include, `${module}.h`);
  const umbrella = existsSync(nested) ? `umbrella header "${nested}"` : existsSync(flat) ? `umbrella header "${flat}"` : `umbrella "${include}"`;
  return `module ${module} {\n    ${umbrella}\n    export *\n}\n`;
}

/** The top-level modules a module map declares (`module X`, `framework module X`, `extern module X`). */
function declaredModules(text: string): string[] {
  const modules: string[] = [];
  let depth = 0;
  const tokens = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|\{|\}|\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const m of text.matchAll(tokens)) {
    if (m[0] === "{") depth++;
    else if (m[0] === "}") depth = Math.max(0, depth - 1);
    else if (m[1] !== undefined && depth === 0) modules.push(m[1]);
  }
  return modules;
}

/** One dependency of a dump-package target: a target, a product or a name (a target first, else a product). */
type Dependency = { kind: "target"; name: string } | { kind: "product"; name: string; package: string } | { kind: "byName"; name: string };

function dependency(raw: unknown): Dependency | undefined {
  const d = raw as Record<string, unknown[] | undefined> | null;
  const name = (list: unknown[] | undefined) => (Array.isArray(list) && typeof list[0] === "string" ? list[0] : undefined);
  const target = name(d?.target ?? undefined);
  if (target !== undefined) return { kind: "target", name: target };
  const product = name(d?.product ?? undefined);
  if (product !== undefined) {
    const pkg = d!.product![1];
    return { kind: "product", name: product, package: typeof pkg === "string" ? pkg : product };
  }
  const byName = name(d?.byName ?? undefined);
  return byName !== undefined ? { kind: "byName", name: byName } : undefined;
}

const realPath = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * The header folders, module maps and module names of the targets the root's `App` target reaches through product,
 * target and by-name dependencies, in dependency order (each target before the ones it depends on, a target's
 * dependencies in the manifest's order). A reference to package `X` resolves as SwiftPM resolves it: against the
 * depending manifest's own dependencies, the one whose name or identity is `X` (case ignored), found among the dumped
 * packages by its folder (real paths), else by identity; the package named `X`, or whose folder's lower-cased name is
 * `x`, is the last fallback. A by-name reference that is not a target of its package goes the same way. A reference
 * still unplaced is listed in `unresolved` (SwiftPM planned the package, so it never stops the precheck).
 */
export function graphHeaders(graph: Graph): PrecheckGraph {
  const all = [graph.root, ...graph.packages];
  const real = new Map(all.map((p) => [p, realPath(p.path)]));
  const identity = (p: DumpedPackage) => path.basename(p.path).toLowerCase();
  const packageOf = (from: DumpedPackage, ref: string): DumpedPackage | undefined => {
    const r = ref.toLowerCase();
    const dep = from.dependencies.find((d) => d.name?.toLowerCase() === r) ?? from.dependencies.find((d) => d.identity.toLowerCase() === r);
    if (dep !== undefined) {
      const dir = dep.path !== undefined ? realPath(dep.path) : undefined;
      const found = all.find((p) => real.get(p) === dir) ?? all.find((p) => identity(p) === dep.identity.toLowerCase());
      if (found !== undefined) return found;
    }
    return all.find((p) => p.name === ref) ?? all.find((p) => identity(p) === r);
  };
  const out: PrecheckGraph = { headerDirs: [], moduleMaps: [], synthesized: [], targets: [], modules: [], swiftModules: [], unresolved: [] };
  const seen = new Set<Target>();

  const visitProduct = (pkg: DumpedPackage | undefined, productName: string, unplaced: string) => {
    const product = pkg?.products.find((p) => p.name === productName);
    if (pkg === undefined || product === undefined) {
      out.unresolved.push(unplaced);
      return;
    }
    for (const name of product.targets) {
      const target = pkg.targets.find((t) => t.name === name);
      if (target !== undefined) visit(pkg, target);
    }
  };
  const visit = (pkg: DumpedPackage, target: Target) => {
    if (seen.has(target)) return;
    seen.add(target);
    if (target !== appTarget) {
      const declared = addHeaders(pkg, target);
      if (target.type === "regular" && hasSwiftSources(pkg, target)) out.swiftModules.push(c99name(target.name), ...declared);
    }
    for (const raw of target.dependencies) {
      const d = dependency(raw);
      if (d === undefined) continue;
      const local = d.kind === "product" ? undefined : pkg.targets.find((t) => t.name === d.name);
      if (local !== undefined) {
        visit(pkg, local);
      } else if (d.kind === "product") {
        visitProduct(packageOf(pkg, d.package), d.name, `${d.name} of ${d.package}`);
      } else {
        const named = packageOf(pkg, d.name);
        const owner = named?.products.some((q) => q.name === d.name) ? named : all.find((p) => p !== pkg && p.products.some((q) => q.name === d.name));
        visitProduct(owner, d.name, d.name);
      }
    }
  };
  /** The target's header folder and module map; the modules its map on disk declares (none: synthesized or no map). */
  const addHeaders = (pkg: DumpedPackage, target: Target): string[] => {
    if (target.type === "binary") {
      const headers = binaryHeaders(pkg, target);
      if (headers === undefined) return [];
      out.headerDirs.push(headers);
      return addModuleMap(path.join(headers, "module.modulemap")) ?? [];
    }
    if (target.type !== "regular") return [];
    const include = path.join(sourceDir(pkg, target), target.publicHeadersPath ?? "include");
    if (!isDir(include)) return [];
    out.headerDirs.push(include);
    const declared = addModuleMap(path.join(include, "module.modulemap"));
    if (declared !== undefined) return declared;
    const module = c99name(target.name);
    out.synthesized.push({ module, text: synthesizedModuleMap(module, include) });
    return [];
  };
  /** The modules the map declares; undefined when there is no map. */
  const addModuleMap = (file: string): string[] | undefined => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const declared = declaredModules(text);
    out.moduleMaps.push(file);
    out.modules.push(...declared);
    return declared;
  };

  const appTarget = graph.root.targets.find((t) => t.name === "App");
  if (appTarget !== undefined) visit(graph.root, appTarget);
  out.targets = [...new Set(all.flatMap((p) => [...p.targets.map((t) => t.name), ...p.products.map((q) => q.name)]))];
  // One map per module: a module a map on disk declares gets no synthesized one (two would be a redefinition).
  const declared = new Set(out.modules);
  out.synthesized = out.synthesized.filter((s) => !declared.has(s.module));
  out.modules = [...new Set([...out.modules, ...out.synthesized.map((s) => s.module)])];
  out.swiftModules = [...new Set(out.swiftModules)];
  out.unresolved = [...new Set(out.unresolved)];
  return out;
}

/** A regular target's folder: its `path`, else `Sources/<name>`. */
const sourceDir = (pkg: DumpedPackage, target: Target): string => path.join(pkg.path, target.path ?? path.join("Sources", target.name));

/**
 * The target compiles a Swift file: one of its `sources` is a `.swift` file or a folder holding one, or, without
 * `sources`, its folder holds one. Not looked in: dot folders, its `exclude` entries and the folders of the package's
 * other targets inside its own. Its public headers folder counts (an Expo mixed target's is its whole folder).
 */
function hasSwiftSources(pkg: DumpedPackage, target: Target): boolean {
  const dir = sourceDir(pkg, target);
  const skipped = new Set([
    ...(target.exclude ?? []).map((e) => path.join(dir, e)),
    ...pkg.targets.filter((t) => t !== target && t.type !== "binary").map((t) => sourceDir(pkg, t)).filter((d) => d !== dir),
  ]);
  const found = (p: string): boolean => {
    if (skipped.has(p)) return false;
    if (p.endsWith(".swift") && !isDir(p)) return existsSync(p);
    let entries: Dirent[];
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((e) =>
      e.isDirectory() ? !e.name.startsWith(".") && found(path.join(p, e.name)) : e.name.endsWith(".swift") && !skipped.has(path.join(p, e.name)),
    );
  };
  return (target.sources ?? ["."]).some((s) => found(path.join(dir, s)));
}

/** A binary target's device slice `Headers` (the slice without a platform variant), when it is an xcframework with one. */
function binaryHeaders(pkg: DumpedPackage, target: Target): string | undefined {
  if (typeof target.path !== "string") return undefined;
  const xcframework = path.join(pkg.path, target.path);
  if (!existsSync(path.join(xcframework, "Info.plist"))) return undefined;
  const device = readXcframeworkSlices(xcframework).find((s) => s.SupportedPlatform === "ios" && s.SupportedPlatformVariant === undefined);
  if (device === undefined) return undefined;
  const headers = path.join(xcframework, device.LibraryIdentifier, device.HeadersPath ?? "Headers");
  return isDir(headers) ? headers : undefined;
}
