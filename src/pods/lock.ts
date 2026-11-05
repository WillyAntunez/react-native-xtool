/**
 * `rn-xtool-pods.lock.json`, at the project root and committed by the user: per binary pod, the version, the subspecs
 * used, the source URL, the download's size and sha256, and the libraries that need it. URLs, sizes and hashes only,
 * never file contents. The first run records; later runs check every download against it. Entries no library needs
 * stay (open question 7): toggling `exclude` keeps the recorded hashes.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PODS_LINK } from "./format.js";
import type { Resolution } from "./resolve.js";

export const PODS_LOCK = "rn-xtool-pods.lock.json";

export interface LockEntry {
  version: string;
  subspecs: string[];
  url: string;
  size: number;
  sha256: string;
  neededBy: string[];
}

export interface PodsLock {
  lockfileVersion: 1;
  pods: Record<string, LockEntry>;
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");

const unreadable = (reason: string): LockError =>
  new LockError(`${PODS_LOCK} is not a lock rn-xtool can read (${reason}); fix it, or delete it to record the files again. See ${PODS_LINK}`);

/** Throws the unreadable text naming the first key with a wrong value. */
function checkLock(json: unknown): asserts json is PodsLock {
  const fail = (key: string, what: string): never => {
    throw unreadable(`${key} must be ${what}`);
  };
  if (!isRecord(json)) fail("the file", "a JSON object");
  const lock = json as Record<string, unknown>;
  if (lock.lockfileVersion !== 1) fail("lockfileVersion", "1");
  if (!isRecord(lock.pods)) fail("pods", "an object of pod names");
  for (const [pod, e] of Object.entries(lock.pods as Record<string, unknown>)) {
    const key = `pods.${pod}`;
    if (!isRecord(e)) fail(key, "an object");
    const entry = e as Record<string, unknown>;
    if (typeof entry.version !== "string" || entry.version.trim() === "") fail(`${key}.version`, "a version");
    if (!isNames(entry.subspecs)) fail(`${key}.subspecs`, "a list of names");
    if (typeof entry.url !== "string" || !/^https?:\/\/\S+$/.test(entry.url)) fail(`${key}.url`, "a URL");
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) fail(`${key}.size`, "a number of bytes");
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`${key}.sha256`, "a sha256 in hex");
    if (!isNames(entry.neededBy)) fail(`${key}.neededBy`, "a list of package names");
  }
}

/** The lock at `root`; an empty lock when the file is missing. */
export function readPodsLock(root: string): PodsLock {
  const file = path.join(root, PODS_LOCK);
  if (!existsSync(file)) return { lockfileVersion: 1, pods: {} };
  const text = readFileSync(file, "utf8");
  if (/^(<{7}|={7}|>{7})(\s|$)/m.test(text)) {
    throw new LockError(
      `${PODS_LOCK} has merge conflict markers; keep either side and build again: rn-xtool checks every file against the hashes it keeps. See ${PODS_LINK}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw unreadable(err instanceof Error ? err.message : String(err));
  }
  checkLock(json);
  return json;
}

/** Object keys sorted at every level; lists of names sorted too. */
function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.every((v) => typeof v === "string") ? [...value].sort() : value.map(sortedValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortedValue(value[k])]),
  );
}

/** Keys sorted, two spaces, a trailing newline. */
export function renderPodsLock(lock: PodsLock): string {
  return `${JSON.stringify(sortedValue(lock), null, 2)}\n`;
}

/** Writes the lock through `<file>.<pid>.tmp` and a rename. */
export function writePodsLock(root: string, lock: PodsLock): void {
  const file = path.join(root, PODS_LOCK);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, renderPodsLock(lock));
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Pod → its locked version. */
export function lockedVersions(lock: PodsLock): Record<string, string> {
  return Object.fromEntries(Object.entries(lock.pods).map(([pod, e]) => [pod, e.version]));
}

/** The entries no library needs now: "MLKitFoo 1.0.0", sorted. */
export function unusedLockEntries(lock: PodsLock, used: ReadonlySet<string>): string[] {
  return Object.entries(lock.pods)
    .filter(([pod]) => !used.has(pod))
    .map(([pod, e]) => `${pod} ${e.version}`)
    .sort();
}

/** Spec goal 1.6: the downloads the step recorded. */
export function recordedLine(n: number): string {
  return `ℹ pods — recorded the sha256 of ${n} download${n === 1 ? "" : "s"} in ${PODS_LOCK}; commit it, so other machines check that they get the same files.`;
}

/** Row 11: a locked version that no longer meets a requirement, and the version recorded instead. */
export function reResolvedLine(change: Resolution["changed"][number]): string {
  return `ℹ pods — ${change.pod}: ${PODS_LOCK} records ${change.from}, which no longer meets "${change.requirement}" (${change.by}); now ${change.to}, recorded in ${PODS_LOCK}`;
}

/** Row 19: the spec names another URL for the same file. */
export function movedLine(pod: string, version: string, url: string): string {
  return `ℹ pods — ${pod} ${version} moved to ${url}; same file (its sha256 matches ${PODS_LOCK}), so the lock's URL is updated`;
}
