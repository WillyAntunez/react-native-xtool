import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { sdkBundle } from "../commands/setup.js";
import type { GeneratedApp } from "../generate/iosXtool.js";
import { appClangArgs, appIncludeDirs, appSwiftArgs } from "../generate/packageSwift.js";
import { toolEnv } from "../tools/exec.js";
import { IOS_MIN } from "../versions.js";
import type { PrecheckGraph } from "./precheckGraph.js";
import { PrecheckError } from "./precheckReport.js";

/** The compilers and the iPhoneOS SDK `xtool dev build` uses, as the precheck runs them. */
export interface PrecheckToolchain {
  clang: string;
  swiftc: string;
  /** The iPhoneOS SDK root of the Darwin SDK bundle. */
  sdk: string;
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
  const triple = (readJson(sdkJson) as { targetTriples?: Record<string, { sdkRootPath?: unknown; toolsetPaths?: unknown }> } | undefined)
    ?.targetTriples?.[IOS_TRIPLE];
  if (typeof triple?.sdkRootPath !== "string") throw notFound(sdkJson);
  const sdk = path.resolve(bundle, triple.sdkRootPath);
  if (!existsSync(sdk)) throw notFound(sdk);

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
  return { clang, swiftc, sdk, swiftExtra, versions };
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

/** Where the precheck's `swiftc` writes `App-Swift.h`, in place of Swift Build's folder. */
const swiftHeaders = (i: PrecheckInputs): string => path.join(i.dir, "swift-headers");

/** Where the precheck writes the module map SwiftPM synthesizes for `module`. */
export function synthesizedModuleMap(dir: string, module: string): string {
  return path.join(dir, "modulemaps", module, "module.modulemap");
}

/** The graph's module maps on disk, then the synthesized ones. */
const moduleMaps = (i: PrecheckInputs): string[] => [
  ...i.graph.moduleMaps,
  ...i.graph.synthesized.map((s) => synthesizedModuleMap(i.dir, s.module)),
];

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

/** The values `appSwiftArgs` passes to Swift's clang importer (each after `-Xcc`). */
function xccValues(args: string[]): string[] {
  return args.flatMap((a, n) => (n > 0 && args[n - 1] === "-Xcc" ? [a] : []));
}

/**
 * `clang -fsyntax-only` of one C-family file, as Swift Build compiles it in the App target. A target without C-family
 * sources has no `appClangArgs`: its one C-family file, the bridging header, gets what Swift's clang importer gets.
 */
export function clangArgs(i: PrecheckInputs, file: string): string[] {
  const language = languageOf(file);
  const objc = language === "objective-c" || language === "objective-c++";
  const cxx = language === "c++" || language === "objective-c++";
  const { app, expo } = i.app.pkg;
  const target = app.mixed ? appClangArgs(app, expo, cxx) : xccValues(appSwiftArgs(app, expo));
  return [
    "-fsyntax-only",
    "-x",
    language,
    "-target",
    TARGET,
    "-isysroot",
    i.toolchain.sdk,
    ...(objc ? ["-fobjc-arc"] : []),
    "-fmodules",
    ...(cxx ? ["-fno-cxx-modules"] : []),
    `-fmodules-cache-path=${i.moduleCache}`,
    "-DDEBUG=1",
    ...withPrecheckHeaders(i, target),
    ...i.graph.headerDirs.flatMap((d) => ["-I", d]),
    ...moduleMaps(i).map((m) => `-fmodule-map-file=${m}`),
    file,
  ];
}

/** `swiftc -typecheck` of the App's Swift files, writing `App-Swift.h` to the precheck's header folder. */
export function swiftcArgs(i: PrecheckInputs, files: string[]): string[] {
  const { app, expo } = i.app.pkg;
  return [
    "-typecheck",
    "-module-name",
    "App",
    "-target",
    TARGET,
    "-sdk",
    i.toolchain.sdk,
    "-swift-version",
    "5",
    "-module-cache-path",
    i.moduleCache,
    "-emit-objc-header-path",
    path.join(swiftHeaders(i), "App-Swift.h"),
    ...i.toolchain.swiftExtra,
    ...withPrecheckHeaders(i, appSwiftArgs(app, expo)),
    ...i.graph.headerDirs.flatMap((d) => ["-I", d, "-Xcc", `-I${d}`]),
    ...moduleMaps(i).flatMap((m) => ["-Xcc", `-fmodule-map-file=${m}`]),
    ...files,
  ];
}
