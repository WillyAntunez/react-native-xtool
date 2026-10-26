import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSetting, openPbxproj, resolveBuildSettingValue, resolveSetting } from "../../src/project/pbxproj.js";

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
