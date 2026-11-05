/**
 * Headers-only library xcframeworks for binary pods (spec goal 2.3, open question 1): one `ios-arm64` slice whose
 * `LibraryPath` is the empty placeholder archive, with the framework's headers and module map under
 * `Headers/<Name>/`, the shape of ExpoModulesJSIHeaders. The real archive is linked once, elsewhere.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EMPTY_AR_ARCHIVE, headersXcframeworkInfoPlist, type XcframeworkLibrary } from "../pipeline/rnArtifacts.js";
import { PODS_LINK, PodsError } from "./format.js";

export const POD_SLICE: XcframeworkLibrary = {
  LibraryIdentifier: "ios-arm64",
  SupportedPlatform: "ios",
  SupportedArchitectures: ["arm64"],
};

interface Token {
  word: string;
  start: number;
  depth: number;
}

/** The identifiers of a module map with their offsets and brace depth; comments and strings are skipped. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))!;
      out.push({ word: m[0], start: i, depth });
      i += m[0].length;
    } else {
      i++;
    }
  }
  return out;
}

function cannotRewrite(label: string, rel: string, what: string): PodsError {
  return new PodsError(`${label}: ${rel} names the framework bundle (${what}), which rn-xtool cannot rewrite for SwiftPM. See ${PODS_LINK}`);
}

/**
 * Drops the leading `framework` of the one top-level `framework module <Name>`, and keeps everything else (umbrella,
 * export, `module *`, every `link` line, comments). A map without a framework module is returned as it is. Throws on a
 * framework submodule (`explicit framework module`, or one inside another module) or a second framework module.
 */
export function rewriteFrameworkModuleMap(text: string, file: string, label: string): string {
  const words = tokens(text);
  let drop: { start: number; end: number } | undefined;
  for (let n = 0; n < words.length; n++) {
    const t = words[n]!;
    if (t.word !== "framework" || words[n - 1]?.word === "link") continue;
    if (words[n + 1]?.word !== "module") continue;
    if (words[n - 1]?.word === "explicit" || t.depth > 0) throw cannotRewrite(label, file, "a framework submodule");
    if (drop !== undefined) throw cannotRewrite(label, file, "another framework module");
    drop = { start: t.start, end: words[n + 1]!.start };
  }
  return drop === undefined ? text : text.slice(0, drop.start) + text.slice(drop.end);
}

/** The module map of a framework that ships none, from its umbrella header `<name>.h`. */
export function generatedModuleMap(name: string): string {
  return `module ${name} {\n  umbrella header "${name}.h"\n  export *\n  module * { export * }\n}\n`;
}

/**
 * The module map for `<name>.framework` at `framework` (`rel` for the texts): its `Modules/module.modulemap`
 * rewritten, or one generated from `Headers/<name>.h`. A `Modules/module.private.modulemap` stops (row 31), and so
 * does a framework with neither (row 30).
 */
export async function frameworkModuleMap(framework: string, name: string, rel: string, label: string): Promise<string> {
  if (existsSync(path.join(framework, "Modules", "module.private.modulemap"))) {
    throw cannotRewrite(label, `${rel}/Modules/module.private.modulemap`, "a module.private.modulemap");
  }
  const map = path.join(framework, "Modules", "module.modulemap");
  if (existsSync(map)) return rewriteFrameworkModuleMap(await readFile(map, "utf8"), `${rel}/Modules/module.modulemap`, label);
  if (existsSync(path.join(framework, "Headers", `${name}.h`))) return generatedModuleMap(name);
  throw new PodsError(
    `${label}: ${rel} has no Modules/module.modulemap and no Headers/${name}.h, so rn-xtool cannot make a module for it. See ${PODS_LINK}`,
  );
}

/**
 * `<dir>/<name>.xcframework`: `Info.plist` from headersXcframeworkInfoPlist with the one `ios-arm64` slice, the empty
 * placeholder archive `ios-arm64/lib<name>-ios-arm64.a`, and `ios-arm64/Headers/<name>/` with `files` (relative to
 * `from`, folders kept) and `module.modulemap`.
 */
export async function writeHeadersXcframework(
  dir: string,
  name: string,
  headers: { from: string; files: string[] },
  moduleMap: string,
): Promise<string> {
  const xcf = path.join(dir, `${name}.xcframework`);
  const slice = path.join(xcf, POD_SLICE.LibraryIdentifier);
  const into = path.join(slice, "Headers", name);
  await mkdir(into, { recursive: true });
  for (const f of headers.files) {
    const to = path.join(into, f);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(path.join(headers.from, f), to);
  }
  await writeFile(path.join(into, "module.modulemap"), moduleMap);
  await writeFile(path.join(slice, `lib${name}-${POD_SLICE.LibraryIdentifier}.a`), EMPTY_AR_ARCHIVE);
  await writeFile(path.join(xcf, "Info.plist"), headersXcframeworkInfoPlist(name, [POD_SLICE]));
  return xcf;
}
