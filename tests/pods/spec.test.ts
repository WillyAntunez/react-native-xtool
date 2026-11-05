import { describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import { PodSpecError, parsePodSpec, podRoute, selectedLayers, type PodSpec } from "../../src/pods/spec.js";
import { fixtureSpec } from "../support/podFixtures.js";

const fixture = (pod: string, version: string): PodSpec => parsePodSpec(fixtureSpec(pod, version), { pod, version });
const LINK = troubleshootingUrl("cocoapods-binaries");

/** A minimal spec in ML Kit's shape, with `extra` over it. */
function spec(extra: Record<string, unknown>): PodSpec {
  return parsePodSpec(
    {
      name: "Example",
      version: "1.0.0",
      source: { http: "https://example.invalid/dl/Example-1.0.0.tar.gz" },
      vendored_frameworks: ["Frameworks/Example.framework"],
      ...extra,
    },
    { pod: "Example", version: "1.0.0" },
  );
}

describe("parsePodSpec", () => {
  it("reads string and array requirements and trims their items", () => {
    const vision = fixture("MLKitVision", "9.0.0");
    expect(vision.layer.dependencies).toEqual({
      "GTMSessionFetcher/Core": [">= 3.3.2", "< 4.0"],
      "GoogleToolboxForMac/Logger": [">= 4.2.1", "< 5.0"],
      "GoogleToolboxForMac/NSData+zlib": [">= 4.2.1", "< 5.0"],
      MLImage: ["1.0.0-beta7"],
      MLKitCommon: ["~> 13.0"],
    });
  });

  it("reads the attributes rn-xtool uses", () => {
    const text = fixture("MLKitTextRecognition", "6.0.0");
    expect(text.name).toBe("MLKitTextRecognition");
    expect(text.version).toBe("6.0.0");
    expect(text.source).toEqual({ http: "https://example.invalid/dl/MLKitTextRecognition-6.0.0.tar.gz" });
    expect(text.license).toEqual({ type: "Copyright", text: "Copyright 2024 Google LLC" });
    expect(text.homepage).toBe("https://example.invalid/ml-kit/guides");
    expect(text.authors).toEqual(["Google, Inc."]);
    expect(text.iosMin).toBe("15.5");
    expect(text.layer.vendoredFrameworks).toEqual(["Frameworks/MLKitTextRecognition.framework"]);
    expect(text.layer.resourceBundles).toEqual({ LatinOCRResources: ["Resources/LatinOCRResources/**"] });
    expect(text.layer.libraries).toEqual(["c++"]);
    expect(text.layer.frameworks).toContain("CoreImage");
    expect(fixture("GoogleMLKit", "8.0.0").moduleName).toBe("MLKit");
  });

  it("reads authors as a string, a list or an object", () => {
    expect(fixture("MLKitFoo", "1.0.0").authors).toEqual(["Example One", "Example Two"]);
    expect(fixture("nanopb", "3.30910.0").authors).toEqual(["Placeholder Author"]);
  });

  it("selects default_subspecs when the root is named, and every subspec without them", () => {
    expect(selectedLayers(fixture("GoogleMLKit", "8.0.0"), []).used).toEqual(["Common", "MLKitCore"]);
    expect(selectedLayers(fixture("GTMSessionFetcher", "3.5.0"), []).used).toEqual(["Core", "Full"]);
    const noDefaults = spec({ subspecs: [{ name: "A" }, { name: "B" }] });
    expect(selectedLayers(noDefaults, []).used).toEqual(["A", "B"]);
    expect(selectedLayers(noDefaults, ["Example"]).used).toEqual(["A", "B"]);
  });

  it("follows a subspec's dependency on another subspec of the same pod", () => {
    const mlkit = fixture("GoogleMLKit", "8.0.0");
    const { layers, used } = selectedLayers(mlkit, ["TextRecognition"]);
    expect(used).toEqual(["MLKitCore", "TextRecognition"]);
    expect(layers[0]).toBe(mlkit.layer);
    expect(layers.flatMap((l) => l.sourceFiles)).toEqual(["MLKitCore/Sources/MLKit.h"]);
    expect(layers.flatMap((l) => l.preservePaths)).toContain("MLKitCore/Sources/module.modulemap");
    expect(layers.flatMap((l) => Object.keys(l.dependencies))).toEqual(
      expect.arrayContaining(["MLKitCommon", "MLKitTextRecognition"]),
    );
    expect(selectedLayers(mlkit, ["GoogleMLKit/TextRecognition", "TextRecognitionKorean"]).used).toEqual([
      "MLKitCore",
      "TextRecognition",
      "TextRecognitionKorean",
    ]);
  });

  it("takes a nested subspec with its parents", () => {
    const nested = spec({
      subspecs: [{ name: "A", frameworks: "Security", subspecs: [{ name: "B", libraries: "z" }, { name: "C" }] }],
    });
    const { layers, used } = selectedLayers(nested, ["A/B"]);
    expect(used).toEqual(["A", "A/B"]);
    expect(layers.flatMap((l) => [...l.frameworks, ...l.libraries])).toEqual(["Security", "z"]);
  });

  it("names a subspec the spec does not have", () => {
    expect(() => selectedLayers(fixture("GoogleMLKit", "8.0.0"), ["Nope"])).toThrow(
      `The spec of GoogleMLKit 8.0.0 has no subspec "Nope". See ${LINK}`,
    );
  });

  it("merges ios-scoped attributes and ignores other platforms", () => {
    const transport = fixture("GoogleDataTransport", "10.1.1");
    expect(transport.layer.frameworks).toEqual(["SystemConfiguration", "CoreTelephony"]);
    expect(transport.layer.libraries).toEqual(["z"]);
    const utilities = fixture("GoogleUtilities", "8.1.5");
    const { layers } = selectedLayers(utilities, ["Reachability"]);
    expect(layers.flatMap((l) => l.frameworks)).toEqual(["SystemConfiguration", "Security"]);
    const scoped = spec({
      vendored_frameworks: ["Frameworks/Example.framework"],
      ios: { vendored_frameworks: "Frameworks/ExampleIOS.framework", dependencies: { Other: "~> 1.0" } },
      osx: { vendored_frameworks: "Frameworks/ExampleMac.framework" },
      tvos: { frameworks: "TVServices" },
      watchos: { frameworks: "WatchKit" },
      visionos: { frameworks: "RealityKit" },
    });
    expect(scoped.layer.vendoredFrameworks).toEqual(["Frameworks/Example.framework", "Frameworks/ExampleIOS.framework"]);
    expect(scoped.layer.dependencies).toEqual({ Other: ["~> 1.0"] });
    expect(scoped.layer.frameworks).toEqual([]);
  });

  it.each([
    ["dependencies", 3, "3"],
    ["vendored_frameworks", {}, "{}"],
    ["subspecs", "x", '"x"'],
    ["source", [], "[]"],
  ])("names the pod and the key of a value it cannot read (%s)", (key, value, shown) => {
    expect(() => spec({ [key]: value })).toThrow(PodSpecError);
    expect(() => spec({ [key]: value })).toThrow(
      `The spec of Example 1.0.0 has a "${key}" value rn-xtool cannot read (${shown}). See ${LINK}`,
    );
  });

  it("names an ios-scoped key and shows at most 80 characters of the value", () => {
    const long = { a: "x".repeat(200) };
    expect(() => spec({ ios: { libraries: long } })).toThrow(
      `The spec of Example 1.0.0 has a "ios.libraries" value rn-xtool cannot read (${JSON.stringify(long).slice(0, 80)}). See ${LINK}`,
    );
    expect(() => spec({ dependencies: { Other: [1] } })).toThrow(`has a "dependencies" value rn-xtool cannot read ({"Other":[1]})`);
  });

  it("ignores keys that do not change the build", () => {
    const parsed = spec({
      description: { not: "a string" },
      screenshots: 7,
      pod_target_xcconfig: ["odd"],
      requires_arc: "Foundation/*.m",
      osx: 3,
    });
    expect(parsed.layer.vendoredFrameworks).toEqual(["Frameworks/Example.framework"]);
  });

  it.each([
    ["an ML Kit framework", fixture("MLKitTextRecognition", "6.0.0"), [], { kind: "binary", headersOnly: false }],
    ["GoogleMLKit with MLKitCore", fixture("GoogleMLKit", "8.0.0"), ["TextRecognition"], { kind: "binary", headersOnly: true }],
    [
      "a vendored_libraries spec",
      fixture("MLKitLegacy", "1.0.0"),
      [],
      { kind: "other", what: "ships vendored libraries (Libraries/libMLKitLegacy.a)" },
    ],
    [
      "a .m in source_files",
      spec({ vendored_frameworks: [], source_files: ["Sources/*.h", "Sources/Example.{h,m}"] }),
      [],
      { kind: "other", what: "compiles sources (Sources/Example.{h,m})" },
    ],
    [
      "a wildcard in source_files",
      spec({ vendored_frameworks: [], source_files: "Sources/**/*" }),
      [],
      { kind: "other", what: "compiles sources (Sources/**/*)" },
    ],
    [
      'type: "dmg"',
      spec({ source: { http: "https://example.invalid/dl/Example.dmg", type: "dmg" } }),
      [],
      { kind: "other", what: "is a dmg download (https://example.invalid/dl/Example.dmg)" },
    ],
    [
      "an unknown archive extension",
      spec({ source: { http: "https://example.invalid/dl/Example-1.0.0.tar.bz2" } }),
      [],
      { kind: "other", what: "is a tar.bz2 download (https://example.invalid/dl/Example-1.0.0.tar.bz2)" },
    ],
    [
      "an svn source",
      spec({ source: { svn: "https://example.invalid/svn/example", tag: "1.0.0" } }),
      [],
      { kind: "other", what: "comes from a svn source, which rn-xtool cannot download" },
    ],
    [
      "a framework with glue sources",
      spec({ source_files: ["Sources/*.{h,m}"] }),
      [],
      { kind: "other", what: "compiles sources (Sources/*.{h,m})" },
    ],
    [
      "a framework with a vendored library",
      spec({ vendored_libraries: "Libraries/libExample.a" }),
      [],
      { kind: "other", what: "ships vendored libraries (Libraries/libExample.a)" },
    ],
    [
      "a framework with header source_files",
      spec({ source_files: "Frameworks/Example.framework/Headers/*.h" }),
      [],
      { kind: "binary", headersOnly: false },
    ],
    ["GTMSessionFetcher", fixture("GTMSessionFetcher", "3.5.0"), ["Core"], { kind: "source" }],
    ["a zip", fixture("MLKitFoo", "1.0.0"), [], { kind: "binary", headersOnly: false }],
    [
      "a tgz type",
      spec({ source: { http: "https://example.invalid/dl/download?id=1", type: "tgz" } }),
      [],
      { kind: "binary", headersOnly: false },
    ],
  ])("routes each source shape: %s", (_name, parsed, subspecs, route) => {
    expect(podRoute(parsed, selectedLayers(parsed, subspecs).layers)).toEqual(route);
  });
});
