import { realpathSync } from "node:fs";
import path from "node:path";
import { troubleshootingUrl } from "../docs.js";
import { jsiScratchDir } from "./jsiHeaders.js";

/**
 * A build killed while clang writes its module cache (Ctrl-C, a closed terminal, a reboot) leaves precompiled module
 * files there that are empty or cut short, and every later build that reads them stops with clang's "file '<path>' is
 * not a valid module file". Which folder holds the file decides the remedy; a file anywhere else gets none, so the
 * explanation never names a remedy that cannot work.
 */

/** Clang's words for a precompiled module file it cannot read, with that file's path. */
const BAD_MODULE_FILE = /file '([^'\n]+)' is not a valid (?:precompiled )?module file/g;

const SEE = `See ${troubleshootingUrl("interrupted-build")}`;

/** The module caches rn-xtool knows how to empty, under a project's `ios-xtool`. */
const CACHES: ReadonlyArray<{ dir: (iosXtool: string) => string; hint: string }> = [
  {
    // The jsi script's scratch path; `build --clean` removes it on every kind (jsi.ts).
    dir: (iosXtool) => jsiScratchDir(path.join(iosXtool, "jsi-out")),
    hint:
      "The jsi step stopped on a precompiled module file in ExpoModulesJSI's module cache that is empty or cut short " +
      '("is not a valid module file"): a build interrupted during the jsi step leaves its module cache that way, and ' +
      "the next builds keep reading it. Run `rm -rf ios-xtool/jsi-out/.jsi-build` in the project folder, then " +
      "`rn-xtool build`, or run `rn-xtool build --clean`, which removes that folder too; either way the jsi step " +
      `builds ExpoModulesJSI again from the start. ${SEE}`,
  },
  {
    // xtool's SwiftPM scratch; Expo's `build --clean` keeps it, so the remedy deletes it by hand.
    dir: (iosXtool) => path.join(iosXtool, ".build"),
    hint:
      "xtool dev build stopped on a precompiled module file in the app build's module cache (ios-xtool/.build) that " +
      'is empty or cut short ("is not a valid module file"): a build interrupted during xtool-build leaves its module ' +
      "cache that way, and the next builds keep reading it. `rn-xtool build --clean` does not remove " +
      "ios-xtool/.build on Expo projects. Run `rm -rf ios-xtool/.build` in the project folder, then `rn-xtool " +
      `build\`: its xtool-build starts cold and takes several minutes. ${SEE}`,
  },
];

/** `iosXtoolDir` and, when it resolves to another path (a symlink on the way), that path too. */
function spellings(iosXtoolDir: string): string[] {
  try {
    const real = realpathSync(iosXtoolDir);
    return real === iosXtoolDir ? [iosXtoolDir] : [iosXtoolDir, real];
  } catch {
    return [iosXtoolDir];
  }
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The paragraph explaining build output that shows clang's "is not a valid module file", or undefined: when it shows
 * none, or when not every file it names is in one module cache rn-xtool knows (under `iosXtoolDir`, absolute paths).
 */
export function badModuleFileHint(output: string, iosXtoolDir: string): string | undefined {
  const files = [...output.matchAll(BAD_MODULE_FILE)].map((m) => m[1]!);
  if (files.length === 0 || !files.every((f) => path.isAbsolute(f))) return undefined;
  const roots = spellings(iosXtoolDir);
  const cache = CACHES.find((c) => files.every((f) => roots.some((r) => isInside(f, c.dir(r)))));
  return cache?.hint;
}

/**
 * A failed build (an execa error carrying its kept `stdout` and `stderr`) with {@link badModuleFileHint}'s paragraph
 * after its message, and the failure as its `cause`; `e` itself when there is no paragraph.
 */
export function explainBadModuleFile(e: unknown, iosXtoolDir: string): unknown {
  if (!(e instanceof Error)) return e;
  const kept = e as { stdout?: unknown; stderr?: unknown };
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const hint = badModuleFileHint(`${text(kept.stdout)}\n${text(kept.stderr)}`, iosXtoolDir);
  return hint === undefined ? e : new Error(`${e.message}\n${hint}`, { cause: e });
}
