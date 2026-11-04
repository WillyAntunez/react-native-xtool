/**
 * The resources a scaffolded library's podspec declares, which do not reach the app: the scaffolder writes no
 * resources into its Package.swift, and rn-xtool copies no bundle into `App.app`. Podspecs are read as text, never
 * evaluated.
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

/** The names of one podspec's resources: a bundle of privacy manifests only by its files, another bundle by its key. */
function podspecResources(text: string): string[] {
  const lines = podspecLines(text);
  const podName = /\.name\s*=\s*(["'])([^"'#]+)\1/.exec(text)?.[2];
  const items: string[] = [];
  for (const at of unconditionalLineIndexes(text)) {
    const line = rubyCode(lines[at]!);
    if (RESOURCE_BUNDLES.test(line)) {
      for (const m of (assignedValue(lines, at) ?? "").matchAll(BUNDLE_ENTRY)) {
        const globs = strings(m[3]!);
        if (globs.length > 0 && globs.every((g) => g.endsWith(".xcprivacy"))) items.push(...globs.map((g) => path.basename(g)));
        else items.push(`${podName === undefined ? m[2]! : m[2]!.replace(/#\{\w+\.name\}/g, podName)}.bundle`);
      }
    } else if (RESOURCES.test(line)) {
      items.push(...strings(assignedValue(lines, at) ?? "").map((g) => path.basename(g)));
    }
  }
  return items;
}

/**
 * For each dependency autolinking.json lists for iOS whose Package.swift rn-xtool's scaffolder wrote, sorted by name:
 * its podspecs' unconditional `s.resource_bundles` / `s.ios.resource_bundles` (other platforms' are ignored) and
 * `s.resources`. A bundle whose globs all end in `.xcprivacy` is named by the files' basenames, any other bundle
 * `<key>.bundle`, and a plain resource by its basename. Libraries without any are left out.
 */
export function unbundledResources(projectRoot: string): { pkg: string; items: string[] }[] {
  const json = readJson(path.join(projectPaths(projectRoot).autolinking, "autolinking.json"));
  const deps: unknown = json?.dependencies;
  if (deps === null || typeof deps !== "object") return [];
  const found: { pkg: string; items: string[] }[] = [];
  for (const [pkg, dep] of Object.entries(deps as Record<string, { root?: unknown; platforms?: { ios?: unknown } }>)) {
    const ios = dep?.platforms?.ios as { podspecPath?: unknown } | null | undefined;
    if (ios === null || typeof ios !== "object" || typeof dep.root !== "string") continue;
    if (!readText(path.join(dep.root, "Package.swift"))?.includes(SCAFFOLDER_BANNER)) continue;
    const podspecs = typeof ios.podspecPath === "string" && ios.podspecPath !== "" ? [ios.podspecPath] : podspecFiles(dep.root);
    const items = [...new Set(podspecs.flatMap((f) => podspecResources(readText(f) ?? "")))];
    if (items.length > 0) found.push({ pkg, items });
  }
  return found.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
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
