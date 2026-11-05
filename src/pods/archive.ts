/**
 * A pod's archive is listed before anything is extracted: an entry with an absolute path, a `..` segment, a device or
 * special file, or a link that resolves outside the archive (through the archive's own links too) refuses the whole
 * archive. Tar archives are listed with GNU tar (C-quoted names, so no name can pass for a link target), zip archives
 * with `unzip -Z`, a zip symlink's target with `unzip -p`.
 */
import path from "node:path";
import { execa } from "execa";
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

const defaultRunner: ListRunner = async (cmd, args) => {
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
export async function listArchive(file: string, ext: "tar.gz" | "zip", run: ListRunner = defaultRunner): Promise<ArchiveEntry[]> {
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
function resolveInside(links: ReadonlyMap<string, string>, start: string[], rel: string): string[] | undefined {
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
