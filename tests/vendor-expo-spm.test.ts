import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../src/tools/exec.js";
import {
  EXPO_FETCH_CMD,
  EXPO_INTEGRITY,
  EXPO_SHARED_PATCH,
  EXPO_TARBALL,
  type Classify,
  type EmitContext,
  type Plugin,
  type Podspec,
  emit,
  layoutOf,
  loadSpm,
  mkTmp,
  moduleFixture,
  shared58Spm,
  vendoredSpm,
} from "./support/expoSpm.js";

const ROOT = packageRoot();
const VENDOR = path.join(ROOT, "vendor", "expo-spm");
const NOT_UPSTREAM = new Set(["README.md", "LICENSE", "package.json", "rn-xtool-edits.patch"]);

const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;
const skipReason = !existsSync(EXPO_TARBALL)
  ? `pristine tarball missing; run: ${EXPO_FETCH_CMD}`
  : !has("tar") || !has("patch")
    ? "tar and patch are required"
    : null;
const provenance = skipReason ? it.skip : it;

function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
  );
}

describe("vendor/expo-spm provenance", () => {
  provenance("the cached tarball is expo 58.0.19", () => {
    expect("sha512-" + createHash("sha512").update(readFileSync(EXPO_TARBALL)).digest("base64")).toBe(EXPO_INTEGRITY);
  });

  provenance("vendor/expo-spm is expo 58.0.19 with our patch and rn-xtool-edits.patch applied", () => {
    const dir = mkTmp("vendor-expo-spm-");
    expect(spawnSync("tar", ["-xzf", EXPO_TARBALL, "-C", dir, "package/scripts/spm"]).status).toBe(0);
    const scripts = path.join(dir, "package", "scripts");
    const patchOne = (strip: string, cwd: string, file: string) =>
      spawnSync("patch", [strip, "-F0", "-d", cwd, "-i", file], { encoding: "utf8" });
    // patch-package format (a/node_modules/expo/scripts/spm/...): strip 4 to land in scripts/.
    const first = patchOne("-p4", scripts, EXPO_SHARED_PATCH);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const second = patchOne("-p1", scripts, path.join(VENDOR, "rn-xtool-edits.patch"));
    expect(second.status, second.stdout + second.stderr).toBe(0);

    const notVendored = (f: string) => f.startsWith(path.join("spm", "__tests__") + path.sep) || f === path.join("spm", "jest.config.js");
    const expected = listFiles(scripts)
      .filter((f) => !notVendored(f))
      .sort();
    const actual = listFiles(VENDOR)
      .filter((f) => !NOT_UPSTREAM.has(f))
      .sort();
    expect(actual).toEqual(expected);
    for (const f of expected) {
      expect(readFileSync(path.join(VENDOR, f)).equals(readFileSync(path.join(scripts, f))), f).toBe(true);
    }
  });

  provenance("LICENSE is expo 58.0.19's", () => {
    const out = spawnSync("tar", ["-xzOf", EXPO_TARBALL, "package/LICENSE"], { maxBuffer: 1 << 24 });
    expect(out.status).toBe(0);
    expect(readFileSync(path.join(VENDOR, "LICENSE")).equals(out.stdout)).toBe(true);
  });
});

// --- Every package the vendored plugin loads, and where from ---

/** rn-xtool's own exact dependencies the vendored copy may load from its install. */
const RN_XTOOL_DEPS: Record<string, string> = { "expo-modules-autolinking": "58.0.15", "expo-modules-macros": "0.22.0" };
/** Template specifiers resolved from one of RN_XTOOL_DEPS (the host's macro binary, from expo-modules-macros). */
const LISTED_TEMPLATES = ["@expo/modules-macros-${process.platform}-${process.arch}"];
/**
 * Packages of the app: never from rn-xtool's install or the vendored copy's location. expo-constants
 * is resolved by the generated Xcode build phase (script-phases.js), from the app's PROJECT_ROOT.
 */
const APP_PACKAGES = ["@expo/config-plugins", "xcode", "expo", "expo-modules-core", "expo-modules-jsi", "react-native", "expo-constants"];
/**
 * What an app package may be resolved from (the `paths` entry or the `createRequire` argument):
 * - `path.join(appRoot, 'package.json')`: appPackages() (app-target.js) finding the app's expo, from
 *   RN_XTOOL_PROJECT_ROOT;
 * - `path.join(expoDir, 'package.json')`: appPackages() finding @expo/config-plugins through that expo;
 * - `path.dirname(configPlugins)`: `xcode` next to the app's @expo/config-plugins, as upstream does;
 * - `appRoot`: the plugin context's projectRoot (plugin.js);
 * - `from` / `path.join(from, 'package.json')`: a `dir(name, from)` helper walking app → expo → core;
 * - `process.argv[1]`: the Xcode build phase's PROJECT_ROOT (script-phases.js).
 */
const APP_BASES = [
  "path.join(appRoot, 'package.json')",
  "path.join(expoDir, 'package.json')",
  "path.dirname(configPlugins)",
  "appRoot",
  "from",
  "path.join(from, 'package.json')",
  "process.argv[1]",
];

type Site = { spec: string; base: string | null };

/** The argument list of the call whose `(` is at `open`, without the parentheses. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** The text inside a `paths: [ … ]` option (brackets balanced), or null without one. */
function pathsEntries(args: string): string | null {
  const m = /\bpaths:\s*\[/.exec(args);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < args.length; i++) {
    if (args[i] === "[") depth++;
    else if (args[i] === "]" && --depth === 0) return args.slice(m.index + m[0].length, i).trim();
  }
  return null;
}

/** The string specifier a call's arguments start with (template and escaped template text included), or null. */
function leadingSpecifier(args: string): string | null {
  const m = /^\s*\\?(['"`])((?:(?!\\?\1).)*)\\?\1/s.exec(args);
  return m ? m[2]!.replace(/\\\$/g, "$") : null;
}

/** Every `require(…)`, `require.resolve(…)` and `createRequire(…).resolve(…)` with a string specifier. */
function requireSites(text: string): Site[] {
  const sites: Site[] = [];
  const re = /\brequire\.resolve\(|\brequire\(|\bcreateRequire\(/g;
  for (let m; (m = re.exec(text)); ) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(text, open);
    if (m[0] === "createRequire(") {
      const after = open + args.length + 2;
      if (!text.startsWith(".resolve(", after)) continue;
      const spec = leadingSpecifier(callArgs(text, after + ".resolve".length));
      if (spec != null) sites.push({ spec, base: args.trim() });
      continue;
    }
    const spec = leadingSpecifier(args);
    if (spec == null) continue;
    sites.push({ spec, base: m[0] === "require.resolve(" ? pathsEntries(args) : null });
  }
  return sites;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The names a `const <fn> = (<name>, <from>) => …` helper is called with: `<fn>('<pkg>', …)`. */
function helperNames(text: string, param: string): string[] | null {
  const helper = new RegExp(`const (\\w+) = \\(${param.slice(2, -1)}, \\w+\\) =>`).exec(text);
  if (!helper) return null;
  return [...text.matchAll(new RegExp(`\\b${helper[1]}\\(\\s*['"]([^'"]+)['"]`, "g"))].map((m) => m[1]!);
}

/** Every unclassified package load in `text` (a file named `file`), as `file: specifier (why)`. */
function unclassifiedRequires(file: string, text: string, declared: Record<string, string>): string[] {
  const failures: string[] = [];
  const builtins = new Set(builtinModules);
  const fromApp = (name: string, base: string | null, spec: string) => {
    if (!APP_PACKAGES.includes(name)) failures.push(`${file}: ${spec} (unknown package ${name})`);
    else if (base == null) failures.push(`${file}: ${spec} (app package loaded with a plain require)`);
    else if (base.includes("__dirname")) failures.push(`${file}: ${spec} (app package resolved from __dirname)`);
    else if (!APP_BASES.includes(base) && !base.split(/,\s*/).every((b) => APP_BASES.includes(b)))
      failures.push(`${file}: ${spec} (app package resolved from ${base})`);
  };
  for (const { spec, base } of requireSites(text)) {
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    const name = packageName(spec);
    if (builtins.has(name.replace(/^node:/, ""))) continue;
    if (name in RN_XTOOL_DEPS) {
      if (declared[name] !== RN_XTOOL_DEPS[name])
        failures.push(`${file}: ${spec} (rn-xtool must depend on ${name} ${RN_XTOOL_DEPS[name]} exactly)`);
      continue;
    }
    if (LISTED_TEMPLATES.includes(name)) continue;
    const dynamic = /^\$\{\w+\}$/.exec(name);
    if (dynamic) {
      const names = helperNames(text, name);
      if (names == null || names.length === 0) failures.push(`${file}: ${spec} (dynamic specifier with unknown names)`);
      else for (const n of names) fromApp(n, base, `${spec} as ${n}`);
      continue;
    }
    fromApp(name, base, spec);
  }
  return failures;
}

describe("vendor/expo-spm dependencies", () => {
  it("every non-relative require is classified", () => {
    const declared = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> })
      .dependencies;
    const spm = vendoredSpm();
    const files = readdirSync(spm).filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(10);
    const failures = files.flatMap((f) => unclassifiedRequires(`spm/${f}`, readFileSync(path.join(spm, f), "utf8"), declared));
    expect(failures).toEqual([]);

    // The classifier itself: what it must refuse.
    expect(unclassifiedRequires("x.js", "require('left-pad');", declared)).toEqual(["x.js: left-pad (unknown package left-pad)"]);
    expect(unclassifiedRequires("x.js", "const { IOSConfig } = require('@expo/config-plugins');", declared)).toEqual([
      "x.js: @expo/config-plugins (app package loaded with a plain require)",
    ]);
    expect(unclassifiedRequires("x.js", "require.resolve('react-native/package.json', { paths: [__dirname] })", declared)).toEqual([
      "x.js: react-native/package.json (app package resolved from __dirname)",
    ]);
    expect(unclassifiedRequires("x.js", "require.resolve('expo-modules-macros/package.json')", { "expo-modules-macros": "^0.22.0" })).toEqual([
      "x.js: expo-modules-macros/package.json (rn-xtool must depend on expo-modules-macros 0.22.0 exactly)",
    ]);
  });

  it("the vendored plugin finds autolinking 58.0.15 and the macros from rn-xtool", () => {
    const req = createRequire(path.join(vendoredSpm(), "cli.js"));
    const autolinking = req.resolve("expo-modules-autolinking/package.json");
    expect(autolinking.startsWith(path.join(ROOT, "node_modules") + path.sep)).toBe(true);
    expect((JSON.parse(readFileSync(autolinking, "utf8")) as { version: string }).version).toBe("58.0.15");
    const macros = path.dirname(req.resolve("expo-modules-macros/package.json"));
    expect(
      existsSync(createRequire(path.join(macros, "package.json")).resolve(`@expo/modules-macros-linux-${process.arch}/ExpoModulesMacros`)),
    ).toBe(true);
  });
});

// --- The vendored-only edits ---

type AppTarget = { appPackages(): { IOSConfig: { marker?: string }; xcode: { marker?: string } } };
type Flavored = {
  artifactBaseDirs(packageName: string, moduleRoot: string | null): string[];
  extractTarball(src: string, packageName: string, frameworkName: string, cacheDir: string, flavor: string): string;
};

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

/** expo-constants 57's shape: headers flat in ios/, a podspec without header_dir; with Swift, mixed. */
const constantsFixture = (swift = false) =>
  moduleFixture("EXConstants", {
    "ios/EXConstantsService.h": "#import <Foundation/Foundation.h>\n@interface EXConstantsService : NSObject\n@end\n",
    "ios/EXConstantsService.m": "#import <EXConstants/EXConstantsService.h>\n@implementation EXConstantsService\n@end\n",
    ...(swift ? { "ios/ConstantsModule.swift": "import Foundation\n" } : {}),
  });

/** A mixed module whose Objective-C relies on CocoaPods' prefix header for UIKit. */
const prefixFixture = () =>
  moduleFixture("EXLegacy", {
    "ios/Legacy.swift": "import Foundation\n",
    "ios/EXLegacy/EXLegacyWrapper.h": "@interface EXLegacyWrapper : NSObject <UIApplicationDelegate>\n@end\n",
    "ios/EXLegacy/EXLegacyWrapper.m": '#import "EXLegacyWrapper.h"\n@implementation EXLegacyWrapper\n@end\n',
  });

const PREFIX_PCH = "#ifdef __OBJC__\n#import <UIKit/UIKit.h>\n#endif\n";

type FlaggedSubspec = { name: string; dir: string; compilerFlags: string[] };
type EmitSourceModule = {
  emitSourceModule(
    identity: object,
    hasManifest: boolean,
    ctx: EmitContext,
    dumpManifest: null,
    generatedPackages: Map<string, unknown>,
  ): { ok: { packageDep: { path: string } } };
};

/** expo-dev-launcher 57.0.21's podspec, abridged: its `Unsafe` subspec is Objective-C++ without ARC. */
const UNSAFE_PODSPEC = `Pod::Spec.new do |s|
  s.name           = 'expo-dev-launcher'
  s.source_files   = 'ios/**/*.{h,m,mm,swift,cpp}'
  s.exclude_files  = 'ios/Unsafe/**/*.{h,m,mm,swift,cpp}', 'ios/Tests/**/*.{h,m,swift}'
  s.requires_arc   = true
  s.header_dir     = 'EXDevLauncher'

  s.subspec 'Unsafe' do |unsafe|
    unsafe.source_files = 'ios/Unsafe/**/*.{h,m,mm,swift,cpp}'
    unsafe.compiler_flags = '-x objective-c++ -std=c++20 -fno-objc-arc' # Disable Automatic Reference Counting
  end

  s.subspec 'Main' do |main|
    main.dependency "expo-dev-launcher/Unsafe"
  end

  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = 'ios/Tests/**/*.{h,m,mm,swift}'
    test_spec.compiler_flags = '-fno-objc-arc'
  end

  s.default_subspec = 'Main'
end
`;

/** expo-dev-launcher 57's layout: mixed, with the `Unsafe` subspec's sources in ios/Unsafe. */
const unsafeFixture = () =>
  moduleFixture("EXDevLauncher", {
    "expo-dev-launcher.podspec": UNSAFE_PODSPEC,
    "ios/Launcher.swift": "import Foundation\n",
    "ios/EXDevLauncherController.h": "#import <Foundation/Foundation.h>\n@interface EXDevLauncherController : NSObject\n@end\n",
    "ios/EXDevLauncherController.m":
      "#import <EXDevLauncher/EXDevLauncherController.h>\n#import <EXDevLauncher/NSObject+EXUnsafe.h>\n@implementation EXDevLauncherController\n@end\n",
    "ios/Unsafe/NSObject+EXUnsafe.h": "#import <Foundation/Foundation.h>\n@interface NSObject (EXUnsafe)\n- (void)ex_unsafe;\n@end\n",
    "ios/Unsafe/NSObject+EXUnsafe.m":
      "#import <EXDevLauncher/NSObject+EXUnsafe.h>\n#import <EXDevLauncher/EXDevLauncherController.h>\n#import <mutex>\n" +
      "@implementation NSObject (EXUnsafe)\n- (void)ex_unsafe { static std::mutex m; std::lock_guard<std::mutex> l(m); [[NSObject new] release]; }\n@end\n",
    "ios/Tests/LauncherTests.swift": "",
  });

/** The `.target(…)` block named `name` in a rendered manifest, or "" without one. */
function targetBlock(manifest: string, name: string): string {
  const start = manifest.indexOf(`.target(\n            name: "${name}",`);
  if (start < 0) return "";
  const end = manifest.indexOf("\n        )", start);
  return manifest.slice(start, end);
}

/** The value of one `<key>: [...]` line of a target block. */
const settingLine = (block: string, key: string) =>
  block
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${key}: [`)) ?? "";

const UNSAFE_FLAGS = '.unsafeFlags(["-x", "objective-c++", "-std=c++20", "-fno-objc-arc", "-fno-cxx-modules"])';

describe("vendor/expo-spm edits", () => {
  it("P1 finds expo-modules-macros next to the vendored copy when core lacks it", () => {
    const core = mkTmp("vendor-p1-core-");
    writeFileSync(path.join(core, "package.json"), JSON.stringify({ name: "expo-modules-core", version: "57.0.0" }));
    const flags = loadSpm<Plugin>(vendoredSpm(), "plugin.js").macroPluginFlags(core);
    expect(flags[3]!.startsWith(path.join(ROOT, "node_modules", "@expo", `modules-macros-linux-${process.arch}`) + path.sep)).toBe(true);
    expect(flags[3]!.endsWith("#ExpoModulesMacros")).toBe(true);
  });

  /** A temp app; `pkgs` maps a path under node_modules to the marker its index.js exports. */
  function p2App(pkgs: Record<string, string>): string {
    const app = mkTmp("vendor-p2-app-");
    writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "app" }));
    for (const [rel, marker] of Object.entries(pkgs)) {
      const dir = path.join(app, "node_modules", rel);
      mkdirSync(dir, { recursive: true });
      const name = rel.split("/node_modules/").pop()!;
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
      const body = name === "@expo/config-plugins" ? `{ IOSConfig: { marker: "${marker}" } }` : `{ marker: "${marker}" }`;
      writeFileSync(path.join(dir, "index.js"), `module.exports = ${body};\n`);
    }
    return app;
  }

  it("P2 resolves app packages from RN_XTOOL_PROJECT_ROOT, never from vendor/", () => {
    const app = p2App({ expo: "expo", "@expo/config-plugins": "app", xcode: "app-xcode" });
    const appTarget = loadSpm<AppTarget>(vendoredSpm(), "app-target.js");
    const flavored = loadSpm<Flavored>(vendoredSpm(), "flavored-frameworks.js");

    withEnv({ RN_XTOOL_PROJECT_ROOT: app, EXPO_PRECOMPILED_MODULES_PATH: undefined }, () => {
      const { IOSConfig, xcode } = appTarget.appPackages();
      expect(IOSConfig.marker).toBe("app");
      expect(xcode.marker).toBe("app-xcode");
      const dirs = flavored.artifactBaseDirs("expo-modules-core", null);
      expect(dirs.length).toBeGreaterThan(0);
      for (const d of dirs) expect(d.startsWith(app + path.sep), d).toBe(true);
    });
    withEnv({ RN_XTOOL_PROJECT_ROOT: undefined }, () => {
      expect(() => appTarget.appPackages()).toThrow(/RN_XTOOL_PROJECT_ROOT is not set/);
    });
  });

  it("P2 loads the @expo/config-plugins of the app's expo, as the installed copy does", () => {
    const app = p2App({
      expo: "expo",
      "@expo/config-plugins": "top",
      xcode: "top-xcode",
      "expo/node_modules/@expo/config-plugins": "expo",
      "expo/node_modules/xcode": "expo-xcode",
    });
    withEnv({ RN_XTOOL_PROJECT_ROOT: app }, () => {
      const { IOSConfig, xcode } = loadSpm<AppTarget>(vendoredSpm(), "app-target.js").appPackages();
      expect(IOSConfig.marker).toBe("expo");
      expect(xcode.marker).toBe("expo-xcode");
    });
  });

  it("P2 takes a relative RN_XTOOL_PROJECT_ROOT against the working directory", () => {
    const app = p2App({ expo: "expo", "@expo/config-plugins": "app", xcode: "app-xcode" });
    const rel = path.relative(process.cwd(), app);
    expect(path.isAbsolute(rel)).toBe(false);
    withEnv({ RN_XTOOL_PROJECT_ROOT: rel, EXPO_PRECOMPILED_MODULES_PATH: undefined }, () => {
      expect(loadSpm<AppTarget>(vendoredSpm(), "app-target.js").appPackages().IOSConfig.marker).toBe("app");
      const dirs = loadSpm<Flavored>(vendoredSpm(), "flavored-frameworks.js").artifactBaseDirs("expo-modules-core", null);
      expect(dirs).toEqual([path.join(app, "node_modules", "precompile", ".build", "expo-modules-core", "output")]);
    });
  });

  it("P3 gives flat-header mixed packages the pod name as header dir", () => {
    const spm = vendoredSpm();
    for (const [swift, expected] of [[true, "mixed"], [false, "clang"]] as const) {
      const root = constantsFixture(swift);
      const { sources, layout } = layoutOf(spm, "EXConstants", root);
      expect(layout).toBe(expected);
      const { dir } = emit(spm, "EXConstants", root, layout!, sources);
      expect(existsSync(path.join(dir, "pod-headers", "EXConstants", "EXConstantsService.h")), expected).toBe(true);
    }
  });

  it("P4 writes a UIKit prefix header and includes it for C and C++", () => {
    const spm = vendoredSpm();
    const root = prefixFixture();
    const { sources, layout } = layoutOf(spm, "EXLegacy", root);
    expect(layout).toBe("mixed");
    const { dir, read, manifest } = emit(spm, "EXLegacy", root, layout!, sources);
    expect(read("prefix.pch")).toBe(PREFIX_PCH);
    const include = `"-include", "${path.join(dir, "prefix.pch")}"`;
    const settings = (key: string) => manifest.split("\n").find((l) => l.includes(`${key}: [`)) ?? "";
    expect(settings("cSettings")).toContain(include);
    expect(settings("cxxSettings")).toContain(include);
  });

  it("P6 reads the compiler flags of a subspec with its own source directory", () => {
    const podspec = loadSpm<{ readPodspecFacts(o: object): { flaggedSubspecs?: FlaggedSubspec[] } }>(vendoredSpm(), "podspec.js");
    const root = unsafeFixture();
    expect(podspec.readPodspecFacts({ podName: "expo-dev-launcher", podspecDir: root, moduleRoot: root }).flaggedSubspecs).toEqual([
      { name: "Unsafe", dir: path.join(root, "ios", "Unsafe"), compilerFlags: ["-x", "objective-c++", "-std=c++20", "-fno-objc-arc"] },
    ]);

    // Globs are relative to the podspec; flags without source files of their own, interpolated
    // Ruby, a source glob outside one directory and test specs are not read.
    const nested = moduleFixture(
      "EXNested",
      { "ios/Legacy/L.m": "" },
      [
        "s.subspec 'Legacy' do |legacy|",
        "    legacy.source_files = ['Legacy/*.{h,m}', 'Legacy/**/*.mm']",
        "    legacy.ios.compiler_flags = '-fno-objc-arc', '-Wno-deprecated'",
        "  end",
        "  s.subspec 'Flagged' do |f|",
        "    f.compiler_flags = '-fno-objc-arc'",
        "  end",
        "  s.subspec 'Interpolated' do |i|",
        "    i.source_files = 'Other/**/*.m'",
        "    i.compiler_flags = \"#{flags}\"",
        "  end",
        "  s.subspec 'Spread' do |w|",
        "    w.source_files = '**/*.m'",
        "    w.compiler_flags = '-fno-objc-arc'",
        "  end",
      ].join("\n"),
    );
    expect(
      podspec.readPodspecFacts({ podName: "EXNested", podspecDir: path.join(nested, "ios"), moduleRoot: nested }).flaggedSubspecs,
    ).toEqual([{ name: "Legacy", dir: path.join(nested, "ios", "Legacy"), compilerFlags: ["-fno-objc-arc", "-Wno-deprecated"] }]);
    const constants = constantsFixture();
    expect(podspec.readPodspecFacts({ podName: "EXConstants", podspecDir: path.join(constants, "ios"), moduleRoot: constants }).flaggedSubspecs).toEqual([]);
  });

  it("P6 builds a flagged subspec as its own Clang target with its flags", () => {
    const spm = vendoredSpm();
    const root = unsafeFixture();
    const sources = loadSpm<Classify>(spm, "classify.js").scanAppleSources(root);
    const facts = loadSpm<Podspec>(spm, "podspec.js").readPodspecFacts({ podName: "expo-dev-launcher", podspecDir: root, moduleRoot: root });
    const identity = { moduleRoot: root, packageName: "expo-dev-launcher", podName: "expo-dev-launcher", iosDeploymentTarget: null, spmPackages: [], sources, podspec: facts };
    const ctx = { frameworkSearchPath: "/fw", outDir: mkTmp("vendor-p6-out-"), macroFlags: [] };
    const plugin = loadSpm<EmitSourceModule>(spm, "plugin.js");
    const dir = plugin.emitSourceModule(identity, false, ctx, null, new Map()).ok.packageDep.path;
    const manifest = readFileSync(path.join(dir, "Package.swift"), "utf8");

    expect(manifest).toContain('.library(name: "EXDevLauncher", targets: ["EXDevLauncher", "EXDevLauncher_Unsafe"])');
    const main = targetBlock(manifest, "EXDevLauncher");
    expect(main).toContain('path: "root/ios",');
    expect(settingLine(main, "exclude")).toBe('exclude: ["Tests", "Unsafe"],');
    expect(main).not.toContain("objective-c++");

    const unsafe = targetBlock(manifest, "EXDevLauncher_Unsafe");
    expect(unsafe).toContain('path: "root/ios/Unsafe",');
    expect(unsafe).toContain('dependencies: [\n                "EXDevLauncher",\n            ],');
    expect(unsafe).toContain('publicHeadersPath: ".",');
    // The main target's Clang settings (header search paths, prefix header), then the subspec's flags.
    for (const key of ["cSettings", "cxxSettings"]) {
      const own = settingLine(main, key).slice(0, -2);
      expect(settingLine(unsafe, key), key).toBe(`${own}, ${UNSAFE_FLAGS}],`);
    }
    // The subspec's header stays reachable as <EXDevLauncher/…>, from both targets.
    expect(readFileSync(path.join(dir, "pod-headers", "EXDevLauncher", "NSObject+EXUnsafe.h"), "utf8")).toBe(
      `#import "${path.join(root, "ios", "Unsafe", "NSObject+EXUnsafe.h")}"\n`,
    );
    // The versioned 6.5 manifest carries the same targets.
    expect(readFileSync(path.join(dir, "Package@swift-6.5.swift"), "utf8")).toContain('name: "EXDevLauncher_Unsafe",');
  });

  /** A C-family file that is not a placeholder (an empty one would make the module pure Swift). */
  const C_SOURCE = "int odd(void) { return 1; }\n";
  /** An EXOdd module (mixed, at the root) with `files` and a root `EXOdd.podspec` of `subspecs`; its facts and manifest. */
  function oddPackage(files: Record<string, string>, subspecs: string) {
    const spm = vendoredSpm();
    const root = moduleFixture(
      "EXOdd",
      { "ios/Odd.swift": "", "ios/Odd.h": "", "ios/Odd.m": C_SOURCE, ...files, "EXOdd.podspec": `Pod::Spec.new do |s|\n${subspecs}\nend\n` },
      "s.source_files = 'ios/**/*'",
    );
    const sources = loadSpm<Classify>(spm, "classify.js").scanAppleSources(root);
    const facts = loadSpm<Podspec>(spm, "podspec.js").readPodspecFacts({ podName: "EXOdd", podspecDir: root, moduleRoot: root }) as {
      flaggedSubspecs?: FlaggedSubspec[];
    };
    const identity = { moduleRoot: root, packageName: "expo-odd", podName: "EXOdd", iosDeploymentTarget: null, spmPackages: [], sources, podspec: facts };
    const ctx = { frameworkSearchPath: "/fw", outDir: mkTmp("vendor-p6-odd-"), macroFlags: [] };
    const dir = loadSpm<EmitSourceModule>(spm, "plugin.js").emitSourceModule(identity, false, ctx, null, new Map()).ok.packageDep.path;
    return { root, facts, manifest: readFileSync(path.join(dir, "Package.swift"), "utf8") };
  }
  const subspec = (name: string, glob: string, flags = "'-fno-objc-arc'") =>
    `  s.subspec '${name}' do |x|\n    x.source_files = '${glob}'\n    x.compiler_flags = ${flags}\n  end`;
  const targetNames = (manifest: string) => [...manifest.matchAll(/\.target\(\n {12}name: "([^"]+)"/g)].map((m) => m[1]);

  it("P6 leaves a flagged subspec it cannot split in the main target", () => {
    // Swift in the directory, only headers, the whole source directory, a directory outside it,
    // one inside an ignored directory.
    for (const [files, glob] of [
      [{ "ios/X/X.swift": "", "ios/X/X.m": C_SOURCE }, "ios/X/**/*"],
      [{ "ios/X/X.h": "" }, "ios/X/**/*"],
      [{}, "ios/**/*.m"],
      [{ "common/X.m": "" }, "common/*.m"],
      [{ "ios/Tests/X/X.m": C_SOURCE }, "ios/Tests/X/*.m"],
    ] as const) {
      const { facts, manifest } = oddPackage(files, subspec("X", glob));
      expect(facts.flaggedSubspecs?.map((f) => f.name), glob).toEqual(["X"]);
      expect(targetNames(manifest), glob).toEqual(["EXOdd"]);
      expect(manifest, glob).not.toContain("-fno-objc-arc");
    }
  });

  it("P6 reads only compiler flags and sources that are literal values", () => {
    for (const [flags, globs] of [
      ["'-fno-objc-arc' if ENV['MRC']", "'ios/X/*.m'"],
      ["'-w', extra_flags", "'ios/X/*.m'"],
      ["ENV['X'] || '-w'", "'ios/X/*.m'"],
      ["'-w'.freeze", "'ios/X/*.m'"],
      ["'-fno-objc-arc'", "'ios/X/*.m', more_globs"],
      ["'-fno-objc-arc'", "['ios/X/*.m'] + extra"],
    ]) {
      const body = `  s.subspec 'X' do |x|\n    x.source_files = ${globs}\n    x.compiler_flags = ${flags}\n  end`;
      const { facts, manifest } = oddPackage({ "ios/X/X.m": C_SOURCE }, body);
      expect(facts.flaggedSubspecs, `${flags} / ${globs}`).toEqual([]);
      expect(targetNames(manifest)).toEqual(["EXOdd"]);
    }
    // An append to a literal is not a literal value either.
    const appended = `  s.subspec 'X' do |x|\n    x.source_files = 'ios/X/*.m'\n    x.compiler_flags = '-w'\n    x.compiler_flags += ' -fno-objc-arc'\n  end`;
    expect(oddPackage({ "ios/X/X.m": C_SOURCE }, appended).facts.flaggedSubspecs).toEqual([]);
    // Literal forms that are read: one string, several, an array, with a comment after.
    for (const flags of ["'-w -fno-objc-arc'", "'-w', \"-fno-objc-arc\"", "[ '-w', '-fno-objc-arc', ] # MRC"]) {
      expect(oddPackage({ "ios/X/X.m": C_SOURCE }, subspec("X", "ios/X/*.m", flags)).facts.flaggedSubspecs?.[0]?.compilerFlags, flags).toEqual([
        "-w",
        "-fno-objc-arc",
      ]);
    }
  });

  it("P6 splits several subspecs and adds -fno-cxx-modules only for C++", () => {
    const { manifest } = oddPackage(
      { "ios/A/A.m": C_SOURCE, "ios/B/B.c": C_SOURCE },
      [subspec("A", "ios/A/**/*.{h,m}", "'-xobjective-c++ -fno-objc-arc'"), subspec("B", "ios/B/*.c", "'-x c -w'")].join("\n"),
    );
    expect(targetNames(manifest)).toEqual(["EXOdd", "EXOdd_A", "EXOdd_B"]);
    expect(manifest).toContain('.library(name: "EXOdd", targets: ["EXOdd", "EXOdd_A", "EXOdd_B"])');
    expect(settingLine(targetBlock(manifest, "EXOdd"), "exclude")).toBe('exclude: ["A", "B"],');
    expect(settingLine(targetBlock(manifest, "EXOdd_A"), "cSettings")).toContain(
      '.unsafeFlags(["-xobjective-c++", "-fno-objc-arc", "-fno-cxx-modules"])],',
    );
    expect(settingLine(targetBlock(manifest, "EXOdd_B"), "cSettings")).toContain('.unsafeFlags(["-x", "c", "-w"])],');
  });

  it("P6 keeps one target per directory and per name", () => {
    // A subspec nested in another's directory is compiled with the outer subspec's flags.
    const nested = oddPackage({ "ios/A/A.m": C_SOURCE, "ios/A/B/B.m": C_SOURCE }, [subspec("A", "ios/A/**/*.m"), subspec("B", "ios/A/B/*.m", "'-w'")].join("\n"));
    expect(nested.facts.flaggedSubspecs?.map((f) => f.name)).toEqual(["A", "B"]);
    expect(targetNames(nested.manifest)).toEqual(["EXOdd", "EXOdd_A"]);
    expect(nested.manifest).not.toContain('"-w"');
    // Two names with one C99 identifier: the first keeps it, the second stays in the module's target.
    const clash = oddPackage({ "ios/X/X.m": C_SOURCE, "ios/Y/Y.m": C_SOURCE }, [subspec("Foo-Bar", "ios/X/*.m"), subspec("Foo_Bar", "ios/Y/*.m", "'-w'")].join("\n"));
    expect(targetNames(clash.manifest)).toEqual(["EXOdd", "EXOdd_Foo_Bar"]);
    expect(targetBlock(clash.manifest, "EXOdd_Foo_Bar")).toContain('path: "root/ios/X",');
    expect(settingLine(targetBlock(clash.manifest, "EXOdd"), "exclude")).toBe('exclude: ["X"],');
    expect(clash.manifest).not.toContain('"-w"');
  });

  it("P6 carries the module's excludes under a subspec's directory over to its target", () => {
    const { manifest } = oddPackage(
      { "ios/A/A.m": C_SOURCE, "ios/A/View.xib": "", "ios/A/Media.xcassets/Contents.json": "{}", "ios/A/Tests/ATests.m": C_SOURCE },
      subspec("A", "ios/A/**/*.m"),
    );
    expect(settingLine(targetBlock(manifest, "EXOdd_A"), "exclude")).toBe('exclude: ["Tests", "Media.xcassets", "View.xib"],');
    expect(settingLine(targetBlock(manifest, "EXOdd"), "exclude")).toContain('"A"]');
  });

  it("P5 extracts without AppleDouble entries or xattr warnings", () => {
    const src = mkTmp("vendor-p5-src-");
    mkdirSync(path.join(src, "X.xcframework"));
    writeFileSync(path.join(src, "X.xcframework", "Info.plist"), "<plist/>\n");
    writeFileSync(path.join(src, "X.xcframework", "._Info.plist"), "AppleDouble");
    writeFileSync(path.join(src, "._X.xcframework"), "AppleDouble");
    const tgz = path.join(mkTmp("vendor-p5-tgz-"), "X.tar.gz");
    const made = spawnSync(
      "tar",
      ["--format=pax", "--pax-option=LIBARCHIVE.xattr.com.apple.provenance=AQ", "-czf", tgz, "-C", src, "._X.xcframework", "X.xcframework"],
      { encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    const cache = mkTmp("vendor-p5-cache-");
    const xcframework = loadSpm<Flavored>(vendoredSpm(), "flavored-frameworks.js").extractTarball(tgz, "x", "X", cache, "debug");
    expect(path.basename(xcframework)).toBe("X.xcframework");
    expect(existsSync(path.join(xcframework, "Info.plist"))).toBe(true);
    expect(listFiles(cache).filter((f) => path.basename(f).startsWith("._"))).toEqual([]);
  });

  it.skipIf(skipReason != null)("the 58 copy keeps 58's behaviour", () => {
    const spm = shared58Spm()!;
    const constants = constantsFixture();
    const c = layoutOf(spm, "EXConstants", constants);
    expect(existsSync(path.join(emit(spm, "EXConstants", constants, c.layout!, c.sources).dir, "pod-headers", "EXConstants"))).toBe(false);
    const legacy = prefixFixture();
    const l = layoutOf(spm, "EXLegacy", legacy);
    const { dir, manifest } = emit(spm, "EXLegacy", legacy, l.layout!, l.sources);
    expect(existsSync(path.join(dir, "prefix.pch"))).toBe(false);
    expect(manifest).not.toContain("prefix.pch");
    const unsafe = unsafeFixture();
    const u = layoutOf(spm, "EXDevLauncher", unsafe);
    const podspec = loadSpm<{ readPodspecFacts(o: object): { flaggedSubspecs?: unknown } }>(spm, "podspec.js");
    expect(podspec.readPodspecFacts({ podName: "expo-dev-launcher", podspecDir: unsafe, moduleRoot: unsafe }).flaggedSubspecs).toBeUndefined();
    expect(emit(spm, "EXDevLauncher", unsafe, u.layout!, u.sources).manifest).not.toContain("EXDevLauncher_Unsafe");
  });
});

// --- Autolinking 58.0.15 against an SDK 57 app ---

const EXPO57_APP = process.env["RN_XTOOL_EXPO57_APP"] ?? path.resolve(import.meta.dirname, "../../app-expo-57");
const app57Autolinking = path.join(EXPO57_APP, "node_modules", "expo-modules-autolinking");
const has57Autolinking = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(app57Autolinking, "package.json"), "utf8")) as { version: string }).version === "57.0.16";
  } catch {
    return false;
  }
})();

describe.skipIf(!has57Autolinking)("autolinking 58.0.15 on SDK 57", () => {
  it("autolinking 58.0.15 generates 57's own ExpoModulesProvider", () => {
    const bin57 = path.join(app57Autolinking, "bin", "expo-modules-autolinking.js");
    const bin58 = createRequire(path.join(vendoredSpm(), "cli.js")).resolve("expo-modules-autolinking/bin/expo-modules-autolinking.js");
    const run = (bin: string, args: string[]) => {
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: EXPO57_APP, encoding: "utf8", maxBuffer: 1 << 26 });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const provider = (bin: string, extra: string[]) => {
      const resolved = JSON.parse(run(bin, ["resolve", "--platform", "apple", "--json"])) as
        | { packageName: string }[]
        | { modules: { packageName: string }[] };
      const names = (Array.isArray(resolved) ? resolved : resolved.modules).map((m) => m.packageName);
      expect(names.length).toBeGreaterThan(0);
      // Same file name in both runs: the class is named after it.
      const target = path.join(mkTmp("vendor-provider-"), "ExpoModulesProvider.swift");
      run(bin, ["generate-modules-provider", "--target", target, "--app-root", EXPO57_APP, "--platform", "apple", ...extra, "--packages", ...names]);
      return readFileSync(target, "utf8");
    };
    expect(provider(bin58, ["--target-platform", "ios"])).toBe(provider(bin57, []));
  });
});
