// B1's include resolution (spec "B. The app target's checks", rows 30–37): each `#import`/`#include` the scanner
// returns for an app file, looked up as clang looks it up in the generated App target. Pure: each file's text is read
// once, every other question goes to `IncludeScope.exists`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { scanIncludes } from "./includeScan.js";

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
  /** The folders looked in, in order, up to the one that answered; empty for a generated header. */
  searched: string[];
  /** Xcode's generated Swift header (`*-Swift.h`): the build writes it, so it is never looked up (row 36). */
  generated: boolean;
}

const isGenerated = (spelling: string): boolean => path.posix.basename(spelling).endsWith("-Swift.h");

/**
 * Resolves the includes of every file in `scope`: a quote include in the including file's copy folder, then in
 * `includeDirs` in order; an angle include in `includeDirs` in order. `__has_include` asks the same lookup: true when
 * it finds the header, unknown otherwise (the header may come from a folder the scope lacks, so its branch stays
 * uncertain).
 */
export function resolveIncludes(scope: IncludeScope): ResolvedInclude[] {
  const lookup = (from: string, spelling: string, angle: boolean): { found?: string; searched: string[] } => {
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
