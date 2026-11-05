/**
 * A pod's archive is listed before anything is extracted: an entry with an absolute path, a `..` segment, a device or
 * special file, or a link that resolves outside the archive (through the archive's own links too) refuses the whole
 * archive. Tar archives are listed with GNU tar (C-quoted names, so no name can pass for a link target), zip archives
 * with `unzip -Z`, a zip symlink's target with `unzip -p`. Then only the paths the spec needs are extracted into
 * `<cache>/extracted/<sha256>-<stamp hash>/`, assembled beside it per process, stamped, and swapped in whole.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { execa } from "execa";
import { swapIn } from "../pipeline/rnArtifacts.js";
import { PODS_LINK, PodsError } from "./format.js";

export interface ArchiveEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "hardlink" | "special";
  target?: string;
}

/** Runs `cmd` with `args` in the C locale; resolves to its stdout. */
export type ListRunner = (cmd: string, args: string[]) => Promise<string>;

/** `cmd` is not installed (the runner failed with ENOENT). */
export class ListToolMissing extends Error {
  constructor(readonly tool: string) {
    super(`${tool} is not installed`);
    this.name = "ListToolMissing";
  }
}

/** Runs with execa in the C locale. */
export const defaultListRunner: ListRunner = async (cmd, args) => {
  const r = await execa(cmd, args, {
    env: { ...process.env, LC_ALL: "C" },
    extendEnv: false,
    stripFinalNewline: false,
    maxBuffer: 512 * 1024 * 1024,
  });
  return r.stdout;
};

const FILE_TYPES: Record<string, ArchiveEntry["type"]> = { "-": "file", C: "file", S: "file", d: "dir", l: "symlink", h: "hardlink" };
const typeOf = (c: string): ArchiveEntry["type"] => FILE_TYPES[c] ?? "special";

const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34, "?": 63 };

/** A C-quoted string at the start of `s` (GNU tar's `--quoting-style=c`): its text and what follows. */
function unquote(s: string, line: string): [string, string] {
  if (!s.startsWith('"')) throw listingError(line);
  const bytes: number[] = [];
  let i = 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    if (s[i] !== "\\") {
      bytes.push(...Buffer.from(s[i]!, "utf8"));
      continue;
    }
    const next = s[++i];
    const octal = /^[0-7]{1,3}/.exec(s.slice(i))?.[0];
    if (octal !== undefined) {
      bytes.push(parseInt(octal, 8));
      i += octal.length - 1;
    } else if (next !== undefined && ESCAPES[next] !== undefined) {
      bytes.push(ESCAPES[next]!);
    } else {
      throw listingError(line);
    }
  }
  if (s[i] !== '"') throw listingError(line);
  return [Buffer.from(bytes).toString("utf8"), s.slice(i + 1)];
}

const listingError = (line: string): Error => new Error(`rn-xtool cannot read this archive listing line: ${line}`);

const TAR_LINE = /^(\S)\S+\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? (".*)$/;

/** `LC_ALL=C tar -tvzf <file> -P --numeric-owner --quoting-style=c`. */
export function parseTarListing(text: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = TAR_LINE.exec(line);
    if (m === null) throw listingError(line);
    const type = typeOf(m[1]!);
    const [name, rest] = unquote(m[2]!, line);
    if (type === "symlink" || type === "hardlink") {
      const sep = type === "symlink" ? " -> " : " link to ";
      if (!rest.startsWith(sep)) throw listingError(line);
      const [target, tail] = unquote(rest.slice(sep.length), line);
      if (tail !== "") throw listingError(line);
      entries.push({ path: name, type, target });
    } else {
      if (rest !== "") throw listingError(line);
      entries.push({ path: name, type });
    }
  }
  return entries;
}

const ZIP_LINE = /^(\S)\S*\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2} (.*)$/;

/** `LC_ALL=C unzip -Z <file>`: the type from the mode column; a symlink's target is read separately. */
export function parseZipListing(longText: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of longText.split("\n")) {
    const m = ZIP_LINE.exec(line);
    if (m === null) continue;
    const name = m[2]!;
    const type = name.endsWith("/") ? "dir" : typeOf(m[1]!);
    entries.push({ path: name, type: type === "hardlink" ? "special" : type });
  }
  return entries;
}

/** unzip's member argument is a wildcard: `*`, `?` and `[` are matched literally as `[*]`, `[?]`, `[[]`. */
const unzipPattern = (name: string): string => name.replace(/[*?[]/g, (c) => `[${c}]`);

/** The archive's entries, with link targets. Throws ListToolMissing when tar or unzip is not installed. */
export async function listArchive(file: string, ext: "tar.gz" | "zip", run: ListRunner = defaultListRunner): Promise<ArchiveEntry[]> {
  const tool = ext === "zip" ? "unzip" : "tar";
  const call = async (args: string[]): Promise<string> => {
    try {
      return await run(tool, args);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ListToolMissing(tool);
      throw err;
    }
  };
  if (ext === "tar.gz") return parseTarListing(await call(["-tvzf", file, "-P", "--numeric-owner", "--quoting-style=c"]));
  const entries = parseZipListing(await call(["-Z", file]));
  for (const e of entries) {
    if (e.type === "symlink") e.target = await call(["-p", file, unzipPattern(e.path)]);
  }
  return entries;
}

const segments = (p: string): string[] => p.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
const isAbsolute = (p: string): boolean => p.startsWith("/") || p.startsWith("\\");

const MAX_LINK_HOPS = 40;

/**
 * Where `rel` leads from the folder `start` (segments under the archive root), following the archive's own symlinks
 * on the way; undefined when it leaves the archive (or loops).
 */
export function resolveInside(links: ReadonlyMap<string, string>, start: string[], rel: string): string[] | undefined {
  const parts = [...start];
  const queue = segments(rel);
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift()!;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(seg);
    const target = links.get(parts.join("/"));
    if (target === undefined) continue;
    if (++hops > MAX_LINK_HOPS || isAbsolute(target)) return undefined;
    parts.pop();
    queue.unshift(...segments(target));
  }
  return parts;
}

export type UnsafeWhy =
  | "has an absolute path"
  | "goes up with .."
  | "is a device or special file"
  | "is a link that points outside the archive";

/** The first entry that must not be extracted, and why. */
export function unsafeEntry(entries: readonly ArchiveEntry[]): { entry: string; why: UnsafeWhy } | undefined {
  const links = new Map<string, string>();
  for (const e of entries) {
    if (e.type === "symlink") links.set(segments(e.path).join("/"), e.target ?? "");
  }
  for (const e of entries) {
    const found = (why: UnsafeWhy) => ({ entry: e.path, why });
    if (isAbsolute(e.path)) return found("has an absolute path");
    const parts = segments(e.path);
    if (parts.includes("..")) return found("goes up with ..");
    if (e.type === "special") return found("is a device or special file");
    if (e.type === "symlink" || e.type === "hardlink") {
      const target = e.target ?? "";
      if (isAbsolute(target)) return found("is a link that points outside the archive");
      const from = e.type === "symlink" ? resolveInside(links, [], parts.slice(0, -1).join("/")) : [];
      if (from === undefined || resolveInside(links, from, target) === undefined) {
        return found("is a link that points outside the archive");
      }
    }
  }
  return undefined;
}

/** The entries of a pod's archive, listed and checked: the stops name the archive, the pod and the entry. */
export async function safeEntries(
  file: string,
  ext: "tar.gz" | "zip",
  who: { pod: string; version: string },
  run?: ListRunner,
): Promise<ArchiveEntry[]> {
  const name = path.basename(file);
  let entries: ArchiveEntry[];
  try {
    entries = await listArchive(file, ext, run);
  } catch (err) {
    if (err instanceof ListToolMissing && err.tool === "unzip") {
      throw new PodsError(
        `${who.pod} ${who.version} is a .zip download, and unzip is not installed. Install it (sudo apt install unzip) and build again.`,
      );
    }
    const stderr = (err as { stderr?: unknown }).stderr;
    const reason = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0]! : err instanceof Error ? err.message : String(err);
    throw new PodsError(`rn-xtool cannot list ${name} (${who.pod} ${who.version}): ${reason}. See ${PODS_LINK}`);
  }
  const bad = unsafeEntry(entries);
  if (bad !== undefined) {
    throw new PodsError(
      `rn-xtool refuses to extract ${name} (${who.pod} ${who.version}): its entry "${bad.entry}" ${bad.why}. Nothing was extracted. See ${PODS_LINK}`,
    );
  }
  return entries;
}

const micromatch = createRequire(import.meta.url)("micromatch") as {
  matcher: (patterns: string[], options?: { dot?: boolean }) => (path: string) => boolean;
};

export interface ExtractRequest {
  archive: string;
  ext: "tar.gz" | "zip";
  sha256: string;
  pod: string;
  version: string;
  /** Strip the one top-level folder when every entry is under it (CocoaPods' `flatten`). */
  flatten: boolean;
  /**
   * Spec paths and globs, relative to the pod's root: vendored framework folders, resource_bundles globs, header
   * source_files, and a module map beside them (preserve_paths). A folder brings what is under it.
   */
  keep: string[];
  /** The vendored framework paths, which must exist afterwards. */
  required: string[];
}

/** Bumped when the extracted layout changes, so stamped trees are rebuilt. */
export const EXTRACTOR_VERSION = 1;
export const EXTRACTED_STAMP = ".rn-xtool-extracted.json";

interface ExtractedStamp {
  extractorVersion: number;
  sha256: string;
  keep: string[];
  flatten: boolean;
}

function readStamp(file: string): ExtractedStamp | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ExtractedStamp;
  } catch {
    return undefined;
  }
}

const sameStamp = (a: ExtractedStamp | undefined, b: ExtractedStamp): boolean =>
  a !== undefined &&
  a.extractorVersion === b.extractorVersion &&
  a.sha256 === b.sha256 &&
  a.flatten === b.flatten &&
  JSON.stringify(a.keep) === JSON.stringify(b.keep);

/** The one top-level folder every entry sits in, or undefined. */
function singleTopFolder(entries: readonly ArchiveEntry[]): string | undefined {
  const tops = new Set(entries.map((e) => segments(e.path)[0]).filter((s) => s !== undefined));
  if (tops.size !== 1) return undefined;
  const [top] = tops as Set<string>;
  const isFolder = entries.some((e) => {
    const parts = segments(e.path);
    return parts.length > 1 || (e.type === "dir" && parts.length === 1);
  });
  return isFolder ? top : undefined;
}

/** The top-level names below `root` (folders with a trailing slash), sorted, for the missing-path text. */
function topLevelNames(entries: readonly ArchiveEntry[], strip: number): string {
  const names = new Map<string, boolean>();
  for (const e of entries) {
    const parts = segments(e.path).slice(strip);
    if (parts.length === 0) continue;
    const folder = parts.length > 1 || e.type === "dir";
    names.set(parts[0]!, (names.get(parts[0]!) ?? false) || folder);
  }
  const shown = [...names].map(([n, folder]) => (folder ? `${n}/` : n)).sort();
  return shown.length === 0 ? "none" : shown.join(", ");
}

/** The entries to extract: those `keep` matches (or one of their folders does), and the targets of kept links. */
function selectEntries(entries: readonly ArchiveEntry[], keep: readonly string[], strip: number): ArchiveEntry[] {
  const rel = (e: ArchiveEntry): string[] => segments(e.path).slice(strip);
  const isMatch = keep.length === 0 ? () => false : micromatch.matcher([...keep], { dot: true });
  const matches = (parts: string[]): boolean => {
    for (let n = 1; n <= parts.length; n++) {
      if (isMatch(parts.slice(0, n).join("/"))) return true;
    }
    return false;
  };
  const links = new Map<string, string>();
  for (const e of entries) if (e.type === "symlink") links.set(segments(e.path).join("/"), e.target ?? "");
  const chosen = new Set<string>();
  const roots: string[][] = [];
  for (const e of entries) {
    const parts = rel(e);
    if (parts.length > 0 && matches(parts)) chosen.add(segments(e.path).join("/"));
  }
  // Kept links bring their targets (and what is under them), until nothing new is added.
  for (let added = true; added; ) {
    added = false;
    for (const e of entries) {
      const full = segments(e.path);
      if (!chosen.has(full.join("/")) || (e.type !== "symlink" && e.type !== "hardlink")) continue;
      const from = e.type === "symlink" ? resolveInside(links, [], full.slice(0, -1).join("/")) : [];
      const to = from === undefined ? undefined : resolveInside(links, from, e.target ?? "");
      if (to !== undefined && !roots.some((r) => r.join("/") === to.join("/"))) {
        roots.push(to);
        added = true;
      }
    }
    for (const e of entries) {
      const full = segments(e.path);
      const key = full.join("/");
      if (chosen.has(key)) continue;
      if (roots.some((r) => r.length <= full.length && r.every((s, i) => full[i] === s))) {
        chosen.add(key);
        added = true;
      }
    }
  }
  return entries.filter((e) => segments(e.path).length > strip && chosen.has(segments(e.path).join("/")));
}

/** Folders the owner can enter and files the owner can read, whatever modes the archive recorded. */
async function makeReadable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) await makeReadable(p);
    else if (d.isFile()) await chmod(p, (lstatSync(p).mode & 0o777) | 0o600);
  }
}

let sequence = 0;

/**
 * `<sha256>-<the first 16 hex digits of the stamp's sha256>`: a cache tree is named by its archive and by everything
 * its content depends on, so two selections of one archive never share a folder.
 */
export function treeName(sha256: string, stamp: unknown): string {
  return `${sha256}-${createHash("sha256").update(JSON.stringify(stamp)).digest("hex").slice(0, 16)}`;
}

/**
 * `<cache>/extracted/<sha256>-<stamp hash>`: the listing and its checks first; the members `keep` matches are extracted into
 * `<dest>.tmp-<pid>-<n>` (with `flatten`, from below the one top-level folder), `required` is checked, the stamp is
 * written last into the finished tree, and the tree is swapped in whole. A tree with the same stamp is reused; one
 * without it is rebuilt. A tree another build stamped meanwhile wins.
 */
export async function extractPod(
  req: ExtractRequest,
  cache: string,
  run: ListRunner = defaultListRunner,
  swap: typeof swapIn = swapIn,
): Promise<string> {
  const stamp: ExtractedStamp = {
    extractorVersion: EXTRACTOR_VERSION,
    sha256: req.sha256,
    keep: [...req.keep].sort(),
    flatten: req.flatten,
  };
  const dest = path.join(cache, "extracted", treeName(req.sha256, stamp));
  const stampFile = path.join(dest, EXTRACTED_STAMP);
  if (sameStamp(readStamp(stampFile), stamp)) return dest;

  const entries = await safeEntries(req.archive, req.ext, req, run);
  const top = req.flatten ? singleTopFolder(entries) : undefined;
  const strip = top === undefined ? 0 : 1;
  const selected = selectEntries(entries, stamp.keep, strip);

  const n = sequence++;
  const tmp = `${dest}.tmp-${process.pid}-${n}`;
  const work = `${tmp}.x`;
  try {
    await rm(tmp, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    if (selected.length > 0) {
      const tool = req.ext === "zip" ? "unzip" : "tar";
      try {
        if (req.ext === "tar.gz") {
          const list = `${tmp}.list`;
          await writeFile(list, selected.map((e) => `${e.path}\0`).join(""));
          try {
            await run("tar", [
              "-xzf", req.archive, "-C", work,
              "--no-same-owner", "--no-same-permissions", "--no-recursion", "--no-wildcards",
              "--null", "--verbatim-files-from", "-T", list,
            ]);
          } finally {
            await rm(list, { force: true });
          }
        } else {
          await run("unzip", ["-q", "-o", req.archive, ...selected.map((e) => unzipPattern(e.path)), "-d", work]);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && tool === "unzip") {
          throw new PodsError(
            `${req.pod} ${req.version} is a .zip download, and unzip is not installed. Install it (sudo apt install unzip) and build again.`,
          );
        }
        throw err;
      }
    }
    const root = top === undefined ? work : path.join(work, top);
    if (!existsSync(root)) await mkdir(root, { recursive: true });
    await rename(root, tmp);
    await makeReadable(tmp);
    for (const p of req.required) {
      if (lstatSync(path.join(tmp, p), { throwIfNoEntry: false }) === undefined) {
        throw new PodsError(
          `${req.pod} ${req.version}: its spec names ${p}, which the download does not hold. Its top-level entries: ${topLevelNames(entries, strip)}. See ${PODS_LINK}`,
        );
      }
    }
    await writeFile(path.join(tmp, EXTRACTED_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
    if (sameStamp(readStamp(stampFile), stamp)) return dest;
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await swap(tmp, dest, `${dest}.old-${process.pid}-${n}`);
    } catch (err) {
      // Another build swapped its tree in between the check and the swap: the stamped tree wins.
      if (sameStamp(readStamp(stampFile), stamp)) return dest;
      throw err;
    }
    return dest;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
