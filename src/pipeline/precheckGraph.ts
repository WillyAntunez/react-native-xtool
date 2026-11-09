import { existsSync, readFileSync, statSync } from "node:fs";
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
  products: { name: string; targets: string[] }[];
  targets: { name: string; type: string; path?: string | null; publicHeadersPath?: string | null; dependencies: unknown[] }[];
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

/** The fields the precheck reads of one dump-package output; undefined when it is not one. */
function dumpedPackage(json: unknown, dir: string): DumpedPackage | undefined {
  const raw = json as { name?: unknown; products?: unknown; targets?: unknown } | undefined;
  if (typeof raw?.name !== "string" || !Array.isArray(raw.targets)) return undefined;
  const products = Array.isArray(raw.products) ? (raw.products as { name?: unknown; targets?: unknown }[]) : [];
  return {
    name: raw.name,
    path: dir,
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

/** SwiftPM's C99 name of a target: its module name. */
function c99name(name: string): string {
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

/**
 * The header folders, module maps and module names of the targets the root's `App` target reaches through product,
 * target and by-name dependencies, in dependency order (each target before the ones it depends on, a target's
 * dependencies in the manifest's order). A product's package is the one whose name, or whose folder's lower-cased
 * name, equals the reference.
 */
export function graphHeaders(graph: Graph): PrecheckGraph {
  const all = [graph.root, ...graph.packages];
  const packageOf = (ref: string): DumpedPackage | undefined =>
    all.find((p) => p.name === ref) ?? all.find((p) => path.basename(p.path).toLowerCase() === ref.toLowerCase());
  const out: PrecheckGraph = { headerDirs: [], moduleMaps: [], synthesized: [], targets: [], modules: [] };
  const seen = new Set<Target>();

  const visitProduct = (pkg: DumpedPackage, productName: string) => {
    const product = pkg.products.find((p) => p.name === productName);
    if (product === undefined) throw new PrecheckError(`precheck — the package ${pkg.name} (${pkg.path}) has no product ${productName}`);
    for (const name of product.targets) {
      const target = pkg.targets.find((t) => t.name === name);
      if (target !== undefined) visit(pkg, target);
    }
  };
  const visit = (pkg: DumpedPackage, target: Target) => {
    if (seen.has(target)) return;
    seen.add(target);
    if (target !== appTarget) addHeaders(pkg, target);
    for (const raw of target.dependencies) {
      const d = dependency(raw);
      if (d === undefined) continue;
      const local = d.kind === "product" ? undefined : pkg.targets.find((t) => t.name === d.name);
      if (local !== undefined) {
        visit(pkg, local);
      } else if (d.kind === "product") {
        const owner = packageOf(d.package);
        if (owner === undefined) throw new PrecheckError(`precheck — ${target.name} depends on ${d.name} of ${d.package}, a package SwiftPM did not list`);
        visitProduct(owner, d.name);
      } else if (d.kind === "byName") {
        const owner = all.find((p) => p !== pkg && p.products.some((q) => q.name === d.name));
        if (owner !== undefined) visitProduct(owner, d.name);
      }
    }
  };
  const addHeaders = (pkg: DumpedPackage, target: Target) => {
    if (target.type === "binary") {
      const headers = binaryHeaders(pkg, target);
      if (headers === undefined) return;
      out.headerDirs.push(headers);
      addModuleMap(path.join(headers, "module.modulemap"));
    } else if (target.type === "regular") {
      const include = path.join(pkg.path, target.path ?? path.join("Sources", target.name), target.publicHeadersPath ?? "include");
      if (!isDir(include)) return;
      out.headerDirs.push(include);
      if (addModuleMap(path.join(include, "module.modulemap"))) return;
      const module = c99name(target.name);
      out.synthesized.push({ module, text: synthesizedModuleMap(module, include) });
    }
  };
  const addModuleMap = (file: string): boolean => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return false;
    }
    out.moduleMaps.push(file);
    out.modules.push(...declaredModules(text));
    return true;
  };

  const appTarget = graph.root.targets.find((t) => t.name === "App");
  if (appTarget !== undefined) visit(graph.root, appTarget);
  out.targets = [...new Set(all.flatMap((p) => [...p.targets.map((t) => t.name), ...p.products.map((q) => q.name)]))];
  out.modules = [...new Set([...out.modules, ...out.synthesized.map((s) => s.module)])];
  return out;
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
