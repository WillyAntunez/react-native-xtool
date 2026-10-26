import { readdirSync } from "node:fs";
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
    throw new DetectError(`${iosDir} holds more than one .xcodeproj (${projects.join(", ")}); rn-xtool needs exactly one`);
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
    throw new DetectError(`${file} has more than one application target (${apps.map((t) => t.name).join(", ")}); rn-xtool needs exactly one`);
  }
  return { path: file, projectName: projects[0]!.slice(0, -".xcodeproj".length), appTarget: apps[0]!, targets, project };
}

/** The `buildSettings` of `configuration` in the configuration list `listUuid`. */
function configurationSettings(p: Pbxproj, listUuid: string, configuration: string): Record<string, unknown> | undefined {
  const list = p.project.pbxXCConfigurationList()[listUuid];
  if (!list) return undefined;
  const configs = p.project.pbxXCBuildConfigurationSection();
  for (const ref of list.buildConfigurations as { value: string }[]) {
    const config = configs[ref.value];
    if (config && unquote(String(config.name)) === configuration) return config.buildSettings;
  }
  return undefined;
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

/** Resolved value of `key`; see `resolveBuildSettingValue`. `$(inherited)` is the project-level value of the same key (empty at the top of the chain). */
export function resolveSetting(p: Pbxproj, key: string, configuration = "Debug"): string | undefined {
  const builtin = (name: string): string | undefined => {
    if (name === "TARGET_NAME") return p.appTarget.name;
    if (name === "PROJECT_NAME") return p.projectName;
    return undefined;
  };
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
const IGNORABLE_FLAGS = ["OTHER_CFLAGS", "OTHER_LDFLAGS", "OTHER_SWIFT_FLAGS"];
/** Flags the template sets that the generated project already provides. */
const BENIGN_FLAGS = new Set(["$(inherited)", "-ObjC", "-lc++"]);

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
  const files = new Map<string, string | undefined>();
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
      }
    }
    groupPaths.set(uuid, { path: here ?? "", name: g.name === undefined ? undefined : unquote(String(g.name)), files: collected });
    return collected;
  };
  visit(mainGroup, "", new Set());
  return { files, groupPaths, variants };
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
  const { files, groupPaths, variants } = walkGroups(objs, mainGroup);

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
  for (const uuid of phaseFiles(objs, target, "PBXResourcesBuildPhase", variants)) {
    if (!objs.PBXFileReference[uuid]) continue;
    const file = fileOf(uuid);
    (SKIPPED_RESOURCE.test(file.relPath) ? skippedResources : resources).push(file);
  }

  // Headers are rarely in a build phase: take every header under the app target's folder group.
  const infoPlist = resolveSetting(p, "INFOPLIST_FILE");
  const folder = infoPlist ? path.posix.dirname(infoPlist) : undefined;
  if (folder && folder !== ".") {
    const group =
      [...groupPaths.entries()].find(([uuid, g]) => uuid !== mainGroup && g.path === folder) ??
      [...groupPaths.entries()].find(([uuid, g]) => uuid !== mainGroup && g.path === "" && g.name === folder);
    for (const uuid of group?.[1].files ?? []) {
      const file = fileOf(uuid);
      if (!HEADER.test(file.relPath)) continue;
      if (!headers.some((h) => h.relPath === file.relPath)) headers.push(file);
    }
  }

  const seen = new Map<string, string>();
  for (const f of [...swiftSources, ...cSources]) {
    const base = path.posix.basename(f.relPath);
    const first = seen.get(base);
    if (first !== undefined) {
      throw new DetectError(`Two compiled sources share the name ${base} (${first} and ${f.relPath}); the generated target needs unique file names`);
    }
    seen.set(base, f.relPath);
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
