import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../src/tools/exec.js";
import { FETCH_HINT } from "./support/tarballs.js";
import { hasTool, patchTool, tool } from "./support/tools.js";
import {
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

const has = hasTool;
const skipReason = !existsSync(EXPO_TARBALL)
  ? `pristine tarball missing; ${FETCH_HINT}`
  : !has("tar") || !has("patch")
    ? "tar and patch are required"
    : null;
const provenance = skipReason ? (title: string, fn: () => void) => it.skip(`${title} (${skipReason})`, fn) : it;

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
    expect(tool("tar", ["-xzf", EXPO_TARBALL, "-C", dir, "package/scripts/spm"]).status).toBe(0);
    const scripts = path.join(dir, "package", "scripts");
    const patchOne = (strip: string, cwd: string, file: string) =>
      patchTool([strip, "-F0", "-d", cwd, "-i", file]);
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
    const out = tool("tar", ["-xzOf", EXPO_TARBALL, "package/LICENSE"], { encoding: "buffer" }) as unknown as { status: number | null; stdout: Buffer };
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

  type P7Podspec = { podspecIosDeploymentTarget(text: string): string | null };
  /** A podspec whose top-level spec (`|s|`) holds `body`. */
  const p7Podspec = (body: string) => `Pod::Spec.new do |s|\n  s.name = 'EXFloor'\n${body}\nend\n`;

  it("P7 reads the iOS deployment target a podspec declares", () => {
    const { podspecIosDeploymentTarget } = loadSpm<P7Podspec>(vendoredSpm(), "podspec.js");
    for (const [body, expected] of [
      // expo-router 56.2.22's form.
      ["  s.platforms      = {\n    :ios => '16.4'\n  }", "16.4"],
      ["  s.platforms = { :ios => '16.4', :tvos => '16.4' }", "16.4"],
      // Several lines, a trailing comma (@expo/dom-webview 56), the Ruby 1.9 key.
      ["  s.platforms       = {\n    :osx => '13.4',\n    :ios => \"16.4\",\n  }", "16.4"],
      ["  s.platforms = { ios: '15.1', tvos: '15.1' }", "15.1"],
      ["  s.ios.deployment_target = '15.1'", "15.1"],
      ["  s.platform = :ios, '13.0'", "13.0"],
      // The highest literal the top-level spec declares.
      ["  s.ios.deployment_target = '15.1'\n  s.platforms = { :ios => '16.4' } # floor", "16.4"],
      // Not literal values.
      ["  s.platforms = { :ios => min_ios_version_supported }", null],
      ['  s.platforms = { :ios => "#{ios_min}" }', null],
      ["  s.ios.deployment_target = ios_min", null],
      ["  s.platform = :ios, '13.0'.freeze", null],
      ["  s.platforms = { :ios => '16.4' }.merge(extra)", null],
      // A test_spec's or a subspec's own platforms.
      ["  s.test_spec 'Tests' do |test_spec|\n    test_spec.platforms = { :ios => '17.0' }\n  end", null],
      ["  s.subspec 'Extra' do |ss|\n    ss.ios.deployment_target = '17.0'\n  end", null],
      ["  s.subspec 'Shadow' do |s|\n    s.platforms = { :ios => '17.0' }\n  end\n  s.platforms = { :ios => '16.4' }", "16.4"],
      // No iOS, no platform at all.
      ["  s.platforms = { :osx => '13.4' }", null],
      ["  s.platform = :ios", null],
      ["  s.swift_version = '5.9'", null],
    ] as const) {
      expect(podspecIosDeploymentTarget(p7Podspec(body)), body).toBe(expected);
    }
    // Only the `Pod::Spec.new` receiver counts, whatever its name.
    expect(podspecIosDeploymentTarget("Pod::Spec.new do |spec|\n  spec.platforms = { :ios => '16.4' }\nend\n")).toBe("16.4");
    expect(podspecIosDeploymentTarget("x.platforms = { :ios => '16.4' }\n")).toBeNull();
  });

  it("P7 raises a module to its podspec's iOS floor", () => {
    type PodIdentity = {
      podIdentity(
        record: { productName: string; iosDeploymentTarget: string | null } | null,
        pod: { podName: string; podspecDir: string },
        packageName: string,
        autolinkedRoot: string | null,
        readModuleRoot: { sources(root: string): unknown },
      ): { iosDeploymentTarget: string | null; podspec: { iosDeploymentTarget?: string | null } };
    };
    const { podIdentity } = loadSpm<PodIdentity>(vendoredSpm(), "plugin.js");
    const readModuleRoot = { sources: loadSpm<Classify>(vendoredSpm(), "classify.js").scanAppleSources };
    for (const [record, podspec, expected] of [
      [null, "16.4", "16.4"],
      ["16.0", "16.4", "16.4"],
      ["17.0", "16.4", "17.0"],
      ["16.0", "15.1", "16.0"],
      [null, null, null],
    ] as const) {
      const body = podspec == null ? "s.source_files = 'ios/**/*.swift'" : `s.platforms = {\n    :ios => '${podspec}'\n  }`;
      const root = moduleFixture("EXFloor", { "ios/Floor.swift": "import Foundation\n" }, body);
      const identity = podIdentity(
        record == null ? null : { productName: "EXFloor", iosDeploymentTarget: record },
        { podName: "EXFloor", podspecDir: path.join(root, "ios") },
        "expo-floor",
        root,
        readModuleRoot,
      );
      expect(identity.podspec.iosDeploymentTarget, `${record} / ${podspec}`).toBe(podspec);
      expect(identity.iosDeploymentTarget, `${record} / ${podspec}`).toBe(expected);
    }
  });

  it("P7 reads only what Ruby runs, and versions SwiftPM takes", () => {
    const { podspecIosDeploymentTarget } = loadSpm<P7Podspec>(vendoredSpm(), "podspec.js");
    const floor = "  s.platforms = { :ios => '16.4' }";
    for (const [body, expected] of [
      // Heredoc bodies are text, whatever they look like.
      [`  s.description = <<-DESC\n    s.platforms = { :ios => '17.0' }\n  DESC\n${floor}`, "16.4"],
      [`  s.description = <<~EOS.strip\n    s.ios.deployment_target = '17.0'\n  EOS\n${floor}`, "16.4"],
      [`  s.description = <<~'EOS'\n    s.platform = :ios, '17.0'\n  EOS\n${floor}`, "16.4"],
      [`  s.summary, s.description = <<-ONE, <<-TWO\n    s.platforms = { :ios => '17.0' }\n  ONE\n    s.platforms = { :ios => '18.0' }\n  TWO\n${floor}`, "16.4"],
      // A heredoc whose terminator never comes hides the rest, as Ruby would refuse it.
      [`  s.description = <<-DESC\n${floor}`, null],
      // An append is not a heredoc.
      [`  s.preserve_paths = []\n  s.preserve_paths << 'ios'\n${floor}`, "16.4"],
      // `=begin`/`=end` comments, from column 0 only.
      [`=begin\n  s.ios.deployment_target = '17.0'\n=end\n${floor}`, "16.4"],
      [`  s.ios.deployment_target = '17.0' # =begin\n`, "17.0"],
      // A one-part version is written as SwiftPM documents it: two parts.
      ["  s.ios.deployment_target = '17'", "17.0"],
      ['  s.platforms = { :ios => "17" }', "17.0"],
      ["  s.ios.deployment_target = '16.4.1'", "16.4.1"],
      ["  s.ios.deployment_target = '16.4.0.1'", null],
      // Versions compare as numbers.
      [`  s.platforms = { :ios => '16.10' }\n${floor}`, "16.10"],
      [`${floor}\n  s.ios.deployment_target = '16.10'`, "16.10"],
      // A nested spec whose block variable shadows the top-level receiver.
      [`  s.test_spec 'Tests' do |s|\n    s.platforms = { :ios => '17.0' }\n  end\n${floor}`, "16.4"],
      [`  s.app_spec 'App' do |s|\n    s.ios.deployment_target = '17.0'\n  end\n${floor}`, "16.4"],
      ["  s.app_spec 'App' do |app|\n    app.ios.deployment_target = '17.0'\n  end", null],
    ] as const) {
      expect(podspecIosDeploymentTarget(p7Podspec(body)), body).toBe(expected);
    }
  });

  it("P7 takes the highest floor over several podspecs in one package", () => {
    const { readPodspecFacts } = loadSpm<{ readPodspecFacts(o: object): { iosDeploymentTarget?: string | null } }>(vendoredSpm(), "podspec.js");
    const root = moduleFixture("EXFloor", {
      "ios/EXFloorA.podspec": "Pod::Spec.new do |s|\n  s.platforms = { :ios => '16.4' }\nend\n",
      "ios/EXFloorB.podspec": "Pod::Spec.new do |spec|\n  spec.ios.deployment_target = '16.10'\nend\n",
      "ios/EXFloorC.podspec": "Pod::Spec.new do |s|\n  s.ios.deployment_target = min_ios\nend\n",
    });
    rmSync(path.join(root, "ios", "EXFloor.podspec"));
    // No podspec carries the pod's name, so every one in the directory describes it.
    expect(readPodspecFacts({ podName: "EXFloor", podspecDir: path.join(root, "ios"), moduleRoot: root }).iosDeploymentTarget).toBe("16.10");
  });

  type FloorIdentity = {
    packageName: string;
    iosDeploymentTarget: string | null;
    cappedPodspecFloor?: string | null;
    podspec: { iosDeploymentTarget?: string | null };
  };
  type FloorPlugin = {
    resolvePodIdentities(
      modules: { packageName: string; pods: { podName: string; podspecDir: string }[] }[],
      metadata: Map<string, { productName: string; iosDeploymentTarget: string | null }>,
      autolinkedRoots: Map<string, string>,
    ): Map<{ podName: string }, FloorIdentity>;
    emitSourceModule(
      identity: FloorIdentity,
      hasManifest: boolean,
      ctx: object,
      dumpManifest: () => never,
    ): { ok: { packageDep: { path: string } } } | null;
    cappedFloorWarnings(emitted: { identity: FloorIdentity; linkedAs: string }[], minimum: string | null): string[];
    reportCappedFloors(warnings: string[]): void;
  };
  const APP_TARGET = "RN_XTOOL_APP_IOS_DEPLOYMENT_TARGET";
  const NOTES = "RN_XTOOL_PLUGIN_NOTES";

  /**
   * Core (spm.config.json 16.0, podspec 16.4) and three siblings: one that declares no floor, one whose podspec asks
   * 17.0 and one whose spm.config.json asks 17.0, through resolvePodIdentities and the generated manifests.
   */
  function floorApp() {
    const plugin = loadSpm<FloorPlugin>(vendoredSpm(), "plugin.js");
    const swift = { "ios/Module.swift": "import Foundation\n" };
    const pkgs = {
      "expo-modules-core": moduleFixture("ExpoModulesCore", swift, "s.platforms = {\n    :ios => '16.4'\n  }"),
      "expo-plain": moduleFixture("EXPlain", swift, "s.source_files = 'ios/**/*.swift'"),
      "expo-podspec-17": moduleFixture("EXPodspec17", swift, "s.platforms = { :ios => '17.0' }"),
      "expo-config-17": moduleFixture("EXConfig17", swift, "s.source_files = 'ios/**/*.swift'"),
    };
    const pods = { "expo-modules-core": "ExpoModulesCore", "expo-plain": "EXPlain", "expo-podspec-17": "EXPodspec17", "expo-config-17": "EXConfig17" };
    const modules = Object.entries(pods).map(([packageName, podName]) => ({
      packageName,
      pods: [{ podName, podspecDir: path.join(pkgs[packageName as keyof typeof pkgs], "ios") }],
    }));
    const metadata = new Map([
      ["ExpoModulesCore", { productName: "ExpoModulesCore", iosDeploymentTarget: "16.0" }],
      ["EXConfig17", { productName: "EXConfig17", iosDeploymentTarget: "17.0" }],
    ]);
    const identities = plugin.resolvePodIdentities(modules, metadata, new Map(Object.entries(pkgs)));
    const byPod = new Map([...identities].map(([pod, identity]) => [pod.podName, identity]));
    const core = byPod.get("ExpoModulesCore")!;
    const outDir = mkTmp("vendor-p7-out-");
    // What linkPasses hands every generated package: core's floor as the minimum.
    const ctx = { frameworkSearchPath: "/fw", outDir, macroFlags: [], minimumIosDeploymentTarget: core.iosDeploymentTarget };
    const platforms = (pod: string) => {
      const emission = plugin.emitSourceModule(byPod.get(pod)!, false, ctx, () => {
        throw new Error("no checked-in manifest");
      });
      const manifest = readFileSync(path.join(emission!.ok.packageDep.path, "Package.swift"), "utf8");
      return /platforms: .*/.exec(manifest)?.[0];
    };
    const emitted = ["EXPlain", "EXPodspec17", "EXConfig17"].map((pod) => ({ identity: byPod.get(pod)!, linkedAs: "pure-swift" }));
    return { plugin, core, byPod, platforms, warnings: () => plugin.cappedFloorWarnings(emitted, core.iosDeploymentTarget) };
  }

  it("P7 takes core's podspec floor into a sibling's generated manifest", () => {
    withEnv({ [APP_TARGET]: "16.4" }, () => {
      const app = floorApp();
      expect(app.core.iosDeploymentTarget).toBe("16.4");
      expect(app.platforms("EXPlain")).toBe('platforms: [.iOS("16.4")],');
    });
  });

  it("P7 caps a podspec's floor at the app's deployment target and warns once", () => {
    withEnv({ [APP_TARGET]: "16.4" }, () => {
      const app = floorApp();
      expect(app.byPod.get("EXPodspec17")!.podspec.iosDeploymentTarget).toBe("17.0");
      expect(app.byPod.get("EXPodspec17")!.iosDeploymentTarget).toBe("16.4");
      expect(app.platforms("EXPodspec17")).toBe('platforms: [.iOS("16.4")],');
      expect(app.warnings()).toEqual([
        "expo-podspec-17's podspec asks for iOS 17.0, and rn-xtool builds the app for iOS 16.4, so expo-podspec-17 is " +
          "compiled for iOS 16.4: its code that needs iOS 17.0 must be behind an availability check " +
          "(`if #available(iOS 17.0, *)`). On a Mac, the app's deployment target would be raised to iOS 17.0 instead.",
      ]);
    });
  });

  it("P7 leaves a module's own spm.config.json floor as it was", () => {
    withEnv({ [APP_TARGET]: "16.4" }, () => {
      const app = floorApp();
      // Before P7: the spm.config.json floor raised to core's spm.config.json floor (16.0).
      expect(app.byPod.get("EXConfig17")!.iosDeploymentTarget).toBe("17.0");
      expect(app.platforms("EXConfig17")).toBe('platforms: [.iOS("17.0")],');
      expect(app.warnings().join("\n")).not.toContain("expo-config-17");
    });
  });

  it("P7 takes a podspec's floor uncapped and silent without the app's deployment target", () => {
    withEnv({ [APP_TARGET]: undefined }, () => {
      const app = floorApp();
      expect(app.byPod.get("EXPodspec17")!.iosDeploymentTarget).toBe("17.0");
      expect(app.platforms("EXPodspec17")).toBe('platforms: [.iOS("17.0")],');
      expect(app.platforms("EXPlain")).toBe('platforms: [.iOS("16.4")],');
      expect(app.warnings()).toEqual([]);
    });
    withEnv({ [APP_TARGET]: "sixteen" }, () => {
      expect(() => floorApp()).toThrow(/RN_XTOOL_APP_IOS_DEPLOYMENT_TARGET must be an iOS version/);
    });
  });

  it("P7 writes its warnings to the notes file rn-xtool prints, else to stderr", () => {
    const { reportCappedFloors } = loadSpm<FloorPlugin>(vendoredSpm(), "plugin.js");
    const notes = path.join(mkTmp("vendor-p7-notes-"), "notes.jsonl");
    withEnv({ [NOTES]: notes }, () => {
      reportCappedFloors([]);
      expect(existsSync(notes)).toBe(false);
      reportCappedFloors(["one", "two"]);
    });
    expect(readFileSync(notes, "utf8")).toBe('{"warning":"one"}\n{"warning":"two"}\n');
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (s: string) => warned.push(s);
    try {
      withEnv({ [NOTES]: undefined }, () => reportCappedFloors(["one"]));
    } finally {
      console.warn = warn;
    }
    expect(warned).toEqual(["[expo-spm-plugin] WARNING: one"]);
  });

  it("P5 extracts without AppleDouble entries or xattr warnings", () => {
    const src = mkTmp("vendor-p5-src-");
    mkdirSync(path.join(src, "X.xcframework"));
    writeFileSync(path.join(src, "X.xcframework", "Info.plist"), "<plist/>\n");
    writeFileSync(path.join(src, "X.xcframework", "._Info.plist"), "AppleDouble");
    writeFileSync(path.join(src, "._X.xcframework"), "AppleDouble");
    const tgz = path.join(mkTmp("vendor-p5-tgz-"), "X.tar.gz");
    const made = tool("tar", [
      "--format=pax",
      "--pax-option=LIBARCHIVE.xattr.com.apple.provenance=AQ",
      "-czf",
      tgz,
      "-C",
      src,
      "._X.xcframework",
      "X.xcframework",
    ]);
    expect(made.status, made.stderr).toBe(0);
    const cache = mkTmp("vendor-p5-cache-");
    const xcframework = loadSpm<Flavored>(vendoredSpm(), "flavored-frameworks.js").extractTarball(tgz, "x", "X", cache, "debug");
    expect(path.basename(xcframework)).toBe("X.xcframework");
    expect(existsSync(path.join(xcframework, "Info.plist"))).toBe(true);
    expect(listFiles(cache).filter((f) => path.basename(f).startsWith("._"))).toEqual([]);
  });

  it.skipIf(skipReason != null)(`the 58 copy keeps 58's behaviour${skipReason ? ` (${skipReason})` : ""}`, () => {
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
    const podspec = loadSpm<{ readPodspecFacts(o: object): { flaggedSubspecs?: unknown; iosDeploymentTarget?: unknown } }>(spm, "podspec.js");
    expect(podspec.readPodspecFacts({ podName: "expo-dev-launcher", podspecDir: unsafe, moduleRoot: unsafe }).flaggedSubspecs).toBeUndefined();
    expect(emit(spm, "EXDevLauncher", unsafe, u.layout!, u.sources).manifest).not.toContain("EXDevLauncher_Unsafe");
    // P7: 58 never reads a podspec's iOS platform.
    const floored = moduleFixture("EXFloor", {}, "s.platforms = { :ios => '16.4' }");
    expect(podspec.readPodspecFacts({ podName: "EXFloor", podspecDir: path.join(floored, "ios"), moduleRoot: floored }).iosDeploymentTarget).toBeUndefined();
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

describe.skipIf(!has57Autolinking)("autolinking 58.0.15 on SDK 57 (needs ../app-expo-57)", () => {
  it("autolinking 58.0.15 generates 57's own ExpoModulesProvider", () => {
    const bin57 = path.join(app57Autolinking, "bin", "expo-modules-autolinking.js");
    const bin58 = createRequire(path.join(vendoredSpm(), "cli.js")).resolve("expo-modules-autolinking/bin/expo-modules-autolinking.js");
    const run = (bin: string, args: string[]) => {
      const r = tool(process.execPath, [bin, ...args], { cwd: EXPO57_APP });
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
