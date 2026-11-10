import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { graphHeaders, planManifest, readPackageGraph, type DumpedPackage, type SwiftRunner } from "../src/pipeline/precheckGraph.js";
import { PrecheckError } from "../src/pipeline/precheckReport.js";
import { headersXcframeworkInfoPlist } from "../src/pipeline/rnArtifacts.js";
import { devEnv } from "../src/tools/xtool.js";

// Two dump-package runs at a time, so the bound shows with six packages.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, availableParallelism: () => 2 }, availableParallelism: () => 2 };
});

const FIXTURES = path.join(import.meta.dirname, "fixtures", "precheck", "graph");
const FIXTURE_ROOT = "/home/me/app";

let t = "";
/** The fixtures' graph as readPackageGraph reads it. */
let graph: { root: DumpedPackage; packages: DumpedPackage[] };
beforeAll(async () => {
  t = mkdtempSync(path.join(tmpdir(), "precheck-graph-"));
  makeTree(t);
  graph = await readPackageGraph(path.join(t, "ios-xtool"), path.join(t, "scratch"), fakeSwift(t).run);
});
afterAll(() => rmSync(t, { recursive: true, force: true }));

const write = (file: string, text = "") => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A fixture's text with the fixtures' project root moved to `root`. */
const fixture = (name: string, root: string) => readFileSync(path.join(FIXTURES, name), "utf8").replaceAll(FIXTURE_ROOT, root);

const DEVICE = { LibraryIdentifier: "ios-arm64", SupportedPlatform: "ios", SupportedArchitectures: ["arm64"] };
const SIMULATOR = {
  LibraryIdentifier: "ios-arm64_x86_64-simulator",
  SupportedPlatform: "ios",
  SupportedPlatformVariant: "simulator",
  SupportedArchitectures: ["arm64", "x86_64"],
};

/** The folders the fixtures' packages name, as the generated project lays them out. */
function makeTree(root: string): void {
  write(path.join(root, "ios-xtool/Sources/App/AppDelegate.swift"), "import UIKit\n");
  write(path.join(root, "ios-xtool/Sources/RNXtoolDevSupport/RNXtoolDevSupport.m"));
  const xcf = path.join(root, "ios/build/xcframeworks");
  write(path.join(xcf, "ReactHeadersTarget/include/React/RCTBridge.h"));
  for (const [name, map] of [
    ["ReactNativeHeaders", 'module React {\n  module React_RCTAppDelegate {\n    header "React_RCTAppDelegate/RCTAppDelegate.h"\n    export *\n  }\n  export *\n}\n'],
    ["ReactNativeDependenciesHeaders", "// the dependencies' headers\nframework module ReactNativeDependencies {\n  umbrella \".\"\n  export *\n}\n"],
  ] as const) {
    const dir = path.join(xcf, `${name}.xcframework`);
    write(path.join(dir, "Info.plist"), headersXcframeworkInfoPlist(name, [SIMULATOR, DEVICE]));
    write(path.join(dir, "ios-arm64/Headers/module.modulemap"), map);
    write(path.join(dir, "ios-arm64_x86_64-simulator/Headers/module.modulemap"), map);
  }
  const gen = path.join(root, "ios/build/generated/ios");
  write(path.join(gen, "ReactCodegen/include/ReactCodegen/ReactCodegen.h"));
  write(path.join(gen, "ReactCodegen/include/ReactCodegen/RCTModuleProviders.h"));
  write(path.join(gen, "ReactCodegen/ReactCodegen.mm"));
  write(path.join(gen, "ReactAppDependencyProvider/include/RCTAppDependencyProvider.h"));
  write(path.join(gen, "ReactAppHeaders/include/ReactAppHeaders.h"));
  write(path.join(root, "ios/build/generated/autolinking/AutolinkedAggregate/AutolinkedAggregate.m"));
  const lib = path.join(root, "node_modules/rn-lib/ios");
  write(path.join(lib, "public/module.modulemap"), 'module RNLib {\n  umbrella header "RNLib.h"\n  export *\n}\n');
  write(path.join(lib, "public/RNLib.h"));
  write(path.join(lib, "swift/RNLib.swift"));
  write(path.join(root, "node_modules/unreached-lib/ios/include/UnreachedLib.h"));
  write(path.join(root, "alias/a/Sources/App/AppDelegate.swift"));
  write(path.join(root, "alias/b/ios/Sources/BarLib/include/BarLib.h"));
}

/** Each fixture package's folder (as show-dependencies names it) → its dump-package output. */
const DUMPS: Record<string, string> = {
  "ios-xtool": "dump-AppXtool.json",
  "ios/build/xcframeworks": "dump-ReactNative.json",
  "ios/build/generated/ios": "dump-React-GeneratedCode.json",
  "ios/build/generated/autolinking": "dump-Autolinked.json",
  "node_modules/rn-lib": "dump-RNLib.json",
  "node_modules/unreached-lib": "dump-UnreachedLib.json",
};

/** The alias fixtures: the root names its dependency `Foo`, whose manifest is `Bar`, in a folder named `ios`. */
const ALIAS_DUMPS: Record<string, string> = {
  "alias/a": "alias/dump-a.json",
  "alias/b/ios": "alias/dump-b.json",
};

interface Call {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A SwiftRunner over the fixtures; `answer` overrides a command's result. */
function fakeSwift(
  root: string,
  answer: (args: string[]) => { code: number; stdout: string; stderr: string } | undefined = () => undefined,
  dumps: Record<string, string> = DUMPS,
  shown = "show-dependencies.json",
) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run: SwiftRunner = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd, env: opts.env });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const given = answer(args);
    if (given) return given;
    if (args[1] === "show-dependencies") return { code: 0, stdout: fixture(shown, root), stderr: "" };
    if (args[1] === "dump-package") {
      const rel = path.relative(root, args[args.indexOf("--package-path") + 1]!);
      return { code: 0, stdout: fixture(dumps[rel]!, root), stderr: "" };
    }
    throw new Error(`unexpected swift ${args.join(" ")}`);
  };
  return { run, calls, maxInFlight: () => maxInFlight };
}

describe("precheckGraph", () => {
  it("plans the package and refuses an executable App target", async () => {
    const ios = path.join(t, "ios-xtool");
    // SwiftPM prints the plan and exits 1 when a `main` file makes App an executable target.
    const exe = fakeSwift(t, () => ({
      code: 1,
      stdout: fixture("describe-executable.json", t),
      stderr:
        "warning: 'ios-xtool': 'App' was identified as an executable target given the presence of a 'main' file.\n" +
        "error: 'ios-xtool': library product 'App' should not contain executable targets (it has 'App')\n",
    }));
    const err = await planManifest(ios, exe.run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrecheckError);
    expect((err as Error).message).toBe(
      "precheck — SwiftPM plans the App target as an executable target (a file named main); xtool links the app's entry point from the App library",
    );
    expect(exe.calls).toEqual([{ args: ["package", "describe", "--type", "json"], cwd: ios, env: devEnv(ios) }]);

    const refused = fakeSwift(t, () => ({
      code: 1,
      stdout: "",
      stderr: "warning: 'ios-xtool': ignoring this\nerror: 'ios-xtool': target 'App' has overlapping sources: Sources/App/x.h\n",
    }));
    const refusal = await planManifest(ios, refused.run).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(PrecheckError);
    expect((refusal as Error).message).toBe(
      "precheck — SwiftPM refused the generated package (ios-xtool/Package.swift):\n" +
        "error: 'ios-xtool': target 'App' has overlapping sources: Sources/App/x.h",
    );

    const silent = fakeSwift(t, () => ({ code: 0, stdout: "", stderr: "" }));
    const noPlan = await planManifest(ios, silent.run).catch((e: unknown) => e);
    expect(noPlan).toBeInstanceOf(PrecheckError);
    expect((noPlan as Error).message).toContain("precheck — SwiftPM gave no plan for the generated package (ios-xtool/Package.swift)");

    const app = fakeSwift(t, () => ({ code: 0, stdout: fixture("describe-app.json", t), stderr: "" }));
    await expect(planManifest(ios, app.run)).resolves.toBeUndefined();
  });

  it("collects the header folders reachable from App", () => {
    const g = graphHeaders(graph);
    const xcf = path.join(t, "ios/build/xcframeworks");
    const gen = path.join(t, "ios/build/generated/ios");
    expect(g.headerDirs).toEqual([
      path.join(xcf, "ReactHeadersTarget/include"),
      path.join(xcf, "ReactNativeHeaders.xcframework/ios-arm64/Headers"),
      path.join(xcf, "ReactNativeDependenciesHeaders.xcframework/ios-arm64/Headers"),
      path.join(gen, "ReactCodegen/include"),
      path.join(gen, "ReactAppDependencyProvider/include"),
      path.join(t, "node_modules/rn-lib/ios/public"),
      path.join(gen, "ReactAppHeaders/include"),
    ]);
    expect(g.moduleMaps).toEqual([
      path.join(xcf, "ReactNativeHeaders.xcframework/ios-arm64/Headers/module.modulemap"),
      path.join(xcf, "ReactNativeDependenciesHeaders.xcframework/ios-arm64/Headers/module.modulemap"),
      path.join(t, "node_modules/rn-lib/ios/public/module.modulemap"),
    ]);
    expect(JSON.stringify(g)).not.toContain("unreached-lib");
  });

  it("synthesizes a module map as SwiftPM does", () => {
    const g = graphHeaders(graph);
    const gen = path.join(t, "ios/build/generated/ios");
    const xcf = path.join(t, "ios/build/xcframeworks");
    expect(g.synthesized).toEqual([
      { module: "ReactHeaders", text: `module ReactHeaders {\n    umbrella "${xcf}/ReactHeadersTarget/include"\n    export *\n}\n` },
      {
        module: "ReactCodegen",
        text: `module ReactCodegen {\n    umbrella header "${gen}/ReactCodegen/include/ReactCodegen/ReactCodegen.h"\n    export *\n}\n`,
      },
      {
        module: "ReactAppDependencyProvider",
        text: `module ReactAppDependencyProvider {\n    umbrella "${gen}/ReactAppDependencyProvider/include"\n    export *\n}\n`,
      },
      {
        module: "ReactAppHeaders",
        text: `module ReactAppHeaders {\n    umbrella header "${gen}/ReactAppHeaders/include/ReactAppHeaders.h"\n    export *\n}\n`,
      },
    ]);

    // The module name is the target's C99 name, as SwiftPM spells it.
    const lib = path.join(t, "c99");
    write(path.join(lib, "Sources/my-lib/include/my_lib.h"));
    const app = { name: "App", type: "regular", dependencies: [{ byName: ["my-lib", null] }] };
    const own = graphHeaders({
      root: { name: "C99", path: lib, dependencies: [], products: [], targets: [app, { name: "my-lib", type: "regular", dependencies: [] }] },
      packages: [],
    });
    expect(own.synthesized).toEqual([
      { module: "my_lib", text: `module my_lib {\n    umbrella header "${lib}/Sources/my-lib/include/my_lib.h"\n    export *\n}\n` },
    ]);
  });

  it("prefers the flat umbrella header, as SwiftPM does", () => {
    const lib = path.join(t, "flat-first");
    write(path.join(lib, "Sources/Both/include/Both.h"));
    write(path.join(lib, "Sources/Both/include/Both/Both.h"));
    const app = { name: "App", type: "regular", dependencies: [{ byName: ["Both", null] }] };
    const g = graphHeaders({
      root: { name: "Flat", path: lib, dependencies: [], products: [], targets: [app, { name: "Both", type: "regular", dependencies: [] }] },
      packages: [],
    });
    expect(g.synthesized).toEqual([
      { module: "Both", text: `module Both {\n    umbrella header "${lib}/Sources/Both/include/Both.h"\n    export *\n}\n` },
    ]);
  });

  it("synthesizes no module map for a module a map on disk declares", () => {
    // Two maps of one module are a redefinition: the one on disk is the module's.
    const lib = path.join(t, "declared");
    write(path.join(lib, "Sources/Maps/include/module.modulemap"), "module Maps {}\nmodule Other {}\n");
    write(path.join(lib, "Sources/Other/include/Other.h"));
    const app = { name: "App", type: "regular", dependencies: [{ byName: ["Maps", null] }, { byName: ["Other", null] }] };
    const targets = [app, ...["Maps", "Other"].map((name) => ({ name, type: "regular", dependencies: [] }))];
    const g = graphHeaders({ root: { name: "Declared", path: lib, dependencies: [], products: [], targets }, packages: [] });
    expect(g.synthesized).toEqual([]);
    expect(g.moduleMaps).toEqual([path.join(lib, "Sources/Maps/include/module.modulemap")]);
    expect(g.headerDirs).toEqual([path.join(lib, "Sources/Maps/include"), path.join(lib, "Sources/Other/include")]);
    expect(g.modules).toEqual(["Maps", "Other"]);
  });

  it("lists the graph's targets and modules", () => {
    const g = graphHeaders(graph);
    // Target names and product names: an angle include's first component is usually a product's (`<Autolinked/…>`).
    expect(g.targets).toEqual([
      "App",
      "RNXtoolDevSupport",
      "ReactHeaders",
      "ReactNativeHeaders",
      "ReactNativeDependenciesHeaders",
      "ReactCodegen",
      "ReactAppDependencyProvider",
      "ReactAppHeaders",
      "AutolinkedAggregate",
      "Autolinked",
      "RNLib",
      "RNLibSwift",
      "UnreachedLib",
    ]);
    expect(g.modules).toEqual([
      "React",
      "ReactNativeDependencies",
      "RNLib",
      "ReactHeaders",
      "ReactCodegen",
      "ReactAppDependencyProvider",
      "ReactAppHeaders",
    ]);
  });

  it("lists the modules of the targets SwiftPM builds from Swift", () => {
    expect(graphHeaders(graph).swiftModules).toEqual(["RNLibSwift"]);

    const lib = path.join(t, "swift-modules");
    // A Swift target with an include folder (a synthesized map), a clang-only one, an Expo-style mixed target whose
    // public headers folder is its whole folder, one whose `sources` list names its Swift, one whose Swift is excluded
    // or in a dot folder, and a Swift-only target without headers.
    write(path.join(lib, "Sources/X/Foo.swift"));
    write(path.join(lib, "Sources/X/include/X.h"));
    write(path.join(lib, "Sources/C/C.m"));
    write(path.join(lib, "Sources/C/include/C.h"));
    write(path.join(lib, "root/ios/Mix.swift"));
    write(path.join(lib, "root/ios/Mix.h"));
    write(path.join(lib, "root/ios/module.modulemap"), "module MixObjC {\n  header \"Mix.h\"\n}\n");
    write(path.join(lib, "pager/ios/Pager.swift"));
    write(path.join(lib, "pager/ios/Pager.h"));
    write(path.join(lib, "Sources/E/E.m"));
    write(path.join(lib, "Sources/E/include/E.h"));
    write(path.join(lib, "Sources/E/Tests/ETests.swift"));
    write(path.join(lib, "Sources/D/D.m"));
    write(path.join(lib, "Sources/D/include/D.h"));
    write(path.join(lib, "Sources/D/.build/Gen.swift"));
    write(path.join(lib, "Sources/S/S.swift"));
    const names = ["X", "C", "Mix", "Pager", "E", "D", "S"];
    const app = { name: "App", type: "regular", dependencies: names.map((n) => ({ byName: [n, null] })) };
    const targets = [
      app,
      { name: "X", type: "regular", dependencies: [] },
      { name: "C", type: "regular", dependencies: [] },
      { name: "Mix", type: "regular", path: "root/ios", publicHeadersPath: ".", dependencies: [] },
      { name: "Pager", type: "regular", path: "pager", sources: ["ios/Pager.swift", "ios/Pager.h"], publicHeadersPath: "ios", dependencies: [] },
      { name: "E", type: "regular", exclude: ["Tests"], dependencies: [] },
      { name: "D", type: "regular", dependencies: [] },
      { name: "S", type: "regular", dependencies: [] },
    ];
    const g = graphHeaders({ root: { name: "SwiftModules", path: lib, dependencies: [], products: [], targets }, packages: [] });
    expect(g.modules).toEqual(expect.arrayContaining(["X", "C", "MixObjC", "Pager", "E", "D"]));
    expect(g.swiftModules).toEqual(["X", "Mix", "MixObjC", "Pager", "S"]);
  });

  it("follows symlinked folders and leaves resources out when it looks for Swift", async () => {
    const lib = path.join(t, "swift-links");
    // L's Swift is in a folder outside the target, linked in; Loop links to itself; R's only Swift file is a resource.
    write(path.join(lib, "Sources/L/L.m"));
    write(path.join(lib, "Sources/L/include/L.h"));
    write(path.join(lib, "elsewhere/LSwift.swift"));
    symlinkSync(path.join(lib, "elsewhere"), path.join(lib, "Sources/L/Swift"));
    write(path.join(lib, "Sources/Loop/Loop.m"));
    write(path.join(lib, "Sources/Loop/include/Loop.h"));
    symlinkSync(path.join(lib, "Sources/Loop"), path.join(lib, "Sources/Loop/again"));
    write(path.join(lib, "Sources/R/R.m"));
    write(path.join(lib, "Sources/R/include/R.h"));
    write(path.join(lib, "Sources/R/Assets/Template.swift"));
    const names = ["L", "Loop", "R"];
    const targets = [
      { name: "App", type: "regular", dependencies: names.map((n) => ({ byName: [n, null] })) },
      { name: "L", type: "regular", dependencies: [] },
      { name: "Loop", type: "regular", dependencies: [] },
      { name: "R", type: "regular", resources: ["Assets"], dependencies: [] },
    ];
    const g = graphHeaders({ root: { name: "SwiftLinks", path: lib, dependencies: [], products: [], targets }, packages: [] });
    expect(g.modules).toEqual(expect.arrayContaining(["L", "Loop", "R"]));
    expect(g.swiftModules).toEqual(["L"]);

    // dump-package names a resource by its path and rule.
    const ios = path.join(t, "ios-xtool");
    const dump = JSON.parse(fixture("dump-AppXtool.json", t)) as { targets: Record<string, unknown>[] };
    dump.targets[0]!.resources = [{ path: "Assets", rule: { process: {} } }, { path: "Info.plist", rule: { copy: {} } }];
    const swift = fakeSwift(t, (args) =>
      args[1] === "dump-package" && args[args.indexOf("--package-path") + 1] === ios ? { code: 0, stdout: JSON.stringify(dump), stderr: "" } : undefined,
    );
    const read = await readPackageGraph(ios, path.join(t, "scratch-resources"), swift.run);
    expect(read.root.targets[0]!.resources).toEqual(["Assets", "Info.plist"]);
  });

  it("runs dump-package with a scratch path outside the library", async () => {
    const ios = path.join(t, "ios-xtool");
    const scratch = path.join(t, "scratch");
    const swift = fakeSwift(t);
    const graph = await readPackageGraph(ios, scratch, swift.run);

    expect(swift.calls[0]).toEqual({ args: ["package", "show-dependencies", "--format", "json"], cwd: ios, env: devEnv(ios) });
    const dumps = swift.calls.slice(1);
    expect(dumps.map((c) => c.args)).toEqual(
      Object.keys(DUMPS).map((rel, n) => [
        "package",
        "dump-package",
        "--package-path",
        path.join(t, rel),
        "--scratch-path",
        path.join(scratch, String(n)),
      ]),
    );
    for (const c of dumps) expect(c).toMatchObject({ cwd: ios, env: devEnv(ios) });
    expect(swift.maxInFlight()).toBe(2);
    const read = await readPackageGraph(ios, scratch, fakeSwift(t).run);
    expect([read.root, ...read.packages].map((p) => [p.name, p.path])).toEqual(
      ["AppXtool", "ReactNative", "React-GeneratedCode", "Autolinked", "RNLib", "UnreachedLib"].map((name, n) => [name, path.join(t, Object.keys(DUMPS)[n]!)]),
    );
    // The package-level dependencies, as the manifest names them: the alias SwiftPM resolves `package:` against.
    expect(read.root.dependencies[0]).toEqual({ identity: "xcframeworks", name: "ReactNative", path: path.join(t, "ios/build/xcframeworks") });
    expect(read.packages[2]!.dependencies).toEqual([{ identity: "rn-lib", path: path.join(t, "node_modules/rn-lib") }]);

    const broken = fakeSwift(t, (args) =>
      args.includes(path.join(t, "node_modules/rn-lib"))
        ? { code: 1, stdout: "", stderr: "error: Invalid manifest (compiled with: …)\nPackage.swift:3:1: error: cannot find 'Pakage' in scope\n" }
        : undefined,
    );
    const err = await readPackageGraph(ios, scratch, broken.run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrecheckError);
    expect((err as Error).message).toBe(
      `precheck — SwiftPM could not read the package RNLib (${path.join(t, "node_modules/rn-lib")}):\n` +
        "error: Invalid manifest (compiled with: …)\nPackage.swift:3:1: error: cannot find 'Pakage' in scope",
    );
  });

  it("resolves a product's package through the name the depending manifest gives it", async () => {
    const swift = fakeSwift(t, () => undefined, ALIAS_DUMPS, "alias/show-dependencies.json");
    const aliased = await readPackageGraph(path.join(t, "alias/a"), path.join(t, "alias-scratch"), swift.run);
    const g = graphHeaders(aliased);
    expect(g.headerDirs).toEqual([path.join(t, "alias/b/ios/Sources/BarLib/include")]);
    expect(g.unresolved).toEqual([]);
  });

  it("names an xcframework whose Info.plist it cannot read", () => {
    const lib = path.join(t, "broken-xcframework");
    write(path.join(lib, "Broken.xcframework/Info.plist"), "<plist><dict><key>AvailableLibraries</key>");
    write(path.join(lib, "Gone.xcframework/ios-arm64/Headers/Gone.h"));
    const app = { name: "App", type: "regular", dependencies: [{ byName: ["Broken", null] }] };
    const targets = (name: string) => [
      { ...app, dependencies: [{ byName: [name, null] }] },
      { name, type: "binary", path: `${name}.xcframework`, dependencies: [] },
    ];
    for (const name of ["Broken", "Gone"]) {
      let err: unknown;
      try {
        graphHeaders({ root: { name: "Bin", path: lib, dependencies: [], products: [], targets: targets(name) }, packages: [] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PrecheckError);
      expect((err as Error).message).toMatch(
        new RegExp(`^precheck — rn-xtool could not read the xcframework ${name} \\(${path.join(lib, `${name}.xcframework`)}\\): `),
      );
    }
    // A binary target that is no xcframework folder (a zip archive) gives no headers, as before.
    const zip = graphHeaders({
      root: { name: "Bin", path: lib, dependencies: [], products: [], targets: [{ ...app, dependencies: [{ byName: ["Z", null] }] }, { name: "Z", type: "binary", path: "Z.zip", dependencies: [] }] },
      packages: [],
    });
    expect(zip.headerDirs).toEqual([]);
  });

  it("lists the references it cannot place, without stopping", () => {
    const dir = path.join(t, "unplaced");
    const app = {
      name: "App",
      type: "regular",
      dependencies: [{ product: ["Gone", "Missing", null, null] }, { byName: ["Nowhere", null] }, { product: ["NoSuch", "Present", null, null] }],
    };
    const g = graphHeaders({
      root: { name: "Root", path: dir, dependencies: [{ identity: "present", path: path.join(dir, "present") }], products: [], targets: [app] },
      packages: [{ name: "Present", path: path.join(dir, "present"), dependencies: [], products: [], targets: [] }],
    });
    expect(g.unresolved).toEqual(["Gone of Missing", "Nowhere", "NoSuch of Present"]);
    expect(g.headerDirs).toEqual([]);
  });
});
