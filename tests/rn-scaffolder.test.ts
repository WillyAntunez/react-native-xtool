import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
const hasPatchBinary = spawnSync("patch", ["--version"]).error === undefined;

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
    it("read-podspec.js has the React Native version macros hunk", () => {
      expect(src("read-podspec.js")).toContain("function readRnVersionMacros");
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
    it("scaffold-package-swift.js has the mixed-language target hunk", () => {
      const f = src("scaffold-package-swift.js");
      expect(f).toContain("MIXED_TOOLS_VERSION_LINE");
      expect(f).toContain("function writeMixedLanguageSupport");
      expect(f).not.toContain("status: 'skipped-mixed-language'");
    });
    it("scaffold-package-swift.js has the bare React header hunk", () => {
      expect(src("scaffold-package-swift.js")).toContain("function bareReactHeaders");
    });
    it("scaffold-package-swift.js has the pod→SwiftPM map hunk", () => {
      expect(src("scaffold-package-swift.js")).toContain("const KNOWN_POD_SPM_PACKAGES");
    });
    it("spm-utils.js has the header-less ReactAppHeaders module map hunk", () => {
      expect(src("spm-utils.js")).toContain("module ReactAppHeaders {");
    });
  });

  it("gives the per-app header farm a header-less module map, so Objective-C imports it textually", () => {
    const appRoot = tempDir();
    const gen = path.join(appRoot, "build", "generated", "ios", "ReactAppDependencyProvider");
    mkdirSync(gen, { recursive: true });
    writeFileSync(path.join(gen, "RCTAppDependencyProvider.h"), "#import <Foundation/Foundation.h>\n");
    const { buildPerAppHeaderTree } = load<{ buildPerAppHeaderTree(root: string): { path: string } }>("spm-utils.js");
    const farm = buildPerAppHeaderTree(appRoot).path;
    expect(existsSync(path.join(farm, "ReactAppDependencyProvider", "RCTAppDependencyProvider.h"))).toBe(true);
    const map = readFileSync(path.join(farm, "module.modulemap"), "utf8");
    expect(map).toContain("module ReactAppHeaders {\n  export *\n}\n");
    expect(map).not.toMatch(/umbrella|header "/);
  });

  it.skipIf(!hasPatchBinary)("the committed patch reverse-applies cleanly to the installed RN files", async () => {
    const r = await execa("patch", ["-R", "-p1", "-F0", "--dry-run", "-i", PATCH], { cwd: APP, reject: false });
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
    describe("React Native version macros", () => {
      const rnVersion = (
        JSON.parse(readFileSync(path.join(APP, "node_modules/react-native/package.json"), "utf8")) as { version: string }
      ).version.split(".");
      const [major, minor, patch] = rnVersion;
      it("resolves REACT_NATIVE_*_VERSION=#{...} from the installed RN and warns", () => {
        const m = model(
          "s.pod_target_xcconfig = { \"OTHER_CFLAGS\" => \"$(inherited) -DREACT_NATIVE_MINOR_VERSION=#{cfg[:minor]} -DFOO=#{bar}\" }\n" +
            "  s.xcconfig = { \"GCC_PREPROCESSOR_DEFINITIONS\" => \"REACT_NATIVE_MAJOR_VERSION=#{a} REACT_NATIVE_PATCH_VERSION=#{b}\" }",
        ) as Model & { warnings: string[] };
        expect(names(m.preprocessorDefines)).toEqual(
          expect.arrayContaining([
            `REACT_NATIVE_MINOR_VERSION=${minor}`,
            `REACT_NATIVE_MAJOR_VERSION=${major}`,
            `REACT_NATIVE_PATCH_VERSION=${patch}`,
          ]),
        );
        const w = m.warnings.filter((x) => x.startsWith("Resolved interpolated define(s)"));
        expect(w).toHaveLength(1);
        expect(w[0]).toContain(`REACT_NATIVE_MINOR_VERSION=${minor}`);
      });
      it("still drops any other interpolated define", () => {
        const m = model('s.pod_target_xcconfig = { "OTHER_CFLAGS" => "-DFOO=#{bar} -DREACT_NATIVE_VERSION_X=#{y}" }');
        expect(names(m.preprocessorDefines)).toEqual([]);
      });
      it.skipIf(!existsSync(SVG_PODSPEC))("the real react-native-svg podspec gets REACT_NATIVE_MINOR_VERSION", () => {
        const m = load<ReadPodspec>("read-podspec.js").readPodspecCached(SVG_PODSPEC) as unknown as Model;
        expect(names(m.preprocessorDefines)).toContain(`REACT_NATIVE_MINOR_VERSION=${minor}`);
      });
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
    function lib(sourceGlob: string, extra = ""): { model: Model; dep: Dep } {
      const root = tempDir();
      for (const f of ["apple/Foo.m", "apple/Foo.h", "apple/Filters/A.metal", "apple/Filters/B.metal"]) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), "");
      }
      writeFileSync(
        path.join(root, "Foo.podspec"),
        `Pod::Spec.new do |s|\n  s.name = "Foo"\n  s.source_files = "${sourceGlob}"\n  ${extra}\nend\n`,
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
    it("emits target arguments in SwiftPM's required order (resources before publicHeadersPath)", async () => {
      const { dep } = lib("apple/**/*.{h,m}", 's.resources = "assets/*.png"');
      mkdirSync(path.join(dep.root, "assets"), { recursive: true });
      writeFileSync(path.join(dep.root, "assets/a.png"), "");
      const full = {
        ...dep,
        swiftNameSource: "podspec",
        platforms: { ios: { podspecPath: path.join(dep.root, "Foo.podspec") } },
      };
      const ctx = { appRoot: dep.root, projectRoot: dep.root, reactNativeRoot: dep.root, force: true, dryRun: false, cacheSlotLabel: null, remote: null };
      load<{ scaffoldPackageSwiftForDep(d: object, c: object): unknown }>("scaffold-package-swift.js").scaffoldPackageSwiftForDep(full, ctx);
      const pkg = readFileSync(path.join(dep.root, "Package.swift"), "utf8");
      const at = (k: string) => pkg.indexOf(`${k}:`, pkg.indexOf("path:"));
      expect(at("resources")).toBeGreaterThan(-1);
      expect(at("publicHeadersPath")).toBeGreaterThan(-1);
      expect(at("sources")).toBeLessThan(at("resources"));
      expect(at("resources")).toBeLessThan(at("publicHeadersPath"));
      const swift = await execa("swift", ["package", "dump-package"], {
        cwd: dep.root,
        reject: false,
        env: { PATH: `${process.env["HOME"]}/.local/share/swiftly/bin:${process.env["PATH"]}` },
      });
      expect(swift.stderr).not.toContain("must precede argument");
    });
    it("emits target arguments in SwiftPM's required order (resources before publicHeadersPath)", async () => {
      const { dep } = lib("apple/**/*.{h,m}", 's.resources = "assets/*.png"');
      mkdirSync(path.join(dep.root, "assets"), { recursive: true });
      writeFileSync(path.join(dep.root, "assets/a.png"), "");
      const full = {
        ...dep,
        swiftNameSource: "podspec",
        platforms: { ios: { podspecPath: path.join(dep.root, "Foo.podspec") } },
      };
      const ctx = { appRoot: dep.root, projectRoot: dep.root, reactNativeRoot: dep.root, force: true, dryRun: false, cacheSlotLabel: null, remote: null };
      load<{ scaffoldPackageSwiftForDep(d: object, c: object): unknown }>("scaffold-package-swift.js").scaffoldPackageSwiftForDep(full, ctx);
      const pkg = readFileSync(path.join(dep.root, "Package.swift"), "utf8");
      const at = (k: string) => pkg.indexOf(`${k}:`, pkg.indexOf("path:"));
      expect(at("resources")).toBeGreaterThan(-1);
      expect(at("publicHeadersPath")).toBeGreaterThan(-1);
      expect(at("sources")).toBeLessThan(at("resources"));
      expect(at("resources")).toBeLessThan(at("publicHeadersPath"));
      const swift = await execa("swift", ["package", "dump-package"], {
        cwd: dep.root,
        reject: false,
        env: { PATH: `${process.env["HOME"]}/.local/share/swiftly/bin:${process.env["PATH"]}` },
      });
      if (!swift.failed || !/ENOENT/.test(String(swift.code ?? swift.message))) {
        expect(swift.stderr).not.toContain("must precede argument");
      }
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

  describe("mixed Swift + Objective-C targets", () => {
    const GREETER_H = "#import <Foundation/Foundation.h>\n@interface FooGreeter : NSObject\n- (NSString *)greet:(NSString *)name;\n@end\n";
    const GREETER_M = '#import "FooGreeter.h"\n@implementation FooGreeter\n- (NSString *)greet:(NSString *)name { return name; }\n@end\n';
    // A header the Swift sources never use: it must stay out of the Swift umbrella.
    const VIEW_H = "#import <UIKit/UIKit.h>\n@interface FooView : UIView\n@end\n";
    const VIEW_M = '#import "FooView.h"\n@implementation FooView\n@end\n';
    const SWIFT_A = "import Foundation\npublic final class FooUser {\n  public func hi() -> String { FooGreeter().greet(\"swift\") }\n}\n";
    const SWIFT_B = "import Foundation\n@objc public final class FooSwift: NSObject {\n  @objc public func hello() -> String { \"hello\" }\n}\n";
    const SWIFT_AB = "import Foundation\n@objc public final class FooSwift: NSObject {\n  @objc public func hello() -> String { FooGreeter().greet(\"swift\") }\n}\n";
    const BRIDGE_MM = '#import <Foundation/Foundation.h>\n#import "Foo-Swift.h"\nNSString *FooBridgeHello(void) { return [[FooSwift new] hello]; }\n';
    const FIXTURES: Record<string, Record<string, string>> = {
      // Swift uses an Objective-C class.
      A: { "ios/FooGreeter.h": GREETER_H, "ios/FooGreeter.m": GREETER_M, "ios/FooView.h": VIEW_H, "ios/FooView.m": VIEW_M, "ios/Foo.swift": SWIFT_A },
      // Objective-C++ imports the generated Foo-Swift.h.
      B: { "ios/Foo.swift": SWIFT_B, "ios/FooBridge.h": "NSString *FooBridgeHello(void);\n", "ios/FooBridge.mm": BRIDGE_MM },
      // Both directions in one module.
      circular: { "ios/FooGreeter.h": GREETER_H, "ios/FooGreeter.m": GREETER_M, "ios/Foo.swift": SWIFT_AB, "ios/FooBridge.h": "NSString *FooBridgeHello(void);\n", "ios/FooBridge.mm": BRIDGE_MM },
    };
    function mixedLib(files: Record<string, string>, podBody = '  s.source_files = "ios/**/*.{h,m,mm,swift}"'): string {
      const root = tempDir();
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), text);
      }
      writeFileSync(path.join(root, "Foo.podspec"), `Pod::Spec.new do |s|\n  s.name = "Foo"\n${podBody}\nend\n`);
      return root;
    }
    function scaffoldMixed(root: string): { status: string; pkg: string; warnings: string[] } {
      const dep = { name: "foo", root, swiftName: "Foo", swiftNameSource: "podspec", platforms: { ios: { podspecPath: path.join(root, "Foo.podspec") } } };
      const ctx = { appRoot: root, projectRoot: root, reactNativeRoot: root, force: true, dryRun: false, cacheSlotLabel: null, remote: null };
      const res = load<{ scaffoldPackageSwiftForDep(d: object, c: object): { status: string; warnings?: string[] } }>(
        "scaffold-package-swift.js",
      ).scaffoldPackageSwiftForDep(dep, ctx);
      const pkgFile = path.join(root, "Package.swift");
      return { status: res.status, pkg: existsSync(pkgFile) ? readFileSync(pkgFile, "utf8") : "", warnings: res.warnings ?? [] };
    }
    const settings = (pkg: string, key: string) => pkg.split("\n").find((l) => l.trim().startsWith(`${key}:`)) ?? "";

    for (const [shape, files] of Object.entries(FIXTURES)) {
      it(`emits one mixed-language target for direction ${shape}`, () => {
        const root = mixedLib(files);
        const { status, pkg } = scaffoldMixed(root);
        expect(status).toBe("written");
        expect(pkg.split("\n")[0]).toBe("// swift-tools-version: 6.4;(experimentalMultiLang)");
        expect(pkg).toContain('"ios/Foo.swift"');
        expect(pkg).toMatch(/"ios\/Foo(Greeter\.m|Bridge\.mm)"/);
        expect(pkg.match(/\.target\(/g)).toHaveLength(1);
        expect(pkg).toContain('let rnSpmSwiftHeadersDir = Context.environment["RN_SPM_SWIFT_HEADERS_DIR"]');
        expect(pkg).toContain('let rnSpmBridgingHeader = Context.packageDirectory + "/rn-spm-swift/umbrella.h"');
        expect(settings(pkg, "swiftSettings")).toContain('.unsafeFlags(["-import-objc-header", rnSpmBridgingHeader])');
        for (const key of ["cSettings", "cxxSettings"]) {
          expect(settings(pkg, key)).toContain('.unsafeFlags(["-I", rnSpmSwiftHeadersDir])');
          expect(settings(pkg, key)).toContain('.headerSearchPath("rn-spm-swift")');
        }
        // SwiftPM 6.4 drops cxxLanguageStandard for mixed targets: React's C++20 headers need it.
        expect(settings(pkg, "cxxSettings")).toContain('.unsafeFlags(["-std=c++20"])');
        expect(settings(pkg, "cSettings")).not.toContain("-std=");
        // The committed manifest must not bake in a machine path.
        expect(pkg).not.toContain(root);
        expect(readFileSync(path.join(root, "rn-spm-swift/Foo/Foo-Swift.h"), "utf8")).toContain("#import <Foo-Swift.h>");
        expect(existsSync(path.join(root, "rn-spm-swift/Foo-Swift.h"))).toBe(false);
      });
    }

    it("puts the module headers in the umbrella, minus the C++ ones", () => {
      const root = mixedLib({
        ...FIXTURES["A"]!,
        // Fabric-style: an unresolved <react/...> include is C++.
        "ios/FooCxx.h": "#import <UIKit/UIKit.h>\n#import <react/renderer/core/Props.h>\n@interface FooCxx : UIView\n@end\n",
        // C++ in the header itself, and a header that only reaches C++ through it.
        "ios/FooNs.h": "namespace foo {\nint bar();\n}\n",
        "ios/FooIndirect.h": '#import "FooNs.h"\n',
        // C++ behind #ifdef __cplusplus is invisible to Swift: the header stays.
        "ios/FooGuarded.h": "#import <UIKit/UIKit.h>\n#ifdef __cplusplus\n#import <react/renderer/core/Props.h>\n@interface FooGuarded : UIView\n@end\n#endif\n",
      });
      const { warnings } = scaffoldMixed(root);
      const umbrella = readFileSync(path.join(root, "rn-spm-swift/umbrella.h"), "utf8");
      expect(umbrella).toContain("#import <Foundation/Foundation.h>");
      expect(umbrella).toContain("#import <UIKit/UIKit.h>");
      for (const h of ["FooGreeter.h", "FooView.h", "FooGuarded.h"]) expect(umbrella).toContain(`#import "../ios/${h}"`);
      for (const h of ["FooCxx.h", "FooNs.h", "FooIndirect.h"]) expect(umbrella).not.toContain(h);
      expect(warnings.some((w) => w.includes("C++ header(s) out of the Swift umbrella") && w.includes("ios/FooIndirect.h"))).toBe(true);
    });

    it("follows includes into the React header trees to find C++", () => {
      const reactRoot = tempDir();
      mkdirSync(path.join(reactRoot, "React"), { recursive: true });
      writeFileSync(path.join(reactRoot, "React/RCTCxxBase.h"), "#import <UIKit/UIKit.h>\nnamespace facebook {}\n@interface RCTCxxBase : UIView\n@end\n");
      writeFileSync(path.join(reactRoot, "React/RCTObjcBase.h"), "#import <UIKit/UIKit.h>\n@interface RCTObjcBase : UIView\n@end\n");
      const root = mixedLib({
        ...FIXTURES["B"]!,
        "ios/FooFabric.h": "#import <React/RCTCxxBase.h>\n@interface FooFabric : RCTCxxBase\n@end\n",
        "ios/FooPaper.h": "#import <React/RCTObjcBase.h>\n@interface FooPaper : RCTObjcBase\n@end\n",
      });
      const model = load<ReadPodspec>("read-podspec.js").readPodspecCached(path.join(root, "Foo.podspec"));
      const dep: Dep = { name: "foo", root, swiftName: "Foo", platforms: { ios: {} } };
      const translate = load<{ translatePodspecToSpmTarget(...a: unknown[]): { mixedLanguage: { umbrellaHeaders: string[] } } }>(
        "scaffold-package-swift.js",
      ).translatePodspecToSpmTarget;
      expect(translate(model, dep, new Map(), new Map(), [reactRoot]).mixedLanguage.umbrellaHeaders).toEqual([
        "ios/FooBridge.h",
        "ios/FooPaper.h",
      ]);
      // Without the React trees the include is unresolved and not a C++-only root: kept.
      expect(translate(model, dep).mixedLanguage.umbrellaHeaders).toContain("ios/FooFabric.h");
    });

    it("forwards the CocoaPods module's -Swift.h spelling when module_name differs", () => {
      const root = mixedLib(FIXTURES["B"]!, '  s.source_files = "ios/**/*.{h,m,mm,swift}"\n  s.module_name = "FooKit"');
      scaffoldMixed(root);
      expect(readFileSync(path.join(root, "rn-spm-swift/FooKit-Swift.h"), "utf8")).toContain("#import <Foo-Swift.h>");
      expect(readFileSync(path.join(root, "rn-spm-swift/FooKit/FooKit-Swift.h"), "utf8")).toContain("#import <Foo-Swift.h>");
    });

    it("forwards the c99 spelling to the target-named header Swift Build writes", () => {
      // Swift Build names the header after the target ("react-foo-Swift.h"), CocoaPods sources
      // spell the c99 module ("react_foo-Swift.h"), as react-native-pager-view does.
      const root = mixedLib(FIXTURES["B"]!);
      writeFileSync(path.join(root, "Foo.podspec"), 'Pod::Spec.new do |s|\n  s.name = "react-foo"\n  s.source_files = "ios/**/*.{h,m,mm,swift}"\nend\n');
      const dep = { name: "react-foo", root, swiftName: "react-foo", swiftNameSource: "podspec", platforms: { ios: { podspecPath: path.join(root, "Foo.podspec") } } };
      const ctx = { appRoot: root, projectRoot: root, reactNativeRoot: root, force: true, dryRun: false, cacheSlotLabel: null, remote: null };
      load<{ scaffoldPackageSwiftForDep(d: object, c: object): unknown }>("scaffold-package-swift.js").scaffoldPackageSwiftForDep(dep, ctx);
      expect(readFileSync(path.join(root, "rn-spm-swift/react_foo-Swift.h"), "utf8")).toContain("#import <react-foo-Swift.h>");
      expect(readFileSync(path.join(root, "rn-spm-swift/react_foo/react_foo-Swift.h"), "utf8")).toContain("#import <react-foo-Swift.h>");
    });

    it("uses the podspec's SWIFT_OBJC_BRIDGING_HEADER instead of the umbrella", () => {
      const root = mixedLib(
        { ...FIXTURES["A"]!, "ios/Foo-Bridging-Header.h": '#import "FooGreeter.h"\n' },
        '  s.source_files = "ios/**/*.{h,m,mm,swift}"\n  s.pod_target_xcconfig = { "SWIFT_OBJC_BRIDGING_HEADER" => "$(PODS_TARGET_SRCROOT)/ios/Foo-Bridging-Header.h" }',
      );
      const { pkg } = scaffoldMixed(root);
      expect(pkg).toContain('let rnSpmBridgingHeader = Context.packageDirectory + "/ios/Foo-Bridging-Header.h"');
      expect(existsSync(path.join(root, "rn-spm-swift/umbrella.h"))).toBe(false);
    });

    it("warns at scaffold time when RN_SPM_SWIFT_HEADERS_DIR is unset, and not when it is set", () => {
      const saved = process.env["RN_SPM_SWIFT_HEADERS_DIR"];
      try {
        delete process.env["RN_SPM_SWIFT_HEADERS_DIR"];
        expect(scaffoldMixed(mixedLib(FIXTURES["B"]!)).warnings.some((w) => w.includes("RN_SPM_SWIFT_HEADERS_DIR"))).toBe(true);
        process.env["RN_SPM_SWIFT_HEADERS_DIR"] = "/build/GeneratedModuleMaps-iphoneos";
        expect(scaffoldMixed(mixedLib(FIXTURES["B"]!)).warnings.some((w) => w.includes("RN_SPM_SWIFT_HEADERS_DIR"))).toBe(false);
      } finally {
        if (saved === undefined) delete process.env["RN_SPM_SWIFT_HEADERS_DIR"];
        else process.env["RN_SPM_SWIFT_HEADERS_DIR"] = saved;
      }
    });

    it("keeps the 6.0 header and no mixed settings for a single-language library", () => {
      const root = mixedLib({ "ios/FooGreeter.h": GREETER_H, "ios/FooGreeter.m": GREETER_M });
      const { status, pkg } = scaffoldMixed(root);
      expect(status).toBe("written");
      expect(pkg.split("\n")[0]).toBe("// swift-tools-version: 6.0");
      expect(pkg).not.toContain("rnSpm");
      expect(pkg).not.toContain("swiftSettings");
      expect(pkg).not.toContain('"-std=c++20"');
      expect(existsSync(path.join(root, "rn-spm-swift"))).toBe(false);
    });

    it("never feeds its own support files back into sources on a re-scaffold", () => {
      const root = mixedLib(FIXTURES["circular"]!, '  s.source_files = "**/*.{h,m,mm,swift}"');
      scaffoldMixed(root);
      const { pkg } = scaffoldMixed(root);
      expect(pkg).not.toContain('"rn-spm-swift/');
      expect(pkg).not.toContain('"Package.swift"');
    });

    it("emits a manifest SwiftPM accepts", async () => {
      const { pkg } = scaffoldMixed(mixedLib(FIXTURES["circular"]!));
      const root = tempDir();
      writeFileSync(path.join(root, "Package.swift"), pkg);
      const swift = await execa("swift", ["package", "dump-package"], {
        cwd: root,
        reject: false,
        env: { PATH: `${process.env["HOME"]}/.local/share/swiftly/bin:${process.env["PATH"]}` },
      });
      if (swift.failed && /ENOENT/.test(String(swift.code ?? swift.message))) return;
      expect(swift.exitCode, swift.stderr).toBe(0);
      expect(JSON.parse(swift.stdout).toolsVersion._version).toBe("6.4.0");
    });
  });

  describe("bare React header imports", () => {
    it("forwards a bare quoted import of a React header (CocoaPods header map) to <React/...>", () => {
      const reactRoot = tempDir();
      mkdirSync(path.join(reactRoot, "React"), { recursive: true });
      writeFileSync(path.join(reactRoot, "React/RCTFabricComponentsPlugins.h"), "");
      const root = tempDir();
      mkdirSync(path.join(root, "ios"), { recursive: true });
      writeFileSync(path.join(root, "ios/Foo.h"), "");
      writeFileSync(
        path.join(root, "ios/Foo.mm"),
        '#import "Foo.h"\n#import "RCTFabricComponentsPlugins.h"\n#import "Missing.h"\n#import "React/RCTBridge.h"\n',
      );
      writeFileSync(
        path.join(root, "Foo.podspec"),
        'Pod::Spec.new do |s|\n  s.name = "Foo"\n  s.source_files = "ios/**/*.{h,mm}"\n  s.dependency "React-Core"\nend\n',
      );
      const model = load<ReadPodspec>("read-podspec.js").readPodspecCached(path.join(root, "Foo.podspec"));
      const dep: Dep = { name: "foo", root, swiftName: "Foo", platforms: { ios: {} } };
      const spec = load<{ translatePodspecToSpmTarget(...a: unknown[]): { reactBareHeaders: string[]; headerSearchPaths: string[] } }>(
        "scaffold-package-swift.js",
      ).translatePodspecToSpmTarget(model, dep, new Map(), new Map(), [reactRoot]);
      expect(spec.reactBareHeaders).toEqual(["RCTFabricComponentsPlugins.h"]);
      expect(spec.headerSearchPaths).toContain("rn-spm-react-headers");
      const none = load<{ translatePodspecToSpmTarget(...a: unknown[]): { reactBareHeaders: string[]; headerSearchPaths: string[] } }>(
        "scaffold-package-swift.js",
      ).translatePodspecToSpmTarget(model, dep);
      expect(none.reactBareHeaders).toEqual([]);
      expect(none.headerSearchPaths).not.toContain("rn-spm-react-headers");
    });
  });

  describe("CocoaPods dependencies mapped to SwiftPM packages", () => {
    type ExtSpec = Spec & { externalPackages: { pod: string; url: string; from: string; product: string; package: string }[] };
    function lib(deps: string): string {
      const root = tempDir();
      mkdirSync(path.join(root, "ios"), { recursive: true });
      writeFileSync(path.join(root, "ios/Foo.h"), "#import <Foundation/Foundation.h>\n");
      writeFileSync(path.join(root, "ios/Foo.m"), '#import "Foo.h"\n');
      writeFileSync(
        path.join(root, "Foo.podspec"),
        `Pod::Spec.new do |s|\n  s.name = "Foo"\n  s.source_files = "ios/**/*.{h,m}"\n${deps}\nend\n`,
      );
      return root;
    }
    const translate = (root: string) =>
      load<{ translatePodspecToSpmTarget(...a: unknown[]): ExtSpec }>("scaffold-package-swift.js").translatePodspecToSpmTarget(
        load<ReadPodspec>("read-podspec.js").readPodspecCached(path.join(root, "Foo.podspec")),
        { name: "foo", root, swiftName: "Foo", platforms: { ios: {} } },
      );
    const UNMAPPED = (pod: string) =>
      `Dependency "${pod}" is a CocoaPods pod with no known SwiftPM equivalent; the scaffolded package may fail to build — add it to the pod→SwiftPM map in scaffold-package-swift.js`;

    it("maps SwiftUIIntrospect (react-native-pager-view's `~> 1.0`) to its SwiftPM package", () => {
      const spec = translate(lib(`  s.dependency "SwiftUIIntrospect", '~> 1.0'`));
      expect(spec.externalPackages).toEqual([
        {
          pod: "SwiftUIIntrospect",
          url: "https://github.com/siteline/swiftui-introspect",
          from: "1.0.0",
          product: "SwiftUIIntrospect",
          package: "swiftui-introspect",
        },
      ]);
      expect(spec.warnings.filter((w) => w.includes("SwiftUIIntrospect"))).toEqual([]);
    });

    it("emits the .package(url:from:) and the .product dependency", () => {
      const root = lib(`  s.dependency "SwiftUIIntrospect", '~> 1.0'`);
      const dep = { name: "foo", root, swiftName: "Foo", swiftNameSource: "podspec", platforms: { ios: { podspecPath: path.join(root, "Foo.podspec") } } };
      const ctx = { appRoot: root, projectRoot: root, reactNativeRoot: root, force: true, dryRun: false, cacheSlotLabel: null, remote: null };
      const res = load<{ scaffoldPackageSwiftForDep(d: object, c: object): { status: string } }>(
        "scaffold-package-swift.js",
      ).scaffoldPackageSwiftForDep(dep, ctx);
      expect(res.status).toBe("written");
      const pkg = readFileSync(path.join(root, "Package.swift"), "utf8");
      expect(pkg).toContain('.package(url: "https://github.com/siteline/swiftui-introspect", from: "1.0.0")');
      expect(pkg).toContain('.product(name: "SwiftUIIntrospect", package: "swiftui-introspect")');
    });

    it("warns loudly about an unmapped external pod, once per pod (subspecs included)", () => {
      const spec = translate(lib(`  s.dependency "MMKV", '>= 1.3'\n  s.dependency "Firebase/Core"\n  s.dependency "Firebase/Messaging"`));
      expect(spec.externalPackages).toEqual([]);
      expect(spec.warnings).toContain(UNMAPPED("MMKV"));
      expect(spec.warnings.filter((w) => w === UNMAPPED("Firebase"))).toHaveLength(1);
    });

    it("does not call an Expo module a CocoaPods pod", () => {
      const spec = translate(lib(`  s.dependency "ExpoModulesCore"`));
      expect(spec.externalPackages).toEqual([]);
      expect(spec.warnings.some((w) => w.includes("no known SwiftPM equivalent"))).toBe(false);
      expect(spec.warnings.some((w) => w.includes('"ExpoModulesCore"'))).toBe(true);
    });
  });
});
