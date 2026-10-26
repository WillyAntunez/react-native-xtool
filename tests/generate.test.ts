import { mkdtemp, rm, mkdir, cp, readFile, readdir, lstat, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderPackageSwift } from "../src/generate/packageSwift.js";
import { renderXtoolYml } from "../src/generate/xtoolYml.js";
import { writeIosXtool } from "../src/generate/iosXtool.js";
import { expoClangImporterInputs, type ClangImporterInputs } from "../src/generate/expoImporter.js";
import { projectPaths, swiftHeadersDir } from "../src/paths.js";
import { openPbxproj, readTargetContent } from "../src/project/pbxproj.js";
import type { ProjectInfo } from "../src/project/index.js";
import type { RuntimeFramework } from "../src/frameworks.js";

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const fw = (name: string, searchPath: string): RuntimeFramework => ({
  id: name,
  name,
  executable: `${searchPath}/${name}.framework/${name}`,
  searchPath,
  frameworkDir: `${searchPath}/${name}.framework`,
});
const frameworks = [fw("React", "/a/b"), fw("hermesvm", "/a/b"), fw("ExpoFont", "/c/d")];

const noApp = { mixed: false, defines: [], headerSearchPaths: [], swiftHeadersDir: "/h" };
const expoInputs = (o: { clangImporter?: ClangImporterInputs } = {}) => ({
  compileInterfacesDir: "/p/ci",
  jsiHeaders: true,
  ...o,
});

describe("renderPackageSwift", () => {
  const { manifest: out, manifest65 } = renderPackageSwift({
    iosDir: "/p/ios",
    frameworks,
    iosMin: "16.4",
    expo: expoInputs(),
    app: noApp,
  });
  it("links frameworks and one -F per unique searchPath", () => {
    expect(out).toContain('.linkedFramework("hermesvm")');
    expect(out.match(/"-F", "\/a\/b"/g)).toHaveLength(1);
    expect(out.match(/"-F", "\/c\/d"/g)).toHaveLength(1);
    expect(out).toContain('.unsafeFlags(["-F", "/p/ci"])');
    expect(manifest65).toBeUndefined();
  });
  it("sets language modes, platform and dependencies", () => {
    expect(out).toContain("swiftLanguageModes: [.v5]");
    expect(out).toContain("cxxLanguageStandard: .cxx20");
    expect(out).toContain('platforms: [.iOS("16.4")]');
    expect(out).toContain('.package(name: "ReactNative", path: "/p/ios/build/xcframeworks")');
  });
  it("defines Expo's configuration conditions, which gate debug-only modules in ExpoModulesProvider", () => {
    expect(out).toContain('.define("EXPO_CONFIGURATION_DEBUG", .when(configuration: .debug))');
    expect(out).toContain('.define("EXPO_CONFIGURATION_RELEASE", .when(configuration: .release))');
  });
  it("passes the Expo clang importer inputs to the app's Swift compiler when given", () => {
    const o = renderPackageSwift({
      iosDir: "/p/ios",
      frameworks: [],
      iosMin: "16.4",
      expo: expoInputs({
        clangImporter: { swiftHeadersDir: "/h", includeDirs: ["/e/A/pod-headers"], moduleMaps: ["/h/A.modulemap"] },
      }),
      app: noApp,
    }).manifest;
    expect(o).toContain('.unsafeFlags(["-Xcc", "-I/h", "-Xcc", "-I/e/A/pod-headers", "-Xcc", "-fmodule-map-file=/h/A.modulemap"])');
    expect(out).not.toContain('"-Xcc"');
  });
  it("escapes quotes and backslashes", () => {
    const o = renderPackageSwift({ iosDir: '/p"x\\y', frameworks: [], iosMin: "16.4", expo: expoInputs(), app: noApp });
    expect(o.manifest).toContain('/p\\"x\\\\y/build/xcframeworks');
  });

  it("keeps the Expo manifest unchanged", async () => {
    // tests/fixtures/expo-Package.swift is the renderer's output before bare support existed.
    const snapshot = await readFile(new URL("./fixtures/expo-Package.swift", import.meta.url), "utf8");
    const o = renderPackageSwift({
      iosDir: "/p/ios",
      frameworks,
      iosMin: "16.4",
      expo: expoInputs({
        clangImporter: { swiftHeadersDir: "/h", includeDirs: ["/e/A/pod-headers"], moduleMaps: ["/h/A.modulemap"] },
      }),
      app: noApp,
    });
    expect(o.manifest).toBe(snapshot);
    expect(o.manifest65).toBeUndefined();
  });

  it("renders the Swift-only bare manifest", () => {
    const o = renderPackageSwift({
      iosDir: "/p/ios",
      frameworks,
      iosMin: "16.4",
      app: { ...noApp, defines: ["DEBUG=1"] },
    });
    expect(o.manifest.split("\n")[0]).toBe("// swift-tools-version: 6.0");
    expect(o.manifest65).toBeUndefined();
    expect(o.manifest).not.toContain("ExpoModulesJSIHeaders");
    expect(o.manifest).not.toContain("EXPO_CONFIGURATION");
    expect(o.manifest).not.toContain("compile-interfaces");
    expect(o.manifest).not.toContain("/p/ci");
    expect(o.manifest).not.toContain("cSettings");
    expect(o.manifest).not.toContain("resources:");
    expect(o.manifest).toContain('.package(name: "Autolinked", path: "/p/ios/build/generated/autolinking")');
    expect(o.manifest).toContain('.define("DEBUG", .when(configuration: .debug))');
    expect(o.manifest).toContain('.linkedFramework("React")');
  });

  describe("mixed App target", () => {
    const mixed = renderPackageSwift({
      iosDir: "/p/ios",
      frameworks,
      iosMin: "16.4",
      app: {
        mixed: true,
        bridgingHeader: "/x/Sources/App/HelloWorld-Bridging-Header.h",
        defines: ["DEBUG=1", "FOO=1", 'VERSION="1.0"', "BARE"],
        headerSearchPaths: ["/x/Sources/App/include", "/p/ios/Vendor/include"],
        cxxStandard: "gnu++20",
        swiftHeadersDir: "/x/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos",
      },
    });

    it("renders the mixed manifest pair", () => {
      const { manifest, manifest65 } = mixed;
      expect(manifest.split("\n")[0]).toBe("// swift-tools-version: 6.4;(experimentalMultiLang)");
      expect(manifest).toContain('"-import-objc-header", "/x/Sources/App/HelloWorld-Bridging-Header.h"');
      expect(manifest).toContain('.define("FOO", to: "1")');
      expect(manifest).toContain('.define("VERSION", to: "\\"1.0\\"")');
      expect(manifest).toContain('.define("BARE")');
      expect(manifest).toContain('"-I", "/p/ios/Vendor/include"');
      expect(manifest).toContain('"-I", "/x/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos"');
      // App resources reach the bundle root through xtool.yml, not SwiftPM.
      expect(manifest).not.toContain("resources:");
      expect(manifest).toContain("cxxLanguageStandard: .gnucxx20");
      // Swift requires the target's arguments in declaration order.
      const order = ["path:", "cSettings:", "cxxSettings:", "swiftSettings:", "linkerSettings:"].map((k) => manifest.indexOf(k));
      expect(order.every((at, n) => at > -1 && (n === 0 || at > order[n - 1]!))).toBe(true);
      expect(manifest).not.toContain("ExpoModulesJSIHeaders");
      expect(manifest65).toBeDefined();
      const [first65, ...rest65] = manifest65!.split("\n");
      expect(first65).toBe("// swift-tools-version: 6.5");
      expect(manifest65).not.toContain("experimentalMultiLang");
      expect(rest65.join("\n")).toBe(manifest.split("\n").slice(1).join("\n"));
    });

    it("gives C and C++ the same defines and include paths", () => {
      const section = (name: string) => {
        const start = mixed.manifest.indexOf(`${name}: [`);
        expect(start).toBeGreaterThan(-1);
        return mixed.manifest.slice(start + name.length, mixed.manifest.indexOf("            ],", start));
      };
      expect(section("cSettings")).toBe(section("cxxSettings"));
      expect(section("cSettings")).toContain('.define("DEBUG", to: "1")');
      expect(section("cSettings")).toContain('"-I", "/x/Sources/App/include"');
    });

    it("lets the bridging header see the target's include paths and defines", () => {
      const swift = mixed.manifest.slice(mixed.manifest.indexOf("swiftSettings: ["), mixed.manifest.indexOf("linkerSettings: ["));
      expect(swift).toContain('"-Xcc", "-I/p/ios/Vendor/include"');
      expect(swift).toContain('"-Xcc", "-DFOO=1"');
      expect(swift).not.toContain('to: "1"');
    });

    it("maps the C++ standard and falls back to C++20", () => {
      const std = (cxxStandard?: string) =>
        renderPackageSwift({ iosDir: "/p/ios", frameworks: [], iosMin: "16.4", app: { ...noApp, mixed: true, cxxStandard } })
          .manifest.match(/cxxLanguageStandard: (\S+)/)![1];
      expect(std("c++17")).toBe(".cxx17");
      expect(std("gnu++14")).toBe(".gnucxx14");
      expect(std("c++0x")).toBe(".cxx11");
      expect(std("compiler-default")).toBe(".cxx20");
      expect(std(undefined)).toBe(".cxx20");
    });
  });
});

describe("renderXtoolYml", () => {
  it("renders defaults", () => {
    const y = renderXtoolYml({ bundleIdentifier: "com.example.app" });
    expect(y).toContain("bundleID: com.example.app");
    for (const r of ["Frameworks", "ip.txt", "EXConstants.bundle"]) expect(y).toContain(`  - ${r}`);
  });
  it("honours explicit resources", () => {
    const y = renderXtoolYml({ bundleIdentifier: "a.b", resources: ["X"] });
    expect(y).toContain("  - X");
    expect(y).not.toContain("ip.txt");
  });
});

describe("writeIosXtool", () => {
  it("writes the package and is idempotent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "xt7-"));
    tmps.push(tmp);
    const target = join(tmp, "ios", "app");
    await mkdir(target, { recursive: true });
    await cp(new URL("./fixtures/ios-target", import.meta.url).pathname, target, { recursive: true });
    const paths = projectPaths(tmp);
    const project: ProjectInfo = {
      kind: "expo", root: tmp, name: "app", slug: "app", version: "1.0.0", buildNumber: "1",
      bundleIdentifier: "com.example.app", moduleName: "main", sdkVersion: 58, rnVersion: "0.88.0",
      iosTargetName: "app", iosTargetDir: target, infoPlistPath: join(target, "Info.plist"),
      hasExpoModules: true, hasExpoConstants: true, hasDevClient: false,
    };
    const ctx = { project, paths, frameworks, metroPort: 8081, lanIp: "192.168.1.5" };
    await writeIosXtool(ctx);
    await writeFile(join(paths.iosXtool, "Package@swift-6.5.swift"), "// stale\n");
    await writeIosXtool(ctx);

    expect((await readdir(paths.iosXtool)).sort()).toEqual(
      [".gitignore", "Info.plist", "Package.swift", "Sources", "ip.txt", "xtool.yml"],
    );
    expect((await readdir(paths.sources)).sort()).toEqual(
      ["AppDelegate.swift", "ExpoModulesProvider.swift", "SceneDelegate.swift"],
    );
    const link = join(paths.sources, "ExpoModulesProvider.swift");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).not.toMatch(/^\//);
    expect(await readFile(join(paths.iosXtool, "Info.plist"), "utf8")).toContain("App.SceneDelegate");
    expect(await readFile(join(paths.iosXtool, "ip.txt"), "utf8")).toBe("192.168.1.5\n");
    expect(await readFile(join(paths.iosXtool, ".gitignore"), "utf8")).toBe("*\n");
    const pkg = await readFile(join(paths.iosXtool, "Package.swift"), "utf8");
    expect(pkg.match(/"-F"/g)).toHaveLength(3); // compile-interfaces + 2 unique searchPaths
    expect(pkg).toContain("ExpoModulesJSIHeaders");
    expect(await readFile(join(paths.iosXtool, "xtool.yml"), "utf8")).toContain("  - EXConstants.bundle");
  });

  /** A bare project laid out like the with-objc pbxproj fixture, with every listed file on disk. */
  async function bareProject(o: { pbxproj?: (src: string) => string } = {}) {
    const root = await mkdtemp(join(tmpdir(), "xt7-bare-"));
    tmps.push(root);
    const ios = join(root, "ios");
    const app = join(ios, "HelloWorld");
    await mkdir(join(ios, "HelloWorld.xcodeproj"), { recursive: true });
    const pbxSrc = await readFile(new URL("./fixtures/pbxproj/with-objc.pbxproj", import.meta.url), "utf8");
    await writeFile(join(ios, "HelloWorld.xcodeproj", "project.pbxproj"), (o.pbxproj ?? ((x) => x))(pbxSrc));
    const files: Record<string, string> = {
      "AppDelegate.swift": "// app delegate\n",
      "SceneDelegate.swift": "// scene delegate\n",
      "Native/NativeModule.m": '#import "NativeModule.h"\n#import "App-Swift.h"\n',
      "Native/NativeModule.h": "@interface NativeModule : NSObject\n@end\n",
      "HelloWorld-Bridging-Header.h": '#import "NativeModule.h"\n',
      "Fonts/Inter.ttf": "font",
      "PrivacyInfo.xcprivacy": "<plist/>",
      "Base.lproj/Localizable.strings": '"hi" = "hi";\n',
      "es.lproj/Localizable.strings": '"hi" = "hola";\n',
      "Base.lproj/Intro.storyboard": "<document/>",
      "LaunchScreen.storyboard": "<document/>",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(app, rel, ".."), { recursive: true });
      await writeFile(join(app, rel), text);
    }
    await cp(new URL("./fixtures/bare/ios/HelloWorld/Info.plist", import.meta.url).pathname, join(app, "Info.plist"));
    const project: ProjectInfo = {
      kind: "bare", root, name: "HelloWorld", slug: "HelloWorld", version: "1.0", buildNumber: "1",
      bundleIdentifier: "org.reactjs.native.example.HelloWorld", moduleName: "HelloWorld", rnVersion: "0.88.0",
      iosTargetName: "HelloWorld", iosTargetDir: app, infoPlistPath: join(app, "Info.plist"),
      hasExpoModules: false, hasExpoConstants: false, hasDevClient: false,
      bare: readTargetContent(openPbxproj(ios), ios),
    };
    const logs: string[] = [];
    const paths = projectPaths(root);
    const ctx = { project, paths, frameworks, metroPort: 8081, lanIp: "192.168.1.5", log: (s: string) => logs.push(s) };
    return { root, app, paths, project, ctx, logs };
  }

  it("writeIosXtool copies bare sources and resources", async () => {
    const { paths, ctx, logs } = await bareProject();
    await mkdir(paths.sources, { recursive: true });
    await writeFile(join(paths.sources, "Removed.swift"), "// no longer in the target\n");
    const staged = join(paths.iosXtool, "Resources");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "Removed.ttf"), "stale");
    await writeIosXtool(ctx);
    await writeIosXtool(ctx);

    const at = (rel: string) => readFile(join(paths.sources, rel), "utf8");
    expect(await at("AppDelegate.swift")).toBe("// app delegate\n");
    expect(await at("SceneDelegate.swift")).toBe("// scene delegate\n");
    expect(await at("Native/NativeModule.m")).toContain('#import "App-Swift.h"');
    expect(await at("Native/NativeModule.h")).toContain("@interface NativeModule");
    expect(await at("HelloWorld-Bridging-Header.h")).toBe('#import "NativeModule.h"\n');
    // include/ forwards to the copy, so `#import "NativeModule.h"` resolves from anywhere to one file.
    expect(await at("include/NativeModule.h")).toBe('#import "../Native/NativeModule.h"\n');
    expect((await readdir(paths.sources)).sort()).toEqual(
      ["AppDelegate.swift", "HelloWorld-Bridging-Header.h", "Native", "SceneDelegate.swift", "include"],
    );
    // Resources are staged flat, as Xcode copies them to the bundle root; .lproj dirs are kept.
    const res = (rel: string) => readFile(join(staged, rel), "utf8");
    expect(await res("Inter.ttf")).toBe("font");
    expect(await res("PrivacyInfo.xcprivacy")).toBe("<plist/>");
    expect(await res("Base.lproj/Localizable.strings")).toContain('"hi"');
    expect(await res("es.lproj/Localizable.strings")).toContain("hola");
    expect((await readdir(staged)).sort()).toEqual(["Base.lproj", "Inter.ttf", "PrivacyInfo.xcprivacy", "es.lproj"]);

    const pkg = await readFile(join(paths.iosXtool, "Package.swift"), "utf8");
    const pkg65 = await readFile(join(paths.iosXtool, "Package@swift-6.5.swift"), "utf8");
    expect(pkg.split("\n")[0]).toBe("// swift-tools-version: 6.4;(experimentalMultiLang)");
    expect(pkg65.split("\n")[0]).toBe("// swift-tools-version: 6.5");
    expect(pkg).toContain(`"-import-objc-header", "${join(paths.sources, "HelloWorld-Bridging-Header.h")}"`);
    expect(pkg).toContain(`"-I", "${join(paths.sources, "include")}"`);
    expect(pkg).toContain(`"-I", "${join(paths.ios, "Vendor/include")}"`);
    expect(pkg).toContain(`"-I", "${swiftHeadersDir(paths.iosXtool)}"`);
    expect(pkg).toContain('.define("FOO", to: "1")');
    expect(pkg).not.toContain("resources:");
    expect(pkg).not.toContain("ExpoModulesJSIHeaders");
    expect(pkg).not.toContain("compile-interfaces");

    const yml = await readFile(join(paths.iosXtool, "xtool.yml"), "utf8");
    expect(yml).toContain(
      "resources:\n  - Frameworks\n  - ip.txt\n  - Resources/Base.lproj\n  - Resources/Inter.ttf\n" +
        "  - Resources/PrivacyInfo.xcprivacy\n  - Resources/es.lproj\n",
    );
    expect(yml).not.toContain("EXConstants.bundle");
    expect(yml).toContain("bundleID: org.reactjs.native.example.HelloWorld");
    const info = await readFile(join(paths.iosXtool, "Info.plist"), "utf8");
    expect(info).toContain("App.SceneDelegate");
    expect(info).toContain("Hello App Display Name");

    const skipped = logs.filter((l) => l.includes("LaunchScreen.storyboard"));
    expect(skipped).toHaveLength(2); // one line per run
    expect(skipped[0]).toContain("HelloWorld/Images.xcassets");
    expect(skipped[0]).toContain("HelloWorld/Base.lproj/Intro.storyboard");
    expect(logs.filter((l) => l.includes("OTHER_CFLAGS"))).toHaveLength(2);
    expect(logs).toHaveLength(4);
  });

  it("writes a Swift-only bare target with the 6.0 manifest and drops a stale 6.5 one", async () => {
    // The pristine template: Swift sources only, no bridging header, no resources.
    const root = await mkdtemp(join(tmpdir(), "xt7-tpl-"));
    tmps.push(root);
    const ios = join(root, "ios");
    await cp(new URL("./fixtures/bare/ios", import.meta.url).pathname, ios, { recursive: true });
    const app = join(ios, "HelloWorld");
    const paths = projectPaths(root);
    await mkdir(paths.iosXtool, { recursive: true });
    await writeFile(join(paths.iosXtool, "Package@swift-6.5.swift"), "// stale\n");
    const logs: string[] = [];
    await writeIosXtool({
      project: {
        kind: "bare", root, name: "HelloWorld", slug: "HelloWorld", version: "1.0", buildNumber: "1",
        bundleIdentifier: "org.reactjs.native.example.HelloWorld", moduleName: "HelloWorld", rnVersion: "0.88.0",
        iosTargetName: "HelloWorld", iosTargetDir: app, infoPlistPath: join(app, "Info.plist"),
        hasExpoModules: false, hasExpoConstants: false, hasDevClient: false,
        bare: readTargetContent(openPbxproj(ios), ios),
      },
      paths, frameworks, metroPort: 8081, lanIp: "192.168.1.5", log: (s: string) => logs.push(s),
    });
    expect((await readdir(paths.sources)).sort()).toEqual(["AppDelegate.swift", "SceneDelegate.swift"]);
    expect((await readdir(paths.iosXtool)).sort()).toEqual(
      [".gitignore", "Info.plist", "Package.swift", "Sources", "ip.txt", "xtool.yml"],
    );
    const pkg = await readFile(join(paths.iosXtool, "Package.swift"), "utf8");
    expect(pkg.split("\n")[0]).toBe("// swift-tools-version: 6.0");
    expect(pkg).not.toContain("resources:");
    expect(pkg).not.toContain("-import-objc-header");
    expect(logs).toEqual([expect.stringContaining("LaunchScreen.storyboard")]);
  });

  it("links ExpoModulesProvider and the Expo inputs for a bare project with Expo modules", async () => {
    const { paths, ctx } = await bareProject();
    ctx.project.hasExpoModules = true;
    ctx.project.hasExpoConstants = true;
    await writeIosXtool(ctx);
    expect((await lstat(join(paths.sources, "ExpoModulesProvider.swift"))).isSymbolicLink()).toBe(true);
    const pkg = await readFile(join(paths.iosXtool, "Package.swift"), "utf8");
    expect(pkg).toContain("ExpoModulesJSIHeaders");
    expect(pkg).toContain(`"-F", "${join(paths.expoDir, "compile-interfaces")}"`);
    expect(await readFile(join(paths.iosXtool, "xtool.yml"), "utf8")).toContain("  - EXConstants.bundle");
  });

  it("refuses an app target file outside ios/", async () => {
    const { paths, ctx } = await bareProject();
    ctx.project.bare!.swiftSources.push({ absPath: "/opt/shared/Abs.swift", relPath: "../../opt/shared/Abs.swift" });
    await expect(writeIosXtool(ctx)).rejects.toThrow(/\/opt\/shared\/Abs\.swift.*outside/);
    await expect(readFile(join(paths.iosXtool, "Package.swift"), "utf8")).rejects.toThrow();
  });

  it("refuses a header that would land among the include/ forwards", async () => {
    const { app, ctx } = await bareProject();
    await mkdir(join(app, "include"), { recursive: true });
    await writeFile(join(app, "include", "Api.h"), "");
    ctx.project.bare!.headers.push({ absPath: join(app, "include", "Api.h"), relPath: "HelloWorld/include/Api.h" });
    await expect(writeIosXtool(ctx)).rejects.toThrow(/HelloWorld\/include\/Api\.h/);
  });

  it("keeps .bundle folders and files inside a .bundle together", async () => {
    const { app, paths, ctx } = await bareProject();
    await mkdir(join(app, "Assets", "Maps.bundle", "tiles"), { recursive: true });
    await writeFile(join(app, "Assets", "Maps.bundle", "tiles", "a.png"), "png");
    await mkdir(join(app, "Vendor.bundle"), { recursive: true });
    await writeFile(join(app, "Vendor.bundle", "logo.png"), "logo");
    ctx.project.bare!.resources.push(
      { absPath: join(app, "Assets", "Maps.bundle"), relPath: "HelloWorld/Assets/Maps.bundle" },
      { absPath: join(app, "Vendor.bundle", "logo.png"), relPath: "HelloWorld/Vendor.bundle/logo.png" },
    );
    await writeIosXtool(ctx);
    const staged = join(paths.iosXtool, "Resources");
    expect(await readFile(join(staged, "Maps.bundle", "tiles", "a.png"), "utf8")).toBe("png");
    expect(await readFile(join(staged, "Vendor.bundle", "logo.png"), "utf8")).toBe("logo");
    const yml = await readFile(join(paths.iosXtool, "xtool.yml"), "utf8");
    expect(yml).toContain("  - Resources/Maps.bundle\n");
    expect(yml).toContain("  - Resources/Vendor.bundle\n");
  });

  it("refuses two resources that flatten to one name, naming both", async () => {
    const { app, ctx } = await bareProject();
    await mkdir(join(app, "Other"), { recursive: true });
    await writeFile(join(app, "Other", "Inter.ttf"), "other");
    ctx.project.bare!.resources.push({ absPath: join(app, "Other", "Inter.ttf"), relPath: "HelloWorld/Other/Inter.ttf" });
    const err = await writeIosXtool(ctx).catch((e: unknown) => e);
    expect(String(err)).toContain("HelloWorld/Fonts/Inter.ttf");
    expect(String(err)).toContain("HelloWorld/Other/Inter.ttf");
  });

  it("stages no resources for an Expo project and clears stale ones", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "xt7-"));
    tmps.push(tmp);
    const target = join(tmp, "ios", "app");
    await mkdir(target, { recursive: true });
    await cp(new URL("./fixtures/ios-target", import.meta.url).pathname, target, { recursive: true });
    const paths = projectPaths(tmp);
    await mkdir(join(paths.iosXtool, "Resources"), { recursive: true });
    await writeFile(join(paths.iosXtool, "Resources", "Old.ttf"), "stale");
    await writeIosXtool({
      project: {
        kind: "expo", root: tmp, name: "app", slug: "app", version: "1.0.0", buildNumber: "1",
        bundleIdentifier: "com.example.app", moduleName: "main", sdkVersion: 58, rnVersion: "0.88.0",
        iosTargetName: "app", iosTargetDir: target, infoPlistPath: join(target, "Info.plist"),
        hasExpoModules: true, hasExpoConstants: true, hasDevClient: false,
      },
      paths, frameworks, metroPort: 8081, lanIp: "192.168.1.5",
    });
    expect(await readdir(paths.iosXtool)).not.toContain("Resources");
    expect(await readFile(join(paths.iosXtool, "xtool.yml"), "utf8")).not.toContain("Resources/");
  });

  it("bakes the Metro port into ip.txt for bare apps only", async () => {
    // Bare RN reads only the packager host from ip.txt and takes the port from RCT_METRO_PORT (8081 in
    // the prebuilt React framework) unless the host carries one; Expo's dev launcher reads RCTMetroPort.
    const bare = await bareProject();
    await writeIosXtool({ ...bare.ctx, lanIp: "192.168.1.100", metroPort: 8082 });
    expect(await readFile(join(bare.paths.iosXtool, "ip.txt"), "utf8")).toBe("192.168.1.100:8082\n");

    const tmp = await mkdtemp(join(tmpdir(), "xt7-"));
    tmps.push(tmp);
    const target = join(tmp, "ios", "app");
    await mkdir(target, { recursive: true });
    await cp(new URL("./fixtures/ios-target", import.meta.url).pathname, target, { recursive: true });
    const paths = projectPaths(tmp);
    await writeIosXtool({
      project: {
        kind: "expo", root: tmp, name: "app", slug: "app", version: "1.0.0", buildNumber: "1",
        bundleIdentifier: "com.example.app", moduleName: "main", sdkVersion: 58, rnVersion: "0.88.0",
        iosTargetName: "app", iosTargetDir: target, infoPlistPath: join(target, "Info.plist"),
        hasExpoModules: true, hasExpoConstants: true, hasDevClient: false,
      },
      paths, frameworks, metroPort: 8082, lanIp: "192.168.1.100",
    });
    expect(await readFile(join(paths.iosXtool, "ip.txt"), "utf8")).toBe("192.168.1.100\n");
  });

  it("names a file the app target lists but the disk lacks", async () => {
    const { app, ctx } = await bareProject();
    await rm(join(app, "Fonts", "Inter.ttf"));
    await expect(writeIosXtool(ctx)).rejects.toThrow(/HelloWorld\/Fonts\/Inter\.ttf/);
  });
});

describe("expoClangImporterInputs", () => {
  async function autolinking(pkgs: Record<string, string[]>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "xt-imp-"));
    tmps.push(dir);
    const decls: string[] = [];
    for (const [name, files] of Object.entries(pkgs)) {
      const pkg = join(dir, "expo", "expo-source", name);
      for (const f of files) {
        await mkdir(join(pkg, f, ".."), { recursive: true });
        await writeFile(join(pkg, f), "");
      }
      await mkdir(pkg, { recursive: true });
      decls.push(`        .package(name: "${name}", path: "${pkg}"),`);
    }
    // A stale package directory the manifest no longer references.
    await mkdir(join(dir, "expo", "expo-source", "Gone", "pod-headers", "Gone"), { recursive: true });
    await writeFile(join(dir, "expo", "expo-source", "Gone", "pod-headers", "Gone", "Gone-umbrella.h"), "");
    await writeFile(join(dir, "Package.swift"), `let package = Package(dependencies: [\n${decls.join("\n")}\n])\n`);
    return dir;
  }

  it("lists pod-headers dirs and Swift module maps of the referenced Expo packages when one is mixed", async () => {
    const dir = await autolinking({
      Mixed: ["pod-headers/Mixed/Mixed-Swift.h", "pod-headers/Mixed/Mixed-umbrella.h"],
      Swifty: ["pod-headers/Swifty/Swifty-Swift.h"],
      ObjC: ["pod-headers/ObjC/Header.h"],
      Manifest: ["Package.swift"],
    });
    const inputs = await expoClangImporterInputs(dir, "/h");
    expect(inputs).toEqual({
      swiftHeadersDir: "/h",
      includeDirs: ["Mixed", "ObjC", "Swifty"].map((n) => join(dir, "expo", "expo-source", n, "pod-headers")),
      moduleMaps: ["/h/Mixed.modulemap", "/h/Swifty.modulemap"],
    });
  });

  it("returns nothing without a mixed package, or without the autolinking manifest", async () => {
    const dir = await autolinking({ Swifty: ["pod-headers/Swifty/Swifty-Swift.h"] });
    expect(await expoClangImporterInputs(dir, "/h")).toBeUndefined();
    expect(await expoClangImporterInputs(join(dir, "missing"), "/h")).toBeUndefined();
  });
});
