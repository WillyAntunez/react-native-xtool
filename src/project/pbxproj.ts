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
  if (Array.isArray(value)) return value.map((v) => unquote(String(v))).join(" ");
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
    throw new DetectError(`${iosDir} holds more than one .xcodeproj (${projects.join(", ")}); expo-xtool needs exactly one`);
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
    throw new DetectError(`${file} has more than one application target (${apps.map((t) => t.name).join(", ")}); expo-xtool needs exactly one`);
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

const REFERENCE = /\$\(([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z0-9]+))?\)/g;

/**
 * Expands `$(NAME)` and `$(NAME:rfc1034identifier)` using `lookup`. Any other reference (unknown name, unsupported
 * modifier, or a name `lookup` cannot answer) throws, naming the setting.
 */
export function resolveBuildSettingValue(value: string, lookup: (key: string) => string | undefined): string {
  const out = value.replace(REFERENCE, (whole, name: string, modifier?: string) => {
    if (modifier !== undefined && modifier !== "rfc1034identifier") {
      throw new DetectError(`Unsupported build setting modifier ":${modifier}" in ${whole}`);
    }
    const found = lookup(name);
    if (found === undefined) throw new DetectError(`Cannot resolve build setting $(${name}) in "${value}"`);
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
