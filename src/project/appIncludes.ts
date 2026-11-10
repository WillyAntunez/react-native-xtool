// B1's include resolution (spec "B. The app target's checks", rows 30–37): each `#import`/`#include` the scanner
// returns for an app file, looked up as clang looks it up in the generated App target. Pure: each file's text is read
// once, every other question goes to `IncludeScope.exists`. Pass 1 (`appIncludesPass1`) runs it over the app's copy
// before the copy exists, with no toolchain: file-system reads only.

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { bareCopyLayout } from "../generate/bareSources.js";
import { expoBridgingHeaderPath } from "../generate/iosXtool.js";
import { projectPaths } from "../paths.js";
import { definesOf, scanIncludes } from "./includeScan.js";
import {
  AmbiguousProjectError,
  appXcconfigWarnings,
  openPbxproj,
  readTargetContent,
  resolveSetting,
  type BareTargetContent,
  type Pbxproj,
} from "./pbxproj.js";
import type { ProjectInfo, ProjectKind } from "./types.js";

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
/** Folders of ios/ that hold no app files: CocoaPods', build output, and rn-xtool's own. */
const NOT_APP_DIRS = new Set(["Pods", "build", "DerivedData", "ios-xtool"]);

/**
 * Lowercased file name → the files of that name under `iosDir`, sorted by path. Not walked: the top-level folders of
 * `NOT_APP_DIRS`, dot folders and `node_modules`; symbolic links to folders are not followed.
 */
function iosFileIndex(iosDir: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (dir: string, top: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules" && !(top && NOT_APP_DIRS.has(e.name))) walk(p, false);
      } else {
        const key = e.name.toLowerCase();
        index.set(key, [...(index.get(key) ?? []), p]);
      }
    }
  };
  walk(iosDir, true);
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
  /** The headers the app target references, on disk or not (and its bridging header), by their paths from ios/. */
  appHeaders: string[];
  /** The project uses binary pods, whose headers pass 1 cannot see. */
  binaryPods: boolean;
  /** `files` is an Expo app's bridging header, the one file of ios/ generate copies. */
  expo?: boolean;
}

export interface Pass1Result {
  /** One line per app-own include that resolves nowhere (row 30), without the `✖ ` mark. */
  missing: string[];
  /** Includes left to the build: React Native's or the libraries' headers (row 32). */
  pending: number;
  /** The certain includes that resolved. */
  checked: number;
}

/** A quote spelling without its leading `./` and `../` segments: the part a file's path must end with. */
const pathTail = (spelling: string): string => spelling.replace(/^(?:\.\.?\/)+/, "");

/** `file` (forward slashes) is `tail`, or ends with `/<tail>`. */
const endsWithPath = (file: string, tail: string): boolean => file === tail || file.endsWith(`/${tail}`);

/** "a, b or c" */
function orList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * Pass 1 of B1: the includes of `files` resolved in the app's copy as the generated App target compiles it, before
 * the copy exists. The include folders are `<sources>/include` (the forwards) then the header search paths; under
 * `sources` only the copy's planned files and forwards exist, elsewhere the disk answers. Only a certain include
 * counts (R6): resolved → `checked`; unresolved, an angle include → `pending`, and a quote include → `missing` only
 * with app-own evidence and without binary pods, else `pending`. The evidence: one of `appHeaders`, or a file under
 * ios/ (case ignored, so that a case-only twin gets its hint), whose path ends with the spelling, its leading `./`
 * and `../` aside; for a spelling without a folder, its name alone. A header of that name in another folder is no
 * evidence for a spelling with one (`SomeLib/Utils.h`): a library's forwards may hold it: clang falls back to the angle and system folders, so the compile decides
 * (an SDK, libc or library header). Uncertain includes and Xcode's generated Swift headers count nowhere.
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

  let iosFiles: Map<string, string[]> | undefined;
  /** The files under ios/ named `base`, ignoring case (the walk runs once, at the first quote miss). */
  const onDisk = (base: string): string[] => (iosFiles ??= iosFileIndex(path.join(i.root, "ios"))).get(base.toLowerCase()) ?? [];
  /** The files under ios/ whose path ends with the spelling, case ignored (by name alone for one without a folder). */
  const matching = (spelling: string): string[] => {
    const tail = pathTail(spelling).toLowerCase();
    return onDisk(path.posix.basename(spelling)).filter((f) => endsWithPath(f.split(path.sep).join("/").toLowerCase(), tail));
  };
  const appOwn = (spelling: string): boolean => {
    const tail = pathTail(spelling);
    return i.appHeaders.some((h) => endsWithPath(h.split(path.sep).join("/"), tail)) || matching(spelling).length > 0;
  };

  const listed = new Set(i.files.map((f) => f.source));
  const byDisplay = new Map(i.files.map((f) => [f.display, f]));
  /**
   * What ios/ holds of that name: a file the target does not list (on Expo, one generate does not copy), else one
   * whose name differs only in case.
   */
  const hint = (spelling: string): string => {
    const base = path.posix.basename(spelling);
    const files = matching(spelling);
    const unlisted = files.find((f) => path.basename(f) === base && !listed.has(f));
    if (unlisted !== undefined) {
      return i.expo === true
        ? `; ${fromRoot(i.root, unlisted)} exists, but rn-xtool copies only the bridging header of an Expo app`
        : `; ${fromRoot(i.root, unlisted)} exists but the app target does not list it (add it to the target)`;
    }
    const twin = files.find((f) => path.basename(f) !== base);
    return twin === undefined ? "" : `; ${fromRoot(i.root, twin)} differs only in case (file names are case-sensitive on Linux)`;
  };
  const missingLine = (r: ResolvedInclude): string => {
    const head = `${r.file}:${r.line} imports "${r.spelling}"`;
    if (path.isAbsolute(r.spelling)) return `${head}, which does not exist`;
    const file = byDisplay.get(r.file)!;
    const folders = [
      fromRoot(i.root, path.dirname(file.source)),
      "the app target's headers",
      ...i.headerSearchPaths.map((d) => fromRoot(i.root, d)),
    ];
    return `${head}, which is not in ${orList(folders)}${hint(r.spelling)}`;
  };

  const out: Pass1Result = { missing: [], pending: 0, checked: 0 };
  for (const r of results) {
    if (r.generated || !r.certain) continue;
    if (r.found !== undefined) out.checked++;
    else if (r.angle || i.binaryPods || !appOwn(r.spelling)) out.pending++;
    else out.missing.push(missingLine(r));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 1 in `doctor --project` and at the start of `build`.

export interface AppTargetCheck {
  /** Pass 1's `missing` lines, without the `✖ ` mark. */
  errors: string[];
  /** `appXcconfigWarnings`' lines, with their `⚠ ` mark. */
  warnings: string[];
  pending: number;
  checked: number;
}

type AppTargetProject = Pick<ProjectInfo, "kind" | "bare" | "iosTargetDir">;

/** Pass 1 over the app target of `project`, then the xcconfig warnings of the project `pbx` opens (none: undefined). */
function checkAppTarget(
  root: string,
  project: AppTargetProject,
  binaryPods: boolean,
  pbx: () => Pbxproj | undefined,
): AppTargetCheck {
  const iosDir = path.join(root, "ios");
  const sources = projectPaths(root).sources;
  let input: Pass1Input | undefined;
  if (project.kind === "bare" && project.bare !== undefined) {
    const bare = project.bare;
    input = {
      root,
      files: bareScope(bare, iosDir, project.iosTargetDir, sources, root),
      forwards: bareCopyLayout(bare, iosDir, project.iosTargetDir).forwards,
      sources,
      headerSearchPaths: bare.headerSearchPaths,
      defines: bare.defines,
      appHeaders: [...bare.headers, ...(bare.bridgingHeader ? [bare.bridgingHeader] : [])].map((h) => h.relPath),
      binaryPods,
    };
  } else if (project.kind === "expo") {
    // generate copies the bridging header alone, to Sources/App/<base name>; nothing else of ios/ is compiled.
    const header = expoBridgingHeaderPath(iosDir);
    if (header !== undefined) {
      const base = path.basename(header);
      input = {
        root,
        files: [{ path: path.join(sources, base), source: header, display: fromRoot(root, header) }],
        forwards: new Map(),
        sources,
        headerSearchPaths: [],
        defines: [],
        appHeaders: [base],
        binaryPods,
        expo: true,
      };
    }
  }
  const pass = input === undefined ? { missing: [], pending: 0, checked: 0 } : appIncludesPass1(input);
  const opened = pbx();
  return {
    errors: pass.missing,
    warnings: opened === undefined ? [] : appXcconfigWarnings(opened, root),
    pending: pass.pending,
    checked: pass.checked,
  };
}

/**
 * The Expo app's Xcode project, once expo prebuild wrote it; undefined without one, and when ios/ holds several
 * (generate warns about that).
 */
function expoPbxproj(iosDir: string): Pbxproj | undefined {
  try {
    if (!readdirSync(iosDir).some((n) => n.endsWith(".xcodeproj"))) return undefined;
  } catch {
    return undefined;
  }
  try {
    return openPbxproj(iosDir);
  } catch (e) {
    if (e instanceof AmbiguousProjectError) return undefined;
    throw e;
  }
}

/**
 * Pass 1 of B1 over the app target as `generate` will copy it, with `appXcconfigWarnings`: on bare, the target's
 * C-family sources, headers and bridging header; on Expo, the prebuild's bridging header alone (no forwards, no search
 * paths), all empty before expo prebuild. File-system reads only. `binaryPods`: `binaryPodCandidates` finds any.
 */
export function appTargetCheck(input: { root: string; project: AppTargetProject; binaryPods: boolean }): AppTargetCheck {
  const iosDir = path.join(input.root, "ios");
  const pbx = () => (input.project.kind === "bare" ? openPbxproj(iosDir) : expoPbxproj(iosDir));
  return checkAppTarget(input.root, input.project, input.binaryPods, pbx);
}

/**
 * `doctor --project`'s app-target lines, in order: `✖ app-includes — <error>` per error, `⚠ app-target — <warning>`
 * per warning, `ℹ app-includes — …: checked at build` with pending includes, and `✔ app-includes — …` without errors
 * when an include was checked. A bare project whose pbxproj, app target or INFOPLIST_FILE cannot be read, as
 * `readProject` reads them, gives no line: the project line reports it. A throw of the check itself (a file the copy
 * refuses, an Expo bridging header that is missing) is an error line: the build stops on it too.
 */
export function appTargetLines(root: string, kind: ProjectKind | undefined, opts: { binaryPods: boolean }): string[] {
  const iosDir = path.join(root, "ios");
  let run: () => AppTargetCheck;
  if (kind === "bare") {
    let pbx: Pbxproj;
    let project: AppTargetProject;
    try {
      pbx = openPbxproj(iosDir);
      const infoPlist = resolveSetting(pbx, "INFOPLIST_FILE");
      if (!infoPlist) return [];
      project = { kind, bare: readTargetContent(pbx, iosDir), iosTargetDir: path.dirname(path.resolve(iosDir, infoPlist)) };
    } catch {
      return [];
    }
    run = () => checkAppTarget(root, project, opts.binaryPods, () => pbx);
  } else if (kind === "expo") {
    // The Expo check reads only the bridging header: the target folder plays no part.
    run = () => appTargetCheck({ root, project: { kind, iosTargetDir: iosDir }, binaryPods: opts.binaryPods });
  } else {
    return [];
  }
  let check: AppTargetCheck;
  try {
    check = run();
  } catch (e) {
    return [`✖ app-includes — ${e instanceof Error ? e.message : String(e)}`];
  }
  const n = check.pending;
  return [
    ...check.errors.map((e) => `✖ app-includes — ${e}`),
    ...check.warnings.map((w) => `⚠ app-target — ${w.replace(/^⚠ /, "")}`),
    ...(n > 0 ? [`ℹ app-includes — ${n} includes into React Native's or the libraries' headers: checked at build`] : []),
    ...(check.errors.length === 0 && check.checked > 0
      ? [`✔ app-includes — ${check.checked} includes of the app's own sources resolve`]
      : []),
  ];
}
