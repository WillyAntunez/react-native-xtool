/**
 * The app's entitlements, as Xcode would sign the Debug build with them: the file `CODE_SIGN_ENTITLEMENTS` names in the
 * app target's Debug configuration (on Expo, in the pbxproj `expo prebuild` wrote, so config plugins' additions are
 * in). rn-xtool builds Debug only, so a different Release file is not read. rn-xtool copies it to
 * `ios-xtool/App.entitlements`, which `xtool.yml`'s `entitlementsPath` names.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as plist from "plist";
import { buildSetting, openPbxproj, resolveBuildSettingValue, resolveSetting, type Pbxproj } from "./pbxproj.js";
import type { ProjectInfo } from "./types.js";

/** A refusal: xtool cannot sign the app with the file `CODE_SIGN_ENTITLEMENTS` names. */
export class EntitlementsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementsError";
  }
}

export interface AppEntitlements {
  /** Absolute path of the app's entitlements file. */
  file: string;
  /** The same, relative to the project root (`ios/App/App.entitlements`). */
  rel: string;
  dict: Record<string, unknown>;
}

/** Signing references xtool rewrites with the team it signs for: kept as they are. */
const SIGNING_REFERENCES = new Set(["AppIdentifierPrefix", "TeamIdentifierPrefix"]);
const REFERENCE = /\$\(([A-Za-z_][A-Za-z0-9_]*)(?::[A-Za-z0-9]+)?\)/g;

/**
 * A setting's value resolved like Xcode would: `$(SRCROOT)` and `$(PROJECT_DIR)` are ios/, `$(PRODUCT_BUNDLE_IDENTIFIER)`
 * the app's bundle id (the one xtool signs), the rest from the pbxproj.
 */
function resolveIn(p: Pbxproj, iosDir: string, raw: string, bundleId: string): string {
  return resolveBuildSettingValue(raw, (name) => {
    if (name === "SRCROOT" || name === "PROJECT_DIR") return iosDir;
    if (name === "PRODUCT_BUNDLE_IDENTIFIER") return bundleId;
    if (name === "TARGET_NAME") return p.appTarget.name;
    if (name === "PROJECT_NAME") return p.projectName;
    return resolveSetting(p, name);
  });
}

/** Each `$(NAME)` the pbxproj answers, resolved; signing references and unknown settings are kept as written. */
function resolveValue(value: unknown, resolve: (reference: string) => string | undefined): unknown {
  if (typeof value === "string") {
    return value.replace(REFERENCE, (whole, name: string) => (SIGNING_REFERENCES.has(name) ? whole : (resolve(whole) ?? whole)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, resolve));
  if (isDict(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, resolve)]));
  return value;
}

function isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !ArrayBuffer.isView(value);
}

/**
 * The entitlements of the app target's Debug configuration; undefined when ios/ holds no Xcode project or the setting
 * is unset or empty. The path resolves against ios/. Values' `$(PRODUCT_BUNDLE_IDENTIFIER)` (the app's bundle id) and
 * other build settings are resolved from the pbxproj; `$(AppIdentifierPrefix)` and `$(TeamIdentifierPrefix)` are kept,
 * since xtool rewrites them. Throws an EntitlementsError when the file is missing or not a property list dictionary.
 */
export function readEntitlements(project: ProjectInfo, iosDir: string): AppEntitlements | undefined {
  let projects: string[];
  try {
    projects = readdirSync(iosDir).filter((n) => n.endsWith(".xcodeproj"));
  } catch {
    return undefined;
  }
  if (projects.length === 0) return undefined;
  const p = openPbxproj(iosDir);
  const raw = buildSetting(p, "CODE_SIGN_ENTITLEMENTS")?.trim();
  if (!raw) return undefined;
  const setting = resolveIn(p, iosDir, raw, project.bundleIdentifier).trim();
  if (setting === "") return undefined;
  const file = path.resolve(iosDir, setting);
  const rel = path.relative(project.root, file).split(path.sep).join("/");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new EntitlementsError(
      `CODE_SIGN_ENTITLEMENTS names ${rel}, which does not exist; xtool cannot sign the app without it. Fix the setting or create the file.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = plist.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isDict(parsed)) {
    throw new EntitlementsError(`${rel} (CODE_SIGN_ENTITLEMENTS) is not a property list dictionary; xtool cannot sign the app with it.`);
  }
  const resolve = (reference: string): string | undefined => {
    try {
      return resolveIn(p, iosDir, reference, project.bundleIdentifier);
    } catch {
      return undefined;
    }
  };
  return { file, rel, dict: resolveValue(parsed, resolve) as Record<string, unknown> };
}
