// B1's include resolution (spec "B. The app target's checks", rows 30–37): each `#import`/`#include` the scanner
// returns for an app file, looked up as clang looks it up in the generated App target. Pure: each file's text is read
// once, every other question goes to `IncludeScope.exists`. Pass 1 (`appIncludesPass1`) runs it over the app's copy
// before the copy exists, with no toolchain: file-system reads only.

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { bareCopyLayout } from "../generate/bareSources.js";
import { definesOf, scanIncludes } from "./includeScan.js";
import type { BareTargetContent } from "./pbxproj.js";
import { dependencyDirs, packageDir } from "./podspecs.js";

export interface IncludeScope {
  /** `path`: where the file sits in the copy; `source`: where its text is read; `display`: how messages name it. */
  files: { path: string; source: string; display: string }[];
  exists: (p: string) => boolean;
  /** The include folders, in clang's order (after the including file's folder for a quote include). */
  includeDirs: string[];
  defines: ReadonlyMap<string, string>;
}

export interface ResolvedInclude {
  /** The `display` of the including file. */
  file: string;
  line: number;
  spelling: string;
  angle: boolean;
  certain: boolean;
  /** The path that answered; absent when no folder did, and for a generated header. */
  found?: string;
  /** The folders looked in, in order, up to the one that answered; empty for a generated header or an absolute spelling. */
  searched: string[];
  /** Xcode's generated Swift header (`*-Swift.h`): the build writes it, so it is never looked up (row 36). */
  generated: boolean;
}

const isGenerated = (spelling: string): boolean => path.posix.basename(spelling).endsWith("-Swift.h");

/**
 * Resolves the includes of every file in `scope`: a quote include in the including file's copy folder, then in
 * `includeDirs` in order; an angle include in `includeDirs` in order; an absolute spelling as it is. `__has_include`
 * asks the same lookup: true when it finds the header, unknown otherwise (the header may come from a folder the scope
 * lacks, so its branch stays uncertain).
 */
export function resolveIncludes(scope: IncludeScope): ResolvedInclude[] {
  const lookup = (from: string, spelling: string, angle: boolean): { found?: string; searched: string[] } => {
    // Clang opens an absolute spelling as it is, in no folder.
    if (path.isAbsolute(spelling)) return scope.exists(spelling) ? { found: spelling, searched: [] } : { searched: [] };
    const searched: string[] = [];
    for (const dir of angle ? scope.includeDirs : [path.dirname(from), ...scope.includeDirs]) {
      searched.push(dir);
      const candidate = path.join(dir, spelling);
      if (scope.exists(candidate)) return { found: candidate, searched };
    }
    return { searched };
  };

  const out: ResolvedInclude[] = [];
  for (const file of scope.files) {
    const text = readFileSync(file.source, "utf8");
    const hasInclude = (spelling: string, angle: boolean): boolean | undefined =>
      !isGenerated(spelling) && lookup(file.path, spelling, angle).found !== undefined ? true : undefined;
    for (const inc of scanIncludes(text, { defines: scope.defines, hasInclude })) {
      const generated = isGenerated(inc.spelling);
      const { found, searched } = generated ? { found: undefined, searched: [] } : lookup(file.path, inc.spelling, inc.angle);
      out.push({ file: file.display, ...inc, ...(found !== undefined ? { found } : {}), searched, generated });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 1 (rows 30–32): the app's own includes, before staging.

/** The copy's folder of header forwards (`Sources/App/include`), as `copyBareTarget` writes it. */
const INCLUDE_DIR = "include";
const HEADER = /\.(h|hpp)$/i;

/**
 * Base name → the header files (`.h`, `.hpp`) under the installed `react-native` and each of the project's installed
 * `dependencies`. A dependency's own `node_modules` and its dot folders are not walked; symbolic links to folders are
 * not followed.
 */
export function dependencyHeaderIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
      } else if (HEADER.test(e.name)) {
        index.set(e.name, [...(index.get(e.name) ?? []), p]);
      }
    }
  };
  const rn = packageDir(root, "react-native");
  for (const dir of new Set([...(rn === undefined ? [] : [rn]), ...dependencyDirs(root).map((d) => d.dir)])) walk(dir);
  return index;
}

/** `p` relative to the project root, with forward slashes; as it is when outside the root. */
function fromRoot(root: string, p: string): string {
  const rel = path.relative(root, p);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? p : rel.split(path.sep).join("/");
}

/**
 * The files pass 1 reads: the app target's C-family sources, its kept headers and its bridging header, each at its
 * place in the copy under `sources` (`bareCopyLayout`), named relative to the project root (`ios/ObjcApp/main.m`). A
 * listed file missing on disk is left out: the copy stops on it with its own message.
 */
export function bareScope(
  bare: BareTargetContent,
  iosDir: string,
  iosTargetDir: string,
  sources: string,
  root: string,
): IncludeScope["files"] {
  const swift = new Set(bare.swiftSources);
  return bareCopyLayout(bare, iosDir, iosTargetDir)
    .files.filter(({ file }) => !swift.has(file) && existsSync(file.absPath))
    .map(({ file, dest }) => ({ path: path.join(sources, dest), source: file.absPath, display: fromRoot(root, file.absPath) }));
}

export interface Pass1Input {
  root: string;
  files: IncludeScope["files"];
  /** A header's base name → its place in the copy, relative to `sources` (`BareCopyLayout.forwards`). */
  forwards: Map<string, string>;
  /** Where the copy goes (`ios-xtool/Sources/App`); it is not read: the build writes it afresh. */
  sources: string;
  /** Absolute, in the project's order. */
  headerSearchPaths: string[];
  /** The target's `GCC_PREPROCESSOR_DEFINITIONS` entries. */
  defines: string[];
  /** The project uses binary pods, whose headers pass 1 cannot see. */
  binaryPods: boolean;
}

export interface Pass1Result {
  /** One line per app-own include that resolves nowhere (row 30), without the `✖ ` mark. */
  missing: string[];
  /** Includes left to the build: React Native's or the libraries' headers (row 32). */
  pending: number;
  /** The certain includes that resolved. */
  checked: number;
}

/** "a, b or c" */
function orList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * Pass 1 of B1: the includes of `files` resolved in the app's copy as the generated App target compiles it, before
 * the copy exists. The include folders are `<sources>/include` (the forwards) then the header search paths; under
 * `sources` only the copy's planned files and forwards exist, elsewhere the disk answers. Only a certain include
 * counts (R6): resolved → `checked`; an angle miss, and a quote miss whose base name an installed dependency's header
 * (`react-native` or a `dependencies` entry, any folder) carries or that binary pods may provide → `pending`; any
 * other quote miss → `missing`. Uncertain includes and
 * Xcode's generated Swift headers count nowhere.
 */
export function appIncludesPass1(i: Pass1Input): Pass1Result {
  const include = path.join(i.sources, INCLUDE_DIR);
  /** Each place in the copy → the source file it holds, named from the project root. */
  const copy = new Map(i.files.map((f) => [f.path, f.display]));
  for (const [base, dest] of i.forwards) {
    const held = copy.get(path.join(i.sources, dest));
    if (held !== undefined) copy.set(path.join(include, base), held);
  }
  const inCopy = (p: string): boolean => p === i.sources || p.startsWith(`${i.sources}${path.sep}`);
  const exists = (p: string): boolean => copy.has(p) || (!inCopy(p) && existsSync(p));
  const results = resolveIncludes({
    files: i.files,
    exists,
    includeDirs: [include, ...i.headerSearchPaths],
    defines: definesOf(i.defines),
  });

  // By base name only: the build may find the header in another layout than the source tree's (React Native's staged
  // `React/` headers for `React/Base/RCTBridgeModule.h`, a pod's `header_dir`), so any header of that name defers.
  let index: Map<string, string[]> | undefined;
  const dependencyProvides = (spelling: string): boolean => {
    index ??= dependencyHeaderIndex(i.root);
    return index.has(path.posix.basename(spelling));
  };

  /** A file whose path matches `p` but for case: in the copy, or on disk outside it. */
  const caseTwin = (p: string): string | undefined => {
    const lower = p.toLowerCase();
    for (const [place, display] of copy) if (place.toLowerCase() === lower) return display;
    if (inCopy(p)) return undefined;
    let at = path.parse(p).root;
    for (const part of path.relative(at, p).split(path.sep)) {
      let names: string[];
      try {
        names = readdirSync(at);
      } catch {
        return undefined;
      }
      const name = names.find((n) => n.toLowerCase() === part.toLowerCase());
      if (name === undefined) return undefined;
      at = path.join(at, name);
    }
    return fromRoot(i.root, at);
  };

  const byDisplay = new Map(i.files.map((f) => [f.display, f]));
  const missingLine = (r: ResolvedInclude): string => {
    const head = `${r.file}:${r.line} imports "${r.spelling}"`;
    if (path.isAbsolute(r.spelling)) return `${head}, which does not exist`;
    const file = byDisplay.get(r.file)!;
    const folders = [
      fromRoot(i.root, path.dirname(file.source)),
      "the app target's headers",
      ...i.headerSearchPaths.map((d) => fromRoot(i.root, d)),
    ];
    const twin = r.searched.map((d) => caseTwin(path.join(d, r.spelling))).find((t) => t !== undefined);
    const suffix = twin === undefined ? "" : `; ${twin} differs only in case (file names are case-sensitive on Linux)`;
    return `${head}, which is not in ${orList(folders)}${suffix}`;
  };

  const out: Pass1Result = { missing: [], pending: 0, checked: 0 };
  for (const r of results) {
    if (r.generated || !r.certain) continue;
    if (r.found !== undefined) out.checked++;
    else if (r.angle || i.binaryPods || dependencyProvides(r.spelling)) out.pending++;
    else out.missing.push(missingLine(r));
  }
  return out;
}
