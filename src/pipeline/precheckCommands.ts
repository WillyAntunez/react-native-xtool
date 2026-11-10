import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { sdkBundle } from "../commands/setup.js";
import type { GeneratedApp } from "../generate/iosXtool.js";
import { appClangArgs, appIncludeDirs, appSwiftArgs } from "../generate/packageSwift.js";
import { toolEnv } from "../tools/exec.js";
import { IOS_MIN } from "../versions.js";
import { c99name, type PrecheckGraph } from "./precheckGraph.js";
import { PrecheckError } from "./precheckReport.js";

/** The compilers and the iPhoneOS SDK `xtool dev build` uses, as the precheck runs them. */
export interface PrecheckToolchain {
  clang: string;
  swiftc: string;
  /** The iPhoneOS SDK root of the Darwin SDK bundle. */
  sdk: string;
  /** The triple's `swiftResourcesPath`: Swift's `-resource-dir` (SwiftShims and the runtime's modules), as SwiftPM passes it. */
  swiftResources: string;
  /** The triple's `includeSearchPaths` (XCTest's folder), each Swift's `-Isystem` as Swift Build passes them. */
  swiftIncludes: string[];
  /** The Swift options of the bundle's toolsets for arm64-apple-ios, without `-use-ld=…` (nothing is linked). */
  swiftExtra: string[];
  /** `clang --version`, `swiftc --version` and `darwin-sdk-version.txt`: what the module cache depends on. */
  versions: string;
}

const IOS_TRIPLE = "arm64-apple-ios";
const TARGET = `${IOS_TRIPLE}${IOS_MIN}`;

/** The absolute path of the executable `name` in `env.PATH`, or undefined. */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not in this folder
    }
  }
  return undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

async function versionText(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  const r = await execa(bin, ["--version"], { env, extendEnv: false, reject: false });
  return `${r.stdout}`.trim() || `${r.stderr}`.trim();
}

/**
 * `clang` and `swiftc` on the Swift toolchain's PATH (`toolEnv()`), and from the Darwin SDK bundle's `swift-sdk.json`
 * the iPhoneOS SDK (`targetTriples["arm64-apple-ios"].sdkRootPath`) and the Swift options of that triple's toolsets.
 * Paths in `swift-sdk.json` are relative to its folder.
 */
export async function precheckToolchain(env: NodeJS.ProcessEnv = toolEnv()): Promise<PrecheckToolchain> {
  const found = (tool: string): string => {
    const file = findOnPath(tool, env);
    if (file === undefined) throw new PrecheckError(`precheck — ${tool} was not found on the Swift toolchain's PATH; run rn-xtool setup`);
    return file;
  };
  const clang = found("clang");
  const swiftc = found("swiftc");

  const bundle = sdkBundle();
  const sdkJson = path.join(bundle, "swift-sdk.json");
  const notFound = (where: string) =>
    new PrecheckError(`precheck — the iPhoneOS SDK was not found in the Darwin SDK (${where}); run rn-xtool setup --xcode-xip <path>`);
  type Triple = { sdkRootPath?: unknown; toolsetPaths?: unknown; swiftResourcesPath?: unknown; includeSearchPaths?: unknown };
  const triple = (readJson(sdkJson) as { targetTriples?: Record<string, Triple> } | undefined)?.targetTriples?.[IOS_TRIPLE];
  if (typeof triple?.sdkRootPath !== "string") throw notFound(sdkJson);
  const sdk = path.resolve(bundle, triple.sdkRootPath);
  if (!existsSync(sdk)) throw notFound(sdk);
  // Unnamed: the path given is swift-sdk.json's, as for the SDK.
  const swiftResources = typeof triple.swiftResourcesPath === "string" ? path.resolve(bundle, triple.swiftResourcesPath) : undefined;
  if (swiftResources === undefined || !existsSync(swiftResources)) {
    throw new PrecheckError(
      `precheck — the Swift resources were not found in the Darwin SDK (${swiftResources ?? sdkJson}); run rn-xtool setup --xcode-xip <path>`,
    );
  }
  const swiftIncludes = strings(triple.includeSearchPaths).map((p) => path.resolve(bundle, p));

  const swiftExtra = strings(triple.toolsetPaths)
    .flatMap((toolset) => {
      const json = readJson(path.resolve(bundle, toolset)) as { swiftCompiler?: { extraCLIOptions?: unknown } } | undefined;
      return strings(json?.swiftCompiler?.extraCLIOptions);
    })
    .filter((o) => !o.startsWith("-use-ld="));

  let sdkVersion = "";
  try {
    sdkVersion = readFileSync(path.join(bundle, "darwin-sdk-version.txt"), "utf8").trim();
  } catch {
    // an older bundle without it: the compilers' versions still key the cache
  }
  const versions = [await versionText(clang, env), await versionText(swiftc, env), sdkVersion].join("\n");
  return { clang, swiftc, sdk, swiftResources, swiftIncludes, swiftExtra, versions };
}

/** `rn<rnVersion>-<the first 12 hex digits of sha256(versions)>`: the module cache's folder under `<dir>/ModuleCache`. */
export function moduleCacheKey(rnVersion: string, versions: string): string {
  return `rn${rnVersion}-${createHash("sha256").update(versions).digest("hex").slice(0, 12)}`;
}

export interface PrecheckInputs {
  app: GeneratedApp;
  graph: PrecheckGraph;
  toolchain: PrecheckToolchain;
  /** `ios-xtool/.precheck`. */
  dir: string;
  /** `<dir>/ModuleCache/<moduleCacheKey>`. */
  moduleCache: string;
}

/**
 * Swift's `-package-name`, as SwiftPM derives it: the generated package's identity (its folder's name, lower-cased; the
 * precheck's folder is in it) as a C99 name, `ios_xtool`. `package` declarations need it.
 */
const packageName = (i: PrecheckInputs): string => c99name(path.basename(path.dirname(i.dir)).toLowerCase());

/** The platform's and the SDK's developer frameworks (XCTest's), which Swift Build searches after the SDK's. */
const developerFrameworks = (sdk: string): string[] => [
  path.join(sdk, "..", "..", "Library", "Frameworks"),
  path.join(sdk, "Developer", "Library", "Frameworks"),
];

/** Where the precheck's `swiftc` writes `App-Swift.h`, in place of Swift Build's folder. */
const swiftHeaders = (i: PrecheckInputs): string => path.join(i.dir, "swift-headers");

/** Where the precheck writes the module map SwiftPM synthesizes for `module`. */
export function synthesizedModuleMap(dir: string, module: string): string {
  return path.join(dir, "modulemaps", module, "module.modulemap");
}

/** The module Swift Build's importer map `map` is for: each is named for its module. */
const importerModule = (map: string): string => path.basename(map, ".modulemap");

/** The header folder a synthesized map's umbrella names: the longest of the graph's folders it names or is inside. */
function synthesizedFolder(headerDirs: string[], text: string): string | undefined {
  return headerDirs.filter((d) => text.includes(`"${d}"`) || text.includes(`"${d}/`)).sort((a, b) => b.length - a.length)[0];
}

/** The module maps of a command, one per module, and what the target's own flags and the graph's folders give up. */
interface ModuleMaps {
  /** The graph's maps on disk, then the synthesized maps that stand in (after the target's own importer maps). */
  maps: string[];
  /** Swift Build's importer maps of a module a map on disk declares: left out of the target's flags. */
  shadowed: Set<string>;
  /** The header folders of the synthesized maps that gave way to Swift Build's own: left out too. */
  folders: Set<string>;
}

/**
 * The module maps, one per module (two maps of one module are a redefinition). On the command line Swift Build's
 * importer maps (`expo.clangImporter.moduleMaps`, in the target's own flags) come first, for the modules the graph's
 * maps on disk do not declare; then the graph's on disk (`graphHeaders` synthesizes none for a module they declare);
 * then a synthesized map for each module neither names. Swift Build gives the App no header folder for a module whose
 * map it writes (a mixed Swift and Objective-C target), so a synthesized map that gives way takes its folder with it. A module in `unwritten`, whose importer map Swift Build has not written yet (the
 * precheck drops that map from the command), keeps its synthesized map and folder.
 */
function moduleMaps(i: PrecheckInputs, unwritten: ReadonlySet<string>): ModuleMaps {
  const synthesized = new Set(i.graph.synthesized.map((s) => s.module));
  const onDisk = new Set(i.graph.modules.filter((m) => !synthesized.has(m)));
  const importer = i.app.pkg.expo?.clangImporter?.moduleMaps ?? [];
  const shadowed = new Set(importer.filter((m) => onDisk.has(importerModule(m))));
  const swiftBuilds = new Set(importer.filter((m) => !shadowed.has(m)).map(importerModule).filter((m) => !unwritten.has(m)));
  const gaveWay = i.graph.synthesized.filter((s) => swiftBuilds.has(s.module));
  return {
    maps: [
      ...i.graph.moduleMaps,
      ...i.graph.synthesized.filter((s) => !swiftBuilds.has(s.module)).map((s) => synthesizedModuleMap(i.dir, s.module)),
    ],
    shadowed,
    folders: new Set(gaveWay.flatMap((s) => synthesizedFolder(i.graph.headerDirs, s.text) ?? [])),
  };
}

/** `args` without the `-fmodule-map-file=` of each of `maps`, and the `-Xcc` before it. */
function withoutMaps(args: string[], maps: Set<string>): string[] {
  const kept: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-fmodule-map-file=") && maps.has(arg.slice("-fmodule-map-file=".length))) {
      if (kept.at(-1) === "-Xcc") kept.pop();
      continue;
    }
    kept.push(arg);
  }
  return kept;
}

/**
 * `args` with Swift Build's header folder moved to the precheck's wherever a path starts with it: an element of its
 * own, or after a flag joined to it (`-I<folder>`, `-fmodule-map-file=<folder>/X.modulemap`).
 */
function withPrecheckHeaders(i: PrecheckInputs, args: string[]): string[] {
  const from = i.app.pkg.app.swiftHeadersDir;
  const to = swiftHeaders(i);
  return args.map((arg) => {
    const at = arg.indexOf(from);
    if (at < 0) return arg;
    const flag = arg.slice(0, at);
    const rest = arg.slice(at + from.length);
    const isPath = /^(-[A-Za-z][\w-]*=?)?$/.test(flag) && (rest === "" || rest.startsWith("/"));
    return isPath ? `${flag}${to}${rest}` : arg;
  });
}

/** The App target's include folders, Swift Build's header folder replaced by the precheck's, then the graph's. */
export function precheckIncludeDirs(i: PrecheckInputs): string[] {
  return [...withPrecheckHeaders(i, appIncludeDirs(i.app.pkg.app, i.app.pkg.expo)), ...i.graph.headerDirs];
}

type Language = "objective-c" | "objective-c++" | "c" | "c++";

const LANGUAGES: Record<string, Language> = {
  ".m": "objective-c",
  ".mm": "objective-c++",
  ".c": "c",
  ".cc": "c++",
  ".cpp": "c++",
  ".cxx": "c++",
  ".h": "objective-c",
};

function languageOf(file: string): Language {
  const language = LANGUAGES[path.extname(file).toLowerCase()];
  if (language === undefined) throw new Error(`precheck: no clang language for ${file}`);
  return language;
}

/**
 * What Swift Build defines for a package target in a Debug build, besides the manifest's own settings: Swift's
 * conditions, its clang importer's macros, and a C-family file's macros (C++ adds libc++'s hardening mode).
 */
const SWIFT_BUILD_DEFINES = {
  swift: ["SWIFT_PACKAGE", "DEBUG", "SWIFT_MODULE_RESOURCE_BUNDLE_UNAVAILABLE", "Xcode"],
  importer: ["SWIFT_PACKAGE", "DEBUG=1", "_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG"],
  clang: ["SWIFT_PACKAGE", "DEBUG=1", "OBJC_OLD_DISPATCH_PROTOTYPES=1", "Xcode"],
  cxx: ["_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG"],
};

/** What `appSwiftArgs` gives Swift's clang importer: its `-F <folder>` pairs and the values after each `-Xcc`. */
function importerArgs(args: string[]): string[] {
  return args.flatMap((a, n) => {
    if (n === 0) return [];
    if (args[n - 1] === "-F") return ["-F", a];
    return args[n - 1] === "-Xcc" ? [a] : [];
  });
}

/**
 * `clang -fsyntax-only` of one C-family file, as Swift Build compiles it in the App target. A target without C-family
 * sources has no `appClangArgs`: its one C-family file, the bridging header, gets what Swift's clang importer gets
 * (Swift Build's importer macros, the `-F` frameworks and the `-Xcc` values).
 */
export function clangArgs(i: PrecheckInputs, file: string, unwritten: ReadonlySet<string> = new Set()): string[] {
  const language = languageOf(file);
  const objc = language === "objective-c" || language === "objective-c++";
  const cxx = language === "c++" || language === "objective-c++";
  const { app, expo } = i.app.pkg;
  const target = app.mixed ? appClangArgs(app, expo, cxx) : importerArgs(appSwiftArgs(app, expo));
  const defines = app.mixed ? [...SWIFT_BUILD_DEFINES.clang, ...(cxx ? SWIFT_BUILD_DEFINES.cxx : [])] : SWIFT_BUILD_DEFINES.importer;
  const maps = moduleMaps(i, unwritten);
  return [
    "-fsyntax-only",
    "-x",
    language,
    "-target",
    TARGET,
    "-isysroot",
    i.toolchain.sdk,
    ...developerFrameworks(i.toolchain.sdk).flatMap((d) => ["-iframework", d]),
    ...(objc ? ["-fobjc-arc"] : []),
    "-fmodules",
    // A file of the App target, as Swift Build compiles one; the bridging header is the importer's, which has none.
    ...(app.mixed ? ["-fmodule-name=App"] : []),
    // With C++ modules off the cache is unused, and clang warns about the flag.
    ...(cxx ? ["-fno-cxx-modules"] : [`-fmodules-cache-path=${i.moduleCache}`]),
    ...defines.map((d) => `-D${d}`),
    ...withPrecheckHeaders(i, withoutMaps(target, maps.shadowed)),
    ...i.graph.headerDirs.filter((d) => !maps.folders.has(d)).flatMap((d) => ["-I", d]),
    ...maps.maps.map((m) => `-fmodule-map-file=${m}`),
    file,
  ];
}

/**
 * `swiftc -typecheck` of the App's Swift files, writing `App-Swift.h` to the precheck's header folder. App is a library
 * target (the precheck refuses an executable one), which Swift Build compiles with `-parse-as-library`: without it a
 * one-file module's file is its main file, where an `@main` type is an error. The clang importer gets Swift Build's
 * macros (`DEBUG=1`: React Native's headers hide their debug API without it) and, in a mixed target, the App's own,
 * which the manifest's `cSettings` give Swift Build; a Swift-only target has them only with its bridging header.
 */
export function swiftcArgs(i: PrecheckInputs, files: string[], unwritten: ReadonlySet<string> = new Set()): string[] {
  const { app, expo } = i.app.pkg;
  const maps = moduleMaps(i, unwritten);
  return [
    "-typecheck",
    "-parse-as-library",
    "-module-name",
    "App",
    "-target",
    TARGET,
    "-sdk",
    i.toolchain.sdk,
    "-resource-dir",
    i.toolchain.swiftResources,
    // The importer's clang headers, as Swift Build names them: the Swift resources' own.
    "-Xcc",
    "-resource-dir",
    "-Xcc",
    path.join(i.toolchain.swiftResources, "clang"),
    ...i.toolchain.swiftIncludes.flatMap((d) => ["-Isystem", d]),
    ...developerFrameworks(i.toolchain.sdk).flatMap((d) => ["-F", d]),
    "-package-name",
    packageName(i),
    // Swift Build's Debug feature: `@DebugDescription` expands.
    "-enable-experimental-feature",
    "DebugDescriptionMacro",
    "-swift-version",
    "5",
    "-module-cache-path",
    i.moduleCache,
    "-emit-objc-header-path",
    path.join(swiftHeaders(i), "App-Swift.h"),
    ...i.toolchain.swiftExtra,
    ...SWIFT_BUILD_DEFINES.swift.map((d) => `-D${d}`),
    ...[...new Set([...SWIFT_BUILD_DEFINES.importer, ...(app.mixed ? app.defines : [])])].flatMap((d) => ["-Xcc", `-D${d}`]),
    ...withPrecheckHeaders(i, withoutMaps(appSwiftArgs(app, expo), maps.shadowed)),
    // The importer's only: Swift Build gives Swift no search path for a clang target's headers.
    ...i.graph.headerDirs.filter((d) => !maps.folders.has(d)).flatMap((d) => ["-Xcc", `-I${d}`]),
    ...maps.maps.flatMap((m) => ["-Xcc", `-fmodule-map-file=${m}`]),
    ...files,
  ];
}
