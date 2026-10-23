import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";

// Exercises the PATCHED react-native SwiftPM scaffolder (patches/react-native+0.88.0.patch)
// as installed in the reference app (override with EXPO_XTOOL_REF_APP). Skipped when that app is
// not on this machine.
const APP = process.env["EXPO_XTOOL_REF_APP"] ?? "/home/willy/Desktop/willy/expo-ios-linux/app";
const SPM = path.join(APP, "node_modules/react-native/scripts/spm");
const RNGH_PODSPEC = path.join(
  APP,
  "node_modules/react-native-gesture-handler/RNGestureHandler.podspec",
);
const SVG_PODSPEC = path.join(APP, "node_modules/react-native-svg/RNSVG.podspec");
const PATCH = path.resolve(import.meta.dirname, "../patches/react-native+0.88.0.patch");
const SCREENS_PODSPEC = path.join(APP, "node_modules/react-native-screens/RNScreens.podspec");
const available = existsSync(path.join(SPM, "read-podspec.js"));

type Model = { sourceFiles: string[] };
type Spec = { publicHeadersPath: string | null; namespacedShimHeaders: string[]; warnings: string[] };
type Dep = { name: string; root: string; swiftName: string; platforms: object };
type ReadPodspec = { readPodspecCached(file: string): Model };
type Scaffold = { translatePodspecToSpmTarget(model: Model, dep: Dep): Spec };

const tmp: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "xtool-rnspm-"));
  tmp.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!available)("patched RN SwiftPM scaffolder", () => {
  const req = createRequire(import.meta.url);
  const load = <T>(f: string) => req(path.join(SPM, f)) as T;

  function podspec(body: string): string {
    const dir = tempDir();
    const file = path.join(dir, "Foo.podspec");
    writeFileSync(file, `Pod::Spec.new do |s|\n  s.name = "Foo"\n  ${body}\nend\n`);
    return file;
  }

  describe("the installed RN files carry the patch", () => {
    // Guards against testing an unpatched RN: each hunk must be present in what the tests load.
    const src = (f: string) => readFileSync(path.join(SPM, f), "utf8");
    it("read-podspec.js has the bare-list hunk", () => {
      expect(src("read-podspec.js")).toContain("Ruby bare list without brackets");
    });
    it("read-podspec.js has the Ruby constants hunk", () => {
      expect(src("read-podspec.js")).toContain("function resolveRubyConstants");
    });
    it("read-podspec.js has the subspec merge hunk", () => {
      const f = src("read-podspec.js");
      expect(f).toContain("function splitSubspecs");
      expect(f).toContain("const MAIN_RECV");
    });
    it("read-podspec.js has the platform-scoped fields hunk", () => {
      expect(src("read-podspec.js")).toContain("function getStringFieldOn");
    });
    it("the scaffolder has the preprocessor defines hunks", () => {
      expect(src("read-podspec.js")).toContain("function getDefineXcconfig");
      expect(src("scaffold-package-swift.js")).toContain("RCT_NEW_ARCH_ENABLED");
    });
    it("scaffold-package-swift.js has the umbrella-header and shim hunks", () => {
      const f = src("scaffold-package-swift.js");
      expect(f).toContain("umbrellaNextToSubdirs");
      expect(f).toContain("stub is named by basename");
    });
    it("scaffold-package-swift.js has the header_dir namespace hunk", () => {
      expect(src("scaffold-package-swift.js")).toContain("headerDirShims");
      expect(src("read-podspec.js")).toContain("function headerDirScopes");
    });
  });

  it("the committed patch reverse-applies cleanly to the installed RN files", async () => {
    const r = await execa("patch", ["-R", "-p1", "--dry-run", "-i", PATCH], { cwd: APP, reject: false });
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  describe("read-podspec getArrayField", () => {
    const read = (body: string) =>
      load<ReadPodspec>("read-podspec.js").readPodspecCached(podspec(body)).sourceFiles;

    it("reads a Ruby bare list without brackets", () => {
      expect(read('s.source_files = "a/**/*.{h,m}", "b/**/*.{h,cpp}"')).toEqual([
        "a/**/*.{h,m}",
        "b/**/*.{h,cpp}",
      ]);
    });
    it("keeps the array form", () => {
      expect(read('s.source_files = ["a/*.h", "b/*.m"]')).toEqual(["a/*.h", "b/*.m"]);
    });
    it("keeps the single string form", () => {
      expect(read('s.source_files = "a/*.h"')).toEqual(["a/*.h"]);
    });
    it.skipIf(!existsSync(RNGH_PODSPEC))("reads all globs of the real RNGH podspec", () => {
      const globs = load<ReadPodspec>("read-podspec.js").readPodspecCached(RNGH_PODSPEC).sourceFiles;
      expect(globs).toContain("shared/**/*.{h,cpp}");
      expect(globs.length).toBeGreaterThan(1);
    });
  });

  describe("read-podspec Ruby constants", () => {
    const read = (body: string) =>
      load<ReadPodspec>("read-podspec.js").readPodspecCached(podspec(body)).sourceFiles;

    it("resolves a string constant, interpolation and identifier RHS", () => {
      expect(
        read(
          "exts = '{h,m,mm,cpp}'\n  files = [\"ios/**/*.#{exts}\"]\n  s.source_files = files",
        ),
      ).toEqual(["ios/**/*.{h,m,mm,cpp}"]);
    });
    it("resolves interpolation in a literal field", () => {
      expect(read('exts = "{h,m}"\n  s.source_files = "a/*.#{exts}"')).toEqual(["a/*.{h,m}"]);
    });
    it("resolves an array constant", () => {
      expect(read('globs = ["a/*.h", "b/*.m"]\n  s.source_files = globs')).toEqual(["a/*.h", "b/*.m"]);
    });
    it("leaves an unknown interpolation as-is", () => {
      expect(read('s.source_files = "a/*.#{x}"')).toEqual(["a/*.#{x}"]);
    });
    it.skipIf(!existsSync(SCREENS_PODSPEC))("reads the real RNScreens podspec", () => {
      const m = load<ReadPodspec>("read-podspec.js").readPodspecCached(SCREENS_PODSPEC) as Model & {
        excludeFiles: string[];
      };
      expect(m.sourceFiles.some((g) => g.startsWith("ios/**"))).toBe(true);
      expect(m.excludeFiles.some((g) => g.startsWith("ios/"))).toBe(true);
    });
  });

  describe("read-podspec subspecs", () => {
    const readModel = (body: string) =>
      load<ReadPodspec>("read-podspec.js").readPodspecCached(podspec(body)) as Model & {
        excludeFiles: string[];
        headerSearchPaths: string[];
        headerDir: string | null;
      };
    const SUB =
      's.header_dir = "main"\n  s.exclude_files = "x/*.cpp"\n' +
      '  s.subspec "a" do |ss|\n    ss.source_files = ["a/*.cpp"]\n    ss.exclude_files = "a/skip/*.cpp"\n' +
      '    ss.header_dir = "sub"\n    ss.pod_target_xcconfig = { "HEADER_SEARCH_PATHS" => "\\"$(PODS_TARGET_SRCROOT)/a\\"" }\n  end\n' +
      '  s.subspec "b" do |ss|\n    ss.source_files = "b/*.cpp"\n    ss.foo do |x|\n      x.bar = 1\n    end\n  end';

    it("merges subspec fields into the main model", () => {
      const m = readModel(`s.source_files = "m/*.mm"\n  ${SUB}`);
      expect(m.sourceFiles).toEqual(["m/*.mm", "a/*.cpp", "b/*.cpp"]);
      expect(m.excludeFiles).toEqual(["x/*.cpp", "a/skip/*.cpp"]);
      expect(m.headerSearchPaths).toEqual(["$(PODS_TARGET_SRCROOT)/a"]);
      expect(m.headerDir).toBe("main");
    });
    it("does not read `ss.<field>` as the main spec's field", () => {
      const m = readModel('s.subspec "a" do |ss|\n    ss.source_files = "a/*.cpp"\n  end');
      expect(m.sourceFiles).toEqual(["a/*.cpp"]);
      expect(readModel('s.subspec "a" do |ss|\n    ss.header_dir = "sub"\n  end').headerDir).toBeNull();
    });
    it("merges only default_subspecs when declared", () => {
      const m = readModel(`s.default_subspecs = ["a"]\n  s.source_files = "m/*.mm"\n  ${SUB}`);
      expect(m.sourceFiles).toEqual(["m/*.mm", "a/*.cpp"]);
    });
    it.skipIf(!existsSync(SCREENS_PODSPEC))("reads the real RNScreens common subspec", () => {
      const m = load<ReadPodspec>("read-podspec.js").readPodspecCached(SCREENS_PODSPEC) as Model & {
        headerSearchPaths: string[];
      };
      expect(m.sourceFiles.some((g) => g.startsWith("ios/**"))).toBe(true);
      expect(m.sourceFiles.some((g) => g.startsWith("common/cpp/**"))).toBe(true);
      expect(m.headerSearchPaths).toContain("$(PODS_TARGET_SRCROOT)/common/cpp");
    });
  });

  describe("read-podspec hardening", () => {
    type M = Model & { excludeFiles: string[]; frameworks: string[] };
    function readRaw(src: string): M {
      const file = path.join(tempDir(), "Foo.podspec");
      writeFileSync(file, src);
      return load<ReadPodspec>("read-podspec.js").readPodspecCached(file) as M;
    }
    const wrap = (body: string, v = "s") => `Pod::Spec.new do |${v}|\n  ${v}.name = "Foo"\n${body}\nend\n`;

    it("derives the main receiver from Pod::Spec.new (|podspec|)", () => {
      const m = readRaw(wrap('  podspec.source_files = "ios/**/*.{h,m}"', "podspec"));
      expect(m.sourceFiles).toEqual(["ios/**/*.{h,m}"]);
    });
    it("ignores a trailing comment after `do |x|` when finding the subspec end", () => {
      const m = readRaw(
        wrap(
          '  s.subspec "a" do |ss|\n    ss.source_files = "a/*.m"\n    [1].each do |x| # loop\n      x\n    end\n    ss.header_dir = "aa"\n  end\n  s.source_files = "ios/*.m"',
        ),
      );
      expect(m.sourceFiles).toEqual(["ios/*.m", "a/*.m"]);
    });
    it("counts a one-line `if … end` as net 0", () => {
      const m = readRaw(
        wrap(
          '  s.subspec "a" do |ss|\n    ss.source_files = "a/*.m"\n    if ENV[\'X\'] == \'1\' then ss.exclude_files = "a/x.m" end\n  end\n  s.subspec "b" do |ss|\n    ss.source_files = "b/*.m"\n  end\n  s.frameworks = "UIKit"',
        ),
      );
      expect(m.sourceFiles).toEqual(["a/*.m", "b/*.m"]);
      expect(m.excludeFiles).toEqual(["a/x.m"]);
      expect(m.frameworks).toEqual(["UIKit"]);
    });
    it("reads a one-line `do |ss| … end` subspec", () => {
      const m = readRaw(
        wrap('  s.subspec "a" do |ss| ss.source_files = "a/*.m" end\n  s.source_files = "ios/*.m"\n  s.frameworks = "UIKit"'),
      );
      expect(m.sourceFiles).toEqual(["ios/*.m", "a/*.m"]);
      expect(m.frameworks).toEqual(["UIKit"]);
    });
    it("merges no subspec for default_subspecs = :none", () => {
      const m = readRaw(
        wrap('  s.default_subspecs = :none\n  s.source_files = "ios/*.m"\n  s.subspec "a" do |ss|\n    ss.source_files = "a/*.m"\n  end'),
      );
      expect(m.sourceFiles).toEqual(["ios/*.m"]);
    });
    it("resolves `ss.x = ident` and `s.ios.x = ident`", () => {
      const m = readRaw(
        'common = ["common/**/*.{h,cpp}"]\nskip = "ios/skip/*.m"\n' +
          wrap('  s.source_files = "ios/*.m"\n  s.ios.exclude_files = skip\n  s.subspec "c" do |ss|\n    ss.source_files = common\n  end'),
      );
      expect(m.sourceFiles).toEqual(["ios/*.m", "common/**/*.{h,cpp}"]);
      expect(m.excludeFiles).toEqual(["ios/skip/*.m"]);
    });
    it("does not interpolate #{} inside single-quoted strings", () => {
      const m = readRaw('exts = "{h,m}"\n' + wrap("  s.source_files = 'ios/*.#{exts}'"));
      expect(m.sourceFiles).toEqual(["ios/*.#{exts}"]);
    });
    it("still interpolates inside double-quoted strings next to single-quoted ones", () => {
      const m = readRaw('exts = "{h,m}"\n' + wrap("  s.source_files = 'a/*.m', \"ios/*.#{exts}\""));
      expect(m.sourceFiles).toEqual(["a/*.m", "ios/*.{h,m}"]);
    });
  });

  describe("read-podspec platform-scoped fields", () => {
    const readModel = (body: string) =>
      load<ReadPodspec>("read-podspec.js").readPodspecCached(podspec(body)) as Model & {
        excludeFiles: string[];
        frameworks: string[];
        headerDir: string | null;
      };

    it("merges s.ios.<field> and ignores the other platforms", () => {
      const m = readModel(
        's.source_files = "a/*.mm"\n  s.exclude_files = "a/x.mm"\n' +
          '  s.ios.exclude_files = "**/*.macos.mm"\n  s.osx.source_files = "mac/*.mm"\n' +
          '  s.macos.exclude_files = "m"\n  s.tvos.source_files = "t"\n  s.visionos.source_files = "v"\n' +
          '  s.watchos.frameworks = "W"\n  s.osx.frameworks = "AppKit"',
      );
      expect(m.sourceFiles).toEqual(["a/*.mm"]);
      expect(m.excludeFiles).toEqual(["a/x.mm", "**/*.macos.mm"]);
      expect(m.frameworks).not.toContain("AppKit");
      expect(m.frameworks).not.toContain("W");
    });
    it("reads s.ios.source_files and s.ios.frameworks, and lets ios win string fields", () => {
      const m = readModel(
        's.header_dir = "generic"\n  s.ios.header_dir = "iosdir"\n  s.ios.source_files = ["i/*.m"]\n' +
          '  s.frameworks = "UIKit"\n  s.ios.frameworks = ["WebKit"]\n  s.osx.header_dir = "mac"',
      );
      expect(m.sourceFiles).toEqual(["i/*.m"]);
      expect(m.frameworks).toEqual(expect.arrayContaining(["UIKit", "WebKit"]));
      expect(m.headerDir).toBe("iosdir");
    });
    it("reads ss.ios.<field> inside a subspec and ignores ss.osx.<field>", () => {
      const m = readModel(
        's.subspec "a" do |ss|\n    ss.source_files = "a/*.m"\n    ss.ios.exclude_files = "a/*.macos.m"\n' +
          '    ss.osx.source_files = "a/mac/*.m"\n  end',
      );
      expect(m.sourceFiles).toEqual(["a/*.m"]);
      expect(m.excludeFiles).toEqual(["a/*.macos.m"]);
    });
    it("reads the svg-style s.ios.exclude_files pattern (inline fixture)", () => {
      const m = readModel(
        "s.source_files = 'apple/**/*.{h,m,mm}'\n  s.ios.exclude_files = '**/*.macos.{h,m,mm}'\n" +
          "  s.tvos.exclude_files = '**/*.macos.{h,m,mm}'\n  s.visionos.exclude_files = '**/*.macos.{h,m,mm}' if s.respond_to?(:visionos)\n" +
          "  s.osx.exclude_files = '**/*.ios.{h,m,mm}'",
      );
      expect(m.sourceFiles).toEqual(["apple/**/*.{h,m,mm}"]);
      expect(m.excludeFiles).toContain("**/*.macos.{h,m,mm}");
      expect(m.excludeFiles).not.toContain("**/*.ios.{h,m,mm}");
    });
    it.skipIf(!existsSync(SVG_PODSPEC))("reads the real react-native-svg podspec", () => {
      const m = load<ReadPodspec>("read-podspec.js").readPodspecCached(SVG_PODSPEC) as Model & {
        excludeFiles: string[];
      };
      expect(m.excludeFiles).toContain("**/*.macos.{h,m,mm}");
    });
  });

  describe("preprocessor defines", () => {
    type Def = { name: string; value: string | null; config: string | null };
    const model = (body: string) =>
      load<ReadPodspec>("read-podspec.js").readPodspecCached(podspec(body)) as Model & {
        preprocessorDefines: Def[];
        compilerFlags: string[];
      };
    const names = (defs: Def[]) => defs.map((d) => (d.value != null ? `${d.name}=${d.value}` : d.name));
    function scaffold(podBody: string, pkgJson: object = {}): Def[] {
      const root = tempDir();
      mkdirSync(path.join(root, "apple"));
      writeFileSync(path.join(root, "apple/Foo.m"), "");
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "foo", ...pkgJson }));
      const file = path.join(root, "Foo.podspec");
      writeFileSync(
        file,
        `Pod::Spec.new do |s|\n  s.name = "Foo"\n  s.source_files = "apple/*.m"\n  ${podBody}\nend\n`,
      );
      const m = load<ReadPodspec>("read-podspec.js").readPodspecCached(file);
      const dep: Dep = { name: "foo", root, swiftName: "Foo", platforms: { ios: {} } };
      const spec = load<Scaffold>("scaffold-package-swift.js").translatePodspecToSpmTarget(m, dep);
      return (spec as unknown as { preprocessorDefines: Def[] }).preprocessorDefines;
    }

    it("lifts -D from literal compiler_flags and GCC_PREPROCESSOR_DEFINITIONS from the xcconfig", () => {
      const m = model(
        's.compiler_flags = "-DFOO=1 -Wall"\n' +
          '  s.pod_target_xcconfig = { "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) BAR=1", "OTHER_CFLAGS" => "-DBAZ -Wno-x" }',
      );
      expect(names(m.preprocessorDefines)).toEqual(expect.arrayContaining(["FOO=1", "BAR=1", "BAZ"]));
      expect(m.compilerFlags).toEqual(["-Wall"]);
    });
    it("drops interpolated defines", () => {
      const m = model('s.pod_target_xcconfig = { "OTHER_CFLAGS" => "-DV=#{x} -DOK=1" }');
      expect(names(m.preprocessorDefines)).toEqual(["OK=1"]);
    });
    it("adds RCT_NEW_ARCH_ENABLED=1 once to a React Native library", () => {
      const defs = scaffold(
        's.compiler_flags = "-DFOO=1"\n  install_modules_dependencies(s)',
      );
      expect(names(defs).filter((n) => n === "RCT_NEW_ARCH_ENABLED=1")).toHaveLength(1);
      expect(names(defs)).toContain("FOO=1");
    });
    it("recognises a React Native library by codegenConfig or a React-Core dependency", () => {
      expect(names(scaffold("", { codegenConfig: { name: "X" } }))).toContain("RCT_NEW_ARCH_ENABLED=1");
      expect(names(scaffold('s.dependency "React-Core"'))).toContain("RCT_NEW_ARCH_ENABLED=1");
    });
    it("does not duplicate a define the podspec already sets", () => {
      const defs = scaffold('s.compiler_flags = "-DRCT_NEW_ARCH_ENABLED=1"\n  s.dependency "React-Core"');
      expect(names(defs).filter((n) => n.startsWith("RCT_NEW_ARCH_ENABLED"))).toEqual(["RCT_NEW_ARCH_ENABLED=1"]);
    });
    it("a Debug-only RCT_NEW_ARCH_ENABLED does not suppress the global one", () => {
      const defs = scaffold(
        's.dependency "React-Core"\n  s.pod_target_xcconfig = { "GCC_PREPROCESSOR_DEFINITIONS[config=*Debug*]" => "RCT_NEW_ARCH_ENABLED=1" }',
      );
      const arch = defs.filter((d) => d.name === "RCT_NEW_ARCH_ENABLED");
      expect(arch.map((d) => d.config).sort()).toEqual(["debug", null].sort());
    });
    it("never lifts FOLLY_* defines from compiler flags, and warns once", () => {
      const m = model(
        's.compiler_flags = "-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DKEEP=1 -Wno-comma"',
      ) as Model & { warnings: string[] };
      expect(names(m.preprocessorDefines)).toEqual(["KEEP=1"]);
      expect(m.compilerFlags).toEqual(["-Wno-comma"]);
      const w = m.warnings.filter((x) => x.startsWith("Dropped Folly define(s)"));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("FOLLY_NO_CONFIG");
      expect(w[0]).toContain("FOLLY_MOBILE=1");
    });
    it("drops FOLLY_* from an xcconfig and from a constant-held flag string", () => {
      const m = model(
        "folly_flags = '-DFOLLY_NO_CONFIG -DFOLLY_USE_LIBCPP=1'\n  s.compiler_flags = folly_flags\n" +
          '  s.pod_target_xcconfig = { "GCC_PREPROCESSOR_DEFINITIONS" => "FOLLY_CFG_NO_COROUTINES=1 OK=1" }',
      );
      expect(names(m.preprocessorDefines)).toEqual(["OK=1"]);
      expect(m.compilerFlags).toEqual([]);
    });
    it("does not add it to a library that is not React Native", () => {
      expect(names(scaffold('s.compiler_flags = "-DFOO=1"'))).toEqual(["FOO=1"]);
    });
  });

  describe("Metal shaders", () => {
    type MetalSpec = Spec & { sources: string[]; excludePaths: string[] };
    function lib(sourceGlob: string): { model: Model; dep: Dep } {
      const root = tempDir();
      for (const f of ["apple/Foo.m", "apple/Foo.h", "apple/Filters/A.metal", "apple/Filters/B.metal"]) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), "");
      }
      writeFileSync(
        path.join(root, "Foo.podspec"),
        `Pod::Spec.new do |s|\n  s.name = "Foo"\n  s.source_files = "${sourceGlob}"\nend\n`,
      );
      const model = load<ReadPodspec>("read-podspec.js").readPodspecCached(path.join(root, "Foo.podspec"));
      return { model, dep: { name: "foo", root, swiftName: "Foo", platforms: { ios: {} } } };
    }
    function withPlatform<T>(platform: string, fn: () => T): T {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform });
      try {
        return fn();
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    }
    const translate = (glob: string, platform: string) => {
      const { model, dep } = lib(glob);
      return withPlatform(platform, () =>
        load<Scaffold>("scaffold-package-swift.js").translatePodspecToSpmTarget(model, dep),
      ) as MetalSpec;
    };

    it("excludes .metal files and warns when the host is not macOS", () => {
      const spec = translate("apple/**/*.{h,m}", "linux");
      expect(spec.excludePaths).toEqual(["apple/Filters/A.metal", "apple/Filters/B.metal"]);
      expect(spec.warnings).toContain(
        "Skipped 2 Metal shader(s) (A.metal, B.metal) — the Metal compiler is only available on macOS; features relying on them are unavailable in this build.",
      );
    });
    it("also removes .metal files that a source glob selects", () => {
      const spec = translate("apple/**/*.{h,m,metal}", "linux");
      expect(spec.sources.some((f) => f.endsWith(".metal"))).toBe(false);
      expect(spec.excludePaths).toHaveLength(2);
    });
    it("keeps the current behaviour on macOS", () => {
      const spec = translate("apple/**/*.{h,m,metal}", "darwin");
      expect(spec.excludePaths).toEqual([]);
      expect(spec.sources.filter((f) => f.endsWith(".metal"))).toHaveLength(2);
      expect(spec.warnings.some((w) => w.includes("Metal"))).toBe(false);
    });
    it("skips on macOS too with RN_SPM_SKIP_METAL=1", () => {
      process.env["RN_SPM_SKIP_METAL"] = "1";
      try {
        expect(translate("apple/**/*.{h,m}", "darwin").excludePaths).toHaveLength(2);
      } finally {
        delete process.env["RN_SPM_SKIP_METAL"];
      }
    });
    it("emits an exclude: list in Package.swift", () => {
      const { dep } = lib("apple/**/*.{h,m}");
      const full = {
        ...dep,
        swiftNameSource: "podspec",
        platforms: { ios: { podspecPath: path.join(dep.root, "Foo.podspec") } },
      };
      const ctx = { appRoot: dep.root, projectRoot: dep.root, reactNativeRoot: dep.root, force: true, dryRun: false, cacheSlotLabel: null, remote: null };
      withPlatform("linux", () =>
        load<{ scaffoldPackageSwiftForDep(d: object, c: object): unknown }>("scaffold-package-swift.js").scaffoldPackageSwiftForDep(full, ctx),
      );
      const pkg = readFileSync(path.join(dep.root, "Package.swift"), "utf8");
      expect(pkg).toContain('exclude: ["apple/Filters/A.metal", "apple/Filters/B.metal"]');
    });
  });

  describe("umbrella header layout", () => {
    function analyse(files: string[], dirs: string[]): Spec {
      const root = tempDir();
      for (const f of files) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), "");
      }
      for (const d of dirs) mkdirSync(path.join(root, d), { recursive: true });
      const file = path.join(root, "Foo.podspec");
      writeFileSync(
        file,
        'Pod::Spec.new do |s|\n  s.name = "Foo"\n  s.source_files = "apple/**/*.{h,m}"\nend\n',
      );
      const model = load<ReadPodspec>("read-podspec.js").readPodspecCached(file);
      const dep: Dep = { name: "foo", root, swiftName: "Foo", platforms: { ios: {} } };
      return load<Scaffold>("scaffold-package-swift.js").translatePodspecToSpmTarget(model, dep);
    }

    it("switches to the include shim when the umbrella header sits next to subdirectories", () => {
      const spec = analyse(
        ["apple/Foo.h", "apple/Foo.m", "apple/Handlers/Bar.h"],
        ["apple/Foo.xcodeproj"],
      );
      expect(spec.publicHeadersPath).toBe("include");
      expect([...spec.namespacedShimHeaders].sort()).toEqual(["apple/Foo.h", "apple/Handlers/Bar.h"]);
    });

    it("keeps the prefix directory when there is no umbrella header", () => {
      const spec = analyse(["apple/Baz.h", "apple/Baz.m", "apple/Handlers/Bar.h"], []);
      expect(spec.publicHeadersPath).toBe("apple");
      expect(spec.namespacedShimHeaders).toEqual([]);
    });

    it("keeps one header and warns on a basename collision", () => {
      const spec = analyse(["apple/Foo.h", "apple/a/Dup.h", "apple/b/Dup.h"], []);
      expect(spec.namespacedShimHeaders.filter((h) => h.endsWith("Dup.h"))).toEqual(["apple/a/Dup.h"]);
      expect(spec.warnings.some((w) => w.includes("Dup.h"))).toBe(true);
    });

    it("prefers the shallowest path on a basename collision", () => {
      const spec = analyse(["apple/Foo.h", "apple/a/b/Dup.h", "apple/z/Dup.h"], []);
      expect(spec.namespacedShimHeaders.filter((h) => h.endsWith("Dup.h"))).toEqual(["apple/z/Dup.h"]);
    });
  });

  describe("header_dir namespaces", () => {
    type HdSpec = Spec & { headerSearchPaths: string[]; headerDirShims: { dir: string; headers: string[] }[] };
    const FILES = [
      "a/A.h",
      "a/A.m",
      "common/cpp/x/C1.h",
      "common/cpp/x/C1.cpp",
      "common/cpp/x/utils/U.h",
      "common/cpp/Dup.h",
      "common/cpp/z/Dup.h",
    ];
    function scaffold(podBody: string): { root: string; spec: HdSpec } {
      const root = tempDir();
      for (const f of FILES) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), "");
      }
      writeFileSync(path.join(root, "Foo.podspec"), `Pod::Spec.new do |s|\n  s.name = "Foo"\n${podBody}\nend\n`);
      const model = load<ReadPodspec>("read-podspec.js").readPodspecCached(path.join(root, "Foo.podspec"));
      const dep: Dep = { name: "foo", root, swiftName: "Foo", platforms: { ios: {} } };
      const spec = load<Scaffold>("scaffold-package-swift.js").translatePodspecToSpmTarget(model, dep) as HdSpec;
      return { root, spec };
    }
    const SUB =
      '  s.source_files = "a/**/*.{h,m}"\n  s.subspec "c" do |ss|\n    ss.source_files = "common/**/*.{h,cpp}"\n    ss.header_dir = "ns"\n  end';

    it("stubs only the subspec's headers under its header_dir", () => {
      const { spec } = scaffold(SUB);
      expect(spec.headerDirShims).toHaveLength(1);
      const shim = spec.headerDirShims[0]!;
      expect(shim.dir).toBe("ns");
      expect([...shim.headers].sort()).toEqual([
        "common/cpp/Dup.h",
        "common/cpp/x/C1.h",
        "common/cpp/x/utils/U.h",
      ]);
      expect(spec.headerSearchPaths).toContain("include");
      expect(spec.warnings.some((w) => w.includes("include/ns/") && w.includes("Dup.h"))).toBe(true);
    });

    const sub = (dir: string, main = "") =>
      `  s.source_files = "a/**/*.{h,m}"\n${main}  s.subspec "c" do |ss|\n    ss.source_files = "common/**/*.{h,cpp}"\n    ss.header_dir = "${dir}"\n  end`;

    it("rejects a header_dir containing '..' or an absolute path", () => {
      for (const bad of ["../escape", "a/../b", "/abs"]) {
        const { spec } = scaffold(sub(bad));
        expect(spec.headerDirShims, bad).toEqual([]);
        expect(spec.warnings.some((w) => w.includes("Ignoring header_dir") && w.includes(bad)), bad).toBe(true);
      }
    });
    it("warns when two scopes share a stub directory", () => {
      const { spec } = scaffold(sub("ns", '  s.header_dir = "ns"\n'));
      expect(spec.headerDirShims.map((s) => s.dir)).toEqual(["ns", "ns"]);
      expect(spec.warnings.some((w) => w.includes("share include/ns/"))).toBe(true);
    });
    it("warns when header_dir equals the target name", () => {
      const { spec } = scaffold(sub("Foo"));
      expect(spec.warnings.some((w) => w.includes("equals the target name"))).toBe(true);
    });
    it("treats a subspec header_dir = \"\" as the root namespace (no stubs, no inheritance)", () => {
      const { spec } = scaffold(sub("", '  s.header_dir = "ns"\n'));
      expect(spec.headerDirShims).toHaveLength(1);
      expect(spec.headerDirShims[0]!.dir).toBe("ns");
      expect(spec.headerDirShims[0]!.headers).toEqual(["a/A.h"]);
    });

    it("covers every header for a main-spec header_dir", () => {
      const { spec } = scaffold('  s.source_files = "a/**/*.{h,m}", "common/**/*.{h,cpp}"\n  s.header_dir = "ns"');
      expect(spec.headerDirShims[0]!.headers).toContain("a/A.h");
      expect(spec.headerDirShims[0]!.headers).toContain("common/cpp/x/C1.h");
      expect(spec.headerSearchPaths).toContain("include");
    });

    it("emits nothing without header_dir", () => {
      const { spec } = scaffold('  s.source_files = "a/**/*.{h,m}"');
      expect(spec.headerDirShims).toEqual([]);
      expect(spec.headerSearchPaths).not.toContain("include");
    });

    it("writes the include/<header_dir>/ stubs and the search path", () => {
      const { root } = scaffold(SUB);
      const dep = {
        name: "foo",
        root,
        swiftName: "Foo",
        swiftNameSource: "podspec",
        platforms: { ios: { podspecPath: path.join(root, "Foo.podspec") } },
      };
      const ctx = {
        appRoot: root,
        projectRoot: root,
        reactNativeRoot: root,
        force: true,
        dryRun: false,
        cacheSlotLabel: null,
        remote: null,
      };
      const res = load<{ scaffoldPackageSwiftForDep(d: object, c: object): { status: string } }>(
        "scaffold-package-swift.js",
      ).scaffoldPackageSwiftForDep(dep, ctx);
      expect(res.status).toBe("written");
      const stub = (f: string) => readFileSync(path.join(root, "include/ns", f), "utf8");
      expect(stub("C1.h")).toContain('#import "../../common/cpp/x/C1.h"');
      expect(stub("U.h")).toContain('#import "../../common/cpp/x/utils/U.h"');
      expect(stub("Dup.h")).toContain('#import "../../common/cpp/Dup.h"');
      expect(existsSync(path.join(root, "include/ns/A.h"))).toBe(false);
      expect(readFileSync(path.join(root, "Package.swift"), "utf8")).toContain('.headerSearchPath("include")');
    });
  });
});
