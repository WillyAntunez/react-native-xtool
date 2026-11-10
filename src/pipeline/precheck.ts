// The precheck step (spec "B2, the precheck", rows 37–55): the generated package planned and its graph read, B1's pass 2
// over the app's copied files, then `swiftc -typecheck` (hop 2) and `clang -fsyntax-only` per C-family file (hop 3),
// each translation unit's output parsed on its own. The flags come from `precheckCommands.ts`, the parsing from
// `precheckReport.ts`: this file only runs the hops, in order, and says what it skipped.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { GeneratedApp } from "../generate/iosXtool.js";
import type { ProjectPaths } from "../paths.js";
import { resolveIncludes, type IncludeScope, type ResolvedInclude } from "../project/appIncludes.js";
import { definesOf } from "../project/includeScan.js";
import { runArgv } from "../tools/exec.js";
import { devEnv } from "../tools/xtool.js";
import {
  clangArgs,
  moduleCacheKey,
  precheckIncludeDirs,
  precheckToolchain,
  swiftcArgs,
  synthesizedModuleMap,
  type PrecheckInputs,
  type PrecheckToolchain,
} from "./precheckCommands.js";
import { graphHeaders, planManifest, readPackageGraph, type SwiftRunner } from "./precheckGraph.js";
import { parseDiagnostics, precheckErrorLines, precheckStop, STALE_MODULE_CACHE, withExit, type Diagnostic } from "./precheckReport.js";

export interface PrecheckOptions {
  root: string;
  rnVersion: string;
  /** `build --clean`: the module cache is emptied first. */
  clean: boolean;
  /** The terminal: errors, and the `ℹ`/`⚠` lines that name what the precheck left to xtool-build. */
  log: (s: string) => void;
}

export interface PrecheckDeps {
  swift: SwiftRunner;
  /** One compiler run; a non-zero exit resolves. `output` is stdout and stderr interleaved. */
  compile: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ code: number; output: string }>;
  toolchain: () => Promise<PrecheckToolchain>;
}

/** The extensions clang compiles in the App target; any other copied file is a header, read only through an include. */
const C_FAMILY = new Set([".m", ".mm", ".c", ".cc", ".cpp", ".cxx"]);
/** The output lines shown for a compiler that failed without a diagnostic. */
const FAILURE_TAIL = 20;
const MODULE_MAP_FLAG = "-fmodule-map-file=";

/** A command that could not start has no exit code: execa's message stands for its output. */
const notStarted = (r: { exitCode?: number; message?: string }): string => (r.exitCode === undefined ? (r.message ?? "") : "");

const realSwift: SwiftRunner = async (args, opts) => {
  const r = await execa("swift", args, { cwd: opts.cwd, env: opts.env, extendEnv: false, reject: false });
  return { code: r.exitCode ?? 1, stdout: `${r.stdout ?? ""}`, stderr: `${r.stderr ?? ""}${notStarted(r)}` };
};

const realCompile: PrecheckDeps["compile"] = async (cmd, args, opts) => {
  const [bin, argv] = runArgv(cmd, args, true);
  const r = await execa(bin, argv, { cwd: opts.cwd, env: opts.env, extendEnv: false, reject: false, all: true });
  return { code: r.exitCode ?? 1, output: `${r.all ?? ""}${notStarted(r)}` };
};

/** A path as the precheck's lines name it: a copied file by its source, any path relative to the project root. */
export function display(file: string, root: string, origins: Record<string, string>): string {
  const source = origins[file] ?? file;
  const rel = path.relative(root, source);
  const outside = rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return outside ? source : rel.split(path.sep).join("/");
}

/** One compiler run: the files it was given, its exit code and its output. */
interface Unit {
  files: string[];
  code: number;
  output: string;
}

/** What every hop shares. */
interface Run {
  paths: ProjectPaths;
  app: GeneratedApp;
  opts: PrecheckOptions;
  deps: PrecheckDeps;
  dir: string;
  logFile: string;
  /** The compilers' TMPDIR, removed at the end. */
  tmp: string;
  env: NodeJS.ProcessEnv;
  /** To precheck.log only. */
  write: (text: string) => void;
  /** To the terminal and precheck.log. */
  show: (line: string) => void;
  name: (file: string) => string;
}

/** `file` emptied, then each text appended as it comes. */
function logWriter(file: string): (text: string) => void {
  writeFileSync(file, "");
  return (text) => appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

const quote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
const commandLine = (cmd: string, args: string[]): string => [cmd, ...args].map(quote).join(" ");
const within = (dir: string, p: string): boolean => p === dir || p.startsWith(`${dir}${path.sep}`);
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** `fn` over `items`, at most `limit` at a time; results in `items`' order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Checks the app's own sources before xtool-build, in order: the module cache (emptied on `clean`, other keys
 * removed) and the toolchain; SwiftPM's plan and graph; pass 2; Swift; the C family; the report. Every command line
 * and all output go to `<dir>/precheck.log`; errors stop with `precheckStop`, and any other stop but a missing
 * toolchain names the way past the precheck too (`withExit`).
 */
export async function runPrecheck(
  paths: ProjectPaths,
  app: GeneratedApp,
  opts: PrecheckOptions,
  deps: Partial<PrecheckDeps> = {},
): Promise<void> {
  const dir = path.join(paths.iosXtool, ".precheck");
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "precheck.log");
  const write = logWriter(logFile);
  const tmp = path.join(dir, "tmp");
  const r: Run = {
    paths,
    app,
    opts,
    deps: { swift: realSwift, compile: realCompile, toolchain: () => precheckToolchain(), ...deps },
    dir,
    logFile,
    tmp,
    env: { ...devEnv(paths.iosXtool), TMPDIR: tmp },
    write,
    show: (line) => {
      write(line);
      opts.log(line);
    },
    name: (file) => display(file, opts.root, app.origins),
  };
  try {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const { toolchain, moduleCache } = await prepare(r);
    const inputs = await readGraph(r, toolchain, moduleCache);
    const maps = placeImporterMaps(r);
    const includes = pass2(r, inputs);
    const waiting = waitingForMaps(r, includes, maps);
    const swiftBuilt = importsSwiftBuilt(r, inputs, includes, maps, waiting);
    const swift = await swiftHop(r, inputs, waiting, swiftBuilt, maps);
    const cFamily = await cFamilyHop(r, inputs, swift !== undefined, includes, new Set([...waiting, ...swiftBuilt.keys()]), maps);
    report(r, [...(swift ?? []), ...cFamily]);
  } catch (e) {
    write(`# stopped: ${e instanceof Error ? e.message : String(e)}`);
    throw withExit(e);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** `clean` empties the module cache before the toolchain is read; a cache under another key is removed after. */
async function prepare(r: Run): Promise<{ toolchain: PrecheckToolchain; moduleCache: string }> {
  const caches = path.join(r.dir, "ModuleCache");
  if (r.opts.clean) rmSync(caches, { recursive: true, force: true });
  const toolchain = await r.deps.toolchain();
  const key = moduleCacheKey(r.opts.rnVersion, toolchain.versions);
  for (const other of entries(caches).filter((e) => e !== key)) rmSync(path.join(caches, other), { recursive: true, force: true });
  r.write(`# precheck of ${r.opts.root}\n# toolchain:\n${toolchain.versions}\n# module cache: ${key}`);
  return { toolchain, moduleCache: path.join(caches, key) };
}

/** SwiftPM's plan (hop 5, first), the package graph's headers, the synthesized module maps and `inputs.json`. */
async function readGraph(r: Run, toolchain: PrecheckToolchain, moduleCache: string): Promise<PrecheckInputs> {
  const swift: SwiftRunner = async (args, o) => {
    const res = await r.deps.swift(args, o);
    r.write(`$ ${commandLine("swift", args)}\n${res.stdout}\n${res.stderr}\n# exit ${res.code}`);
    return res;
  };
  await planManifest(r.paths.iosXtool, swift);
  const graph = graphHeaders(await readPackageGraph(r.paths.iosXtool, path.join(r.tmp, "scratch"), swift));
  rmSync(path.join(r.dir, "modulemaps"), { recursive: true, force: true });
  for (const s of graph.synthesized) {
    const file = synthesizedModuleMap(r.dir, s.module);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, s.text);
  }
  const inputs: PrecheckInputs = { app: r.app, graph, toolchain, dir: r.dir, moduleCache };
  writeFileSync(path.join(r.dir, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
  if (graph.unresolved.length > 0) {
    r.show(
      `ℹ precheck — ${graph.unresolved.length} dependencies of App could not be placed (${graph.unresolved.join(", ")}): checked by xtool-build`,
    );
  }
  return inputs;
}

/** Expo's importer module maps, as the precheck places them. */
interface ImporterMaps {
  /** The modules whose map Swift Build has not written yet (each map is named for its module). */
  missing: Set<string>;
  /** `args` without the flags that name such a map; on the first drop, the `ℹ` line unless `skip` gave it. */
  drop: (args: string[]) => string[];
  /** The one `ℹ` line, naming the files left to xtool-build for those maps. */
  skip: (files: string[]) => void;
}

/** A path a module map names: after `header` (any kind, `umbrella header` too), `umbrella`, or `extern module X`. */
const MAP_PATH = /(\b(?:header|umbrella)\s+|\bextern\s+module\s+[A-Za-z_][A-Za-z0-9_]*\s+)"((?:[^"\\]|\\.)*)"/g;

/**
 * Swift Build's module map `text`, read from `map`, with each relative path it names made absolute against the map's
 * own folder, so that the copy still names Swift Build's files (`header "ExpoUI-Swift.h"`); absolute paths stay. A path
 * to the App's own Swift header (`app.from`) names the precheck's (`app.to`) instead. Nothing else changes.
 */
function withSwiftBuildPaths(text: string, map: string, app: { from: string; to: string }): string {
  return text.replace(MAP_PATH, (whole, head: string, named: string) => {
    if (named.includes("\\")) return whole;
    const resolved = path.resolve(path.dirname(map), named);
    if (resolved === app.from) return `${head}"${app.to}"`;
    return path.isAbsolute(named) ? whole : `${head}"${resolved}"`;
  });
}

/**
 * The precheck's Swift header folder, emptied (`App-Swift.h` is written anew), with Expo's importer module maps Swift
 * Build wrote copied in where the swapped flags name them, their paths still naming Swift Build's files
 * (`withSwiftBuildPaths`). A map Swift Build has not written yet is dropped from the
 * command lines, with one `ℹ` line.
 */
function placeImporterMaps(r: Run): ImporterMaps {
  const to = path.join(r.dir, "swift-headers");
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const from = r.app.pkg.app.swiftHeadersDir;
  const placedMissing = new Set<string>();
  const missing = new Set<string>();
  for (const map of r.app.pkg.expo?.clangImporter?.moduleMaps ?? []) {
    if (!within(from, map) || map === from) continue;
    const placed = path.join(to, path.relative(from, map));
    if (existsSync(map)) {
      mkdirSync(path.dirname(placed), { recursive: true });
      writeFileSync(placed, withSwiftBuildPaths(readFileSync(map, "utf8"), map, { from: path.join(from, "App-Swift.h"), to: path.join(to, "App-Swift.h") }));
    } else {
      placedMissing.add(placed);
      missing.add(path.basename(map, ".modulemap"));
    }
  }
  let told = false;
  const head = `ℹ precheck — ${placedMissing.size} module maps Swift Build writes are not there yet`;
  return {
    missing,
    drop: (args) => {
      const kept: string[] = [];
      for (const arg of args) {
        if (arg.startsWith(MODULE_MAP_FLAG) && placedMissing.has(arg.slice(MODULE_MAP_FLAG.length))) {
          if (kept.at(-1) === "-Xcc") kept.pop();
          if (!told) r.show(`${head}: files that need them are checked by xtool-build`);
          told = true;
          continue;
        }
        kept.push(arg);
      }
      return kept;
    },
    skip: (files) => {
      if (files.length === 0) return;
      r.show(`${head}: ${files.map(r.name).join(", ")} are checked by xtool-build`);
      told = true;
    },
  };
}

/** Where clang looks after the target's include folders, and whether its own resource headers were found. */
interface SystemHeaders {
  has: (spelling: string) => boolean;
  /** clang's resource folder is known: without it, an angle include of `<stdarg.h>` cannot be judged. */
  resource: boolean;
}

/** The include folders clang searches after the target's: its own headers', the SDK's, and the frameworks'. */
function systemHeaders(inputs: PrecheckInputs): SystemHeaders {
  const { sdk, versions } = inputs.toolchain;
  // clang's resource headers (stdarg.h, arm_neon.h, …): <InstalledDir>/../lib/clang/<version>/include.
  const installed = /^InstalledDir: (.+)$/m.exec(versions)?.[1]?.trim();
  const clangLib = installed !== undefined ? path.join(installed, "..", "lib", "clang") : undefined;
  const resource = clangLib !== undefined ? entries(clangLib).map((v) => path.join(clangLib, v, "include")).filter(isDir) : [];
  const dirs = [...resource, path.join(sdk, "usr", "local", "include"), path.join(sdk, "usr", "include"), path.join(sdk, "usr", "include", "c++", "v1")];
  const compileInterfaces = inputs.app.pkg.expo?.compileInterfacesDir;
  const frameworks = [
    ...(compileInterfaces !== undefined ? [compileInterfaces] : []),
    path.join(sdk, "System", "Library", "Frameworks"),
    path.join(sdk, "System", "Library", "SubFrameworks"),
  ];
  const has = (spelling: string): boolean => {
    if (path.isAbsolute(spelling)) return false;
    if (dirs.some((d) => existsSync(path.join(d, spelling)))) return true;
    const slash = spelling.indexOf("/");
    if (slash <= 0) return false;
    const framework = `${spelling.slice(0, slash)}.framework`;
    const rest = spelling.slice(slash + 1);
    return frameworks.some((d) => ["Headers", "PrivateHeaders"].some((h) => existsSync(path.join(d, framework, h, rest))));
  };
  return { has, resource: resource.length > 0 };
}

/** The copy's includes, resolved as pass 2 resolves them. */
interface Includes {
  of: (file: string) => ResolvedInclude[];
  /** A spelling looked up as clang does: from `from`'s folder (quote), then the include folders. */
  lookup: (from: string, spelling: string, angle: boolean) => string | undefined;
  /** `file` and the copy's files its includes find, transitively (a `-Swift.h` forward in the copy followed). */
  reached: (file: string) => string[];
}

/** The files clang reads first: the C-family sources and the bridging header. */
function compileRoots(r: Run): string[] {
  const bridging = r.app.pkg.app.bridgingHeader;
  return [...Object.keys(r.app.origins).filter((f) => C_FAMILY.has(path.extname(f))), ...(bridging !== undefined ? [bridging] : [])];
}

/**
 * B1 pass 2 over the copied files (Swift's aside) with the App target's include folders and defines. A certain miss
 * the system folders do not answer either, in a file the compile reaches through certain includes, is an error when it is a quote include, or
 * an angle include whose first path component is no target of the graph (and clang's own headers were found); the
 * errors stop the step before any compile. Any other certain miss is a `⚠`.
 */
function pass2(r: Run, inputs: PrecheckInputs): Includes {
  const includeDirs = precheckIncludeDirs(inputs);
  r.write(`# pass 2: the App target's ${includeDirs.length} include folders, in order\n${includeDirs.map((d) => `  ${d}`).join("\n")}`);
  const scope: Omit<IncludeScope, "files"> = { exists: existsSync, includeDirs, defines: definesOf(r.app.pkg.app.defines) };
  const files = Object.keys(r.app.origins).filter((f) => path.extname(f) !== ".swift");
  const resolved = resolveIncludes({ ...scope, files: files.map((f) => ({ path: f, source: f, display: f })) });

  const byFile = new Map<string, ResolvedInclude[]>(files.map((f) => [f, []]));
  for (const inc of resolved) byFile.get(inc.file)!.push(inc);
  const of = (file: string): ResolvedInclude[] => {
    let found = byFile.get(file);
    if (found === undefined) {
      found = existsSync(file) ? resolveIncludes({ ...scope, files: [{ path: file, source: file, display: file }] }) : [];
      byFile.set(file, found);
    }
    return found;
  };
  const lookup = (from: string, spelling: string, angle: boolean): string | undefined => {
    if (path.isAbsolute(spelling)) return existsSync(spelling) ? spelling : undefined;
    return (angle ? includeDirs : [path.dirname(from), ...includeDirs]).map((d) => path.join(d, spelling)).find((p) => existsSync(p));
  };
  /** With `certain`, only the includes clang surely opens are followed. */
  const reach = (file: string, certain: boolean): string[] => {
    const seen = new Set<string>();
    const visit = (f: string): void => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const inc of of(f)) {
        if (certain && !inc.certain) continue;
        const found = inc.generated ? lookup(f, inc.spelling, inc.angle) : inc.found;
        if (found !== undefined && within(r.paths.sources, found)) visit(found);
      }
    };
    visit(file);
    return [...seen];
  };
  const reached = (file: string): string[] => reach(file, false);

  // Errors only where clang surely reads the file: a header reached only through an uncertain include may never be.
  const roots = compileRoots(r);
  const compiled = new Set(roots.flatMap(reached));
  const surely = new Set(roots.flatMap((f) => reach(f, true)));
  const system = systemHeaders(inputs);
  const targets = new Set(inputs.graph.targets);
  let errors = 0;
  for (const inc of resolved) {
    if (!inc.certain || inc.generated || inc.found !== undefined || system.has(inc.spelling)) continue;
    const at = `${r.name(inc.file)}:${inc.line} imports ${inc.spelling}`;
    const first = inc.spelling.split("/")[0]!;
    if (!compiled.has(inc.file)) {
      r.show(`⚠ precheck — ${at}, which nothing compiles; checked by xtool-build if it is ever included`);
    } else if (!surely.has(inc.file)) {
      r.show(`⚠ precheck — ${at}, which only a condition the precheck cannot evaluate includes; the compile decides`);
    } else if (inc.angle && targets.has(first)) {
      r.show(`⚠ precheck — ${at}, which rn-xtool did not find; ${first} is a target of the package, so the compile decides`);
    } else if (inc.angle && !system.resource) {
      r.show(`⚠ precheck — ${at}, which rn-xtool did not find; the compile decides`);
    } else {
      errors++;
      r.show(`✖ precheck — ${at}, which is in none of the App target's ${includeDirs.length} include folders (listed in ${r.name(r.logFile)})`);
    }
  }
  if (errors > 0) throw precheckStop(errors, r.name(r.logFile));
  return { of, lookup, reached };
}

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, "");
const readText = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** `import M`, `@attr import M`, `public import M`, `import struct M.X`: the modules a Swift file imports. */
const SWIFT_IMPORT =
  /^\s*(?:(?:@\w+(?:\([^)]*\))?|public|internal|package|private|fileprivate)\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_]\w*)/;
/** `@import M;` and `@import M.Sub;` in a C-family file. */
const AT_IMPORT = /^\s*@import\s+([A-Za-z_]\w*)/;

/** The modules `text` imports, one per line `pattern` matches (comments aside). */
function moduleImports(text: string, pattern: RegExp): string[] {
  return withoutComments(text)
    .split(/\r?\n/)
    .flatMap((line) => {
      const m = pattern.exec(line);
      return m ? [m[1]!] : [];
    });
}

/**
 * The files that import a module whose map Swift Build has not written yet: a C-family file or the bridging header
 * whose reach `@import`s one, a Swift file that `import`s one. When swiftc would read one (a Swift file, or the
 * bridging header), every Swift file waits. Named in the module-map `ℹ` line; none of them is compiled.
 */
function waitingForMaps(r: Run, includes: Includes, maps: ImporterMaps): Set<string> {
  if (maps.missing.size === 0) return new Set();
  const needs = (modules: string[]) => modules.some((m) => maps.missing.has(m));
  const atImports = (file: string) => includes.reached(file).flatMap((f) => moduleImports(readText(f), AT_IMPORT));
  const swift = Object.keys(r.app.origins).filter((f) => path.extname(f) === ".swift");
  const waiting = compileRoots(r).filter((f) => needs(atImports(f)));
  const bridging = r.app.pkg.app.bridgingHeader;
  const swiftWaits = swift.some((f) => needs(moduleImports(readText(f), SWIFT_IMPORT))) || (bridging !== undefined && waiting.includes(bridging));
  const all = new Set([...waiting, ...(swiftWaits ? swift : [])]);
  maps.skip([...all]);
  return all;
}

/** The SDK has module `m`: a framework, or a Swift module of its own. */
const sdkHas = (sdk: string, m: string): boolean =>
  isDir(path.join(sdk, "System", "Library", "Frameworks", `${m}.framework`)) || existsSync(path.join(sdk, "usr", "lib", "swift", `${m}.swiftmodule`));

/**
 * The compile roots, not already waiting for a module map, whose reach `@import`s a module SwiftPM builds from Swift
 * (`graph.swiftModules`) or one no map declares (not a module of the graph's maps, of the SDK, or of an importer map
 * Swift Build wrote): file → that module. clang would not find the module as Swift Build gives it, so none of them is
 * compiled; one `ℹ` line per module names the first file, and the log lists them all. B1 never errors on `@import`.
 */
function importsSwiftBuilt(r: Run, inputs: PrecheckInputs, includes: Includes, maps: ImporterMaps, waiting: Set<string>): Map<string, string> {
  const swiftBuilt = new Set(inputs.graph.swiftModules);
  const modules = new Set(inputs.graph.modules);
  const importer = new Set((r.app.pkg.expo?.clangImporter?.moduleMaps ?? []).map((m) => path.basename(m, ".modulemap")));
  const placed = (m: string): boolean =>
    !swiftBuilt.has(m) && (modules.has(m) || importer.has(m) || maps.missing.has(m) || sdkHas(inputs.toolchain.sdk, m));
  const out = new Map<string, string>();
  const byModule = new Map<string, string[]>();
  for (const root of compileRoots(r)) {
    if (waiting.has(root)) continue;
    const module = includes
      .reached(root)
      .flatMap((f) => moduleImports(readText(f), AT_IMPORT))
      .find((m) => !placed(m));
    if (module === undefined) continue;
    out.set(root, module);
    byModule.set(module, [...(byModule.get(module) ?? []), root]);
  }
  for (const [module, files] of byModule) {
    r.show(`ℹ precheck — ${r.name(files[0]!)} imports the module ${module}, which SwiftPM builds; checked by xtool-build`);
    r.write(`# not compiled, imports the module ${module}: ${files.join(" ")}`);
  }
  return out;
}

/**
 * Hop 2: one `swiftc -typecheck` over the App's Swift files, writing `App-Swift.h`. Not run without Swift files, while
 * they wait for a module map, when a file imports a module the SDK does not have and the graph has only as clang's
 * (SwiftPM builds it from Swift, or it is in no map), nor when the bridging header imports one (`swiftBuilt`): one
 * `ℹ` line, the first such import. Undefined when swiftc did not run.
 */
async function swiftHop(
  r: Run,
  inputs: PrecheckInputs,
  waiting: Set<string>,
  swiftBuilt: Map<string, string>,
  maps: ImporterMaps,
): Promise<Unit[] | undefined> {
  const files = Object.keys(r.app.origins).filter((f) => path.extname(f) === ".swift");
  if (files.length === 0 || files.some((f) => waiting.has(f))) return undefined;
  const modules = new Set(inputs.graph.modules);
  const fromSwift = new Set(inputs.graph.swiftModules);
  const known = (m: string): boolean => (modules.has(m) && !fromSwift.has(m)) || sdkHas(inputs.toolchain.sdk, m);
  for (const file of files) {
    const unknown = moduleImports(readFileSync(file, "utf8"), SWIFT_IMPORT).find((m) => !known(m));
    if (unknown !== undefined) {
      r.show(`ℹ precheck — ${r.name(file)} imports ${unknown}, which SwiftPM builds: checked by xtool-build`);
      return undefined;
    }
  }
  const bridging = r.app.pkg.app.bridgingHeader;
  const throughBridging = bridging !== undefined ? swiftBuilt.get(bridging) : undefined;
  if (throughBridging !== undefined) {
    // swiftc reads the bridging header: the module is as far from it as from clang.
    r.show(`ℹ precheck — ${r.name(files[0]!)} imports ${throughBridging}, which SwiftPM builds: checked by xtool-build`);
    return undefined;
  }
  const args = maps.drop(["-no-color-diagnostics", ...swiftcArgs(inputs, files, maps.missing)]);
  return withRetry(r, inputs, async () => [await compileOne(r, inputs.toolchain.swiftc, args, files)]);
}

/**
 * Hop 3: `clang -fsyntax-only` per C-family file, `os.availableParallelism()` at a time; the bridging header too when
 * swiftc did not read it. A file in `waiting` (for a module map, or importing a module SwiftPM builds from Swift) is
 * not compiled, nor one that imports, itself or through the
 * copy's headers, a `-Swift.h` the precheck did not write: one `ℹ` line per such header.
 */
async function cFamilyHop(
  r: Run,
  inputs: PrecheckInputs,
  swiftRan: boolean,
  includes: Includes,
  waiting: Set<string>,
  maps: ImporterMaps,
): Promise<Unit[]> {
  const files = Object.keys(r.app.origins).filter((f) => C_FAMILY.has(path.extname(f)));
  const bridging = r.app.pkg.app.bridgingHeader;
  if (!swiftRan && bridging !== undefined && path.extname(bridging) === ".h") files.push(bridging);

  const unwritten = swiftHeadersNotWritten(r, includes);
  const skipped = new Map<string, string[]>();
  const compiled = files.filter((file) => {
    if (waiting.has(file)) return false;
    const headers = unwritten(file);
    for (const h of headers) skipped.set(h, [...(skipped.get(h) ?? []), file]);
    return headers.length === 0;
  });
  for (const [header, by] of skipped) {
    r.show(`ℹ precheck — ${by.map(r.name).join(", ")} import ${header}, which the Swift check did not write: checked by xtool-build`);
  }
  if (compiled.length === 0) return [];
  const commands = compiled.map((file) => ({ file, args: maps.drop(["-fno-color-diagnostics", ...clangArgs(inputs, file, maps.missing)]) }));
  return withRetry(r, inputs, () =>
    mapLimit(commands, availableParallelism(), (c) => compileOne(r, inputs.toolchain.clang, c.args, [c.file])),
  );
}

/**
 * The `-Swift.h` spellings a file imports, itself or through the copy's files it reaches, that do not lead to the
 * precheck's Swift header folder (a forward in the copy leads on).
 */
function swiftHeadersNotWritten(r: Run, includes: Includes): (file: string) => string[] {
  const written = path.join(r.dir, "swift-headers");
  return (file) => {
    const missing = new Set<string>();
    for (const f of includes.reached(file)) {
      for (const inc of includes.of(f)) {
        if (!inc.generated) continue;
        const found = includes.lookup(f, inc.spelling, inc.angle);
        if (found === undefined || !(within(written, found) || within(r.paths.sources, found))) missing.add(inc.spelling);
      }
    }
    return [...missing];
  };
}

/** One compiler run, its command line and output appended to the log. */
async function compileOne(r: Run, cmd: string, args: string[], files: string[]): Promise<Unit> {
  const res = await r.deps.compile(cmd, args, { cwd: r.paths.iosXtool, env: r.env });
  r.write(`$ ${commandLine(cmd, args)}\n${res.output}\n# exit ${res.code}`);
  return { files, ...res };
}

/** The hop, run once more after removing the module cache when clang said it was stale (row 42). */
async function withRetry(r: Run, inputs: PrecheckInputs, hop: () => Promise<Unit[]>): Promise<Unit[]> {
  const first = await hop();
  const stale = first.flatMap((u) => u.output.split(/\r?\n/)).find((l) => STALE_MODULE_CACHE.test(l));
  if (stale === undefined) return first;
  rmSync(inputs.moduleCache, { recursive: true, force: true });
  r.show(`ℹ precheck — the module cache was stale (${stale.trim()}); checked again without it`);
  return hop();
}

/**
 * Each run's errors, its output parsed on its own; a run that failed without a diagnostic counts as one error, shown
 * with its last lines. Any error: the lines, then the stop.
 */
function report(r: Run, units: Unit[]): void {
  const diags: Diagnostic[] = [];
  const silent: string[] = [];
  let failures = 0;
  for (const unit of units) {
    const found = parseDiagnostics(unit.output);
    diags.push(...found);
    if (unit.code === 0 || found.length > 0) continue;
    failures++;
    silent.push(
      `✖ precheck — ${unit.files.map(r.name).join(", ")}: compiler exited ${unit.code} without a diagnostic rn-xtool could read`,
      ...unit.output.trimEnd().split(/\r?\n/).slice(-FAILURE_TAIL).map((l) => `  ${l}`),
    );
  }
  const count = diags.length + failures;
  if (count === 0) return;
  for (const line of [...silent, ...precheckErrorLines(diags, r.name)]) r.show(line);
  throw precheckStop(count, r.name(r.logFile));
}
