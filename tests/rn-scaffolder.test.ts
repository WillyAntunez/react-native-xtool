import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
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
    it("scaffold-package-swift.js has the umbrella-header and shim hunks", () => {
      const f = src("scaffold-package-swift.js");
      expect(f).toContain("umbrellaNextToSubdirs");
      expect(f).toContain("stub is named by basename");
    });
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
      expect(m.sourceFiles).toContain("ios/**/*.{h,m,mm,cpp}");
      expect(m.excludeFiles).toContain("ios/gamma/**/*.{h,m,mm,cpp}");
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
});
