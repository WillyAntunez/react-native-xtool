/**
 * The app's entitlements, as Xcode would sign the Debug build with them: the file `CODE_SIGN_ENTITLEMENTS` names in the
 * app target's Debug configuration (on Expo, in the pbxproj `expo prebuild` wrote, so config plugins' additions are
 * in). rn-xtool builds Debug only, so a different Release file is not read. rn-xtool copies it to
 * `ios-xtool/App.entitlements`, which `xtool.yml`'s `entitlementsPath` names.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as plist from "plist";
import { ENTITLEMENT_TABLE, GENERIC_PHRASE } from "./entitlementTable.js";
import {
  AmbiguousProjectError,
  buildSetting,
  builtinSetting,
  openPbxproj,
  resolveBuildSettingValue,
  resolveSetting,
  type Pbxproj,
} from "./pbxproj.js";
import type { ProjectInfo, ProjectKind } from "./types.js";

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

/** The names Xcode resolves to the app's bundle id in entitlements: the build setting, and the Info.plist key. */
const BUNDLE_ID_REFERENCES = new Set(["PRODUCT_BUNDLE_IDENTIFIER", "CFBundleIdentifier"]);

/**
 * A setting's value resolved like Xcode would: `$(PRODUCT_BUNDLE_IDENTIFIER)` and `$(CFBundleIdentifier)` are the
 * app's bundle id (the one xtool signs), Xcode's own settings (`$(SRCROOT)` is ios/) and the rest come from the pbxproj.
 */
function resolveIn(p: Pbxproj, raw: string, bundleId: string): string {
  return resolveBuildSettingValue(raw, (name) =>
    BUNDLE_ID_REFERENCES.has(name) ? bundleId : (builtinSetting(p, name) ?? resolveSetting(p, name)),
  );
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
 * is unset or empty, or when ios/ holds several Xcode projects or application targets. The path resolves against ios/. Values' `$(PRODUCT_BUNDLE_IDENTIFIER)` (the app's bundle id) and
 * other build settings are resolved from the pbxproj; `$(AppIdentifierPrefix)` and `$(TeamIdentifierPrefix)` are kept,
 * since xtool rewrites them. Throws an EntitlementsError when the file is missing or not a property list dictionary.
 */
export function readEntitlements(project: Pick<ProjectInfo, "root" | "bundleIdentifier">, iosDir: string): AppEntitlements | undefined {
  let projects: string[];
  try {
    projects = readdirSync(iosDir).filter((n) => n.endsWith(".xcodeproj"));
  } catch {
    return undefined;
  }
  if (projects.length === 0) return undefined;
  let p: Pbxproj;
  try {
    p = openPbxproj(iosDir);
  } catch (e) {
    // Which project or target is the app's is unknown: the generate step says so (an Expo prebuild never writes this).
    if (e instanceof AmbiguousProjectError) return undefined;
    throw e;
  }
  const raw = buildSetting(p, "CODE_SIGN_ENTITLEMENTS")?.trim();
  if (!raw) return undefined;
  const setting = resolveIn(p, raw, project.bundleIdentifier).trim();
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
      return resolveIn(p, reference, project.bundleIdentifier);
    } catch {
      return undefined;
    }
  };
  return { file, rel, dict: resolveValue(parsed, resolve) as Record<string, unknown> };
}

const KEYCHAIN = "keychain-access-groups";

/**
 * The `⚠` lines for what xtool does with the app's entitlements when it signs, one per key in the file's order
 * (ENTITLEMENT_TABLE, read from the xtool rn-xtool pins). rn-xtool does not know the team at build time, so the lines
 * say what happens on a free team:
 * - a key xtool knows and marks paid is dropped on a free team;
 * - a key xtool does not know is dropped on a free team, and gets no capability on a paid one;
 * - a key Apple gives free teams that xtool does not know, or a key not in the table, is never enabled by xtool;
 * - `keychain-access-groups` listing a group other than the app's own (`$(AppIdentifierPrefix)<bundle id>`, or
 *   `$(TeamIdentifierPrefix)<bundle id>`, the same group on an iOS app) is replaced by the app's own group;
 * - a key xtool knows and signs on a free team gets no line.
 */
export function entitlementLines(e: AppEntitlements, bundleId: string): string[] {
  return Object.entries(e.dict).flatMap(([key, value]): string[] => {
    const info = ENTITLEMENT_TABLE[key];
    const phrase = info?.phrase ?? GENERIC_PHRASE;
    if (key === KEYCHAIN) {
      const own = new Set([`$(AppIdentifierPrefix)${bundleId}`, `$(TeamIdentifierPrefix)${bundleId}`]);
      const groups = Array.isArray(value) ? value : [value];
      if (groups.every((g) => typeof g === "string" && own.has(g))) return [];
      // xtool registers the app as XTL-<Team ID>.<bundle id> and rewrites the group with that id.
      return [
        `⚠ ${KEYCHAIN} lists other groups; xtool signs the app with its own group only (<Team ID>.XTL-<Team ID>.${bundleId}); ` +
          `the build continues; ${phrase}.`,
      ];
    }
    if (info === undefined || (info.xtool === "unknown" && info.appleFree)) {
      return [`⚠ ${key} is not enabled by xtool; the build continues without it; ${phrase}.`];
    }
    if (info.xtool === "paid") return [`⚠ ${key} is not available on a free team; the build continues without it; ${phrase}.`];
    if (info.xtool === "unknown") {
      return [
        `⚠ ${key} is not available on a free team, and xtool does not enable it on a paid one; the build continues ` +
          `without it; ${phrase}.`,
      ];
    }
    return [];
  });
}

/**
 * What `doctor --project` reports on the entitlements: the file and its lines; `pending` for an Expo app whose ios/
 * holds no Xcode project yet (read after expo prebuild, at build); `error` for a refusal or an unreadable pbxproj;
 * undefined when CODE_SIGN_ENTITLEMENTS is unset (or ios/ is missing on bare). The bundle id is the pbxproj's
 * PRODUCT_BUNDLE_IDENTIFIER, as the bare reader takes it.
 */
export type EntitlementsCapability = { rel: string; lines: string[] } | { pending: true } | { error: string };

export function entitlementsCapability(root: string, kind: ProjectKind | undefined): EntitlementsCapability | undefined {
  const iosDir = path.join(root, "ios");
  let hasProject = false;
  try {
    hasProject = readdirSync(iosDir).some((n) => n.endsWith(".xcodeproj"));
  } catch {
    // no ios/
  }
  if (!hasProject) return kind === "expo" ? { pending: true } : undefined;
  try {
    let p: Pbxproj;
    try {
      p = openPbxproj(iosDir);
    } catch (e) {
      if (e instanceof AmbiguousProjectError) return undefined;
      throw e;
    }
    let bundleId = "$(PRODUCT_BUNDLE_IDENTIFIER)";
    try {
      bundleId = resolveSetting(p, "PRODUCT_BUNDLE_IDENTIFIER") ?? bundleId;
    } catch {
      // the project line names an unresolvable bundle id
    }
    const e = readEntitlements({ root, bundleIdentifier: bundleId }, iosDir);
    return e === undefined ? undefined : { rel: e.rel, lines: entitlementLines(e, bundleId) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
