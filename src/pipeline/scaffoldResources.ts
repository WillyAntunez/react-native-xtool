/**
 * The resources a scaffolded library's podspec declares. The scaffolder writes no resources into its Package.swift:
 * rn-xtool builds the `resource_bundles` it can read into `App.app` (`scaffoldedResourceBundles`), and names the rest in
 * one ℹ line (`unbundledResources`). Podspecs are read as text, never evaluated.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { projectPaths } from "../paths.js";
import {
  attribute,
  carriesModifier,
  podspecFiles,
  podspecLines,
  readJson,
  rubyCode,
  unconditionalLineIndexes,
} from "../project/podspecs.js";
import { DuplicateBundleFileError, bundleFiles, type BundleSource } from "./resourceBundles.js";

/** Every file the scaffolder generates carries this (SCAFFOLDER_MARKER in vendor/rn-spm/spm/scaffold-package-swift.js). */
const SCAFFOLDER_BANNER = "AUTO-SCAFFOLDED by react-native spm scaffold";
const RESOURCE_BUNDLES = attribute("resource_bundles");
const RESOURCES = attribute("resources?");
const STRING = /(["'])((?:(?!\1)[^\\]|\\.)*)\1/g;
const BUNDLE_ENTRY = /(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*=>\s*(\[[^\]]*\]|(["'])(?:(?!\4)[^\\]|\\.)*\4)/g;

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `line` without its Ruby comment: a `#` outside any string. */
function withoutComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== undefined) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/**
 * The value assigned on `lines[at]`, with the raw lines that follow it until its brackets close (counted in their code,
 * where strings and comments are blanked). Undefined when they never close, or when the closing line carries an
 * `if`/`unless` modifier: then the whole assignment may not apply.
 */
function assignedValue(lines: string[], at: number): string | undefined {
  let depth = 0;
  const parts: string[] = [];
  for (let i = at; i < lines.length; i++) {
    const cut = (s: string) => (i === at ? s.slice(s.search(/=(?!=)/) + 1) : s);
    const code = cut(rubyCode(lines[i]!));
    parts.push(withoutComment(cut(lines[i]!)));
    depth += (code.match(/[[{(]/g) ?? []).length - (code.match(/[\]})]/g) ?? []).length;
    if (depth <= 0) return i > at && carriesModifier(rubyCode(lines[i]!)) ? undefined : parts.join("\n");
  }
  return undefined;
}

const strings = (text: string) => [...text.matchAll(STRING)].map((m) => m[2]!);

/** A Ruby string literal's value, or undefined when it interpolates (`"#{…}"`). */
function literal(quote: string, body: string): string | undefined {
  if (quote === '"' && body.includes("#{")) return undefined;
  return body.replace(/\\(.)/g, "$1");
}

/** The globs of a bundle's value (a string, or an array of strings), or undefined when one is not a literal string. */
function literalGlobs(value: string): string[] | undefined {
  const globs: string[] = [];
  for (const m of value.matchAll(STRING)) {
    const glob = literal(m[1]!, m[2]!);
    if (glob === undefined) return undefined;
    globs.push(glob);
  }
  // Anything besides the strings, commas and brackets is Ruby code (a variable, a method call).
  const rest = value.replace(STRING, "").replace(/[[\],\s]/g, "");
  return rest === "" && globs.length > 0 ? globs : undefined;
}

interface PodspecResources {
  /** What does not reach the app: plain resources by basename, unreadable bundles by `<key>.bundle`. */
  items: string[];
  /** The bundles rn-xtool builds: key → globs, in podspec order. */
  bundles: Map<string, string[]>;
}

/**
 * One podspec's resources: each `resource_bundles` entry whose key is literal (or `#{s.name}`-style) and whose globs
 * are literal strings is a bundle rn-xtool builds (a key given twice, for every platform and for iOS, merges its
 * globs); any other bundle is named by its key, and a plain resource by its basename.
 */
function podspecResources(text: string): PodspecResources {
  const lines = podspecLines(text);
  const podName = /\.name\s*=\s*(["'])([^"'#]+)\1/.exec(text)?.[2];
  const items: string[] = [];
  const bundles = new Map<string, string[]>();
  for (const at of unconditionalLineIndexes(text)) {
    const line = rubyCode(lines[at]!);
    if (RESOURCE_BUNDLES.test(line)) {
      for (const m of (assignedValue(lines, at) ?? "").matchAll(BUNDLE_ENTRY)) {
        const raw = podName === undefined ? m[2]! : m[2]!.replace(/#\{\w+\.name\}/g, podName);
        const key = literal(m[1]!, raw);
        const globs = literalGlobs(m[3]!);
        if (key === undefined || globs === undefined) {
          items.push(`${raw}.bundle`);
          continue;
        }
        const known = bundles.get(key) ?? [];
        bundles.set(key, [...known, ...globs.filter((g) => !known.includes(g))]);
      }
    } else if (RESOURCES.test(line)) {
      items.push(...strings(assignedValue(lines, at) ?? "").map((g) => path.basename(g)));
    }
  }
  return { items, bundles };
}

const ANY_RESOURCE_BUNDLES = attribute("resource_bundles?");

/**
 * Whether rn-xtool builds every resource bundle a podspec declares, when its library is scaffolded: at least one, each
 * on an unconditional `resource_bundles` line whose hash holds only literal keys and globs. Doctor's podspecs line
 * names only the others.
 */
export function buildsEveryResourceBundle(text: string): boolean {
  const lines = podspecLines(text);
  const unconditional = new Set(unconditionalLineIndexes(text));
  const podName = /\.name\s*=\s*(["'])([^"'#]+)\1/.exec(text)?.[2];
  let found = false;
  for (let at = 0; at < lines.length; at++) {
    const code = rubyCode(lines[at]!);
    if (!ANY_RESOURCE_BUNDLES.test(code)) continue;
    if (!unconditional.has(at) || !RESOURCE_BUNDLES.test(code)) return false;
    const value = assignedValue(lines, at);
    if (value === undefined) return false;
    for (const m of value.matchAll(BUNDLE_ENTRY)) {
      const raw = podName === undefined ? m[2]! : m[2]!.replace(/#\{\w+\.name\}/g, podName);
      if (literal(m[1]!, raw) === undefined || literalGlobs(m[3]!) === undefined) return false;
      found = true;
    }
    // Anything besides the entries is Ruby code: a variable, a method call.
    if (value.replace(BUNDLE_ENTRY, "").replace(/[{}(),\s]/g, "") !== "") return false;
  }
  return found;
}

/** Each dependency autolinking.json lists for iOS whose Package.swift rn-xtool's scaffolder wrote, sorted by name, with its podspecs. */
function scaffoldedLibraries(projectRoot: string): { pkg: string; podspecs: string[] }[] {
  const json = readJson(path.join(projectPaths(projectRoot).autolinking, "autolinking.json"));
  const deps: unknown = json?.dependencies;
  if (deps === null || typeof deps !== "object") return [];
  const found: { pkg: string; podspecs: string[] }[] = [];
  for (const [pkg, dep] of Object.entries(deps as Record<string, { root?: unknown; platforms?: { ios?: unknown } }>)) {
    const ios = dep?.platforms?.ios as { podspecPath?: unknown } | null | undefined;
    if (ios === null || typeof ios !== "object" || typeof dep.root !== "string") continue;
    if (!readText(path.join(dep.root, "Package.swift"))?.includes(SCAFFOLDER_BANNER)) continue;
    const podspecs = typeof ios.podspecPath === "string" && ios.podspecPath !== "" ? [ios.podspecPath] : podspecFiles(dep.root);
    found.push({ pkg, podspecs });
  }
  return found.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
}

/**
 * The resources scaffolded libraries declare that do not reach the app, per library (sorted by name): plain
 * `s.resources` by basename, and `resource_bundles` entries rn-xtool cannot read (an interpolated key or glob) by
 * `<key>.bundle`. Unconditional `s.` and `s.ios.` lines only (other platforms' are ignored). Libraries without any are
 * left out.
 */
export function unbundledResources(projectRoot: string): { pkg: string; items: string[] }[] {
  const found: { pkg: string; items: string[] }[] = [];
  for (const { pkg, podspecs } of scaffoldedLibraries(projectRoot)) {
    const items = [...new Set(podspecs.flatMap((f) => podspecResources(readText(f) ?? "").items))];
    if (items.length > 0) found.push({ pkg, items });
  }
  return found;
}

/**
 * The `resource_bundles` of the scaffolded libraries that rn-xtool builds (spec goal 4.2): one source per literal key,
 * its globs relative to the podspec's folder, owned by the npm package. Read after rn-spm, as `unbundledResources`.
 */
export function scaffoldedResourceBundles(projectRoot: string): BundleSource[] {
  const sources: BundleSource[] = [];
  for (const { pkg, podspecs } of scaffoldedLibraries(projectRoot)) {
    for (const file of podspecs) {
      for (const [key, globs] of podspecResources(readText(file) ?? "").bundles) {
        sources.push({ key, baseDir: path.dirname(file), globs, owner: pkg, library: true });
      }
    }
  }
  return sources;
}

/**
 * The scaffolded libraries' bundles rn-xtool can build, and those that would hold two files under one name, as
 * `<key>.bundle` per library for the ℹ line (row 86: block 2 left such a bundle out and built on). A binary pod's
 * bundle keeps the stop.
 */
export function placeableBundles(sources: readonly BundleSource[]): { bundles: BundleSource[]; left: { pkg: string; items: string[] }[] } {
  const bundles: BundleSource[] = [];
  const left: { pkg: string; items: string[] }[] = [];
  for (const s of sources) {
    try {
      bundleFiles(s);
      bundles.push(s);
    } catch (err) {
      if (!(err instanceof DuplicateBundleFileError)) throw err;
      left.push({ pkg: s.owner, items: [`${s.key}.bundle`] });
    }
  }
  return { bundles, left: withUnbundled([], left) };
}

/** `list` with `more`'s items added to their library's (sorted by name), each item once. */
export function withUnbundled(
  list: readonly { pkg: string; items: string[] }[],
  more: readonly { pkg: string; items: string[] }[],
): { pkg: string; items: string[] }[] {
  const byPkg = new Map<string, string[]>(list.map((l) => [l.pkg, [...l.items]]));
  for (const m of more) {
    const items = byPkg.get(m.pkg) ?? [];
    byPkg.set(m.pkg, [...items, ...m.items.filter((i) => !items.includes(i))]);
  }
  return [...byPkg]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pkg, items]) => ({ pkg, items }));
}

/**
 * The build's one `ℹ` line naming them; undefined when there are none. When every item is a privacy manifest, it says
 * development builds run without them; otherwise that code loading them at run time does not find them.
 */
export function unbundledResourcesLine(list: { pkg: string; items: string[] }[]): string | undefined {
  if (list.length === 0) return undefined;
  const privacyOnly = list.every((l) => l.items.every((i) => i.endsWith(".xcprivacy")));
  return (
    `ℹ Not copied into the app: ${list.map((l) => `${l.pkg} (${l.items.join(", ")})`).join(", ")}. ` +
    (privacyOnly
      ? "Development builds run without them; privacy manifests are read only at App Store submission."
      : "Code that loads them at run time does not find them.")
  );
}
