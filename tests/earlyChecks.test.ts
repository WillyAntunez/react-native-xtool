import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedLimitText,
  allowKnownLimits,
  earlyFailures,
  excludeLines,
  installFailures,
  knownLimitHint,
  libraryFailures,
  podPinWarnings,
  scaffoldedPods,
  UnsupportedSetupError,
} from "../src/project/earlyChecks.js";
import { mergedPodTable, type PodTable } from "../src/project/podTable.js";
import { podDependencies } from "../src/project/podspecs.js";

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
    expect(libraryFailures(root)).toEqual([{ id: "vendored-binaries", allowKey: ASYNC_STORAGE, reason: ASYNC_STORAGE_REASON }]);
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

  it("counts only binaries declared for iOS or for every platform", async () => {
    const spec = (line: string) => ({ "Lib.podspec": `Pod::Spec.new do |s|\n  s.source_files = 'ios/**/*'\n${line}end\n` });
    const otherPlatforms = await Promise.all(
      [
        "  s.osx.vendored_frameworks = 'macos/Lib.xcframework'\n",
        "  s.tvos.vendored_frameworks = 'tvos/Lib.xcframework'\n",
        "  s.visionos.vendored_libraries = 'visionos/libLib.a'\n",
        "  s.watchos.vendored_framework = 'watchos/Lib.xcframework'\n",
        "  s.macos.vendored_library = 'macos/libLib.a'\n",
      ].map((line) => project({ lib: spec(line) })),
    );
    for (const root of otherPlatforms) expect(libraryFailures(root)).toEqual([]);
    const ios = await project({ lib: spec("  s.ios.vendored_frameworks = 'ios/Lib.xcframework'\n") });
    expect(libraryFailures(ios).map((f) => f.id)).toEqual(["vendored-binaries"]);
    const every = await project({ lib: spec("  s.vendored_libraries = 'libLib.a'\n") });
    expect(libraryFailures(every).map((f) => f.id)).toEqual(["vendored-binaries"]);
  });

  it("reads a relative root as the folder it names", async () => {
    const root = await project({ [ASYNC_STORAGE]: asyncStorage() });
    expect(libraryFailures(path.relative(process.cwd(), root))).toEqual([{ id: "vendored-binaries", allowKey: ASYNC_STORAGE, reason: ASYNC_STORAGE_REASON }]);
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
    expect(libraryFailures(persisted)).toEqual([{ id: "vendored-binaries", allowKey: ASYNC_STORAGE, reason: ASYNC_STORAGE_REASON }]);

    // Another package's patch, or a patch that does not create the manifest, says nothing about this one.
    const other = await project({ [ASYNC_STORAGE]: asyncStorage() });
    await writeFiles(other, {
      "patches/other-lib+1.0.0.patch": creates(`${ASYNC_STORAGE}/Package.swift`, own),
      [`patches/${patchName}`]: creates(`${ASYNC_STORAGE}/README.md`, ["notes"]),
    });
    expect(libraryFailures(other)).toEqual([{ id: "vendored-binaries", allowKey: ASYNC_STORAGE, reason: ASYNC_STORAGE_REASON }]);
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
      expect(libraryFailures(root)).toEqual([{ id: "vendored-binaries", allowKey: ASYNC_STORAGE, reason: ASYNC_STORAGE_REASON }]);
    }
  });

  it("refuses an Expo module that builds vendored C sources", async () => {
    const root = await project({ "expo-sqlite": expoSqlite() });
    expect(libraryFailures(root)).toEqual([
      {
        id: "vendored-sources",
        allowKey: "expo-sqlite",
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

const PNPM_REASON = (lock: string) =>
  `This project was installed with pnpm (${lock} and a node_modules/.pnpm store); rn-xtool needs the flat node_modules ` +
  `that npm or Yarn classic installs. Remove node_modules and install with npm. See ${DOCS}#pnpm-and-yarn-pnp`;
const PNP_REASON = (pnp: string) =>
  `This project uses Yarn Plug'n'Play (${pnp}); rn-xtool needs a node_modules folder. Add nodeLinker: node-modules to ` +
  `.yarnrc.yml and run yarn install. See ${DOCS}#pnpm-and-yarn-pnp`;
const HOISTED_REASON = (pkg: string, rel: string) =>
  `${pkg} is installed in ${rel}, outside this project: a workspace hoisted it to a parent folder, and rn-xtool patches ` +
  `and builds only the project's own node_modules/${pkg}. Install the app outside the workspace, or keep ${pkg} in the ` +
  `app's node_modules (for example with nohoist). See ${DOCS}#packages-hoisted-to-a-parent-folder`;

/** A workspace folder with an app at `apps/demo` whose package.json is `app`; returns both paths. */
async function workspace(app: Record<string, unknown> = { name: "demo" }): Promise<{ ws: string; app: string }> {
  const ws = await tempDir();
  const appDir = path.join(ws, "apps", "demo");
  await writeFiles(appDir, { "package.json": JSON.stringify(app) });
  return { ws, app: appDir };
}

describe("installFailures", () => {
  // Each lookup stops at the test's own temp folder: nothing in /tmp, ~ or Node's global folders is read.
  const within = (ws: string) => ({ stopAt: ws });

  it("refuses a pnpm install", async () => {
    const root = await project({});
    await writeFiles(root, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "node_modules/.pnpm/lock.yaml": "" });
    expect(installFailures(root, within(root))).toEqual([{ id: "pnpm", allowKey: "pnpm", reason: PNPM_REASON("pnpm-lock.yaml") }]);
  });

  it("a parent pnpm lockfile and store do not refuse an npm project", async () => {
    const npm = await workspace({ name: "demo", dependencies: { "react-native": "*" } });
    await writeFiles(npm.ws, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "node_modules/.pnpm/lock.yaml": "" });
    await writeFiles(npm.app, { "node_modules/react-native/package.json": JSON.stringify({ name: "react-native" }) });
    expect(installFailures(npm.app, within(npm.ws))).toEqual([]);

    // A stray ~/pnpm-lock.yaml and ~/node_modules/.pnpm (one `pnpm add` in the home folder) above the app.
    const home = await workspace();
    await writeFiles(home.ws, { "pnpm-lock.yaml": "", "node_modules/.pnpm/lock.yaml": "" });
    await writeFiles(home.app, { "node_modules/.pnpm/lock.yaml": "" });
    expect(installFailures(home.app, within(home.ws))).toEqual([]);
  });

  it("a stray lockfile without a .pnpm store does not fire", async () => {
    const root = await project({});
    await writeFiles(root, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect(installFailures(root, within(root))).toEqual([]);
  });

  it("lets a pnpm install with the hoisted node linker through", async () => {
    const pnpm = { "pnpm-lock.yaml": "", "node_modules/.pnpm/lock.yaml": "" };
    const cases: Record<string, string>[] = [
      { ".npmrc": "auto-install-peers=true\nnode-linker=hoisted\n" },
      { "pnpm-workspace.yaml": "packages:\n  - .\nnodeLinker: hoisted\n" },
      { "pnpm-workspace.yaml": "nodeLinker: 'hoisted' # flat\n" },
      // What pnpm 11 records after a hoisted install.
      { "node_modules/.modules.yaml": '{\n  "layoutVersion": 5,\n  "nodeLinker": "hoisted",\n  "storeDir": "x"\n}\n' },
    ];
    for (const files of cases) {
      const root = await project({});
      await writeFiles(root, { ...pnpm, ...files });
      expect(installFailures(root, within(root))).toEqual([]);
    }
    // The install's own record wins: pnpm 11 ignores node-linker in .npmrc and installs isolated.
    const isolated = await project({});
    await writeFiles(isolated, {
      ...pnpm,
      ".npmrc": "node-linker=hoisted\n",
      "node_modules/.modules.yaml": '{\n  "nodeLinker": "isolated"\n}\n',
    });
    expect(installFailures(isolated, within(isolated))).toEqual([{ id: "pnpm", allowKey: "pnpm", reason: PNPM_REASON("pnpm-lock.yaml") }]);
  });

  it("refuses Yarn PnP", async () => {
    const root = await project({}, { dependencies: { "react-native": "*" } });
    await writeFiles(root, { ".pnp.cjs": "" });
    expect(installFailures(root, within(root))).toEqual([{ id: "yarn-pnp", allowKey: "pnp", reason: PNP_REASON(".pnp.cjs") }]);
    const js = await project({});
    await writeFiles(js, { ".pnp.js": "" });
    expect(installFailures(js, within(js))).toEqual([{ id: "yarn-pnp", allowKey: "pnp", reason: PNP_REASON(".pnp.js") }]);

    const local = await project({}, { dependencies: { "react-native": "*" } });
    await writeFiles(local, { ".pnp.cjs": "", "node_modules/react-native/package.json": JSON.stringify({ name: "react-native" }) });
    expect(installFailures(local, within(local))).toEqual([]);
  });

  it("a parent Yarn PnP loader does not refuse the project", async () => {
    const { ws, app } = await workspace();
    await writeFiles(ws, { ".pnp.cjs": "", ".pnp.js": "" });
    expect(installFailures(app, within(ws))).toEqual([]);
  });

  it("refuses react-native hoisted to a parent folder", async () => {
    const { ws, app } = await workspace({ name: "demo", dependencies: { "react-native": "*" } });
    await writeFiles(ws, { "node_modules/react-native/package.json": JSON.stringify({ name: "react-native" }) });
    expect(installFailures(app, within(ws))).toEqual([
      { id: "hoisted", allowKey: "hoisted", reason: HOISTED_REASON("react-native", "../../node_modules/react-native") },
    ]);

    const expo = await workspace({ name: "demo", devDependencies: { expo: "*" } });
    await writeFiles(path.join(expo.ws, "apps"), { "node_modules/expo/package.json": JSON.stringify({ name: "expo" }) });
    expect(installFailures(expo.app, within(expo.ws))).toEqual([{ id: "hoisted", allowKey: "hoisted", reason: HOISTED_REASON("expo", "../node_modules/expo") }]);
  });

  it("looks for hoisted packages only in the parent folders' node_modules", async () => {
    // NODE_PATH and ~/.node_modules are on Node's lookup paths too; a copy found only there is not a workspace's.
    const { ws, app } = await workspace({ name: "demo", dependencies: { "react-native": "*" } });
    const global = path.join(ws, "global");
    await writeFiles(global, { "react-native/package.json": JSON.stringify({ name: "react-native" }) });
    vi.stubEnv("NODE_PATH", global);
    (Module as unknown as { _initPaths(): void })._initPaths();
    try {
      expect(createRequire(path.join(app, "package.json")).resolve.paths("react-native")).toContain(global);
      expect(installFailures(app, within(ws))).toEqual([]);
      expect(installFailures(app)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      (Module as unknown as { _initPaths(): void })._initPaths();
    }
  });

  it("leaves a package found nowhere, or not listed, to the existing errors", async () => {
    const missing = await workspace({ name: "demo", dependencies: { "react-native": "*", expo: "*" } });
    expect(installFailures(missing.app, within(missing.ws))).toEqual([]);
    const unlisted = await workspace({ name: "demo", dependencies: {} });
    await writeFiles(unlisted.ws, { "node_modules/react-native/package.json": JSON.stringify({ name: "react-native" }) });
    expect(installFailures(unlisted.app, within(unlisted.ws))).toEqual([]);
  });

  it("a symlinked react-native in node_modules is not hoisted", async () => {
    const { ws, app } = await workspace({ name: "demo", dependencies: { "react-native": "*" } });
    const outside = path.join(ws, "store", "react-native");
    await writeFiles(outside, { "package.json": JSON.stringify({ name: "react-native" }) });
    await mkdir(path.join(app, "node_modules"), { recursive: true });
    await symlink(outside, path.join(app, "node_modules", "react-native"));
    expect(installFailures(app, within(ws))).toEqual([]);
  });

  it("reads a relative root as the folder it names", async () => {
    const root = await project({});
    await writeFiles(root, { "pnpm-lock.yaml": "", "node_modules/.pnpm/lock.yaml": "" });
    expect(installFailures(path.relative(process.cwd(), root), within(root)).map((f) => f.id)).toEqual(["pnpm"]);
  });

  it("orders pnpm, yarn-pnp and hoisted", async () => {
    const { ws, app } = await workspace({ name: "demo", dependencies: { "react-native": "*" } });
    await writeFiles(app, { "pnpm-lock.yaml": "", "node_modules/.pnpm/lock.yaml": "", ".pnp.cjs": "" });
    await writeFiles(ws, { "node_modules/react-native/package.json": JSON.stringify({ name: "react-native" }) });
    expect(installFailures(app, within(ws)).map((f) => f.id)).toEqual(["pnpm", "yarn-pnp", "hoisted"]);
  });

  it("never throws on a broken project", async () => {
    const invalid = await tempDir();
    await writeFile(path.join(invalid, "package.json"), "{ not json");
    expect(installFailures(invalid, within(invalid))).toEqual([]);
    expect(installFailures(path.join(invalid, "missing"), within(invalid))).toEqual([]);
  });
});

describe("earlyFailures", () => {
  it("orders install failures before library failures", async () => {
    const root = await project({ [ASYNC_STORAGE]: asyncStorage() });
    await writeFiles(root, { "pnpm-lock.yaml": "", "node_modules/.pnpm/lock.yaml": "" });
    expect(earlyFailures(root, { stopAt: root }).map((f) => f.id)).toEqual(["pnpm", "vendored-binaries"]);
  });
});

const REFERENCE_APPS = ["app-expo-57", "app", "app-bare", "app-bare-086", "app-bare-087"].map((name) =>
  path.resolve(import.meta.dirname, "..", "..", name),
);

describe.skipIf(!REFERENCE_APPS.every((app) => existsSync(path.join(app, "package.json"))))(
  "fires on none of the reference apps (needs ../app-expo-57, ../app, ../app-bare, ../app-bare-086 and ../app-bare-087)",
  () => {
    it.each(REFERENCE_APPS.map((app) => [path.basename(app), app]))("%s", (_name, app) => {
      expect(earlyFailures(app)).toEqual([]);
    });
  },
);

describe("module layout", () => {
  it("shares the podspec readers through a leaf module, with no import cycle", () => {
    const src = path.resolve(import.meta.dirname, "..", "src", "project");
    const imports = (file: string) =>
      [...readFileSync(path.join(src, file), "utf8").matchAll(/from "\.\/([\w-]+)\.js"/g)].map((m) => m[1]);
    expect(imports("earlyChecks.ts")).not.toContain("capabilities");
    expect(imports("podspecs.ts")).toEqual([]);
    expect(imports("earlyChecks.ts")).toContain("podspecs");
    expect(imports("capabilities.ts")).toContain("podspecs");
  });
});

describe("knownLimits.allow", () => {
  it("marks the refusals rn-xtool.config.json allows, by package or install kind", async () => {
    const lib = await project({ [ASYNC_STORAGE]: asyncStorage(), "expo-sqlite": expoSqlite() });
    const libs = libraryFailures(lib);
    expect(allowKnownLimits(libs, [ASYNC_STORAGE]).map((f) => [f.allowKey, f.allowed === true])).toEqual([
      [ASYNC_STORAGE, true],
      ["expo-sqlite", false],
    ]);
    expect(allowKnownLimits(libs, []).some((f) => f.allowed)).toBe(false);

    const pnpm = await project({});
    await writeFiles(pnpm, { "pnpm-lock.yaml": "", "node_modules/.pnpm/lock.yaml": "", ".pnp.cjs": "" });
    const installs = installFailures(pnpm, { stopAt: pnpm });
    expect(installs.map((f) => f.allowKey)).toEqual(["pnpm", "pnp"]);
    expect(allowKnownLimits(installs, ["pnpm"]).map((f) => f.allowed === true)).toEqual([true, false]);
    expect(allowKnownLimits(installs, ["pnp"]).map((f) => f.allowed === true)).toEqual([false, true]);

    const { ws, app } = await workspace({ name: "demo", dependencies: { "react-native": "*" } });
    await writeFiles(ws, { "node_modules/react-native/package.json": JSON.stringify({ name: "react-native" }) });
    const hoisted = installFailures(app, { stopAt: ws });
    expect(allowKnownLimits(hoisted, ["hoisted"])[0]?.allowed).toBe(true);
    // A package name never allows an install-level refusal: react-native is not "hoisted".
    expect(allowKnownLimits(hoisted, ["react-native"])[0]?.allowed).toBeUndefined();
  });

  it("ignores an entry for a package that is not refused", async () => {
    const root = await project({ [ASYNC_STORAGE]: asyncStorage() });
    expect(allowKnownLimits(libraryFailures(root), ["not-installed-lib", "yarn-pnp"])).toEqual([
      { id: "vendored-binaries", allowKey: ASYNC_STORAGE, reason: ASYNC_STORAGE_REASON },
    ]);
  });

  it("names the escape hatch in every refusal", () => {
    const f = { id: "vendored-binaries" as const, allowKey: ASYNC_STORAGE, reason: ASYNC_STORAGE_REASON };
    const hint = `To build anyway, add "${ASYNC_STORAGE}" to knownLimits.allow in rn-xtool.config.json.`;
    expect(knownLimitHint(f)).toBe(hint);
    expect(new UnsupportedSetupError([f]).message).toBe(`${ASYNC_STORAGE_REASON}\n${hint}`);
    const g = { id: "pnpm" as const, allowKey: "pnpm", reason: "installed with pnpm." };
    expect(new UnsupportedSetupError([g, f]).message).toBe(
      "rn-xtool cannot build this project yet:\n" +
        '- installed with pnpm.\n  To build anyway, add "pnpm" to knownLimits.allow in rn-xtool.config.json.\n' +
        `- ${ASYNC_STORAGE_REASON}\n  ${hint}`,
    );
  });
});

describe("unmapped pods", () => {
  const NO_POD_TABLE: PodTable = { pods: {}, source: {} };
  const UNMAPPED_DOCS = `${DOCS}#libraries-that-depend-on-cocoapods-pods`;
  const unmapped = (lib: string, pods: string, first: string, several: boolean) =>
    `${lib}: its podspec depends on the CocoaPods ${several ? "pods" : "pod"} ${pods}, which ${several ? "have" : "has"} no ` +
    `SwiftPM package rn-xtool knows. Add ${several ? "them" : "one"} under "pods" in rn-xtool.config.json: ` +
    `{ "pods": { "${first}": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }, or leave the ` +
    `library out with "exclude". See ${UNMAPPED_DOCS}`;

  /** react-native-app-auth 8.5.1's shape: the pod name comes from package.json, AppAuth is a CocoaPods pod. */
  const appAuth = (): Record<string, string> => ({
    "package.json": JSON.stringify({ name: "react-native-app-auth", version: "8.5.1" }),
    "react-native-app-auth.podspec":
      "require 'json'\npackage = JSON.parse(File.read(File.join(__dir__, 'package.json')))\n\n" +
      "Pod::Spec.new do |s|\n  s.name         = package['name']\n  s.source_files  = 'ios/**/*.{h,m}'\n" +
      "  s.dependency 'React-Core'\n  s.dependency 'AppAuth', '>= 1.7.6'\nend\n",
  });

  /** @react-native-ml-kit/text-recognition 2.0.0's shape: five subspecs of the one pod GoogleMLKit. */
  const mlKit = (): Record<string, string> => ({
    "package.json": JSON.stringify({ name: "@react-native-ml-kit/text-recognition", version: "2.0.0" }),
    "RNMLKitTextRecognition.podspec":
      'Pod::Spec.new do |s|\n  s.name         = "RNMLKitTextRecognition"\n  s.dependency "React"\n' +
      "  # To recognize Latin script\n  s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'\n" +
      ["Chinese", "Devanagari", "Japanese", "Korean"].map((l) => `  s.dependency 'GoogleMLKit/TextRecognition${l}', '8.0.0'\n`).join("") +
      "end\n",
  });

  it("refuses AppAuth's shape without a table entry", async () => {
    const root = await project({ "react-native-app-auth": appAuth() });
    expect(libraryFailures(root, { table: NO_POD_TABLE })).toEqual([
      {
        id: "unmapped-pod",
        allowKey: "react-native-app-auth",
        reason: unmapped("react-native-app-auth 8.5.1", "AppAuth", "AppAuth", false),
      },
    ]);
  });

  it("lets AppAuth through with rn-xtool's table", async () => {
    const root = await project({ "react-native-app-auth": appAuth() });
    expect(libraryFailures(root)).toEqual([]);
    expect(libraryFailures(root, { table: mergedPodTable() })).toEqual([]);
  });

  it("maps a pod the config's pods name", async () => {
    const root = await project({ "react-native-app-auth": appAuth() });
    const pods = { MMKV: { url: "https://github.com/Tencent/MMKV", exact: "2.2.4", products: ["MMKV"] } };
    await writeFiles(path.join(root, "node_modules", "react-native-app-auth"), {
      "react-native-app-auth.podspec": "Pod::Spec.new do |s|\n  s.dependency 'MMKV', '~> 2.0'\nend\n",
    });
    expect(libraryFailures(root).map((f) => f.id)).toEqual(["unmapped-pod"]);
    expect(libraryFailures(root, { pods })).toEqual([]);
  });

  it("refuses ML Kit's shape, naming GoogleMLKit once", async () => {
    const root = await project({ "@react-native-ml-kit/text-recognition": mlKit() });
    expect(libraryFailures(root)).toEqual([
      {
        id: "unmapped-pod",
        allowKey: "@react-native-ml-kit/text-recognition",
        reason: unmapped("@react-native-ml-kit/text-recognition 2.0.0", "GoogleMLKit", "GoogleMLKit", false),
      },
    ]);
  });

  it("names several unmapped pods", async () => {
    const two = await project({
      lib: {
        "Lib.podspec":
          "Pod::Spec.new do |s|\n  s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'\n" +
          '  s.dependency "GoogleToolboxForMac/Logger", "~> 4.2"\n  s.dependency \'GoogleMLKit/Vision\'\nend\n',
      },
    });
    expect(libraryFailures(two).map((f) => f.reason)).toEqual([
      unmapped("lib 1.0.0", "GoogleMLKit and GoogleToolboxForMac", "GoogleMLKit", true),
    ]);
    const three = await project({
      lib: {
        "ios/Lib.podspec": "Pod::Spec.new do |s|\n  s.dependency 'MMKV'\n  s.ios.dependency('Lottie', '~> 4.0')\nend\n",
        "Other.podspec": "Pod::Spec.new do |s|\n  s.dependency 'Firebase/Core'\n  s.dependency 'MMKV'\nend\n",
      },
    });
    expect(libraryFailures(three).map((f) => f.reason)).toEqual([
      unmapped("lib 1.0.0", "Firebase, MMKV and Lottie", "Firebase", true),
    ]);
  });

  it("ignores pods under a Ruby condition (react-native-video's shape)", async () => {
    const root = await project({
      "react-native-video": {
        "package.json": JSON.stringify({ name: "react-native-video", version: "6.19.3" }),
        "react-native-video.podspec":
          "fabric_enabled = ENV['RCT_NEW_ARCH_ENABLED'] == '1'\n\nPod::Spec.new do |s|\n  s.name           = 'react-native-video'\n" +
          '  s.subspec "Video" do |ss|\n    ss.source_files = "ios/Video/**/*.{h,m,swift,mm}"\n' +
          '    if fabric_enabled\n      ss.dependency "react-native-video/Fabric"\n    end\n' +
          '    if defined?($RNVideoUseGoogleIMA)\n      Pod::UI.puts "RNVideo: enable IMA SDK"\n\n' +
          "      ss.ios.dependency 'GoogleAds-IMA-iOS-SDK', '~> 3.22.1'\n      ss.tvos.dependency 'GoogleAds-IMA-tvOS-SDK', '~> 4.2'\n" +
          "    end\n    if defined?($RNVideoUseVideoCaching)\n" +
          '      ss.dependency "SPTPersistentCache", "~> 1.1.0"\n      ss.dependency "DVAssetLoaderDelegate", "~> 0.3.1"\n' +
          "    end\n  end\n\n  if respond_to?(:install_modules_dependencies, true)\n    install_modules_dependencies(s)\n" +
          '  else\n    s.dependency "React-Core"\n    s.dependency "Folly" if fabric_enabled\n  end\n' +
          "  s.tvos.dependency 'TVOnlyPod'\n  s.default_subspec = \"Video\"\nend\n",
      },
    });
    expect(libraryFailures(root, { table: NO_POD_TABLE })).toEqual([]);
  });

  it("does not refuse siblings, core, Expo or subspec dependencies", async () => {
    const root = await project({
      lib: {
        "Self.podspec":
          "Pod::Spec.new do |s|\n  s.name = 'Self'\n  s.dependency 'react-native-missing'\n  s.dependency 'RNWorklets'\n" +
          "  s.dependency 'React-Core'\n  s.dependency 'ExpoModulesCore'\n  s.dependency 'Self/Sub'\n" +
          "  s.dependency 'RNSibling', '>= 1.0'\nend\n",
      },
      "react-native-worklets": { "RNWorklets.podspec": "Pod::Spec.new do |s|\n  s.name = 'RNWorklets'\nend\n" },
      sibling: { "RNSibling.podspec": "Pod::Spec.new do |s|\nend\n" },
    });
    await writeFiles(root, {
      "react-native.config.js": "module.exports = { dependencies: { 'react-native-worklets': { platforms: { ios: null } } } };\n",
    });
    expect(libraryFailures(root, { table: NO_POD_TABLE })).toEqual([]);
  });

  it("knownLimits.allow turns it into a warning", async () => {
    const root = await project({ "@react-native-ml-kit/text-recognition": mlKit() });
    const [failure] = allowKnownLimits(libraryFailures(root), ["@react-native-ml-kit/text-recognition"]);
    expect(failure).toMatchObject({ id: "unmapped-pod", allowed: true });
    expect(allowedLimitText(failure!)).toBe(
      `${unmapped("@react-native-ml-kit/text-recognition 2.0.0", "GoogleMLKit", "GoogleMLKit", false)} ` +
        "(allowed by rn-xtool.config.json knownLimits.allow; the build may fail later)",
    );
  });

  it("skips libraries with their own Package.swift or swiftpmConfig.scaffold false", async () => {
    const cases = [
      await project({ "react-native-app-auth": { ...appAuth(), "Package.swift": "// swift-tools-version: 6.0\n" } }),
      await project({ "react-native-app-auth": { ...appAuth(), "ios/Package.swift": "// swift-tools-version: 6.0\n" } }),
      await project({
        "react-native-app-auth": {
          ...appAuth(),
          "package.json": JSON.stringify({ name: "react-native-app-auth", version: "8.5.1", swiftpmConfig: { scaffold: false } }),
        },
      }),
      await project({
        "expo-thing": {
          "expo-module.config.json": JSON.stringify({ platforms: ["apple"] }),
          "ios/ExpoThing.podspec": "Pod::Spec.new do |s|\n  s.dependency 'AppAuth'\nend\n",
        },
      }),
    ];
    for (const root of cases) expect(libraryFailures(root, { table: NO_POD_TABLE })).toEqual([]);
    const scaffolded = await project({
      "react-native-app-auth": { ...appAuth(), "Package.swift": `${SCAFFOLD_MARKER}\n// swift-tools-version: 6.0\n` },
    });
    expect(libraryFailures(scaffolded, { table: NO_POD_TABLE }).map((f) => f.id)).toEqual(["unmapped-pod"]);
  });

  it("does not refuse a sibling installed as a peer, outside package.json (reanimated 4.3.4 and worklets 0.8.3)", async () => {
    // npm installs react-native-worklets as reanimated's peer; autolinking links it, and the scaffolder wires
    // RNWorklets as a sibling, so the pod name is an installed package's, not a CocoaPods pod.
    const reanimated = {
      "package.json": JSON.stringify({ name: "react-native-reanimated", version: "4.3.4", peerDependencies: { "react-native-worklets": ">=0.8.0" } }),
      "RNReanimated.podspec":
        'Pod::Spec.new do |s|\n  s.name         = "RNReanimated"\n  s.source_files = "apple/**/*.{mm,h,m}"\n' +
        '  s.dependency "RNWorklets"\n  install_modules_dependencies(s)\n  s.dependency \'React-jsi\'\nend\n',
    };
    const root = await project({ "react-native-reanimated": reanimated });
    await writeFiles(path.join(root, "node_modules", "react-native-worklets"), {
      "package.json": JSON.stringify({ name: "react-native-worklets", version: "0.8.3" }),
      "RNWorklets.podspec": 'Pod::Spec.new do |s|\n  s.name         = "RNWorklets"\n  install_modules_dependencies(s)\nend\n',
    });
    expect(libraryFailures(root, { table: NO_POD_TABLE })).toEqual([]);
    // A scoped package's podspec counts too.
    const scoped = await project({
      "react-native-reanimated": { ...reanimated, "RNReanimated.podspec": reanimated["RNReanimated.podspec"].replace("RNWorklets", "ScopedPeer") },
    });
    await writeFiles(path.join(scoped, "node_modules", "@scope", "peer"), {
      "package.json": JSON.stringify({ name: "@scope/peer", version: "1.0.0" }),
      "ios/ScopedPeer.podspec": "Pod::Spec.new do |s|\nend\n",
    });
    expect(libraryFailures(scoped, { table: NO_POD_TABLE })).toEqual([]);
    // Not installed at all: still read as a CocoaPods pod (preflight P9's accepted remainder).
    const missing = await project({ "react-native-reanimated": reanimated });
    expect(libraryFailures(missing, { table: NO_POD_TABLE }).map((f) => f.id)).toEqual(["unmapped-pod"]);
  });

  it("leaves out the pods of a subspec the scaffolder drops for a missing sibling", async () => {
    // vision-camera 4.7.3's shape: FrameProcessors depends on react-native-worklets-core, which is not installed, so the
    // scaffolder drops the subspec with its dependencies (fix 20); its pods are neither pinned nor refused.
    const camera = (subspecPods: string) => ({
      "package.json": JSON.stringify({ name: "react-native-vision-camera", version: "4.7.3" }),
      "VisionCamera.podspec":
        'Pod::Spec.new do |s|\n  s.name = "VisionCamera"\n  s.dependency "React-Core"\n' +
        '  s.subspec \'Core\' do |core|\n    core.source_files = "ios/Core/**/*.{h,m,swift}"\n  end\n' +
        `  s.subspec 'FrameProcessors' do |fp|\n    fp.dependency "react-native-worklets-core"\n${subspecPods}  end\nend\n`,
    });
    const dropped = await project({ "react-native-vision-camera": camera("    fp.dependency 'MMKV', '~> 2.0'\n") });
    expect(libraryFailures(dropped, { table: NO_POD_TABLE })).toEqual([]);
    const mapped = await project({ "react-native-vision-camera": camera("    fp.dependency 'AppAuth', '>= 1.7.6'\n") });
    expect(scaffoldedPods(mapped, mergedPodTable())).toEqual(new Map());
    expect(podPinWarnings(mapped, mergedPodTable({ AppAuth: { url: "https://github.com/openid/AppAuth-iOS", exact: "1.0.0", products: ["AppAuth"] } }))).toEqual([]);
    // A subspec without a missing sibling is kept: its pods count.
    const kept = await project({
      "react-native-vision-camera": {
        ...camera(""),
        "VisionCamera.podspec": camera("")["VisionCamera.podspec"].replace(
          "  s.subspec 'Core' do |core|\n",
          "  s.subspec 'Core' do |core|\n    core.dependency 'AppAuth'\n    core.dependency 'MMKV'\n",
        ),
      },
    });
    expect(scaffoldedPods(kept, mergedPodTable())).toEqual(new Map([["react-native-vision-camera", ["AppAuth"]]]));
    expect(libraryFailures(kept, { table: NO_POD_TABLE }).map((f) => f.reason)).toEqual([
      expect.stringContaining("depends on the CocoaPods pods AppAuth and MMKV"),
    ]);
  });

  it("skips the packages the config leaves out", async () => {
    const root = await project({ "react-native-app-auth": appAuth(), "@react-native-ml-kit/text-recognition": mlKit() });
    expect(libraryFailures(root, { table: NO_POD_TABLE, exclude: ["react-native-app-auth"] }).map((f) => f.allowKey)).toEqual([
      "@react-native-ml-kit/text-recognition",
    ]);
  });

  it("names the binaries and the unmapped pods of one library", async () => {
    const root = await project({
      [ASYNC_STORAGE]: asyncStorage({
        "Extra.podspec": "Pod::Spec.new do |s|\n  s.dependency 'MMKV'\nend\n",
      }),
    });
    expect(libraryFailures(root, { table: NO_POD_TABLE }).map((f) => f.id)).toEqual(["vendored-binaries", "unmapped-pod"]);
  });

  it("loads only rn-xtool's vendored scaffolder", async () => {
    const root = await project({ "react-native-app-auth": appAuth() });
    await writeFiles(root, { "node_modules/react-native/scripts/spm/scaffold-package-swift.js": "throw new Error('project code');\n" });
    const req = createRequire(import.meta.url);
    for (const key of Object.keys(req.cache)) if (key.includes(`${path.sep}vendor${path.sep}`)) delete req.cache[key];
    const loader = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
    const seen: string[] = [];
    const real = loader._load;
    const spy = vi.spyOn(loader, "_load").mockImplementation(function (this: unknown, request, parent, isMain) {
      seen.push(request, parent?.filename ?? "");
      return real.call(this, request, parent, isMain);
    });
    try {
      expect(libraryFailures(root, { table: NO_POD_TABLE }).map((f) => f.id)).toEqual(["unmapped-pod"]);
    } finally {
      spy.mockRestore();
    }
    expect(seen.some((s) => s.endsWith(path.join("vendor", "rn-spm", "spm", "scaffold-package-swift.js")))).toBe(true);
    expect(seen.filter((s) => s.startsWith(root))).toEqual([]);
  });

  it("reads each dependency's name and requirements from the given lines", () => {
    expect(
      podDependencies([
        "  s.dependency 'AppAuth', '>= 1.7.6'",
        '  ss.ios.dependency "GoogleMLKit/TextRecognition", " ~> 8.0", "< 9 " # note',
        "  s.dependency('Lottie', ['>= 4.0', '  < 5.0'])",
        "  s.dependency 'React-Core'",
        "  s.tvos.dependency 'TVOnly'",
        "  # s.dependency 'Commented'",
        "  s.dependency \"#{prefix}Pod\"",
        "  s.dependency 'Folly', folly_version",
        "  dependency_list = 'not one'",
      ]),
    ).toEqual([
      { name: "AppAuth", requirements: [">= 1.7.6"] },
      { name: "GoogleMLKit/TextRecognition", requirements: ["~> 8.0", "< 9"] },
      { name: "Lottie", requirements: [">= 4.0", "< 5.0"] },
      { name: "React-Core", requirements: [] },
      { name: "Folly", requirements: [] },
    ]);
  });
});

describe("exclude lines", () => {
  const LEAVING = `${DOCS}#leaving-a-module-out`;
  const camera = {
    "package.json": JSON.stringify({ name: "react-native-vision-camera", version: "4.7.3" }),
    "VisionCamera.podspec": "Pod::Spec.new do |s|\n  s.name = 'VisionCamera'\nend\n",
  };
  const netinfoIos = {
    "package.json": JSON.stringify({ name: "@react-native-community/netinfo", version: "11.5.2" }),
    "ios/Package.swift": "// swift-tools-version: 6.0\n",
  };

  it("prints the ℹ line for an excluded native dependency", async () => {
    const root = await project({ "react-native-vision-camera": camera, "@react-native-community/netinfo": netinfoIos });
    expect(excludeLines(root, ["react-native-vision-camera"])).toEqual([
      "ℹ exclude — left out of this iOS build: react-native-vision-camera (rn-xtool.config.json). JavaScript that uses " +
        `it must check that it is there; see ${LEAVING}`,
    ]);
    expect(excludeLines(root, ["react-native-vision-camera", "@react-native-community/netinfo", "react-native-vision-camera"])).toEqual([
      "ℹ exclude — left out of this iOS build: react-native-vision-camera, @react-native-community/netinfo " +
        `(rn-xtool.config.json). JavaScript that uses it must check that it is there; see ${LEAVING}`,
    ]);
    expect(excludeLines(root, [])).toEqual([]);
  });

  it("warns about a name that is not a native iOS dependency", async () => {
    const root = await project({
      "react-native-vision-camera": camera,
      lodash: { "index.js": "module.exports = {};\n" },
    });
    // Misspelt, JavaScript only, and installed but not listed in the project's dependencies.
    await writeFiles(root, { "node_modules/react-native-other/Other.podspec": "Pod::Spec.new do |s|\nend\n" });
    expect(excludeLines(root, ["react-native-vision-camra", "lodash", "react-native-other", "react-native-vision-camera"])).toEqual([
      "ℹ exclude — left out of this iOS build: react-native-vision-camera (rn-xtool.config.json). JavaScript that uses " +
        `it must check that it is there; see ${LEAVING}`,
      "⚠ exclude names react-native-vision-camra, which is not a native iOS dependency of this project; ignored",
      "⚠ exclude names lodash, which is not a native iOS dependency of this project; ignored",
      "⚠ exclude names react-native-other, which is not a native iOS dependency of this project; ignored",
    ]);
  });

  it("warns that an Expo module needs expo.autolinking.exclude", async () => {
    const root = await project({ "expo-sqlite": expoSqlite() });
    expect(excludeLines(root, ["expo-sqlite"])).toEqual([
      "⚠ exclude names expo-sqlite, an Expo module: Expo's autolinking links it anyway; list it in " +
        "expo.autolinking.exclude in package.json to leave it out",
    ]);
  });

  it("an excluded library is not refused", async () => {
    const root = await project({
      [ASYNC_STORAGE]: asyncStorage(),
      "react-native-mmkv-lib": { "MmkvLib.podspec": "Pod::Spec.new do |s|\n  s.dependency 'MMKV'\nend\n" },
    });
    expect(libraryFailures(root).map((f) => f.id)).toEqual(["vendored-binaries", "unmapped-pod"]);
    expect(libraryFailures(root, { exclude: [ASYNC_STORAGE, "react-native-mmkv-lib"] })).toEqual([]);
    expect(earlyFailures(root, { exclude: [ASYNC_STORAGE, "react-native-mmkv-lib"] })).toEqual([]);
  });
});
