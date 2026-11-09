import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import xcode from "xcode";
import { DetectError } from "./detect.js";

const APP_PRODUCT_TYPE = "com.apple.product-type.application";

export interface PbxTarget {
  name: string;
  uuid: string;
  productType: string;
}

export interface Pbxproj {
  path: string;
  projectName: string;
  appTarget: PbxTarget;
  targets: PbxTarget[];
  /** The parsed `xcode` project handle. */
  project: any;
}

/**
 * ios/ holds more than one Xcode project, or its project more than one application target: rn-xtool cannot tell which
 * one is the app's. `what` says so relative to the project root (`ios/ holds more than one .xcodeproj (A.xcodeproj,
 * B.xcodeproj)`).
 */
export class AmbiguousProjectError extends DetectError {
  readonly what: string;
  constructor(message: string, what: string) {
    super(message);
    this.name = "AmbiguousProjectError";
    this.what = what;
  }
}

/** Strips one pair of surrounding double quotes. */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function toText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    // An element with whitespace stays one word: re-quote it for the shell-style word split in `shellWords`.
    return value.map((v) => unquote(String(v))).map((v) => (/\s/.test(v) ? `"${v}"` : v)).join(" ");
  }
  return unquote(String(value));
}

/** Entries of a pbxproj section, without the `<uuid>_comment` twins the `xcode` package adds. */
function objects(section: Record<string, any>): [string, any][] {
  return Object.entries(section).filter(([k]) => !k.endsWith("_comment"));
}

export function openPbxproj(iosDir: string): Pbxproj {
  let entries: string[];
  try {
    entries = readdirSync(iosDir);
  } catch {
    throw new DetectError(`${iosDir} does not exist or is not readable`);
  }
  const projects = entries.filter((n) => n.endsWith(".xcodeproj")).sort();
  if (projects.length === 0) throw new DetectError(`${iosDir} has no .xcodeproj`);
  if (projects.length > 1) {
    throw new AmbiguousProjectError(
      `${iosDir} holds more than one .xcodeproj (${projects.join(", ")}); rn-xtool needs exactly one`,
      `ios/ holds more than one .xcodeproj (${projects.join(", ")})`,
    );
  }
  const file = path.join(iosDir, projects[0]!, "project.pbxproj");
  const project = xcode.project(file);
  project.parseSync();
  const targets: PbxTarget[] = objects(project.pbxNativeTargetSection()).map(([uuid, t]) => ({
    uuid,
    name: unquote(String(t.name)),
    productType: unquote(String(t.productType)),
  }));
  const apps = targets.filter((t) => t.productType === APP_PRODUCT_TYPE);
  if (apps.length === 0) {
    throw new DetectError(`${file} has no application target (targets: ${targets.map((t) => t.name).join(", ") || "none"})`);
  }
  if (apps.length > 1) {
    const names = apps.map((t) => t.name).join(", ");
    throw new AmbiguousProjectError(
      `${file} has more than one application target (${names}); rn-xtool needs exactly one`,
      `ios/${projects[0]} has more than one application target (${names})`,
    );
  }
  return { path: file, projectName: projects[0]!.slice(0, -".xcodeproj".length), appTarget: apps[0]!, targets, project };
}

/** The XCBuildConfiguration named `configuration` in the configuration list `listUuid`. */
function buildConfiguration(p: Pbxproj, listUuid: string, configuration: string): any {
  const list = p.project.pbxXCConfigurationList()[listUuid];
  if (!list) return undefined;
  const configs = p.project.pbxXCBuildConfigurationSection();
  for (const ref of list.buildConfigurations as { value: string }[]) {
    const config = configs[ref.value];
    if (config && unquote(String(config.name)) === configuration) return config;
  }
  return undefined;
}

/** The `buildSettings` of `configuration` in the configuration list `listUuid`. */
function configurationSettings(p: Pbxproj, listUuid: string, configuration: string): Record<string, unknown> | undefined {
  return buildConfiguration(p, listUuid, configuration)?.buildSettings;
}

function targetLevel(p: Pbxproj, key: string, configuration: string): string | undefined {
  const target = p.project.pbxNativeTargetSection()[p.appTarget.uuid];
  return toText(configurationSettings(p, target.buildConfigurationList, configuration)?.[key]);
}

function projectLevel(p: Pbxproj, key: string, configuration: string): string | undefined {
  const root = p.project.getFirstProject().firstProject;
  return toText(configurationSettings(p, root.buildConfigurationList, configuration)?.[key]);
}

/** Raw (unresolved) value: the app target's configuration, then the project's. */
export function buildSetting(p: Pbxproj, key: string, configuration = "Debug"): string | undefined {
  return targetLevel(p, key, configuration) ?? projectLevel(p, key, configuration);
}

/** Xcode's `:c99extidentifier`: characters other than letters, digits and `_` become `_`, as does a leading digit. */
function c99Identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_");
}

const REFERENCE = /\$\(([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z0-9]+))?\)/g;

/**
 * Expands `$(NAME)`, `$(NAME:rfc1034identifier)` and `$(NAME:c99extidentifier)` using `lookup`. Any other reference (unknown name, unsupported
 * modifier, or a name `lookup` cannot answer) throws, naming the setting.
 */
export function resolveBuildSettingValue(value: string, lookup: (key: string) => string | undefined): string {
  const out = value.replace(REFERENCE, (whole, name: string, modifier?: string) => {
    if (modifier !== undefined && modifier !== "rfc1034identifier" && modifier !== "c99extidentifier") {
      throw new DetectError(`Unsupported build setting modifier ":${modifier}" in ${whole}`);
    }
    const found = lookup(name);
    if (found === undefined) throw new DetectError(`Cannot resolve build setting $(${name}) in "${value}"`);
    if (modifier === "c99extidentifier") return c99Identifier(found);
    return modifier ? found.replace(/[^A-Za-z0-9-]/g, "-") : found;
  });
  const left = out.match(/\$\(([^)]*)\)/);
  if (left) throw new DetectError(`Cannot resolve build setting $(${left[1]}) in "${value}"`);
  return out;
}

/**
 * The settings Xcode defines itself: TARGET_NAME, PROJECT_NAME, SRCROOT and PROJECT_DIR (the folder of the .xcodeproj,
 * ios/), and CONFIGURATION (the configuration read, Debug by default: rn-xtool builds Debug).
 */
export function builtinSetting(p: Pbxproj, name: string, configuration = "Debug"): string | undefined {
  if (name === "CONFIGURATION") return configuration;
  if (name === "TARGET_NAME") return p.appTarget.name;
  if (name === "PROJECT_NAME") return p.projectName;
  if (name === "SRCROOT" || name === "PROJECT_DIR") return path.dirname(path.dirname(p.path));
  return undefined;
}

/** Resolved value of `key`; see `resolveBuildSettingValue`. `$(inherited)` is the project-level value of the same key (empty at the top of the chain). */
export function resolveSetting(p: Pbxproj, key: string, configuration = "Debug"): string | undefined {
  const builtin = (name: string): string | undefined => builtinSetting(p, name, configuration);
  const expand = (raw: string, k: string, inherited: string, stack: string[]): string =>
    resolveBuildSettingValue(raw, (name) =>
      name === "inherited" ? inherited : (builtin(name) ?? resolveKey(name, [...stack, k])),
    );
  const resolveKey = (k: string, stack: string[]): string | undefined => {
    if (stack.includes(k)) throw new DetectError(`Build setting $(${k}) refers to itself (${[...stack, k].join(" -> ")})`);
    const targetRaw = targetLevel(p, k, configuration);
    const projectRaw = projectLevel(p, k, configuration);
    const inherited = projectRaw === undefined ? "" : expand(projectRaw, k, "", stack).trim();
    return targetRaw === undefined ? (projectRaw === undefined ? undefined : inherited) : expand(targetRaw, k, inherited, stack);
  };
  return resolveKey(key, []);
}

export interface TargetFile {
  absPath: string;
  /** Relative to `ios/`, forward slashes. */
  relPath: string;
}

export interface BareTargetContent {
  swiftSources: TargetFile[];
  cSources: TargetFile[];
  headers: TargetFile[];
  resources: TargetFile[];
  /** storyboard / xcassets / xib: not compiled by the generated project. */
  skippedResources: TargetFile[];
  bridgingHeader?: TargetFile;
  defines: string[];
  /** Absolute paths. */
  headerSearchPaths: string[];
  cxxStandard?: string;
  /** Names of settings that are set but not carried over. */
  ignoredSettings: string[];
  /** The target compiles C-family sources (cSources.length > 0). */
  mixed: boolean;
  /** Xcode's module name for the target (PRODUCT_MODULE_NAME): Objective-C imports `<productModuleName>-Swift.h`. */
  productModuleName: string;
}

interface ResolvedRef {
  uuid: string;
  /** Path relative to `ios/` (or absolute for `<absolute>`); undefined for trees we cannot place (SDKROOT, BUILT_PRODUCTS_DIR...). */
  path?: string;
}

const SWIFT = /\.swift$/i;
const C_SOURCE = /\.(m|mm|c|cc|cxx|cpp)$/i;
const HEADER = /\.(h|hpp)$/i;
const SKIPPED_RESOURCE = /\.(storyboard|xcassets|xib)$/i;
/** Folders of ios/ that hold no app headers: CocoaPods' and build output. */
const NOT_APP_DIRS = new Set(["Pods", "build", "DerivedData"]);
const FRAMEWORK_DIR = /\.(xc)?framework$/i;
const IGNORABLE_FLAGS = ["OTHER_CFLAGS", "OTHER_LDFLAGS", "OTHER_SWIFT_FLAGS"];
/** Flags the template sets that the generated project already provides. */
const BENIGN_FLAGS = new Set(["$(inherited)", "-ObjC", "-lc++"]);

/**
 * SwiftPM's rule (PackageBuilder.swift, `Sources.computeModuleKind`): a target with a compiled source whose lowercased
 * name is `main.<ext>`, one dot, is an executable target. The App target must stay a library: xtool links the app's
 * entry point from the App library product.
 */
const SWIFTPM_MAIN = /^main\.[^.]+$/i;
const MAIN_COPY = "AppMain";

/** The name a compiled C-family source of the app target is copied and compiled under: `main.m` → `AppMain.m`. */
export function compiledName(relPath: string): string {
  const base = path.posix.basename(relPath);
  return SWIFTPM_MAIN.test(base) ? `${MAIN_COPY}${path.posix.extname(base)}` : base;
}

/** Splits a build setting like Xcode: whitespace separates words, `"…"` groups, `\\x` is a literal x. */
function shellWords(value: string): string[] {
  const out: string[] = [];
  let word = "";
  let started = false;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\" && i + 1 < value.length) {
      word += value[++i];
      started = true;
    } else if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(c)) {
      if (started) out.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
}

/** The uuid of a list entry: `{ value, comment }`, or a bare string when the entry has no comment. */
function ref(entry: { value: string } | string): string {
  return typeof entry === "string" ? entry : entry.value;
}

function joinPath(base: string, child: string | undefined): string {
  if (!child) return base;
  return base ? path.posix.join(base, child) : path.posix.normalize(child);
}

/** Walks the group tree from the main group, placing every file reference and recording group paths. */
function walkGroups(objs: Record<string, any>, mainGroup: string) {
  const groups = objs.PBXGroup ?? {};
  const fileRefs = objs.PBXFileReference ?? {};
  const variantGroups = objs.PBXVariantGroup ?? {};
  const syncedGroups = objs.PBXFileSystemSynchronizedRootGroup ?? {};
  const files = new Map<string, string | undefined>();
  /** Xcode 16 synchronized folder uuid -> its path. */
  const folders = new Map<string, string | undefined>();
  /** Variant group uuid -> its child file references. */
  const variants = new Map<string, string[]>();
  const groupPaths = new Map<string, { path: string; name?: string; files: string[] }>();

  const place = (tree: string, own: string | undefined, parent: string | undefined): string | undefined => {
    if (tree === "<absolute>") return own;
    if (tree === "SOURCE_ROOT") return own ?? "";
    if (tree === "<group>") return parent === undefined ? undefined : joinPath(parent, own);
    return undefined;
  };

  const visit = (uuid: string, parent: string | undefined, seen: Set<string>): string[] => {
    if (seen.has(uuid)) return [];
    seen.add(uuid);
    const g = groups[uuid];
    const here = place(unquote(String(g.sourceTree ?? "<group>")), g.path === undefined ? undefined : unquote(String(g.path)), parent);
    const collected: string[] = [];
    const placeRef = (uuid: string, tree: string, parentPath: string | undefined) => {
      const f = fileRefs[uuid];
      files.set(uuid, parentPath === undefined ? undefined : place(unquote(String(f.sourceTree ?? tree)), f.path === undefined ? undefined : unquote(String(f.path)), parentPath));
    };
    for (const entry of (g.children ?? []) as ({ value: string } | string)[]) {
      const child = { value: ref(entry) };
      if (variantGroups[child.value]) {
        const v = variantGroups[child.value];
        const vhere = here === undefined ? undefined : place(unquote(String(v.sourceTree ?? "<group>")), v.path === undefined ? undefined : unquote(String(v.path)), here);
        const kids = ((v.children ?? []) as ({ value: string } | string)[]).map(ref).filter((c) => fileRefs[c]);
        for (const k of kids) placeRef(k, "<group>", vhere);
        variants.set(child.value, kids);
      } else if (groups[child.value]) {
        collected.push(...visit(child.value, here, seen));
      } else if (fileRefs[child.value]) {
        placeRef(child.value, "<group>", here);
        collected.push(child.value);
      } else if (syncedGroups[child.value]) {
        const s = syncedGroups[child.value];
        folders.set(child.value, here === undefined ? undefined : place(unquote(String(s.sourceTree ?? "<group>")), s.path === undefined ? undefined : unquote(String(s.path)), here));
      }
    }
    groupPaths.set(uuid, { path: here ?? "", name: g.name === undefined ? undefined : unquote(String(g.name)), files: collected });
    return collected;
  };
  visit(mainGroup, "", new Set());
  return { files, groupPaths, variants, folders };
}

function phaseFiles(objs: Record<string, any>, target: any, section: string, variants: Map<string, string[]>): string[] {
  const phases = objs[section] ?? {};
  const out: string[] = [];
  for (const entry of (target.buildPhases ?? []) as ({ value: string } | string)[]) {
    const phase = phases[ref(entry)];
    if (!phase) continue;
    for (const f of (phase.files ?? []) as ({ value: string } | string)[]) {
      const buildFile = objs.PBXBuildFile?.[ref(f)];
      if (buildFile?.fileRef) out.push(...(variants.get(String(buildFile.fileRef)) ?? [String(buildFile.fileRef)]));
    }
  }
  return out;
}

export function readTargetContent(p: Pbxproj, iosDir: string): BareTargetContent {
  const objs = p.project.hash.project.objects as Record<string, any>;
  const target = objs.PBXNativeTarget[p.appTarget.uuid];
  const mainGroup = p.project.getFirstProject().firstProject.mainGroup as string;
  const { files, groupPaths, variants, folders } = walkGroups(objs, mainGroup);

  const synced = ((target.fileSystemSynchronizedGroups ?? []) as ({ value: string } | string)[]).map(ref);
  if (synced.length > 0) {
    const g = objs.PBXFileSystemSynchronizedRootGroup?.[synced[0]!];
    const folder = folders.get(synced[0]!) ?? unquote(String(g?.path ?? g?.name ?? synced[0]));
    throw new DetectError(
      `The app target ${p.appTarget.name} takes its files from the synchronized folder ${folder} (an Xcode 16 folder group); ` +
        "rn-xtool reads only the files a target lists. Convert the folder to a group (Xcode: Convert to Group) so the target lists its files",
    );
  }

  const toFile = (rel: string): TargetFile => {
    const abs = path.isAbsolute(rel) ? rel : path.join(iosDir, rel);
    const relPath = path.relative(iosDir, abs).split(path.sep).join("/");
    return { absPath: abs, relPath };
  };
  const fileOf = (uuid: string): TargetFile => {
    const placed = files.get(uuid);
    if (placed === undefined) {
      const name = unquote(String(objs.PBXFileReference[uuid]?.path ?? uuid));
      throw new DetectError(`Cannot locate ${name} (${uuid}) in the pbxproj group tree`);
    }
    return toFile(placed);
  };

  const swiftSources: TargetFile[] = [];
  const cSources: TargetFile[] = [];
  const headers: TargetFile[] = [];
  const resources: TargetFile[] = [];
  const skippedResources: TargetFile[] = [];

  const unsupported: string[] = [];
  for (const uuid of phaseFiles(objs, target, "PBXSourcesBuildPhase", variants)) {
    if (!objs.PBXFileReference[uuid]) {
      // A compiled entry that is not a file, e.g. a Core Data model (`.xcdatamodeld`, an XCVersionGroup).
      const other = objs.XCVersionGroup?.[uuid];
      if (other) unsupported.push(unquote(String(other.path ?? other.name ?? uuid)));
      continue;
    }
    const file = fileOf(uuid);
    if (SWIFT.test(file.relPath)) swiftSources.push(file);
    else if (C_SOURCE.test(file.relPath)) cSources.push(file);
    else if (HEADER.test(file.relPath)) headers.push(file);
    else unsupported.push(file.relPath);
  }
  if (unsupported.length > 0) {
    throw new DetectError(`unsupported source type in the app target: ${unsupported.join(", ")}`);
  }
  // A renamed main.swift would lose its top-level code: Swift allows that only in a file named main.swift.
  const swiftMain = swiftSources.find((f) => SWIFTPM_MAIN.test(path.posix.basename(f.relPath)));
  if (swiftMain) {
    const base = path.posix.basename(swiftMain.relPath);
    throw new DetectError(
      `The app target compiles ${swiftMain.relPath}: SwiftPM takes a target with a file named main for an executable, ` +
        "and xtool links the app's entry point from the App library. Mark the app delegate class @main " +
        `(as the React Native template's AppDelegate.swift does), move any other top-level code of ${base} into it, ` +
        `and remove ${base} from the app target`,
    );
  }
  for (const uuid of phaseFiles(objs, target, "PBXResourcesBuildPhase", variants)) {
    if (!objs.PBXFileReference[uuid]) continue;
    const file = fileOf(uuid);
    (SKIPPED_RESOURCE.test(file.relPath) ? skippedResources : resources).push(file);
  }

  // Headers are rarely in a build phase. Xcode's header map makes every header the project references importable as
  // "X.h" from any source of the target: take each one under ios/, outside Pods, build/, frameworks and the Products
  // group. Headers under the app folder come first, so they win a basename shared with another header.
  const firstProject = p.project.getFirstProject().firstProject;
  const mainChildren = ((objs.PBXGroup?.[mainGroup]?.children ?? []) as ({ value: string } | string)[]).map(ref);
  const skippedGroups = [
    String(firstProject.productRefGroup ?? ""),
    ...mainChildren.filter((uuid) => {
      const g = groupPaths.get(uuid);
      return g !== undefined && (g.path === "Pods" || g.name === "Pods");
    }),
  ];
  const skippedRefs = new Set(skippedGroups.flatMap((uuid) => groupPaths.get(uuid)?.files ?? []));
  const referenced: TargetFile[] = [];
  const taken = new Set(headers.map((h) => h.relPath));
  for (const [uuid, placed] of files) {
    if (placed === undefined || skippedRefs.has(uuid) || !HEADER.test(placed)) continue;
    const file = toFile(placed);
    const parts = file.relPath.split("/");
    if (path.posix.isAbsolute(file.relPath) || parts[0] === ".." || NOT_APP_DIRS.has(parts[0]!)) continue;
    if (parts.some((part) => FRAMEWORK_DIR.test(part))) continue;
    if (taken.has(file.relPath)) continue;
    taken.add(file.relPath);
    referenced.push(file);
  }
  const infoPlist = resolveSetting(p, "INFOPLIST_FILE");
  const folder = infoPlist ? path.posix.dirname(infoPlist) : ".";
  const inFolder = (f: TargetFile): boolean => folder !== "." && f.relPath.startsWith(`${folder}/`);
  headers.push(...referenced.filter(inFolder), ...referenced.filter((f) => !inFolder(f)));

  const seen = new Map<string, TargetFile>();
  for (const f of [...swiftSources, ...cSources]) {
    const base = compiledName(f.relPath);
    const first = seen.get(base);
    if (first !== undefined) {
      const renamed = (x: TargetFile): boolean => path.posix.basename(x.relPath) !== base;
      const [a, b] = renamed(f) ? [f, first] : [first, f];
      const lead = renamed(a) ? `${a.relPath}, which is compiled as ${base},` : a.relPath;
      throw new DetectError(`Two compiled sources share the name ${base} (${lead} and ${b.relPath}); the generated target needs unique file names`);
    }
    seen.set(base, f);
  }

  const bridging = resolveSetting(p, "SWIFT_OBJC_BRIDGING_HEADER")?.trim();
  const words = (value: string | undefined): string[] => shellWords(value ?? "").filter((w) => w && w !== "$(inherited)");

  const ignoredSettings = IGNORABLE_FLAGS.filter((name) =>
    words(buildSetting(p, name)).some((w) => !BENIGN_FLAGS.has(w)),
  );

  return {
    swiftSources,
    cSources,
    headers,
    resources,
    skippedResources,
    bridgingHeader: bridging ? toFile(bridging) : undefined,
    defines: words(resolveSetting(p, "GCC_PREPROCESSOR_DEFINITIONS")),
    headerSearchPaths: words(resolveSetting(p, "HEADER_SEARCH_PATHS")).map((w) => path.resolve(iosDir, w)),
    cxxStandard: resolveSetting(p, "CLANG_CXX_LANGUAGE_STANDARD")?.trim() || undefined,
    ignoredSettings,
    mixed: cSources.length > 0,
    productModuleName:
      resolveSetting(p, "PRODUCT_MODULE_NAME")?.trim() ||
      c99Identifier(resolveSetting(p, "PRODUCT_NAME")?.trim() || p.appTarget.name),
  };
}

/** The settings rn-xtool reads from the pbxproj that an xcconfig could set instead. */
export const XCCONFIG_READ_SETTINGS = [
  "HEADER_SEARCH_PATHS",
  "GCC_PREPROCESSOR_DEFINITIONS",
  "CLANG_CXX_LANGUAGE_STANDARD",
  "SWIFT_OBJC_BRIDGING_HEADER",
  "PRODUCT_MODULE_NAME",
  "CODE_SIGN_ENTITLEMENTS",
  "INFOPLIST_FILE",
] as const;

/** `KEY = …` or `KEY[cond]… = …`. */
const XCCONFIG_SETTING = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]\s*)*=/;
const XCCONFIG_INCLUDE = /^\s*#include(\?)?\s*"([^"]*)"/;
/** CocoaPods' generated xcconfigs: their settings are the pods', which rn-xtool builds itself. */
const PODS_XCCONFIG = /^Pods-.*\.xcconfig$/;

/**
 * Adds to `found` the setting names `file` and its includes (`#include`, `#include?`, relative to the including file)
 * set. Each file is read once (`seen`); CocoaPods' are skipped; a file that cannot be read, unless an `#include?`, goes
 * to `unreadable`.
 */
function scanXcconfig(file: string, seen: Set<string>, found: Set<string>, unreadable: string[], optional = false): void {
  if (seen.has(file) || PODS_XCCONFIG.test(path.basename(file))) return;
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    if (!optional) unreadable.push(file);
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const include = XCCONFIG_INCLUDE.exec(line);
    if (include) {
      scanXcconfig(path.resolve(path.dirname(file), include[2]!), seen, found, unreadable, include[1] === "?");
      continue;
    }
    // Anchored at the line start, neither pattern matches a `//` comment line.
    const key = XCCONFIG_SETTING.exec(line)?.[1];
    if (key) found.add(key);
  }
}

/**
 * One `⚠` line per xcconfig, other than CocoaPods', that the Debug configuration of the app target or of the project
 * is based on and that sets one of `XCCONFIG_READ_SETTINGS` (in that order), and one per such file that cannot be read.
 * rn-xtool reads those settings from the pbxproj only. Paths are relative to the project root `root`.
 */
export function appXcconfigWarnings(p: Pbxproj, root: string): string[] {
  const objs = p.project.hash.project.objects as Record<string, any>;
  const firstProject = p.project.getFirstProject().firstProject;
  const { files } = walkGroups(objs, firstProject.mainGroup as string);
  const iosDir = path.dirname(path.dirname(p.path));
  const display = (abs: string): string => path.relative(root, abs).split(path.sep).join("/");
  const cannotRead = (name: string): string =>
    `⚠ ${name} (the app target's base configuration) could not be read; rn-xtool does not read xcconfig files`;

  const lists = [objs.PBXNativeTarget[p.appTarget.uuid].buildConfigurationList, firstProject.buildConfigurationList];
  const bases = new Set<string>();
  for (const list of lists) {
    const base = buildConfiguration(p, String(list), "Debug")?.baseConfigurationReference;
    if (base !== undefined) bases.add(String(base));
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const uuid of bases) {
    const placed = files.get(uuid);
    if (placed === undefined) {
      const fileRef = objs.PBXFileReference?.[uuid];
      const name = unquote(String(fileRef?.path ?? fileRef?.name ?? uuid));
      if (!PODS_XCCONFIG.test(path.posix.basename(name))) out.push(cannotRead(name));
      continue;
    }
    const abs = path.isAbsolute(placed) ? placed : path.join(iosDir, placed);
    const found = new Set<string>();
    const unreadable: string[] = [];
    scanXcconfig(abs, seen, found, unreadable);
    const sets = XCCONFIG_READ_SETTINGS.filter((s) => found.has(s));
    if (sets.length > 0) {
      out.push(`⚠ ${display(abs)} sets ${sets.join(", ")} for the app target; rn-xtool does not read xcconfig files`);
    }
    out.push(...unreadable.map((f) => cannotRead(display(f))));
  }
  return out;
}
