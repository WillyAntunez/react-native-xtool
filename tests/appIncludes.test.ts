import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareCopyLayout } from "../src/generate/bareSources.js";
import {
  appIncludesPass1,
  bareScope,
  resolveIncludes,
  type IncludeScope,
  type Pass1Result,
} from "../src/project/appIncludes.js";
import { definesOf } from "../src/project/includeScan.js";
import { readProject, type BareTargetContent, type TargetFile } from "../src/project/index.js";
import { objcApp } from "./support/objcApp.js";

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

  it("opens an absolute include spelling as is", async () => {
    const { root, ios, sources, at } = await project({ "Vendor/Z.h": "// z\n" });
    const z = join(ios, "Vendor", "Z.h");
    const gone = join(root, "Gone.h");
    const text = [`#import "${z}"`, `#import "${gone}"`, `#if __has_include("${z}")`, `#import "Taken.h"`, `#endif`].join("\n");
    await mkdir(join(ios, "App"), { recursive: true });
    await writeFile(join(ios, "App", "X.m"), text);
    const scope = copyScope(bareOf({ cSources: [at("App/X.m")] }), ios, join(ios, "App"), sources, [join(sources, "include")]);
    expect(resolveIncludes(scope).map((r) => [r.spelling, r.certain, r.found, r.searched])).toEqual([
      [z, true, z, []],
      [gone, true, undefined, []],
      ["Taken.h", true, undefined, [sources, join(sources, "include")]],
    ]);
  });
});

/** Pass 1 over the project at `root` as `doctor --project` and `build` read it; the copy goes to ios-xtool/Sources/App. */
async function pass1(root: string, o: { binaryPods?: boolean } = {}): Promise<Pass1Result> {
  const project = await readProject(root);
  const ios = join(root, "ios");
  const sources = join(root, "ios-xtool", "Sources", "App");
  const bare = project.bare!;
  return appIncludesPass1({
    root,
    files: bareScope(bare, ios, project.iosTargetDir, sources, root),
    forwards: bareCopyLayout(bare, ios, project.iosTargetDir).forwards,
    sources,
    headerSearchPaths: bare.headerSearchPaths,
    defines: bare.defines,
    appHeaders: [...bare.headers, ...(bare.bridgingHeader ? [bare.bridgingHeader] : [])].map((h) => h.relPath),
    binaryPods: o.binaryPods ?? false,
  });
}

/** Rewrites a file of the project at `root` (`rel` from the root). */
function edit(root: string, rel: string, change: (text: string) => string): void {
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = change(before);
  expect(after).not.toBe(before);
  writeFileSync(file, after);
}

/** Adds `lines` to the template's AppDelegate.mm after its React import (line 9), so they start at line 10. */
const addToAppDelegate = (root: string, lines: string) =>
  edit(root, "ios/ObjcApp/AppDelegate.mm", (t) => t.replace("#import <React/RCTBundleURLProvider.h>\n", `$&${lines}`));

describe("appIncludesPass1", () => {
  it("passes the Objective-C template in both layouts", async () => {
    // Pending: the certain angle includes, per including file — AppDelegate.mm <React/RCTBundleURLProvider.h>, main.m
    // <UIKit/UIKit.h>, AppDelegate.h <RCTAppDelegate.h> and <UIKit/UIKit.h>. Checked: "AppDelegate.h" from main.m and
    // from AppDelegate.mm.
    for (const layout of ["template", "root-group"] as const) {
      expect(await pass1(objcApp(layout))).toEqual({ missing: [], pending: 4, checked: 2 });
    }
  });

  it("stops on an app-own quote include that resolves nowhere (F2)", async () => {
    const root = objcApp("root-group");
    rmSync(join(root, "ios", "AppDelegate.h"));
    // A copy left by an earlier build changes nothing: the build writes Sources/App afresh.
    mkdirSync(join(root, "ios-xtool", "Sources", "App"), { recursive: true });
    writeFileSync(join(root, "ios-xtool", "Sources", "App", "AppDelegate.h"), "// stale\n");
    expect(await pass1(root)).toEqual({
      missing: [
        `ios/AppDelegate.mm:7 imports "AppDelegate.h", which is not among the files the app target lists next to ios/AppDelegate.mm or in the app target's headers`,
        `ios/main.m:9 imports "AppDelegate.h", which is not among the files the app target lists next to ios/main.m or in the app target's headers`,
      ],
      pending: 2,
      checked: 0,
    });
  });

  it("leaves a quote include a dependency provides to the build", async () => {
    const root = objcApp("template");
    addToAppDelegate(root, '#import "RNCAsyncStorage.h"\n');
    edit(root, "package.json", (t) => t.replace('"react": "19.3.0",', '"react": "19.3.0",\n    "x": "1.0.0",'));
    const x = join(root, "node_modules", "x");
    mkdirSync(join(x, "ios"), { recursive: true });
    writeFileSync(join(x, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    writeFileSync(join(x, "ios", "RNCAsyncStorage.h"), "// the library's header\n");
    // CocoaPods' copies, build output, dot folders and node_modules under ios/ are not the app's own headers.
    for (const dir of ["Pods/Headers/Public/x", "build/x", ".cache", "node_modules/x"]) {
      mkdirSync(join(root, "ios", dir), { recursive: true });
      writeFileSync(join(root, "ios", dir, "RNCAsyncStorage.h"), "// a copy\n");
    }
    expect(await pass1(root)).toEqual({ missing: [], pending: 5, checked: 2 });
  });

  it("leaves a quote include a dependency provides under another folder to the build", async () => {
    // The build finds it through React Native's staged headers (React/ flattened); the source tree has React/Base/.
    const root = objcApp("template");
    addToAppDelegate(root, '#import "React/RCTBridgeModule.h"\n');
    mkdirSync(join(root, "node_modules", "react-native", "React", "Base"), { recursive: true });
    writeFileSync(join(root, "node_modules", "react-native", "React", "Base", "RCTBridgeModule.h"), "// bridge module\n");
    expect(await pass1(root)).toEqual({ missing: [], pending: 5, checked: 2 });
  });

  it("leaves a quote include of an SDK or libc header to the build", async () => {
    // Clang falls back from the quote folders to the angle and system ones: Xcode and the generated build compile it.
    const root = objcApp("template");
    edit(root, "ios/ObjcApp/main.m", (t) => t.replace("#import <UIKit/UIKit.h>\n", '$&#include "stdlib.h"\n#import "Foundation/Foundation.h"\n'));
    expect(await pass1(root)).toEqual({ missing: [], pending: 6, checked: 2 });
  });

  it("leaves quote misses to the build when the project has binary pods", async () => {
    const root = objcApp("template");
    addToAppDelegate(root, '#import "RNCAsyncStorage.h"\n');
    expect(await pass1(root, { binaryPods: true })).toEqual({ missing: [], pending: 5, checked: 2 });
  });

  it("never errors on an uncertain include", async () => {
    const root = objcApp("template");
    addToAppDelegate(root, '#ifdef FB_SONARKIT_ENABLED\n#import "FlipperKit.h"\n#endif\n');
    expect(await pass1(root)).toEqual({ missing: [], pending: 4, checked: 2 });
  });

  it("never errors on a branch on a macro the App target does not define", async () => {
    // Swift Build compiles the App without RCT_NEW_ARCH_ENABLED: the include is uncertain, and the compile decides.
    const root = objcApp("template");
    writeFileSync(join(root, "ios", "ObjcApp", "Unlisted.h"), "// not in the Xcode project\n");
    addToAppDelegate(root, '#ifdef RCT_NEW_ARCH_ENABLED\n#import "Unlisted.h"\n#endif\n#if RCT_NEW_ARCH_ENABLED\n#import "Gone.h"\n#endif\n');
    expect(await pass1(root)).toEqual({ missing: [], pending: 4, checked: 2 });
  });

  it("needs evidence on the path for a spelling with a folder", async () => {
    // An app file named Utils.h, or the app's AppDelegate.h, says nothing of SomeLib/: a library's forwards may hold it.
    const root = objcApp("template");
    writeFileSync(join(root, "ios", "ObjcApp", "Utils.h"), "// the app's own Utils.h\n");
    addToAppDelegate(root, '#import "SomeLib/Utils.h"\n#import "SomeLib/AppDelegate.h"\n');
    expect(await pass1(root)).toEqual({ missing: [], pending: 6, checked: 2 });
  });

  it("matches a folder spelling against the app's headers and ios/ by its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "xt-incl-"));
    tmps.push(root);
    const ios = join(root, "ios");
    const sources = join(root, "ios-xtool", "Sources", "App");
    await mkdir(join(ios, "App", "Shared"), { recursive: true });
    await writeFile(join(ios, "App", "X.m"), '#import "Shared/Utils.h"\n#import "Shared/utils.h"\n#import "../App/Shared/Utils.h"\n');
    await writeFile(join(ios, "App", "Shared", "Utils.h"), "// utils\n");
    const x = { path: join(sources, "X.m"), source: join(ios, "App", "X.m"), display: "ios/App/X.m" };
    const utils = { path: join(sources, "Shared", "Utils.h"), source: join(ios, "App", "Shared", "Utils.h"), display: "ios/App/Shared/Utils.h" };
    const input = (listed: boolean) => ({
      root,
      files: listed ? [x, utils] : [x],
      forwards: listed ? new Map([["Utils.h", "Shared/Utils.h"]]) : new Map<string, string>(),
      sources,
      headerSearchPaths: [],
      defines: [],
      appHeaders: listed ? ["App/Shared/Utils.h"] : [],
      binaryPods: false,
    });
    // Listed: the copy holds it next to X.m (the relative spelling lands there too); the case-only twin misses.
    const head = (line: number, spelling: string) =>
      `ios/App/X.m:${line} imports "${spelling}", which is not among the files the app target lists next to ios/App/X.m or in the app target's headers`;
    expect(appIncludesPass1(input(true))).toEqual({
      missing: [`${head(2, "Shared/utils.h")}; ios/App/Shared/Utils.h differs only in case (file names are case-sensitive on Linux)`],
      pending: 0,
      checked: 2,
    });
    // On disk, not listed: evidence on the path, and the hint names that file.
    expect(appIncludesPass1(input(false))).toEqual({
      missing: [
        `${head(1, "Shared/Utils.h")}; ios/App/Shared/Utils.h exists but the app target does not list it (add it to the target)`,
        `${head(2, "Shared/utils.h")}; ios/App/Shared/Utils.h differs only in case (file names are case-sensitive on Linux)`,
        `${head(3, "../App/Shared/Utils.h")}; ios/App/Shared/Utils.h exists but the app target does not list it (add it to the target)`,
      ],
      pending: 0,
      checked: 0,
    });
  });

  it("names a header that differs only in case", async () => {
    const root = objcApp("template");
    edit(root, "ios/ObjcApp/AppDelegate.mm", (t) => t.replace('#import "AppDelegate.h"', '#import "appdelegate.h"'));
    expect((await pass1(root)).missing).toEqual([
      `ios/ObjcApp/AppDelegate.mm:7 imports "appdelegate.h", which is not among the files the app target lists next to ` +
        "ios/ObjcApp/AppDelegate.mm or in the app target's headers; " +
        "ios/ObjcApp/AppDelegate.h differs only in case (file names are case-sensitive on Linux)",
    ]);
  });

  it("names a header whose file name on disk differs only in case", async () => {
    const root = objcApp("root-group");
    renameSync(join(root, "ios", "AppDelegate.h"), join(root, "ios", "appdelegate.h"));
    const tail = "or in the app target's headers; ios/appdelegate.h differs only in case (file names are case-sensitive on Linux)";
    const line = (file: string, n: number) => `${file}:${n} imports "AppDelegate.h", ${"which is not among the files the app target lists next to"} ${file} ${tail}`;
    expect(await pass1(root)).toEqual({
      missing: [line("ios/AppDelegate.mm", 7), line("ios/main.m", 9)],
      pending: 2,
      checked: 0,
    });
  });

  it("names a header on disk the app target does not list", async () => {
    const root = objcApp("template");
    writeFileSync(join(root, "ios", "ObjcApp", "Unlisted.h"), "// not in the Xcode project\n");
    addToAppDelegate(root, '#import "Unlisted.h"\n');
    expect((await pass1(root)).missing).toEqual([
      // The head names where the app target's copy looked; the tail, the file on disk it does not list.
      `ios/ObjcApp/AppDelegate.mm:10 imports "Unlisted.h", which is not among the files the app target lists next to ` +
        "ios/ObjcApp/AppDelegate.mm or in the app target's headers; " +
        "ios/ObjcApp/Unlisted.h exists but the app target does not list it (add it to the target)",
    ]);
  });

  it("lists a search path with spaces whole", async () => {
    const root = objcApp("template");
    edit(root, "ios/ObjcApp.xcodeproj/project.pbxproj", (t) =>
      t.replace(
        "\t\t\t\tINFOPLIST_FILE = ObjcApp/Info.plist;\n",
        '\t\t\t\tHEADER_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"$(SRCROOT)/Vendor Kit",\n\t\t\t\t);\n$&',
      ),
    );
    // The header sits one folder below the search path: the app's own, so a miss is an error.
    mkdirSync(join(root, "ios", "Vendor Kit", "include"), { recursive: true });
    writeFileSync(join(root, "ios", "Vendor Kit", "include", "VendorKit.h"), "// vendor\n");
    addToAppDelegate(root, '#import "VendorKit.h"\n');
    expect((await pass1(root)).missing).toEqual([
      `ios/ObjcApp/AppDelegate.mm:10 imports "VendorKit.h", which is not among the files the app target lists next to ` +
        "ios/ObjcApp/AppDelegate.mm, in the app target's headers or in ios/Vendor Kit; ios/Vendor Kit/include/VendorKit.h exists but the app target does not list it (add it to the target)",
    ]);
  });
});
