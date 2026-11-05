import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unbundledResources, unbundledResourcesLine } from "../src/pipeline/scaffoldResources.js";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const BANNER = "// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.\n";
const OWN = "// swift-tools-version: 6.0\nimport PackageDescription\n";

interface Lib {
  podspec: string;
  manifest?: string;
  /** Listed in autolinking.json without an iOS platform. */
  noIos?: boolean;
}

/** A project whose autolinking.json lists each library, with its podspec and Package.swift under node_modules. */
function project(libs: Record<string, Lib>): string {
  const root = mkdtempSync(path.join(tmpdir(), "rn-xtool-resources-"));
  tmp.push(root);
  const dependencies: Record<string, object> = {};
  for (const [name, lib] of Object.entries(libs)) {
    const dir = path.join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    const podspec = path.join(dir, `${name.replace(/\W/g, "")}.podspec`);
    writeFileSync(podspec, lib.podspec);
    if (lib.manifest !== undefined) writeFileSync(path.join(dir, "Package.swift"), lib.manifest);
    dependencies[name] = { root: dir, name, platforms: { ios: lib.noIos ? null : { podspecPath: podspec } } };
  }
  const json = path.join(root, "ios", "build", "generated", "autolinking", "autolinking.json");
  mkdirSync(path.dirname(json), { recursive: true });
  writeFileSync(json, JSON.stringify({ dependencies }));
  return root;
}

const pod = (body: string) => `Pod::Spec.new do |s|\n  s.name = "Lib"\n${body}\nend\n`;

describe("resources that do not reach the app", () => {
  it("names each scaffolded library's resources not copied into the app", () => {
    const root = project({
      "react-native-svg": {
        podspec: pod(
          [
            "  s.osx.resource_bundles = {'RNSVGFilters' => ['apple/**/*.macosx.metallib']}",
            "  s.ios.resource_bundles = {'RNSVGFilters' => ['apple/**/*.iphoneos.metallib']}",
          ].join("\n"),
        ),
        manifest: BANNER,
      },
      "@react-native-async-storage/async-storage": {
        podspec: pod('  s.resource_bundles = { "RNCAsyncStorage_resources" => "ios/PrivacyInfo.xcprivacy" }'),
        manifest: BANNER,
      },
    });
    const list = unbundledResources(root);
    expect(list).toEqual([
      { pkg: "@react-native-async-storage/async-storage", items: ["PrivacyInfo.xcprivacy"] },
      { pkg: "react-native-svg", items: ["RNSVGFilters.bundle"] },
    ]);
    expect(unbundledResourcesLine(list)).toBe(
      "ℹ Not copied into the app: @react-native-async-storage/async-storage (PrivacyInfo.xcprivacy), react-native-svg " +
        "(RNSVGFilters.bundle). Code that loads them at run time does not find them.",
    );
  });

  it("says privacy manifests are read only at App Store submission only when every resource is one", () => {
    const privacy = [
      { pkg: "@react-native-async-storage/async-storage", items: ["PrivacyInfo.xcprivacy"] },
      { pkg: "react-native-device-info", items: ["PrivacyInfo.xcprivacy"] },
    ];
    expect(unbundledResourcesLine(privacy)).toBe(
      "ℹ Not copied into the app: @react-native-async-storage/async-storage (PrivacyInfo.xcprivacy), " +
        "react-native-device-info (PrivacyInfo.xcprivacy). " +
        "Development builds run without them; privacy manifests are read only at App Store submission.",
    );
    const mixed = [{ pkg: "react-native-vector-icons", items: ["PrivacyInfo.xcprivacy", "Ionicons.ttf"] }];
    expect(unbundledResourcesLine(mixed)).toBe(
      "ℹ Not copied into the app: react-native-vector-icons (PrivacyInfo.xcprivacy, Ionicons.ttf). " +
        "Code that loads them at run time does not find them.",
    );
  });

  it("leaves out libraries with their own Package.swift and resources under a Ruby condition", () => {
    const root = project({
      own: { podspec: pod('  s.resource_bundles = { "Own" => ["ios/*.png"] }'), manifest: OWN },
      none: { podspec: pod('  s.resource_bundles = { "None" => ["ios/*.png"] }') },
      cond: {
        podspec: pod(
          [
            "  if ENV['WITH_ASSETS']",
            '    s.resource_bundles = { "Cond" => ["ios/*.png"] }',
            "  end",
            '  s.resources = ["ios/a.png"] if fancy',
            '  # s.resources = ["ios/b.png"]',
          ].join("\n"),
        ),
        manifest: BANNER,
      },
      "no-ios": { podspec: pod('  s.resources = ["ios/c.png"]'), manifest: BANNER, noIos: true },
    });
    expect(unbundledResources(root)).toEqual([]);
    expect(unbundledResourcesLine([])).toBeUndefined();
  });

  it("names plain resources by basename, reads a hash over several lines, and a privacy bundle among other files by key", () => {
    const root = project({
      lib: {
        podspec: pod(
          [
            "  s.resources = ['ios/Assets/logo.png', \"ios/Strings/*.strings\"]",
            "  s.resource = 'ios/extra.json'",
            "  s.resource_bundles = {",
            "    'Mixed' => ['ios/PrivacyInfo.xcprivacy', 'ios/*.png'],",
            "    \"#{s.name}_privacy\" => ['ios/PrivacyInfo.xcprivacy']",
            "  }",
          ].join("\n"),
        ),
        manifest: BANNER,
      },
    });
    expect(unbundledResources(root)).toEqual([
      { pkg: "lib", items: ["logo.png", "*.strings", "extra.json", "Mixed.bundle", "PrivacyInfo.xcprivacy"] },
    ]);
  });

  it("leaves out a value over several lines whose closing line carries a modifier, and reads on after it", () => {
    const root = project({
      lib: {
        podspec: pod(
          [
            "  s.resources = [",
            '    "ios/Extra.png"',
            '  ] if ENV["WITH_EXTRA"]',
            "  s.resource_bundles = {",
            "    'Cond' => ['ios/*.png']",
            "  } unless ENV['NO_BUNDLE']",
            '  s.source_files = "ios/*.{h,m}"',
            '  s.dependency "React-Core"',
            "  s.resources = [",
            "    'ios/Kept.json'",
            "  ]",
          ].join("\n"),
        ),
        manifest: BANNER,
      },
    });
    expect(unbundledResources(root)).toEqual([{ pkg: "lib", items: ["Kept.json"] }]);
  });

  it("is empty without autolinking.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rn-xtool-resources-"));
    tmp.push(root);
    expect(unbundledResources(root)).toEqual([]);
  });
});
