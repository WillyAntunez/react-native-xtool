import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { libraryFailures } from "../src/project/earlyChecks.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-early-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

/**
 * A project whose package.json lists each of `deps` in `dependencies` (`root` overrides its fields), with each
 * package's files under `node_modules/<name>`; a package without its own package.json gets one at version 1.0.0.
 */
async function project(deps: Record<string, Record<string, string>>, root: Record<string, unknown> = {}): Promise<string> {
  const dir = await tempDir();
  const dependencies = Object.fromEntries(Object.keys(deps).map((name) => [name, "*"]));
  await writeFiles(dir, { "package.json": JSON.stringify({ name: "app", dependencies, ...root }) });
  for (const [name, files] of Object.entries(deps)) {
    await writeFiles(path.join(dir, "node_modules", name), {
      "package.json": JSON.stringify({ name, version: "1.0.0" }),
      ...files,
    });
  }
  return dir;
}

const DOCS = "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md";
const ASYNC_STORAGE = "@react-native-async-storage/async-storage";
const SCAFFOLD_MARKER = "// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.";

/** async-storage 3.1.1's shape: a CocoaPods-only library with a prebuilt XCFramework and no Package.swift. */
function asyncStorage(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: ASYNC_STORAGE, version: "3.1.1" }),
    "AsyncStorage.podspec":
      "Pod::Spec.new do |s|\n  s.name = 'RNCAsyncStorage'\n" +
      '  s.ios.vendored_frameworks = "apple-frameworks/SharedAsyncStorage.xcframework"\nend\n',
    ...extra,
  };
}

const ASYNC_STORAGE_REASON =
  `${ASYNC_STORAGE} 3.1.1: its podspec (AsyncStorage.podspec) declares vendored_frameworks and the package ships no ` +
  "Package.swift, so rn-xtool would have to scaffold it, and it cannot link prebuilt binaries yet. " +
  `See ${DOCS}#libraries-with-prebuilt-binaries`;

/** expo-sqlite 58.0.14's shape: an Expo module whose podspec copies C sources from vendor/ at pod install. */
function expoSqlite(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "expo-sqlite", version: "58.0.14" }),
    "expo-module.config.json": JSON.stringify({ platforms: ["apple", "android", "devtools"], apple: { modules: ["SQLiteModule"] } }),
    "ios/ExpoSQLite.podspec":
      "require 'json'\n\nPod::Spec.new do |s|\n  s.name = 'ExpoSQLite'\n  vendor_src = 'sqlite3'\n" +
      "  s.prepare_command = <<-CMD\n  CMD\n  ['sqlite3.c', 'sqlite3.h'].each do |file|\n" +
      "    source = File.join(__dir__, '..', 'vendor', vendor_src, file)\n  end\n" +
      '  s.source_files = "**/*.{c,h,m,swift}"\nend\n',
    "vendor/sqlite3/sqlite3.c": "int sqlite3_x;\n",
    "vendor/sqlite3/sqlite3.h": "int sqlite3_x;\n",
    "vendor/sqlcipher/sqlite3.c": "int sqlite3_y;\n",
    "vendor/sqlcipher/sqlite3.h": "int sqlite3_y;\n",
    ...extra,
  };
}

describe("libraryFailures", () => {
  it("refuses a CocoaPods-only library with prebuilt binaries", async () => {
    const root = await project({ [ASYNC_STORAGE]: asyncStorage() });
    expect(libraryFailures(root)).toEqual([{ id: "vendored-binaries", reason: ASYNC_STORAGE_REASON }]);
  });

  it("names vendored libraries too", async () => {
    const root = await project({
      foo: {
        "package.json": JSON.stringify({ name: "foo", version: "2.0.0" }),
        "ios/Foo.podspec": 'Pod::Spec.new do |s|\n  s.vendored_libraries = "libfoo.a"\n  s.vendored_frameworks = "Foo.xcframework"\nend\n',
      },
      bar: { "Bar.podspec": "Pod::Spec.new do |s|\n  s.vendored_library = 'libbar.a'\nend\n" },
      nover: {
        "package.json": JSON.stringify({ name: "nover" }),
        "Nover.podspec": "Pod::Spec.new do |s|\n  s.vendored_framework = 'N.xcframework'\nend\n",
      },
    });
    expect(libraryFailures(root).map((f) => f.reason.split(" and the package")[0])).toEqual([
      "bar 1.0.0: its podspec (Bar.podspec) declares vendored_libraries",
      "foo 2.0.0: its podspec (ios/Foo.podspec) declares vendored_frameworks and vendored_libraries",
      "nover unknown: its podspec (Nover.podspec) declares vendored_frameworks",
    ]);
  });

  it("never fires on Expo modules", async () => {
    const root = await project({
      "expo-router": {
        "expo-module.config.json": JSON.stringify({ platforms: ["apple", "android"], apple: { modules: ["ExpoRouterModule"] } }),
        "ios/ExpoRouter.podspec": "Pod::Spec.new do |s|\n  s.vendored_frameworks = 'ExpoRouter.xcframework'\nend\n",
      },
      "expo-ios-key": {
        "expo-module.config.json": JSON.stringify({ platforms: ["ios"] }),
        "ios/Key.podspec": "Pod::Spec.new do |s|\n  s.ios.vendored_frameworks = 'Key.xcframework'\nend\n",
      },
    });
    expect(libraryFailures(root)).toEqual([]);
  });

  it("leaves every package with an expo-module.config.json out of the binaries check", async () => {
    const root = await project({
      "android-only": {
        "expo-module.config.json": JSON.stringify({ platforms: ["android"] }),
        "Lib.podspec": "Pod::Spec.new do |s|\n  s.vendored_frameworks = 'Lib.xcframework'\nend\n",
      },
      "unreadable-config": {
        "expo-module.config.json": "{ not json",
        "Lib.podspec": "Pod::Spec.new do |s|\n  s.vendored_frameworks = 'Lib.xcframework'\nend\n",
      },
    });
    expect(libraryFailures(root)).toEqual([]);
  });

  it("reads a relative root as the folder it names", async () => {
    const root = await project({ [ASYNC_STORAGE]: asyncStorage() });
    expect(libraryFailures(path.relative(process.cwd(), root))).toEqual([{ id: "vendored-binaries", reason: ASYNC_STORAGE_REASON }]);
  });

  it("ignores binaries a test spec or a Ruby condition declares", async () => {
    const spec = (body: string) => ({ "Lib.podspec": `Pod::Spec.new do |s|\n  s.name = 'Lib'\n${body}end\n` });
    const roots = await Promise.all(
      [
        "  s.test_spec 'Tests' do |t|\n    t.vendored_frameworks = 'Test.xcframework'\n  end\n",
        "  if ENV['LIB_PREBUILT'] == '1'\n    s.vendored_frameworks = 'Lib.xcframework'\n  end\n",
        "  unless ENV['LIB_SOURCE']\n    s.ios.vendored_libraries = 'libLib.a'\n  else\n    s.source_files = 'ios/**/*'\n  end\n",
        "  s.vendored_frameworks = 'Lib.xcframework' if ENV['LIB_PREBUILT']\n",
        "  s.vendored_frameworks = ENV['LIB_PREBUILT'] ? 'Lib.xcframework' : []\n",
        "  case ENV['LIB_MODE']\n  when 'binary'\n    s.vendored_frameworks = 'Lib.xcframework'\n  end\n",
      ].map((body) => project({ lib: spec(body) })),
    );
    for (const root of roots) expect(libraryFailures(root)).toEqual([]);
  });

  it("still reads the binaries declared after a test spec, a condition or a heredoc", async () => {
    const root = await project({
      lib: {
        "Lib.podspec":
          "Pod::Spec.new do |s|\n  s.test_spec 'Tests' do |t|\n    t.source_files = 'Tests/**/*'\n  end\n" +
          "  if ENV['X']\n    s.dependency 'Y'\n  end\n  s.prepare_command = <<-CMD\n    if true; then echo do; fi\n  CMD\n" +
          "  s.script_phase = { :name => 'end' }\n  s.vendored_frameworks = 'Lib.xcframework'\nend\n",
      },
    });
    expect(libraryFailures(root).map((f) => f.id)).toEqual(["vendored-binaries"]);
  });

  it("skips libraries the project takes out of iOS autolinking", async () => {
    const config = (text: string) => async (root: string) => writeFiles(root, { "react-native.config.js": text });
    const rnConfig = [
      `module.exports = {\n  dependencies: {\n    '${ASYNC_STORAGE}': {\n      platforms: {\n        ios: null, // JS fallback on iOS\n      },\n    },\n  },\n};\n`,
      `module.exports = { dependencies: { "${ASYNC_STORAGE}": { platforms: { android: {}, ios: null } } } };\n`,
      `module.exports = {"dependencies": {"${ASYNC_STORAGE}": {"platforms": {"ios": null}}}};\n`,
    ];
    for (const text of rnConfig) {
      const root = await project({ [ASYNC_STORAGE]: asyncStorage() });
      await config(text)(root);
      expect(libraryFailures(root)).toEqual([]);
    }
    const expoExcluded = [
      { expo: { autolinking: { exclude: [ASYNC_STORAGE, "expo-sqlite"] } } },
      { expo: { autolinking: { ios: { exclude: [ASYNC_STORAGE, "expo-sqlite"] } } } },
      { expo: { autolinking: { apple: { exclude: [ASYNC_STORAGE, "expo-sqlite"] } } } },
    ];
    for (const fields of expoExcluded) {
      const root = await project({ [ASYNC_STORAGE]: asyncStorage(), "expo-sqlite": expoSqlite() }, fields);
      expect(libraryFailures(root)).toEqual([]);
    }
    const appJson = await project({ [ASYNC_STORAGE]: asyncStorage(), "expo-sqlite": expoSqlite() });
    await writeFiles(appJson, { "app.json": JSON.stringify({ expo: { name: "demo", autolinking: { exclude: [ASYNC_STORAGE, "expo-sqlite"] } } }) });
    expect(libraryFailures(appJson)).toEqual([]);
  });

  it("still checks a library the project keeps on iOS", async () => {
    const texts = [
      `module.exports = { dependencies: { '${ASYNC_STORAGE}': { platforms: { android: null } } } };\n`,
      `module.exports = { dependencies: { 'other-lib': { platforms: { ios: null } } } };\n`,
      `// module.exports = { dependencies: { '${ASYNC_STORAGE}': { platforms: { ios: null } } } };\nmodule.exports = {};\n`,
    ];
    for (const text of texts) {
      const root = await project({ [ASYNC_STORAGE]: asyncStorage() });
      await writeFiles(root, { "react-native.config.js": text });
      expect(libraryFailures(root).map((f) => f.id)).toEqual(["vendored-binaries"]);
    }
    const otherExcluded = await project({ [ASYNC_STORAGE]: asyncStorage() }, { expo: { autolinking: { exclude: ["expo-sqlite"] } } });
    expect(libraryFailures(otherExcluded).map((f) => f.id)).toEqual(["vendored-binaries"]);
  });

  it("counts a Package.swift the project's patches/ create", async () => {
    const creates = (pkgPath: string, lines: string[]) =>
      `diff --git a/node_modules/${pkgPath} b/node_modules/${pkgPath}\nnew file mode 100644\nindex 0000000..1111111\n` +
      `--- /dev/null\n+++ b/node_modules/${pkgPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    const own = ["// swift-tools-version: 6.0", "import PackageDescription", 'let package = Package(name: "AsyncStorage")'];
    const patchName = "@react-native-async-storage+async-storage+3.1.1.patch";

    const handWritten = await project({ [ASYNC_STORAGE]: asyncStorage() });
    await writeFiles(handWritten, { [`patches/${patchName}`]: creates(`${ASYNC_STORAGE}/Package.swift`, own) });
    expect(libraryFailures(handWritten)).toEqual([]);

    const inIos = await project({ [ASYNC_STORAGE]: asyncStorage() });
    await writeFiles(inIos, { [`patches/${patchName}`]: creates(`${ASYNC_STORAGE}/ios/Package.swift`, own) });
    expect(libraryFailures(inIos)).toEqual([]);

    const sqlite = await project({ "expo-sqlite": expoSqlite() });
    await writeFiles(sqlite, { "patches/expo-sqlite+58.0.14.patch": creates("expo-sqlite/Package.swift", own) });
    expect(libraryFailures(sqlite)).toEqual([]);

    // rn-xtool persists every scaffold it writes: an unedited one still counts as none.
    const persisted = await project({ [ASYNC_STORAGE]: asyncStorage() });
    await writeFiles(persisted, { [`patches/${patchName}`]: creates(`${ASYNC_STORAGE}/Package.swift`, [SCAFFOLD_MARKER, ...own]) });
    expect(libraryFailures(persisted)).toEqual([{ id: "vendored-binaries", reason: ASYNC_STORAGE_REASON }]);

    // Another package's patch, or a patch that does not create the manifest, says nothing about this one.
    const other = await project({ [ASYNC_STORAGE]: asyncStorage() });
    await writeFiles(other, {
      "patches/other-lib+1.0.0.patch": creates(`${ASYNC_STORAGE}/Package.swift`, own),
      [`patches/${patchName}`]: creates(`${ASYNC_STORAGE}/README.md`, ["notes"]),
    });
    expect(libraryFailures(other)).toEqual([{ id: "vendored-binaries", reason: ASYNC_STORAGE_REASON }]);
  });

  it("counts a scaffolded Package.swift the user edited", async () => {
    const edited = [
      SCAFFOLD_MARKER,
      "import PackageDescription",
      'let package = Package(name: "AsyncStorage", targets: [',
      '    .binaryTarget(name: "SharedAsyncStorage", path: "apple-frameworks/SharedAsyncStorage.xcframework"),',
      "])",
    ].join("\n");
    const inNodeModules = await project({ [ASYNC_STORAGE]: asyncStorage({ "Package.swift": edited }) });
    expect(libraryFailures(inNodeModules)).toEqual([]);
    const inPatches = await project({ [ASYNC_STORAGE]: asyncStorage() });
    const lines = edited.split("\n");
    await writeFiles(inPatches, {
      "patches/@react-native-async-storage+async-storage+3.1.1.patch":
        `diff --git a/node_modules/${ASYNC_STORAGE}/Package.swift b/node_modules/${ASYNC_STORAGE}/Package.swift\n` +
        `new file mode 100644\n--- /dev/null\n+++ b/node_modules/${ASYNC_STORAGE}/Package.swift\n` +
        `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
    });
    expect(libraryFailures(inPatches)).toEqual([]);
  });

  it("skips libraries that manage themselves", async () => {
    const cases = [
      await project({ [ASYNC_STORAGE]: asyncStorage({ "Package.swift": "// swift-tools-version: 6.0\n" }) }),
      await project({ [ASYNC_STORAGE]: asyncStorage({ "ios/Package.swift": "// swift-tools-version: 6.0\n" }) }),
      await project({
        [ASYNC_STORAGE]: asyncStorage({
          "package.json": JSON.stringify({ name: ASYNC_STORAGE, version: "3.1.1", swiftpmConfig: { scaffold: false } }),
        }),
      }),
      await project({ commented: { "Commented.podspec": "Pod::Spec.new do |s|\n  # s.vendored_frameworks = 'X.xcframework'\nend\n" } }),
      await project({ [ASYNC_STORAGE]: asyncStorage() }, { dependencies: {}, devDependencies: { [ASYNC_STORAGE]: "*" } }),
      await project({}, { dependencies: { [ASYNC_STORAGE]: "*" } }),
    ];
    for (const root of cases) expect(libraryFailures(root)).toEqual([]);
  });

  it("a Package.swift rn-xtool scaffolded still counts as none", async () => {
    const scaffolded = "// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.\n";
    const generated = "// AUTO-GENERATED by scripts/generate-spm-autolinking.js\n";
    for (const files of [{ "Package.swift": scaffolded }, { "ios/Package.swift": generated }]) {
      const root = await project({ [ASYNC_STORAGE]: asyncStorage(files) });
      expect(libraryFailures(root)).toEqual([{ id: "vendored-binaries", reason: ASYNC_STORAGE_REASON }]);
    }
  });

  it("refuses an Expo module that builds vendored C sources", async () => {
    const root = await project({ "expo-sqlite": expoSqlite() });
    expect(libraryFailures(root)).toEqual([
      {
        id: "vendored-sources",
        reason:
          "expo-sqlite 58.0.14: its podspec (ios/ExpoSQLite.podspec) builds C sources from vendor/ (vendor/sqlcipher/sqlite3.c, " +
          "vendor/sqlite3/sqlite3.c) and the package ships no Package.swift; rn-xtool cannot build vendored C sources yet. " +
          `See ${DOCS}#libraries-that-build-vendored-c-sources`,
      },
    ]);
    const five = await project({
      "expo-sqlite": {
        "package.json": JSON.stringify({ name: "expo-sqlite", version: "58.0.14" }),
        "expo-module.config.json": JSON.stringify({ platforms: ["apple"] }),
        "ios/ExpoSQLite.podspec": "Pod::Spec.new do |s|\n  source = File.join(__dir__, '..', 'vendor', file)\nend\n",
        ...Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [`vendor/${n}.c`, ""])),
      },
    });
    expect(libraryFailures(five)[0]?.reason).toContain("(vendor/a.c, vendor/b.c, vendor/c.c and 2 more)");
  });

  it("needs both a vendor/ reference and C sources under vendor/", async () => {
    const noReference = await project({
      "expo-sqlite": expoSqlite({ "ios/ExpoSQLite.podspec": 'Pod::Spec.new do |s|\n  s.source_files = "**/*.{c,h,m,swift}"\nend\n' }),
    });
    const { "vendor/sqlite3/sqlite3.c": _a, "vendor/sqlcipher/sqlite3.c": _b, ...headers } = expoSqlite();
    const headersOnly = await project({ "expo-sqlite": headers });
    expect(libraryFailures(noReference)).toEqual([]);
    expect(libraryFailures(headersOnly)).toEqual([]);
  });

  it("lets a precompiled or self-managed vendored-C module through", async () => {
    const prebuilt = Object.fromEntries(
      ["debug", "release"].map((f) => [`prebuilds/output/${f}/xcframeworks/ExpoSQLite.tar.gz`, ""]),
    );
    expect(libraryFailures(await project({ "expo-sqlite": expoSqlite(prebuilt) }))).toEqual([]);
    expect(libraryFailures(await project({ "expo-sqlite": expoSqlite({ "Package.swift": "// swift-tools-version: 6.0\n" }) }))).toEqual([]);
  });

  it("never throws on a broken project", async () => {
    const empty = await tempDir();
    expect(libraryFailures(empty)).toEqual([]);
    const invalid = await tempDir();
    await writeFile(path.join(invalid, "package.json"), "{ not json");
    expect(libraryFailures(invalid)).toEqual([]);
    const unreadable = await project({
      broken: { "Broken.podspec/inside": "", "expo-module.config.json": "{ not json" },
      "bad-json": { "package.json": "{ not json", "Bad.podspec/inside": "" },
    });
    expect(libraryFailures(unreadable)).toEqual([]);
    expect(libraryFailures(path.join(empty, "missing"))).toEqual([]);
  });
});
