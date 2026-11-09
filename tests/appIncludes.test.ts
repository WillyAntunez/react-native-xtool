import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareCopyLayout } from "../src/generate/bareSources.js";
import { resolveIncludes, type IncludeScope } from "../src/project/appIncludes.js";
import { definesOf } from "../src/project/includeScan.js";
import type { BareTargetContent, TargetFile } from "../src/project/index.js";

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A temp project: `ios/` holding `files` (paths relative to ios/), and where the copy would go. */
async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "xt-incl-"));
  tmps.push(root);
  const ios = join(root, "ios");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(ios, rel, ".."), { recursive: true });
    await writeFile(join(ios, rel), text);
  }
  const at = (relPath: string): TargetFile => ({ absPath: join(ios, relPath), relPath });
  return { root, ios, sources: join(root, "ios-xtool", "Sources", "App"), at };
}

function bareOf(o: Partial<BareTargetContent>): BareTargetContent {
  return {
    swiftSources: [], cSources: [], headers: [], resources: [], skippedResources: [], defines: [],
    headerSearchPaths: [], ignoredSettings: [], mixed: true, productModuleName: "App", ...o,
  };
}

/**
 * The scope of the copy `bareCopyLayout` plans under `sources`, before it exists: the planned places and the forwards
 * exist there, the disk answers elsewhere. `display` is the file's path from ios/.
 */
function copyScope(bare: BareTargetContent, ios: string, target: string, sources: string, includeDirs: string[]): IncludeScope {
  const layout = bareCopyLayout(bare, ios, target);
  const places = new Set([
    ...layout.files.map((f) => join(sources, f.dest)),
    ...[...layout.forwards.keys()].map((base) => join(sources, "include", base)),
  ]);
  return {
    files: layout.files.map(({ file, dest }) => ({ path: join(sources, dest), source: file.absPath, display: file.relPath })),
    exists: (p) => places.has(p) || existsSync(p),
    includeDirs,
    defines: definesOf([]),
  };
}

/** spelling → [found, searched] of the includes `display` makes. */
const lookups = (scope: IncludeScope, display: string) =>
  resolveIncludes(scope)
    .filter((r) => r.file === display)
    .map((r) => [r.spelling, r.found, r.searched]);

describe("resolveIncludes", () => {
  it("finds an app header in another folder by name, through the forwards", async () => {
    // Row 31: headers at the root of the group tree (ios/AppDelegate.h) and in the app folder (ios/App/Native).
    const { ios, sources, at } = await project({
      "AppDelegate.h": "@interface AppDelegate : NSObject\n@end\n",
      "App/main.m": '#import "AppDelegate.h"\n#import "Bridge.h"\n',
      "App/Native/Bridge.h": "// bridge\n",
      "App/Native/Module.m": '#import "AppDelegate.h"\n',
    });
    const bare = bareOf({ cSources: [at("App/main.m"), at("App/Native/Module.m")], headers: [at("App/Native/Bridge.h"), at("AppDelegate.h")] });
    const include = join(sources, "include");
    const scope = copyScope(bare, ios, join(ios, "App"), sources, [include]);
    // The copy puts ios/AppDelegate.h next to main.m's copy (AppMain.m), so the neighbour answers there.
    expect(lookups(scope, "App/main.m")).toEqual([
      ["AppDelegate.h", join(sources, "AppDelegate.h"), [sources]],
      ["Bridge.h", join(include, "Bridge.h"), [sources, include]],
    ]);
    expect(lookups(scope, "App/Native/Module.m")).toEqual([
      ["AppDelegate.h", join(include, "AppDelegate.h"), [join(sources, "Native"), include]],
    ]);
  });

  it("finds a quote include next to the including file first", async () => {
    const { ios, sources, at } = await project({
      "App/X.m": '#import "A.h"\n',
      "App/A.h": "// the neighbour\n",
      "Vendor/A.h": "// another A.h\n",
    });
    const bare = bareOf({ cSources: [at("App/X.m")], headers: [at("App/A.h")] });
    const scope = copyScope(bare, ios, join(ios, "App"), sources, [join(ios, "Vendor")]);
    expect(lookups(scope, "App/X.m")).toEqual([["A.h", join(sources, "A.h"), [sources]]]);
  });

  it("resolves a relative include against the copy's layout", async () => {
    // ios/Shared is outside the target folder ios/App: its copy keeps the path from ios/ (Sources/App/Shared/Theme.h).
    const { ios, sources, at } = await project({
      "App/X.m": '#import "../Shared/Theme.h"\n#import "Shared/Theme.h"\n',
      "Shared/Theme.h": "// theme\n",
    });
    const bare = bareOf({ cSources: [at("App/X.m")], headers: [at("Shared/Theme.h")] });
    const scope = copyScope(bare, ios, join(ios, "App"), sources, []);
    expect(lookups(scope, "App/X.m")).toEqual([
      ["../Shared/Theme.h", undefined, [sources]],
      ["Shared/Theme.h", join(sources, "Shared", "Theme.h"), [sources]],
    ]);
  });

  it("never looks up a generated Swift header", async () => {
    const { ios, sources, at } = await project({
      "App/X.m": '#import "App-Swift.h"\n#import "BareDemo-Swift.h"\n#import <Foo/Foo-Swift.h>\n',
      // A file of that name on disk changes nothing: the build generates the header.
      "Vendor/App-Swift.h": "// stale\n",
    });
    const bare = bareOf({ cSources: [at("App/X.m")] });
    const scope = copyScope(bare, ios, join(ios, "App"), sources, [join(ios, "Vendor")]);
    expect(resolveIncludes(scope)).toEqual([
      { file: "App/X.m", line: 1, spelling: "App-Swift.h", angle: false, certain: true, searched: [], generated: true },
      { file: "App/X.m", line: 2, spelling: "BareDemo-Swift.h", angle: false, certain: true, searched: [], generated: true },
      { file: "App/X.m", line: 3, spelling: "Foo/Foo-Swift.h", angle: true, certain: true, searched: [], generated: true },
    ]);
  });

  it("answers __has_include with the same lookup", async () => {
    const text = [
      `#if __has_include("Found.h")`,
      `#import "Found.h"`,
      `#else`,
      `#import "Fallback.h"`,
      `#endif`,
      `#if __has_include("Gone.h")`,
      `#import "Gone.h"`,
      `#endif`,
    ].join("\n");
    const { ios, sources, at } = await project({ "App/X.m": text, "App/Found.h": "// found\n" });
    const bare = bareOf({ cSources: [at("App/X.m")], headers: [at("App/Found.h")] });
    const scope = copyScope(bare, ios, join(ios, "App"), sources, []);
    // A header the lookup does not find may still come from a folder the scope lacks: its branch stays uncertain.
    expect(resolveIncludes(scope).map((r) => [r.spelling, r.line, r.certain, r.found])).toEqual([
      ["Found.h", 2, true, join(sources, "Found.h")],
      ["Gone.h", 7, false, undefined],
    ]);
  });
});
