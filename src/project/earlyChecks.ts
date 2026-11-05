/**
 * Setups rn-xtool cannot build yet, found before the build starts: `doctor --project` names them and `build` stops on
 * them, instead of failing minutes later inside rn-spm or SwiftPM. Every check reads files only. Nothing installed in
 * the project is run or `require`d; the only code loaded is rn-xtool's own vendored copies of the Expo plugin's readers
 * and of React Native's scaffolder (its pod classifier).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { PodEntry } from "../config.js";
import { troubleshootingUrl } from "../docs.js";
import { packageRoot } from "../tools/exec.js";
import { mergedPodTable, type PodTable } from "./podTable.js";
import { attribute, dependencyDirs, podDependencies, podspecFiles, unconditionalLines } from "./podspecs.js";

export type EarlyCheckId = "vendored-binaries" | "vendored-sources" | "unmapped-pod" | "pnpm" | "yarn-pnp" | "hoisted";

export interface EarlyFailure {
  id: EarlyCheckId;
  /** The `knownLimits.allow` entry that lets it through: the package's name, or "pnpm", "pnp" or "hoisted". */
  allowKey: string;
  reason: string;
  /** Set when rn-xtool.config.json's `knownLimits.allow` names `allowKey`: a warning, not a refusal. */
  allowed?: true;
}

/** The sentence every refusal ends with: how to build anyway. */
export function knownLimitHint(f: EarlyFailure): string {
  return `To build anyway, add "${f.allowKey}" to knownLimits.allow in rn-xtool.config.json.`;
}

/** A refusal: its reason (which ends with the docs link), then how to build anyway on its own line after `indent`. */
export function refusalText(f: EarlyFailure, indent = ""): string {
  return `${f.reason}\n${indent}${knownLimitHint(f)}`;
}

/** An allowed refusal as doctor's and build's warning reads it. */
export function allowedLimitText(f: EarlyFailure): string {
  return `${f.reason} (allowed by rn-xtool.config.json knownLimits.allow; the build may fail later)`;
}

/** `failures`, those whose `allowKey` `allow` names marked allowed. Entries that name no failure are ignored. */
export function allowKnownLimits(failures: readonly EarlyFailure[], allow: readonly string[]): EarlyFailure[] {
  const names = new Set(allow);
  return failures.map((f) => (names.has(f.allowKey) ? { ...f, allowed: true } : f));
}

/** `build` stops with it before reading the project: one failure reads as its reason, several as a list. */
export class UnsupportedSetupError extends Error {
  readonly failures: readonly EarlyFailure[];

  constructor(failures: readonly EarlyFailure[]) {
    super(
      failures.length === 1
        ? refusalText(failures[0]!)
        : `rn-xtool cannot build this project yet:\n${failures.map((f) => `- ${refusalText(f, "  ")}`).join("\n")}`,
    );
    this.name = "UnsupportedSetupError";
    this.failures = failures;
  }
}

/** The vendored Expo plugin's podspec and source-tree readers (vendor/expo-spm/spm), the ones `sourceLayout` uses. */
interface ExpoSpmReaders {
  sourceFacts(text: string): { referencesVendor: boolean };
  walkSourceTree(dir: string): { files: string[] };
}

function expoSpmReaders(): ExpoSpmReaders {
  const require = createRequire(import.meta.url);
  const spm = path.join(packageRoot(), "vendor", "expo-spm", "spm");
  const { sourceFacts } = require(path.join(spm, "podspec.js")) as Pick<ExpoSpmReaders, "sourceFacts">;
  const { walkSourceTree } = require(path.join(spm, "classify.js")) as Pick<ExpoSpmReaders, "walkSourceTree">;
  return { sourceFacts, walkSourceTree };
}

/** What the scaffolder makes of a podspec's `s.dependency` (classifyPodDependency in scaffold-package-swift.js). */
interface PodClassification {
  kind: "subspec" | "core" | "expo" | "sibling" | "missing-sibling" | "mapped" | "unmapped";
  /** The name before any `/<subspec>`. */
  pod: string;
}

type ClassifyPodDependency = (
  depName: string,
  ctx: {
    selfPodName: string | null;
    ownNpm: string;
    podToNpm: Map<string, string>;
    linkedNpm: Set<string>;
    table: Record<string, PodEntry>;
  },
) => PodClassification;

/** rn-xtool's vendored scaffolder's classifier, the one the build's scaffold runs: never the project's copy. */
function podClassifier(): ClassifyPodDependency {
  const file = path.join(packageRoot(), "vendor", "rn-spm", "spm", "scaffold-package-swift.js");
  return (createRequire(import.meta.url)(file) as { classifyPodDependency: ClassifyPodDependency }).classifyPodDependency;
}

function readJson(file: string): Record<string, any> | undefined {
  try {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"));
    return json !== null && typeof json === "object" ? (json as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Markers of the manifests rn-xtool's pipeline writes into a library: such a Package.swift is not the library's own. */
const GENERATED_MANIFEST_MARKERS = [
  "AUTO-SCAFFOLDED by react-native spm scaffold",
  "AUTO-GENERATED by scripts/generate-spm-autolinking.js",
];

/**
 * Whether a Package.swift is the library's own: one the library ships or the user wrote, or one rn-xtool scaffolded
 * that the user then edited. A scaffold is taken as edited when it declares a `.binaryTarget(`, which the scaffolder
 * never writes and which linking the library's prebuilt binaries needs. An unedited scaffold counts as none.
 */
function isOwnManifest(text: string): boolean {
  if (!GENERATED_MANIFEST_MARKERS.some((marker) => text.includes(marker))) return true;
  return /\.binaryTarget\s*\(/.test(text);
}

/**
 * The Package.swift files the project's `patches/<pkg>+*.patch` create in `pkg` (at `rels`, relative to the package),
 * as text: patch-package applies them in the build's patches step, so a fresh install has them only after it.
 */
function patchedManifests(root: string, pkg: string, rels: readonly string[]): string[] {
  const dir = path.join(root, "patches");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(`${pkg.replace("/", "+")}+`) && n.endsWith(".patch"));
  } catch {
    return [];
  }
  const targets = new Set(rels.map((rel) => `+++ b/node_modules/${pkg}/${rel}`));
  return names.flatMap((name) => {
    const text = readText(path.join(dir, name)) ?? "";
    return text.split(/^diff --git /m).flatMap((section) => {
      const lines = section.split("\n");
      const created = lines.includes("--- /dev/null") && lines.some((l) => targets.has(l.trimEnd()));
      if (!created) return [];
      const hunk = lines.findIndex((l) => l.startsWith("@@"));
      return [lines.slice(hunk + 1).filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n")];
    });
  });
}

/**
 * Whether the package `name` at `dir` has a manifest of its own at one of `rels`: in node_modules, or created by the
 * project's patches/ (so `doctor --project`, which applies nothing, agrees with a build that has applied them).
 */
function hasOwnManifest(root: string, name: string, dir: string, rels: readonly string[]): boolean {
  const texts = [
    ...rels.flatMap((rel) => {
      const text = readText(path.join(dir, rel));
      return text === undefined ? [] : [text];
    }),
    ...patchedManifests(root, name, rels),
  ];
  return texts.some(isOwnManifest);
}

const LIBRARY_MANIFESTS = ["Package.swift", "ios/Package.swift"] as const;
/** The Expo plugin builds a module from its own manifest only at the module root. */
const EXPO_MODULE_MANIFESTS = ["Package.swift"] as const;

/** An Expo module for Apple platforms: autolinked and built by the Expo plugin, not by rn-xtool's scaffolder. */
function isAppleExpoModule(dir: string): boolean {
  const platforms: unknown = readJson(path.join(dir, "expo-module.config.json"))?.platforms;
  return Array.isArray(platforms) && platforms.some((p) => p === "apple" || p === "ios");
}

/** Whether expo-modules' prebuilds ship a precompiled XCFramework of the module for either flavor. */
function hasPrebuilds(dir: string): boolean {
  return ["debug", "release"].some((flavor) => {
    try {
      return readdirSync(path.join(dir, "prebuilds", "output", flavor, "xcframeworks")).some((n) => n.endsWith(".tar.gz"));
    } catch {
      return false;
    }
  });
}

const VENDORED_FRAMEWORKS = attribute("vendored_frameworks?");
const VENDORED_LIBRARIES = attribute("vendored_librar(?:y|ies)");
const C_FAMILY_SOURCE = /\.(m|mm|c|cpp|cc)$/;

/** "a, b, c and 2 more" */
function firstThree(items: string[]): string {
  const shown = items.slice(0, 3).join(", ");
  return items.length > 3 ? `${shown} and ${items.length - 3} more` : shown;
}

interface Podspec {
  /** Relative to the package directory. */
  rel: string;
  text: string;
}

function binariesFailure(name: string, version: string, podspecs: Podspec[]): EarlyFailure | undefined {
  for (const { rel, text } of podspecs) {
    const lines = unconditionalLines(text);
    const attrs = [
      ...(lines.some((l) => VENDORED_FRAMEWORKS.test(l)) ? ["vendored_frameworks"] : []),
      ...(lines.some((l) => VENDORED_LIBRARIES.test(l)) ? ["vendored_libraries"] : []),
    ];
    if (attrs.length === 0) continue;
    return {
      id: "vendored-binaries",
      allowKey: name,
      reason:
        `${name} ${version}: its podspec (${rel}) declares ${attrs.join(" and ")} and the package ships no Package.swift, ` +
        "so rn-xtool would have to scaffold it, and it cannot link prebuilt binaries yet. " +
        `See ${troubleshootingUrl("libraries-with-prebuilt-binaries")}`,
    };
  }
  return undefined;
}

function sourcesFailure(name: string, version: string, dir: string, podspecs: Podspec[], readers: ExpoSpmReaders): EarlyFailure | undefined {
  const podspec = podspecs.find(({ text }) => readers.sourceFacts(text).referencesVendor);
  if (podspec === undefined) return undefined;
  const files = readers
    .walkSourceTree(path.join(dir, "vendor"))
    .files.filter((file) => C_FAMILY_SOURCE.test(file))
    .map((file) => path.relative(dir, file))
    .sort();
  if (files.length === 0) return undefined;
  return {
    id: "vendored-sources",
    allowKey: name,
    reason:
      `${name} ${version}: its podspec (${podspec.rel}) builds C sources from vendor/ (${firstThree(files)}) and the ` +
      "package ships no Package.swift; rn-xtool cannot build vendored C sources yet. " +
      `See ${troubleshootingUrl("libraries-that-build-vendored-c-sources")}`,
  };
}

/** The value of `react-native.config.js`'s entry for `pkg` (balanced braces), read as text; undefined without one. */
function rnConfigEntry(code: string, pkg: string): string | undefined {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const bare = /^[A-Za-z_$][\w$]*$/.test(pkg) ? `|(?<![\\w$])${esc}(?![\\w$])` : "";
  const key = new RegExp(`(?:(["'\`])${esc}\\1${bare})\\s*:\\s*\\{`).exec(code);
  if (key === null) return undefined;
  const start = key.index + key[0].length - 1;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  return code.slice(start);
}

const RN_CONFIG_FILES = ["react-native.config.js", "react-native.config.cjs", "react-native.config.mjs", "react-native.config.ts"];

/**
 * The dependencies the project takes out of iOS autolinking, read as text and JSON (no project code runs):
 * `react-native.config.js`'s `dependencies.<pkg>.platforms.ios: null`, and `expo.autolinking.exclude` (also under
 * `ios` or `apple`) in package.json and app.json.
 */
function iosExcluded(root: string): (pkg: string) => boolean {
  const rnConfig = RN_CONFIG_FILES.map((f) => readText(path.join(root, f)))
    .filter((t): t is string => t !== undefined)
    .map((t) =>
      t
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/([,{[\s])\/\/.*$/gm, "$1"),
    );
  const appJson = readJson(path.join(root, "app.json"));
  const autolinking = [readJson(path.join(root, "package.json"))?.expo?.autolinking, (appJson?.expo ?? appJson)?.autolinking];
  const expoExcluded = new Set(
    autolinking.flatMap((a) =>
      [a?.exclude, a?.ios?.exclude, a?.apple?.exclude].flatMap((list: unknown) =>
        Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [],
      ),
    ),
  );
  return (pkg) =>
    expoExcluded.has(pkg) ||
    rnConfig.some((code) => {
      const entry = rnConfigEntry(code, pkg);
      return entry !== undefined && /(?<![\w$])(["']?)ios\1\s*:\s*null\b/.test(entry);
    });
}

/** What the library checks read besides the project. */
export interface LibraryCheckOptions {
  /** The config's `pods`, merged over rn-xtool's table (`mergedPodTable`). */
  pods?: Record<string, PodEntry>;
  /** Packages the config leaves out of the iOS build: skipped, like those taken out of iOS autolinking. */
  exclude?: readonly string[];
  /** The pod table to classify with, instead of `mergedPodTable(pods)` (a test seam). */
  table?: PodTable;
}

/** A dependency with podspecs: its name, folder, version and podspec texts. */
interface Library {
  name: string;
  dir: string;
  version: string;
  podspecs: Podspec[];
  /** An Expo module (it has an expo-module.config.json): the Expo plugin builds it, not rn-xtool's scaffolder. */
  expoModule: boolean;
}

/** The project's direct dependencies, read once for every library check. */
class Libraries {
  readonly root: string;
  readonly deps: { name: string; dir: string }[];
  private readonly excluded: (pkg: string) => boolean;
  private readonly opts: LibraryCheckOptions;
  private podIndex?: { podToNpm: Map<string, string>; linkedNpm: Set<string> };
  private podTable?: PodTable;
  private classifier?: ClassifyPodDependency;

  constructor(root: string, opts: LibraryCheckOptions) {
    this.root = root;
    this.opts = opts;
    this.deps = dependencyDirs(root);
    const autolinking = iosExcluded(root);
    const config = new Set(opts.exclude ?? []);
    this.excluded = (pkg) => config.has(pkg) || autolinking(pkg);
  }

  /** The dependency at `dir` with its readable podspecs; undefined without one, or when the project leaves it out of iOS. */
  library(name: string, dir: string): Library | undefined {
    const podspecs = podspecFiles(dir).flatMap((file) => {
      const text = readText(file);
      return text === undefined ? [] : [{ rel: path.relative(dir, file), text }];
    });
    if (podspecs.length === 0 || this.excluded(name)) return undefined;
    const pkg = readJson(path.join(dir, "package.json"));
    const version = typeof pkg?.version === "string" ? pkg.version : "unknown";
    return { name, dir, version, podspecs, expoModule: existsSync(path.join(dir, "expo-module.config.json")) };
  }

  /**
   * Whether rn-xtool's scaffolder would write the library's Package.swift: not an Expo module, no
   * `swiftpmConfig.scaffold: false`, and no manifest of its own (a Package.swift the project's patches/ create counts).
   */
  scaffolded(lib: Library): boolean {
    if (lib.expoModule) return false;
    if (readJson(path.join(lib.dir, "package.json"))?.swiftpmConfig?.scaffold === false) return false;
    return !hasOwnManifest(this.root, lib.name, lib.dir, LIBRARY_MANIFESTS);
  }

  /**
   * Each pod dependency on the unconditional lines of the library's podspecs, as the scaffolder classifies it: the
   * pod-name index covers every direct dependency's podspecs (those left out of iOS too), and the linked packages are the
   * dependencies with a podspec or a Package.swift that the project keeps on iOS.
   */
  podDependencies(lib: Library): (PodClassification & { name: string; requirements: string[] })[] {
    const classify = (this.classifier ??= podClassifier());
    const table = this.table();
    const { podToNpm, linkedNpm } = (this.podIndex ??= this.index());
    return lib.podspecs.flatMap(({ rel, text }) => {
      const source = unconditionalLines(text, "source");
      const literal = source
        .map((line) => /^\s*[A-Za-z_]\w*\.name\s*=\s*(["'])([\w.+-]+)\1\s*(?:#.*)?$/.exec(line)?.[2])
        .find((n) => n !== undefined);
      const selfPodName = literal ?? path.basename(rel, ".podspec");
      return podDependencies(source).map((dep) => ({
        ...dep,
        ...classify(dep.name, { selfPodName, ownNpm: lib.name, podToNpm, linkedNpm, table: table.pods }),
      }));
    });
  }

  /** The pod table the checks classify with. */
  table(): PodTable {
    return (this.podTable ??= this.opts.table ?? mergedPodTable(this.opts.pods));
  }

  private index(): { podToNpm: Map<string, string>; linkedNpm: Set<string> } {
    const podToNpm = new Map<string, string>();
    const linkedNpm = new Set<string>();
    for (const { name, dir } of this.deps) {
      const podspecs = podspecFiles(dir).filter((file) => existsSync(file));
      for (const file of podspecs) podToNpm.set(path.basename(file, ".podspec"), name);
      const manifest = LIBRARY_MANIFESTS.some((rel) => existsSync(path.join(dir, rel)));
      if ((podspecs.length > 0 || manifest) && !this.excluded(name)) linkedNpm.add(name);
    }
    return { podToNpm, linkedNpm };
  }
}

/** "a", "a and b", "a, b and c" */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function unmappedFailure(libs: Libraries, lib: Library): EarlyFailure | undefined {
  const pods: string[] = [];
  for (const dep of libs.podDependencies(lib)) if (dep.kind === "unmapped" && !pods.includes(dep.pod)) pods.push(dep.pod);
  if (pods.length === 0) return undefined;
  const several = pods.length > 1;
  const snippet = `{ "pods": { "${pods[0]}": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }`;
  return {
    id: "unmapped-pod",
    allowKey: lib.name,
    reason:
      `${lib.name} ${lib.version}: its podspec depends on the CocoaPods ${several ? "pods" : "pod"} ${andList(pods)}, ` +
      `which ${several ? "have" : "has"} no SwiftPM package rn-xtool knows. Add ${several ? "them" : "one"} under "pods" ` +
      `in rn-xtool.config.json: ${snippet}, or leave the library out with "exclude". ` +
      `See ${troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")}`,
  };
}

/**
 * The project's dependencies rn-xtool cannot build, by name:
 * - a CocoaPods-only library rn-xtool would scaffold whose podspec declares prebuilt binaries (packages with an
 *   expo-module.config.json are left out: the Expo plugin links their binaries);
 * - the same kind of library depending, on an unconditional podspec line, on a CocoaPods pod the pod table does not map
 *   (one failure per library, naming every such pod);
 * - an Expo module that builds C sources from its vendor/ folder without a Package.swift or prebuilds.
 * A Package.swift the project's patches/ create counts, and so does a scaffold the user edited. Dependencies the
 * project takes out of iOS autolinking or the config leaves out (`exclude`), binaries and pods under a test spec or a
 * Ruby condition, and other unsupported shapes pass here (the last fail in the build). Never throws; [] without a
 * readable package.json.
 */
export function libraryFailures(projectRoot: string, opts: LibraryCheckOptions = {}): EarlyFailure[] {
  let libs: Libraries;
  try {
    libs = new Libraries(path.resolve(projectRoot), opts);
  } catch {
    return [];
  }
  let readers: ExpoSpmReaders | undefined;
  const failuresOf = (name: string, dir: string): (EarlyFailure | undefined)[] => {
    const lib = libs.library(name, dir);
    if (lib === undefined) return [];
    if (lib.expoModule) {
      if (!isAppleExpoModule(dir) || hasPrebuilds(dir) || hasOwnManifest(libs.root, name, dir, EXPO_MODULE_MANIFESTS)) return [];
      return [sourcesFailure(name, lib.version, dir, lib.podspecs, (readers ??= expoSpmReaders()))];
    }
    if (!libs.scaffolded(lib)) return [];
    // Each check on its own: an unreadable pod table says nothing about the binaries.
    return [
      settled(() => binariesFailure(name, lib.version, lib.podspecs), undefined),
      settled(() => unmappedFailure(libs, lib), undefined),
    ];
  };
  return libs.deps.flatMap(({ name, dir }) => {
    try {
      return failuresOf(name, dir).filter((f): f is EarlyFailure => f !== undefined);
    } catch {
      // One unreadable package says nothing about the others; the build reports it if it matters.
      return [];
    }
  });
}

/** Where the parent-folder lookup stops (inclusive); `/` by default. Tests pass their own temp folder. */
export interface LookupOptions {
  stopAt?: string;
}

/** `root`, then each parent folder up to `stopAt` (when it is one of them) or `/`. */
function upFrom(root: string, stopAt?: string): string[] {
  const top = stopAt === undefined ? undefined : path.resolve(stopAt);
  const dirs = [root];
  for (let dir = root; dir !== top && path.dirname(dir) !== dir; dir = path.dirname(dir)) dirs.push(path.dirname(dir));
  return dirs;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether pnpm installed the root with the hoisted node linker (a flat node_modules of real folders). The install's own
 * record (`node_modules/.modules.yaml`) wins; without one, `node-linker=hoisted` in `.npmrc` or `nodeLinker: hoisted`
 * in `pnpm-workspace.yaml`.
 */
function pnpmHoisted(root: string): boolean {
  const recorded = /^\s*"?nodeLinker"?\s*:\s*["']?([\w-]+)/m.exec(readText(path.join(root, "node_modules", ".modules.yaml")) ?? "")?.[1];
  if (recorded !== undefined) return recorded === "hoisted";
  return (
    /^\s*node-linker\s*=\s*hoisted\s*$/m.test(readText(path.join(root, ".npmrc")) ?? "") ||
    /^\s*nodeLinker\s*:\s*["']?hoisted["']?\s*(?:#.*)?$/m.test(readText(path.join(root, "pnpm-workspace.yaml")) ?? "")
  );
}

/**
 * A pnpm install of the project itself: its lockfile and its `node_modules/.pnpm` store in the root, not under the
 * hoisted node linker. Parent folders are not read: a workspace's or a stray home-folder lockfile says nothing about
 * how this project was installed.
 */
function pnpmFailure(root: string): EarlyFailure | undefined {
  if (!existsSync(path.join(root, "pnpm-lock.yaml"))) return undefined;
  if (!isDirectory(path.join(root, "node_modules", ".pnpm")) || pnpmHoisted(root)) return undefined;
  return {
    id: "pnpm",
    allowKey: "pnpm",
    reason:
      "This project was installed with pnpm (pnpm-lock.yaml and a node_modules/.pnpm store); rn-xtool needs " +
      "the flat node_modules that npm or Yarn classic installs. Remove node_modules and install with npm. " +
      `See ${troubleshootingUrl("pnpm-and-yarn-pnp")}`,
  };
}

/** Yarn Plug'n'Play in the project itself: its loader in the root, and no react-native in the root's node_modules. */
function pnpFailure(root: string): EarlyFailure | undefined {
  const pnp = [".pnp.cjs", ".pnp.js"].find((name) => existsSync(path.join(root, name)));
  if (pnp === undefined || existsSync(path.join(root, "node_modules", "react-native", "package.json"))) return undefined;
  return {
    id: "yarn-pnp",
    allowKey: "pnp",
    reason:
      `This project uses Yarn Plug'n'Play (${pnp}); rn-xtool needs a node_modules folder. Add ` +
      `nodeLinker: node-modules to .yarnrc.yml and run yarn install. See ${troubleshootingUrl("pnpm-and-yarn-pnp")}`,
  };
}

const HOISTED_PACKAGES = ["react-native", "expo"] as const;

/**
 * react-native or expo, listed in the root package.json, found first in a parent folder's node_modules instead of the
 * root's own (links are not followed). Node's global folders (NODE_PATH, ~/.node_modules) are not read: a copy there
 * is no workspace's. A package found nowhere is left to the existing errors.
 */
function hoistedFailures(root: string, stopAt?: string): EarlyFailure[] {
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg === undefined) return [];
  const listed = (name: string): boolean =>
    [pkg.dependencies, pkg.devDependencies].some((deps) => deps !== null && typeof deps === "object" && name in deps);
  const own = path.join(root, "node_modules");
  const lookup = upFrom(root, stopAt)
    .filter((dir) => path.basename(dir) !== "node_modules")
    .map((dir) => path.join(dir, "node_modules"));
  return HOISTED_PACKAGES.filter(listed).flatMap((name): EarlyFailure[] => {
    const found = lookup.find((dir) => existsSync(path.join(dir, name, "package.json")));
    if (found === undefined || found === own) return [];
    const rel = path.relative(root, path.join(found, name));
    return [
      {
        id: "hoisted",
        allowKey: "hoisted",
        reason:
          `${name} is installed in ${rel}, outside this project: a workspace hoisted it to a parent folder, and rn-xtool ` +
          `patches and builds only the project's own node_modules/${name}. Install the app outside the workspace, or ` +
          `keep ${name} in the app's node_modules (for example with nohoist). ` +
          `See ${troubleshootingUrl("packages-hoisted-to-a-parent-folder")}`,
      },
    ];
  });
}

/** Each check on its own: one that throws says nothing about the others. */
function settled<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Install layouts rn-xtool cannot read, in this order: pnpm, Yarn Plug'n'Play, react-native or expo hoisted to a
 * parent folder. A layout not listed here passes and fails later. Never throws.
 */
export function installFailures(projectRoot: string, opts: LookupOptions = {}): EarlyFailure[] {
  const root = path.resolve(projectRoot);
  return [
    ...settled(() => [pnpmFailure(root)], []),
    ...settled(() => [pnpFailure(root)], []),
    ...settled(() => hoistedFailures(root, opts.stopAt), []),
  ].filter((f): f is EarlyFailure => f !== undefined);
}

/** Every setup rn-xtool refuses before a build: the install's, then the libraries'. Never throws. */
export function earlyFailures(root: string, opts: LookupOptions & LibraryCheckOptions = {}): EarlyFailure[] {
  const { stopAt, ...library } = opts;
  return [...installFailures(root, stopAt === undefined ? {} : { stopAt }), ...libraryFailures(root, library)];
}
