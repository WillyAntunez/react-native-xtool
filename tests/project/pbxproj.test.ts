import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSetting, openPbxproj, readTargetContent, resolveBuildSettingValue, resolveSetting } from "../../src/project/pbxproj.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const templateIos = path.join(fixtures, "bare", "ios");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A temp ios/ dir holding the given pbxproj contents in `<name>.xcodeproj`. */
async function iosWith(names: string[], contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "expo-xtool-pbxproj-"));
  tempDirs.push(dir);
  for (const n of names) {
    await mkdir(path.join(dir, `${n}.xcodeproj`));
    await writeFile(path.join(dir, `${n}.xcodeproj`, "project.pbxproj"), contents);
  }
  return dir;
}

const templatePbxproj = () => readFile(path.join(templateIos, "HelloWorld.xcodeproj", "project.pbxproj"), "utf8");

describe("pbxproj reader", () => {
  it("finds the application target of the template", () => {
    const p = openPbxproj(templateIos);
    expect(p.appTarget.name).toBe("HelloWorld");
    expect(p.projectName).toBe("HelloWorld");
  });

  it("reads raw target settings", () => {
    const p = openPbxproj(templateIos);
    expect(buildSetting(p, "INFOPLIST_FILE")).toBe("HelloWorld/Info.plist");
    expect(buildSetting(p, "IPHONEOS_DEPLOYMENT_TARGET")).toBe("15.1");
  });

  it("resolves the template bundle id", () => {
    const p = openPbxproj(templateIos);
    expect(resolveSetting(p, "PRODUCT_BUNDLE_IDENTIFIER")).toBe("org.reactjs.native.example.HelloWorld");
  });

  it("resolves rfc1034identifier", () => {
    expect(resolveBuildSettingValue("x.$(PRODUCT_NAME:rfc1034identifier)", (k) => (k === "PRODUCT_NAME" ? "My App_1" : undefined))).toBe(
      "x.My-App-1",
    );
  });

  it("falls back to the project level", async () => {
    const marker = "83CBBA201A601CBA00E9B192 /* Debug */ = {";
    const src = await templatePbxproj();
    const at = src.indexOf("buildSettings = {", src.indexOf(marker)) + "buildSettings = {".length;
    const edited = `${src.slice(0, at)}\n\t\t\t\tONLY_IN_PROJECT = "from project";${src.slice(at)}`;
    const p = openPbxproj(await iosWith(["HelloWorld"], edited));
    expect(buildSetting(p, "ONLY_IN_PROJECT")).toBe("from project");
    expect(resolveSetting(p, "ONLY_IN_PROJECT")).toBe("from project");
  });

  it("resolves $(inherited) when the project level also inherits", () => {
    const p = openPbxproj(templateIos);
    expect(resolveSetting(p, "LD_RUNPATH_SEARCH_PATHS")).toBe("/usr/lib/swift @executable_path/Frameworks");
  });

  it("resolves $(inherited) in a project-only key as empty", async () => {
    const marker = "83CBBA201A601CBA00E9B192 /* Debug */ = {";
    const src = await templatePbxproj();
    const at = src.indexOf("buildSettings = {", src.indexOf(marker)) + "buildSettings = {".length;
    const edited = `${src.slice(0, at)}\n\t\t\t\tONLY_INHERITS = "$(inherited) x";${src.slice(at)}`;
    const p = openPbxproj(await iosWith(["HelloWorld"], edited));
    expect(resolveSetting(p, "ONLY_INHERITS")).toBe("x");
  });

  it("reports a missing ios directory", () => {
    expect(() => openPbxproj("/nonexistent/ios")).toThrow(/nonexistent/);
  });

  it("ignores xcconfig base configurations", () => {
    expect(() => openPbxproj(templateIos)).not.toThrow();
  });

  it("rejects an unknown variable", () => {
    expect(() => resolveBuildSettingValue("$(FOO)", () => undefined)).toThrow(/FOO/);
  });

  it("rejects several application targets", async () => {
    const two = await readFile(path.join(fixtures, "pbxproj", "two-apps.pbxproj"), "utf8");
    const dir = await iosWith(["HelloWorld"], two);
    expect(() => openPbxproj(dir)).toThrow(/HelloWorld.*HelloWorldTwo|HelloWorldTwo.*HelloWorld/);
  });

  it("rejects several xcodeproj", async () => {
    const dir = await iosWith(["One", "Two"], await templatePbxproj());
    expect(() => openPbxproj(dir)).toThrow(/One\.xcodeproj.*Two\.xcodeproj/);
  });
});

describe("readTargetContent", () => {
  const withObjc = () => readFile(path.join(fixtures, "pbxproj", "with-objc.pbxproj"), "utf8");
  const rel = (files: { relPath: string }[]) => files.map((f) => f.relPath).sort();

  it("lists the template sources and resources", () => {
    const content = readTargetContent(openPbxproj(templateIos), templateIos);
    expect(rel(content.swiftSources)).toEqual(["HelloWorld/AppDelegate.swift", "HelloWorld/SceneDelegate.swift"]);
    expect(content.cSources).toEqual([]);
    expect(rel(content.skippedResources)).toEqual(["HelloWorld/Images.xcassets", "HelloWorld/LaunchScreen.storyboard"]);
    expect(content.resources).toEqual([]);
    expect(content.swiftSources[0]!.absPath).toBe(path.join(templateIos, content.swiftSources[0]!.relPath));
    expect(content.mixed).toBe(false);
  });

  it("resolves files through nested groups", async () => {
    const ios = await iosWith(["HelloWorld"], await withObjc());
    const content = readTargetContent(openPbxproj(ios), ios);
    expect(rel(content.cSources)).toEqual(["HelloWorld/Native/NativeModule.m"]);
    expect(rel(content.headers)).toEqual(["HelloWorld/Native/NativeModule.h"]);
    expect(rel(content.resources)).toEqual([
      "HelloWorld/Base.lproj/Localizable.strings",
      "HelloWorld/Fonts/Inter.ttf",
      "HelloWorld/PrivacyInfo.xcprivacy",
      "HelloWorld/es.lproj/Localizable.strings",
    ]);
    expect(rel(content.skippedResources)).toEqual([
      "HelloWorld/Base.lproj/Intro.storyboard",
      "HelloWorld/Images.xcassets",
      "HelloWorld/LaunchScreen.storyboard",
    ]);
    expect(content.mixed).toBe(true);
  });

  it("maps the mixed-target settings", async () => {
    const ios = await iosWith(["HelloWorld"], await withObjc());
    const content = readTargetContent(openPbxproj(ios), ios);
    expect(content.bridgingHeader?.relPath).toBe("HelloWorld/HelloWorld-Bridging-Header.h");
    expect(content.defines).toEqual(["DEBUG=1", "FOO=1", 'VERSION="1.0"', 'GREETING="hello world"']);
    expect(content.headerSearchPaths).toEqual([path.join(ios, "Vendor/include")]);
    expect(content.cxxStandard).toBe("c++20");
    expect(content.ignoredSettings).toEqual(["OTHER_CFLAGS"]);
  });

  const HELLO = "13B07FAE1A68108700A75B9A";
  const MAIN = "83CBB9F61A601CBA00E9B192";
  let counter = 0;

  /** Adds a file reference to `pbxproj`: in `group` (if any) and in the Sources/Resources phase (if any). */
  function addFile(
    pbxproj: string,
    o: { path: string; name?: string; sourceTree?: string; group?: string; phase?: "Sources" | "Resources" },
  ): string {
    const n = String(++counter).padStart(2, "0");
    const ref = `C30000000000000000000a${n}`;
    const bf = `C30000000000000000000b${n}`;
    const tree = o.sourceTree ?? "<group>";
    const q = (v: string) => `"${v}"`;
    let out = pbxproj.replace(
      "/* End PBXFileReference section */",
      `\t\t${ref} = {isa = PBXFileReference; ${o.name ? `name = ${q(o.name)}; ` : ""}path = ${q(o.path)}; sourceTree = ${q(tree)}; };\n/* End PBXFileReference section */`,
    );
    if (o.group) {
      const re = new RegExp(`(${o.group}[^=\\n]*= \\{\\n\\t\\t\\tisa = PBXGroup;\\n\\t\\t\\tchildren = \\(\\n)`);
      expect(out).toMatch(re);
      out = out.replace(re, `$1\t\t\t\t${ref},\n`);
    }
    if (o.phase) {
      out = out.replace(
        "/* End PBXBuildFile section */",
        `\t\t${bf} = {isa = PBXBuildFile; fileRef = ${ref}; };\n/* End PBXBuildFile section */`,
      );
      const re = new RegExp(`(isa = PBX${o.phase}BuildPhase;\\n\\t\\t\\tbuildActionMask = 2147483647;\\n\\t\\t\\tfiles = \\(\\n)`);
      expect(out).toMatch(re);
      out = out.replace(re, `$1\t\t\t\t${bf},\n`);
    }
    return out;
  }

  const read = async (pbxproj: string) => {
    const ios = await iosWith(["HelloWorld"], pbxproj);
    return { ios, content: () => readTargetContent(openPbxproj(ios), ios) };
  };

  it("rejects duplicate compiled basenames, naming both paths", async () => {
    let dup = await withObjc();
    dup = addFile(dup, { path: "A/Foo.swift", group: MAIN, phase: "Sources" });
    dup = addFile(dup, { path: "B/Foo.swift", group: MAIN, phase: "Sources" });
    const { content } = await read(dup);
    expect(content).toThrow(/Foo\.swift/);
    expect(content).toThrow(/A\/Foo\.swift/);
    expect(content).toThrow(/B\/Foo\.swift/);
  });

  it("keeps escaped quotes and quoted spaces in defines", async () => {
    const { content } = await read(await withObjc());
    expect(content().defines).toContain('VERSION="1.0"');
    expect(content().defines).toContain('GREETING="hello world"');
  });

  it("classifies .cxx and uppercase extensions as C sources", async () => {
    let src = await withObjc();
    src = addFile(src, { path: "Legacy.M", group: HELLO, phase: "Sources" });
    src = addFile(src, { path: "Wrap.cxx", group: HELLO, phase: "Sources" });
    const { content } = await read(src);
    expect(rel(content().cSources)).toEqual([
      "HelloWorld/Legacy.M",
      "HelloWorld/Native/NativeModule.m",
      "HelloWorld/Wrap.cxx",
    ]);
  });

  it("rejects unsupported source types in the Sources phase", async () => {
    const src = addFile(await withObjc(), { path: "Shader.metal", group: HELLO, phase: "Sources" });
    const { content } = await read(src);
    expect(content).toThrow(/unsupported source type.*HelloWorld\/Shader\.metal/);
  });

  it("rejects a phase file missing from the group tree", async () => {
    const src = addFile(await withObjc(), { path: "Lost.swift", phase: "Sources" });
    const { content } = await read(src);
    expect(content).toThrow(/Cannot locate Lost\.swift/);
  });

  it("rejects an unresolvable header search path variable", async () => {
    const src = (await withObjc()).replace("Vendor/include,", '"$(PODS_ROOT)/Headers",');
    const { content } = await read(src);
    expect(content).toThrow(/PODS_ROOT/);
  });

  it("places SOURCE_ROOT and absolute references", async () => {
    let src = await withObjc();
    src = addFile(src, { path: "Shared/Util.swift", sourceTree: "SOURCE_ROOT", group: HELLO, phase: "Sources" });
    src = addFile(src, { path: "/opt/shared/Abs.swift", sourceTree: "<absolute>", group: HELLO, phase: "Sources" });
    const { ios, content } = await read(src);
    const swift = content().swiftSources;
    expect(swift.find((f) => f.relPath === "Shared/Util.swift")?.absPath).toBe(path.join(ios, "Shared/Util.swift"));
    const abs = swift.find((f) => f.absPath === "/opt/shared/Abs.swift");
    expect(abs?.relPath).toBe(path.relative(ios, "/opt/shared/Abs.swift").split(path.sep).join("/"));
  });

  it("uses the path, not the display name, of a file reference", async () => {
    const src = addFile(await withObjc(), { path: "Real.swift", name: "Pretty.swift", group: HELLO, phase: "Sources" });
    const { content } = await read(src);
    expect(rel(content().swiftSources)).toContain("HelloWorld/Real.swift");
  });

  it("names the Swift module as Xcode does: PRODUCT_MODULE_NAME, else PRODUCT_NAME as a C identifier", async () => {
    expect((await read(await withObjc())).content().productModuleName).toBe("HelloWorld");
    const spaced = (await withObjc()).replaceAll("PRODUCT_NAME = HelloWorld;", 'PRODUCT_NAME = "Hello World-App";');
    expect((await read(spaced)).content().productModuleName).toBe("Hello_World_App");
    const explicit = (await withObjc()).replaceAll(
      "PRODUCT_NAME = HelloWorld;",
      "PRODUCT_NAME = HelloWorld;\n\t\t\t\tPRODUCT_MODULE_NAME = Greeting;",
    );
    expect((await read(explicit)).content().productModuleName).toBe("Greeting");
    const derived = (await withObjc()).replaceAll(
      "PRODUCT_NAME = HelloWorld;",
      'PRODUCT_NAME = "Hello App";\n\t\t\t\tPRODUCT_MODULE_NAME = "$(PRODUCT_NAME:c99extidentifier)";',
    );
    expect((await read(derived)).content().productModuleName).toBe("Hello_App");
  });

  it("includes app-folder headers that are in no build phase, and only those", async () => {
    let src = await withObjc();
    src = addFile(src, { path: "Bridge.hpp", group: HELLO });
    src = addFile(src, { path: "Outside.h", group: MAIN });
    const { content } = await read(src);
    expect(rel(content().headers)).toEqual(["HelloWorld/Bridge.hpp", "HelloWorld/Native/NativeModule.h"]);
  });
});
