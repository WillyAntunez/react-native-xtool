import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as plist from "plist";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../src/docs.js";
import { bundleFiles, resourceBundleInfoPlist, writeResourceBundle, type BundleSource } from "../src/pipeline/resourceBundles.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
let root: string;
let base: string;
let resources: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "rn-xtool-bundles-"));
  base = path.join(root, "pod");
  resources = path.join(root, "Resources");
  mkdirSync(base);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text = rel): void {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}

const source = (key: string, globs: string[], owner = "MLKitTextRecognition 6.0.0"): BundleSource => ({ key, baseDir: base, globs, owner });

/** Every file below `dir`, relative, sorted. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

describe("bundleFiles", () => {
  it("puts ML Kit's model folder at the bundle root", () => {
    write("Resources/LatinOCRResources/model.tflite");
    write("Resources/LatinOCRResources/sub/labels.txt");
    write("Resources/Other/x.bin");
    expect(bundleFiles(source("LatinOCRResources", ["Resources/LatinOCRResources/**"]))).toEqual([
      { dest: "model.tflite", src: path.join(base, "Resources/LatinOCRResources/model.tflite") },
      { dest: path.join("sub", "labels.txt"), src: path.join(base, "Resources/LatinOCRResources/sub/labels.txt") },
    ]);
  });

  it("flattens react-native-svg's metallib files to the bundle root", () => {
    write("apple/Filters/MetalCI/RNSVGFeColorMatrix.iphoneos.metallib");
    write("apple/Filters/MetalCI/RNSVGFeColorMatrix.macosx.metallib");
    write("apple/Filters/RNSVGArithmetic.iphoneos.metallib");
    const got = bundleFiles(source("RNSVGFilters", ["apple/**/*.iphoneos.metallib"], "react-native-svg"));
    expect(got.map((f) => f.dest)).toEqual(["RNSVGArithmetic.iphoneos.metallib", "RNSVGFeColorMatrix.iphoneos.metallib"]);
  });

  it("stops on two files for one destination", () => {
    write("a/x.metallib");
    write("b/x.metallib");
    expect(() => bundleFiles(source("RNSVGFilters", ["**/*.metallib"], "react-native-svg"))).toThrow(
      `RNSVGFilters.bundle (react-native-svg) would hold x.metallib twice: a/x.metallib and b/x.metallib. See ${LINK}`,
    );
  });

  it("takes a file two globs match once", () => {
    write("ios/PrivacyInfo.xcprivacy");
    const got = bundleFiles(source("P", ["ios/PrivacyInfo.xcprivacy", "ios/*.xcprivacy"], "react-native-device-info"));
    expect(got).toEqual([{ dest: "PrivacyInfo.xcprivacy", src: path.join(base, "ios/PrivacyInfo.xcprivacy") }]);
  });
});

describe("resourceBundleInfoPlist", () => {
  it("writes CocoaPods' Info.plist keys", () => {
    expect(plist.parse(resourceBundleInfoPlist("LatinOCRResources"))).toEqual({
      CFBundleDevelopmentRegion: "en",
      CFBundleIdentifier: "org.cocoapods.LatinOCRResources",
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleName: "LatinOCRResources",
      CFBundlePackageType: "BNDL",
    });
    expect(plist.parse(resourceBundleInfoPlist("RNCAsync_Storage resources"))).toMatchObject({
      CFBundleIdentifier: "org.cocoapods.RNCAsync-Storage-resources",
      CFBundleName: "RNCAsync_Storage resources",
    });
  });
});

describe("writeResourceBundle", () => {
  it("hard-links and never writes a symlink", async () => {
    write("Resources/LatinOCRResources/model.tflite", "weights");
    symlinkSync("model.tflite", path.join(base, "Resources/LatinOCRResources/alias.tflite"));
    const lines: string[] = [];
    const built = await writeResourceBundle(source("LatinOCRResources", ["Resources/LatinOCRResources/**"]), resources, (l) => lines.push(l));
    expect(built).toEqual({ name: "LatinOCRResources.bundle", owner: "MLKitTextRecognition 6.0.0", files: 2 });
    const bundle = path.join(resources, "LatinOCRResources.bundle");
    expect(files(bundle)).toEqual(["Info.plist", "alias.tflite", "model.tflite"]);
    for (const f of ["alias.tflite", "model.tflite"]) {
      expect(lstatSync(path.join(bundle, f)).isFile()).toBe(true);
      expect(statSync(path.join(bundle, f)).ino).toBe(statSync(path.join(base, "Resources/LatinOCRResources/model.tflite")).ino);
    }
    expect(plist.parse(readFileSync(path.join(bundle, "Info.plist"), "utf8"))).toMatchObject({ CFBundleName: "LatinOCRResources" });
    expect(lines).toEqual([]);
  });

  it("writes its own Info.plist without writing through a linked one", async () => {
    write("r/Info.plist", "the pod's");
    write("r/a.txt");
    await writeResourceBundle(source("K", ["r/**"]), resources, () => undefined);
    expect(readFileSync(path.join(base, "r/Info.plist"), "utf8")).toBe("the pod's");
    expect(plist.parse(readFileSync(path.join(resources, "K.bundle", "Info.plist"), "utf8"))).toMatchObject({ CFBundleName: "K" });
  });

  it("replaces a bundle an earlier build left", async () => {
    write("r/a.txt");
    mkdirSync(path.join(resources, "K.bundle"), { recursive: true });
    writeFileSync(path.join(resources, "K.bundle", "stale.txt"), "old");
    await writeResourceBundle(source("K", ["r/**"]), resources, () => undefined);
    expect(files(path.join(resources, "K.bundle"))).toEqual(["Info.plist", "a.txt"]);
  });

  it("leaves compiled resources out with an ℹ line", async () => {
    write("res/Images.xcassets/Contents.json");
    write("res/Images.xcassets/icon.imageset/icon.png");
    write("res/Main.storyboard");
    write("res/Cell.xib");
    write("res/data.json");
    const lines: string[] = [];
    const built = await writeResourceBundle(source("Res", ["res/**"], "some-lib"), resources, (l) => lines.push(l));
    expect(built).toEqual({ name: "Res.bundle", owner: "some-lib", files: 1 });
    expect(files(path.join(resources, "Res.bundle"))).toEqual(["Info.plist", "data.json"]);
    expect(lines).toEqual([
      "ℹ Left out of Res.bundle (some-lib), as they need Xcode's tools (asset catalogs, storyboards, xibs): " +
        "res/Cell.xib, res/Images.xcassets, res/Main.storyboard",
    ]);
  });

  it("skips a bundle that matches no file, with a ⚠", async () => {
    write("apple/x.macosx.metallib");
    const lines: string[] = [];
    const built = await writeResourceBundle(
      source("RNSVGFilters", ["apple/**/*.iphoneos.metallib", "more/*.metallib"], "react-native-svg"),
      resources,
      (l) => lines.push(l),
    );
    expect(built).toBeUndefined();
    expect(existsSync(path.join(resources, "RNSVGFilters.bundle"))).toBe(false);
    expect(lines).toEqual([
      "⚠ RNSVGFilters.bundle (react-native-svg) matches no file (apple/**/*.iphoneos.metallib, more/*.metallib); it is not built",
    ]);
  });

  it("stops on a bundle name that is not a file name", async () => {
    write("r/a.txt");
    await expect(writeResourceBundle(source("../K", ["r/**"], "some-lib"), resources, () => undefined)).rejects.toThrow(
      `The resource bundle name "../K" (some-lib) is not a file name rn-xtool can use. See ${LINK}`,
    );
  });
});
