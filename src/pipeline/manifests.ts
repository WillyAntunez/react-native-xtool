import { existsSync } from "node:fs";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A known non-portable snippet in a library's own `Package.swift`. SwiftPM compiles manifests on the host, so Darwin-only
 * APIs there break the build on Linux. Keyed on content, not on library versions: any manifest with the snippet is fixed.
 */
export interface ManifestFix {
  /** The non-portable API, shown in the log line. */
  name: string;
  /** Any use of the API. Uses inside `#if canImport(Darwin)` and in comments are portable and do not count. */
  symbol: RegExp;
  /** The known non-portable form (global). Rewritten only when it occurs exactly once, in plain code. */
  broken: RegExp;
  /** Its portable form (a `String.replace` replacement for `broken`). */
  portable: string;
  /** Edits that come with the fix only (comments), so the result matches the documented patch byte for byte. */
  companions: readonly { pattern: RegExp; replacement: string }[];
}

/** docs/upstream/reanimated-worklets-manifest.md: react-native-reanimated 4.7.1, react-native-worklets 0.13.0 and 0.13.1. */
const CF_BOOLEAN: ManifestFix = {
  name: "CFGetTypeID",
  symbol: /\bCF(?:Boolean)?GetTypeID\b/,
  broken:
    /^([ \t]*)if[ \t]+CFGetTypeID\([ \t]*([A-Za-z_]\w*)[ \t]*\)[ \t]*==[ \t]*CFBooleanGetTypeID\([ \t]*\)[ \t]*\{[ \t]*$/gm,
  portable: [
    "#if canImport(Darwin)",
    "$1let isBoolean = CFGetTypeID($2) == CFBooleanGetTypeID()",
    "#else",
    '$1let isBoolean = String(cString: $2.objCType) == "c"',
    "#endif",
    "$1if isBoolean {",
  ].join("\n"),
  companions: [
    {
      pattern: /^([ \t]*)\/\/ NSNumber needs the CFBoolean check to tell booleans apart from integers\.[ \t]*$/m,
      replacement: [
        "$1// NSNumber needs a boolean check to tell booleans apart from integers.",
        "$1// CFGetTypeID/CFBooleanGetTypeID only exist on Darwin; this manifest is also",
        "$1// evaluated on Linux hosts (swift-corelibs-foundation), where JSON booleans",
        '$1// are NSNumbers with objCType "c".',
      ].join("\n"),
    },
  ],
};

/** Known non-portable manifest snippets → portable replacements; a new case is one entry. */
export const MANIFEST_FIXES: readonly ManifestFix[] = [CF_BOOLEAN];

/** String literals (multi-line ones first) are matched so that `//` or `/*` inside one is not taken for a comment. */
const STRINGS_OR_COMMENTS = /"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/.*$/gm;
const DARWIN_ONLY = /^[ \t]*#if[ \t]+canImport\(Darwin\)[ \t]*$[\s\S]*?^[ \t]*#(?:else|endif)\b/gm;

/** The code the Linux host compiles: no comments, no `#if canImport(Darwin)` branches. */
function linuxCode(text: string): string {
  return text.replace(STRINGS_OR_COMMENTS, (m) => (m.startsWith('"') ? m : "")).replace(DARWIN_ONLY, "");
}

/** The MANIFEST_FIXES names whose API the Linux host would still compile in this manifest (comments and Darwin branches left out). */
export function unportableSymbols(text: string): string[] {
  const code = linuxCode(text.replace(/\r\n/g, "\n"));
  return MANIFEST_FIXES.filter((f) => f.symbol.test(code)).map((f) => f.name);
}

/** True when `match` at `index` is plain code: not in a comment or string, and not under any `#if`. */
function inPlainCode(text: string, index: number, match: string): boolean {
  // Comments and strings blanked, newlines kept, so offsets and lines stay put.
  const code = text.replace(STRINGS_OR_COMMENTS, (m) => m.replace(/[^\n]/g, " "));
  if (code.slice(index, index + match.length) !== match) return false;
  let depth = 0;
  for (const line of code.slice(0, index).split("\n")) {
    if (/^[ \t]*#if\b/.test(line)) depth++;
    else if (/^[ \t]*#endif\b/.test(line)) depth--;
  }
  return depth === 0;
}

const UNCHANGED = (text: string) => ({ text, fixes: [] as string[] });

function rewrite(text: string): { text: string; fixes: string[] } {
  let out = text;
  const fixes: string[] = [];
  for (const fix of MANIFEST_FIXES) {
    const matches = [...out.matchAll(fix.broken)];
    if (matches.length === 0) continue;
    const m = matches[0]!;
    if (matches.length > 1 || !inPlainCode(out, m.index, m[0])) return UNCHANGED(text);
    const next = out.replace(fix.broken, fix.portable);
    out = fix.companions.reduce((t, c) => t.replace(c.pattern, c.replacement), next);
    fixes.push(fix.name);
  }
  if (fixes.length === 0 || unportableSymbols(out).length > 0) return UNCHANGED(text);
  return { text: out, fixes };
}

/**
 * Rewrites the known non-portable snippets in a manifest. All or nothing: the manifest is returned unchanged with no
 * fixes when a snippet occurs more than once, or in a comment, a string or under an `#if`, when any non-portable API
 * would remain (a form no entry knows), or when its line endings are mixed. CRLF files stay CRLF.
 */
export function makeManifestPortable(text: string): { text: string; fixes: string[] } {
  if (!text.includes("\r")) return rewrite(text);
  const lf = text.replace(/\r\n/g, "\n");
  if (lf.replace(/\n/g, "\r\n") !== text) return UNCHANGED(text);
  const r = rewrite(lf);
  return r.fixes.length === 0 ? UNCHANGED(text) : { text: r.text.replace(/\n/g, "\r\n"), fixes: r.fixes };
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * Installed packages that ship a manifest: `node_modules/*` and `node_modules/@*\/*`, sorted. Autolinking resolves the
 * app's native libraries from the top level, and its list is only known inside rn-spm.
 */
export async function packagesWithManifest(root: string): Promise<{ pkg: string; dir: string }[]> {
  const modules = path.join(root, "node_modules");
  const found: { pkg: string; dir: string }[] = [];
  for (const name of await entries(modules)) {
    const names = name.startsWith("@") ? (await entries(path.join(modules, name))).map((n) => `${name}/${n}`) : [name];
    for (const pkg of names) {
      const dir = path.join(modules, pkg);
      if (existsSync(path.join(dir, "Package.swift"))) found.push({ pkg, dir });
    }
  }
  return found.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
}

const VERSIONED_MANIFEST = /^Package@swift-\d+(?:\.\d+){0,2}\.swift$/;

/** The manifests SwiftPM may read in a package directory: Package.swift, then each Package@swift-*.swift, sorted. */
export async function manifestFiles(dir: string): Promise<string[]> {
  return ["Package.swift", ...(await entries(dir)).filter((n) => VERSIONED_MANIFEST.test(n)).sort()];
}

/** A library manifest that needs the fix could not be written (read-only `node_modules`). */
export class ManifestWriteError extends Error {
  constructor(file: string, code: string) {
    super(
      `Could not write ${file} (${code}) to make it portable to Linux: ` +
        "node_modules is read-only; make it writable or apply the portable manifest yourself.",
    );
    this.name = "ManifestWriteError";
  }
}

const READ_ONLY_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

/** True when `real` lies outside `realModules` (npm link, `file:` dependencies, workspaces). */
export function outside(realModules: string, real: string): boolean {
  const rel = path.relative(realModules, real);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Before rn-spm (after patch-package): makes the installed libraries' own manifests portable to Linux, one log line
 * per library fixed. Idempotent, so a project's persisted patch-package fix from the old docs stays harmless.
 * A package linked from outside the project's `node_modules` is never written: it gets a "skipped" line instead.
 */
export async function fixLibraryManifests(root: string, log: (line: string) => void): Promise<void> {
  const found = await packagesWithManifest(root);
  if (found.length === 0) return;
  const realRoot = await realpath(root);
  const realModules = await realpath(path.join(root, "node_modules"));
  for (const { pkg, dir } of found) {
    const real = await realpath(dir);
    const linked = outside(realModules, real);
    const files = await manifestFiles(dir);
    const fixedFiles: string[] = [];
    const names = new Set<string>();
    for (const file of files) {
      const p = path.join(dir, file);
      let text: string;
      try {
        text = await readFile(p, "utf8");
      } catch {
        continue; // unreadable: SwiftPM reports it if the app uses the library
      }
      const r = makeManifestPortable(text);
      if (r.fixes.length === 0) continue;
      fixedFiles.push(file);
      for (const n of r.fixes) names.add(n);
      if (linked) continue;
      try {
        await writeFile(p, r.text);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== undefined && READ_ONLY_CODES.has(code)) throw new ManifestWriteError(path.relative(root, p), code);
        throw e;
      }
    }
    if (fixedFiles.length === 0) continue;
    if (linked) {
      log(`manifest — skipped ${pkg}: it is a link to ${path.relative(realRoot, real)}; apply the portable manifest in its source`);
    } else {
      log(`manifest — made ${pkg}'s ${fixedFiles.join(" and ")} portable to Linux (${[...names].join(", ")})`);
    }
  }
}
