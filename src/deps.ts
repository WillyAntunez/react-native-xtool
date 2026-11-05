import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { PODS_LOCK } from "./pods/lock.js";
import { detectProjectKind } from "./project/detect.js";
import { openPbxproj, readTargetContent, resolveSetting } from "./project/pbxproj.js";

/** rn-xtool's own version, from the package.json `rn-xtool --version` prints. */
const RN_XTOOL_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** sha256 over the sorted entries; order of the input never matters. */
export function fingerprintOf(entries: string[]): string {
  return createHash("sha256")
    .update([...entries].sort().join("\n"))
    .digest("hex");
}

/** Parsed JSON object, or undefined when the file is missing or malformed. */
async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** sha256 of a file's bytes, or of a directory's sorted entries (names and contents); "missing" when absent. */
async function contentHash(file: string): Promise<string> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return "missing";
  }
  const hash = createHash("sha256");
  if (info.isDirectory()) {
    for (const name of (await readdir(file)).sort()) hash.update(`${name}\0${await contentHash(join(file, name))}\n`);
  } else {
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

/**
 * Bare projects keep their native code in ios/: the pbxproj, the Info.plist and every file of the app
 * target (sources, headers, bridging header, resources), hashed by content. Empty for Expo projects
 * (and for a root that is neither kind); one marker entry when the pbxproj cannot be read.
 */
async function bareNativeEntries(root: string): Promise<string[]> {
  try {
    if (detectProjectKind(root, (await loadConfig(root)).projectKind) !== "bare") return [];
  } catch {
    return [];
  }
  const iosDir = join(root, "ios");
  let files: string[];
  try {
    const pbx = openPbxproj(iosDir);
    const target = readTargetContent(pbx, iosDir);
    const infoPlist = resolveSetting(pbx, "INFOPLIST_FILE");
    files = [
      pbx.path,
      ...(infoPlist ? [resolve(iosDir, infoPlist)] : []),
      ...[...target.swiftSources, ...target.cSources, ...target.headers, ...target.resources].map((f) => f.absPath),
      ...(target.bridgingHeader ? [target.bridgingHeader.absPath] : []),
    ];
  } catch (e) {
    return [`native:unreadable:${e instanceof Error ? e.message : String(e)}`];
  }
  return Promise.all([...new Set(files)].map(async (f) => `native:${relative(root, f)}@${await contentHash(f)}`));
}

/**
 * Fingerprint of everything that can make the installed app or the Metro cache stale:
 * every dependency/devDependency at its INSTALLED version, plus the patches/*.patch names,
 * plus, for a bare project, the content of its native app target (see `bareNativeEntries`),
 * plus the sha256 of rn-xtool-pods.lock.json when there is one,
 * plus rn-xtool's own version (`toolVersion` in tests): what it generates into the app changes between releases.
 *
 * Deliberately no native/JS distinction: JS-only changes also need a Metro cache reset,
 * and telling native dependencies apart reliably needs the autolinking pass.
 */
export async function depsFingerprint(root: string, opts: { toolVersion?: string } = {}): Promise<string> {
  const pkg = await readJson(join(root, "package.json"));
  const names = new Set<string>([
    ...Object.keys((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
    ...Object.keys((pkg?.devDependencies as Record<string, string> | undefined) ?? {}),
  ]);
  const entries = await Promise.all(
    [...names].map(async (name) => {
      const installed = await readJson(join(root, "node_modules", name, "package.json"));
      const version = typeof installed?.version === "string" ? installed.version : "missing";
      return `${name}@${version}`;
    }),
  );
  let patches: string[] = [];
  try {
    patches = (await readdir(join(root, "patches"))).filter((f) => f.endsWith(".patch")).map((f) => `patch:${f}`);
  } catch {
    // no patches directory
  }
  const tool = `rn-xtool@${opts.toolVersion ?? RN_XTOOL_VERSION}`;
  // A pulled change to the binary pods' lock changes what the pods step links (preflight P14).
  const lockHash = await contentHash(join(root, PODS_LOCK));
  const lock = lockHash === "missing" ? [] : [`pods-lock@${lockHash}`];
  return fingerprintOf([...entries, ...patches, ...(await bareNativeEntries(root)), ...lock, tool]);
}
