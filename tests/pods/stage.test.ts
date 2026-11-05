import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import { projectPaths, type ProjectPaths } from "../../src/paths.js";
import type { PodEntry } from "../../src/config.js";
import { PodsError } from "../../src/pods/format.js";
import type { ResolvedBinaryPod, Resolution, SourceDependency } from "../../src/pods/resolve.js";
import type { SpecLayer } from "../../src/pods/spec.js";
import {
  POD_BINARIES_PACKAGE,
  appDeploymentTarget,
  linkOrCopy,
  podBinariesInput,
  renderPodBinariesPackage,
  stagePodBinaries,
  type PodsResult,
} from "../../src/pods/stage.js";
import type { WrappedPod } from "../../src/pods/wrap.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
const LIB = "@react-native-ml-kit/text-recognition";

let root: string;
let cache: string;
let paths: ProjectPaths;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pods-stage-"));
  cache = path.join(root, "cache");
  paths = projectPaths(path.join(root, "app"));
  mkdirSync(paths.ios, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const layer = (over: Partial<SpecLayer> = {}): SpecLayer => ({
  dependencies: {},
  vendoredFrameworks: [],
  vendoredLibraries: [],
  sourceFiles: [],
  preservePaths: [],
  resourceBundles: {},
  resources: [],
  frameworks: [],
  weakFrameworks: [],
  libraries: [],
  ...over,
});

/** A resolved binary pod reached from `roots`, with one layer. */
function binary(pod: string, version: string, roots: string[], over: Partial<SpecLayer> = {}): ResolvedBinaryPod {
  return {
    pod,
    version,
    subspecs: [],
    spec: { name: pod, version } as ResolvedBinaryPod["spec"],
    layers: [layer(over)],
    headersOnly: false,
    neededBy: [LIB],
    roots,
    chain: [],
  };
}

/** A wrapped pod in the cache: `xcframeworks/<Name>.xcframework` with two files, and `archives/lib<Name>.a`. */
function wrapped(pod: string, version: string, names: string[], opts: { archive?: boolean } = {}): WrappedPod {
  const dir = path.join(cache, "wrapped", `${pod}-${version}`);
  const frameworks = names.map((name) => {
    const xcf = path.join(dir, "xcframeworks", `${name}.xcframework`);
    mkdirSync(path.join(xcf, "ios-arm64", "Headers", name), { recursive: true });
    writeFileSync(path.join(xcf, "Info.plist"), `<plist>${name}</plist>`);
    writeFileSync(path.join(xcf, "ios-arm64", "Headers", name, `${name}.h`), `// ${name}`);
    writeFileSync(path.join(xcf, "ios-arm64", "Headers", name, "module.modulemap"), `module ${name} { umbrella header "${name}.h" }`);
    writeFileSync(path.join(xcf, "ios-arm64", `lib${name}-ios-arm64.a`), "!<arch>\n");
    if (opts.archive === false) return { name, xcframework: xcf, privacy: [] };
    const archive = path.join(dir, "archives", `lib${name}.a`);
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, `!<arch>\n${name}`);
    return { name, xcframework: xcf, archive, privacy: [] };
  });
  return { pod, version, sha256: "a".repeat(64), dir, frameworks, warnings: [] };
}

const entry = (url: string, exact: string, products: string[], over: Partial<PodEntry> = {}): PodEntry => ({ url, exact, products, ...over });
const SOURCES: SourceDependency[] = [
  {
    pod: "GTMSessionFetcher",
    subspecs: ["Core"],
    entry: entry("https://github.com/google/gtm-session-fetcher", "3.5.0", ["GTMSessionFetcherCore"], { subspecs: { Core: ["GTMSessionFetcherCore"] } }),
    requiredBy: [{ from: "MLKitCommon", requirements: [">= 3.3.2", "< 4.0"] }],
  },
  {
    pod: "GoogleDataTransport",
    subspecs: [],
    entry: entry("https://github.com/google/GoogleDataTransport", "10.1.1", ["GoogleDataTransport"]),
    requiredBy: [{ from: "MLKitCommon", requirements: ["~> 10.0"] }],
  },
  {
    pod: "GoogleToolboxForMac",
    subspecs: ["Logger", "NSData+zlib"],
    entry: entry("https://github.com/google/google-toolbox-for-mac", "6.0.1", ["GTMLogger", "GTMNSData_zlib"], {
      subspecs: { Logger: ["GTMLogger"], "NSData+zlib": ["GTMNSData_zlib"] },
      emptyTargets: ["GTMDefines"],
    }),
    requiredBy: [{ from: "MLKitCommon", requirements: [">= 4.2.1", "< 5.0"] }],
  },
  {
    pod: "GoogleUtilities",
    subspecs: ["Logger", "UserDefaults"],
    entry: entry("https://github.com/google/GoogleUtilities", "8.1.5", ["GULLogger", "GULUserDefaults"], {
      subspecs: { Logger: ["GULLogger"], UserDefaults: ["GULUserDefaults"] },
    }),
    requiredBy: [{ from: "MLKitCommon", requirements: ["~> 8.0"] }],
  },
];

const TEXT_RECOGNITION = ["MLKitTextRecognition", "MLKitTextRecognitionChinese", "MLKitTextRecognitionCommon", "MLKitTextRecognitionDevanagari", "MLKitTextRecognitionJapanese", "MLKitTextRecognitionKorean"];

/** ML Kit's resolution and wrapped pods, in the shape G1 linked. */
function mlKit(): PodsResult {
  const roots = ["GoogleMLKit"];
  const pods: [string, string, string[], Partial<SpecLayer>][] = [
    ["GoogleMLKit", "8.0.0", ["MLKit"], {}],
    ["MLImage", "1.0.0-beta7", ["MLImage"], { frameworks: ["CoreGraphics", "CoreMedia", "CoreVideo", "Foundation", "UIKit"] }],
    ["MLKitCommon", "13.0.0", ["MLKitCommon"], { frameworks: ["Foundation", "LocalAuthentication"], libraries: ["c++", "sqlite3", "z"] }],
    ["MLKitVision", "9.0.0", ["MLKitVision"], { frameworks: ["Accelerate", "AVFoundation", "CoreGraphics", "CoreMedia", "CoreVideo", "Foundation", "UIKit"] }],
    ...TEXT_RECOGNITION.map((p): [string, string, string[], Partial<SpecLayer>] => [p, "5.0.0", [p], { frameworks: ["CoreImage", "CoreLocation"], libraries: ["c++"] }]),
  ];
  const resolution: Resolution = {
    binary: pods.map(([pod, version, , over]) => ({ ...binary(pod, version, roots, over), headersOnly: pod === "GoogleMLKit" })),
    sources: SOURCES,
    roots: [{ pod: "GoogleMLKit", libraries: [LIB] }],
    changed: [],
  };
  return { resolution, wrapped: pods.map(([pod, version, names]) => wrapped(pod, version, names, { archive: pod !== "GoogleMLKit" })) };
}

const ML_KIT_PACKAGE = `// swift-tools-version: 6.0
// Generated by rn-xtool from rn-xtool-pods.lock.json and its cache. Do not edit; rn-xtool build rewrites it.
import PackageDescription

let package = Package(
    name: "pod-binaries",
    platforms: [.iOS("15.1")],
    products: [
        .library(name: "GoogleMLKit", targets: ["MLImage", "MLKit", "MLKitCommon", "MLKitTextRecognition", "MLKitTextRecognitionChinese", "MLKitTextRecognitionCommon", "MLKitTextRecognitionDevanagari", "MLKitTextRecognitionJapanese", "MLKitTextRecognitionKorean", "MLKitVision", "GoogleMLKitWrapper"]),
    ],
    dependencies: [
        .package(url: "https://github.com/google/GoogleDataTransport", exact: "10.1.1"),
        .package(url: "https://github.com/google/GoogleUtilities", exact: "8.1.5"),
        .package(url: "https://github.com/google/google-toolbox-for-mac", exact: "6.0.1"),
        .package(url: "https://github.com/google/gtm-session-fetcher", exact: "3.5.0"),
    ],
    targets: [
        .binaryTarget(name: "MLImage", path: "xcframeworks/MLImage.xcframework"),
        .binaryTarget(name: "MLKit", path: "xcframeworks/MLKit.xcframework"),
        .binaryTarget(name: "MLKitCommon", path: "xcframeworks/MLKitCommon.xcframework"),
        .binaryTarget(name: "MLKitTextRecognition", path: "xcframeworks/MLKitTextRecognition.xcframework"),
        .binaryTarget(name: "MLKitTextRecognitionChinese", path: "xcframeworks/MLKitTextRecognitionChinese.xcframework"),
        .binaryTarget(name: "MLKitTextRecognitionCommon", path: "xcframeworks/MLKitTextRecognitionCommon.xcframework"),
        .binaryTarget(name: "MLKitTextRecognitionDevanagari", path: "xcframeworks/MLKitTextRecognitionDevanagari.xcframework"),
        .binaryTarget(name: "MLKitTextRecognitionJapanese", path: "xcframeworks/MLKitTextRecognitionJapanese.xcframework"),
        .binaryTarget(name: "MLKitTextRecognitionKorean", path: "xcframeworks/MLKitTextRecognitionKorean.xcframework"),
        .binaryTarget(name: "MLKitVision", path: "xcframeworks/MLKitVision.xcframework"),
        .target(
            name: "GoogleMLKitWrapper",
            dependencies: [
                .product(name: "GTMLogger", package: "google-toolbox-for-mac"),
                .product(name: "GTMNSData_zlib", package: "google-toolbox-for-mac"),
                .product(name: "GoogleDataTransport", package: "googledatatransport"),
                .product(name: "GULLogger", package: "googleutilities"),
                .product(name: "GULUserDefaults", package: "googleutilities"),
                .product(name: "GTMSessionFetcherCore", package: "gtm-session-fetcher"),
            ],
            path: "Sources/GoogleMLKitWrapper"
        ),
    ]
)
`;

/** Every file below `dir`, relative. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

describe("renderPodBinariesPackage", () => {
  it("renders the ML Kit package", () => {
    expect(renderPodBinariesPackage(podBinariesInput(mlKit(), "15.1"))).toBe(ML_KIT_PACKAGE);
  });

  it("lists the binary targets in the product itself", () => {
    const input = podBinariesInput(mlKit(), "15.1");
    expect(input.products).toHaveLength(1);
    expect(input.products[0]!.binaryTargets).toEqual(["MLImage", "MLKit", "MLKitCommon", ...TEXT_RECOGNITION, "MLKitVision"]);
    // Row 43: the dependent library gets each binary target's headers from the product, not through the wrapper.
    const product = /\.library\(name: "GoogleMLKit", targets: \[(.*)\]\)/.exec(renderPodBinariesPackage(input))![1]!;
    for (const t of input.products[0]!.binaryTargets) expect(product).toContain(`"${t}"`);
  });

  it("covers the union of subspecs two libraries name", () => {
    const r = mlKit();
    // A second library names another root through the same pods: one product each, every pod a root reaches.
    r.resolution.roots = [
      { pod: "GoogleMLKit", libraries: [LIB] },
      { pod: "MLKitVision", libraries: ["react-native-vision"] },
    ];
    r.resolution.binary = r.resolution.binary.map((b) =>
      ["MLKitVision", "MLImage", "MLKitCommon"].includes(b.pod) ? { ...b, roots: ["GoogleMLKit", "MLKitVision"] } : b,
    );
    const input = podBinariesInput(r, "15.1");
    expect(input.products.map((p) => [p.name, p.binaryTargets])).toEqual([
      ["GoogleMLKit", ["MLImage", "MLKit", "MLKitCommon", ...TEXT_RECOGNITION, "MLKitVision"]],
      ["MLKitVision", ["MLImage", "MLKitCommon", "MLKitVision"]],
    ]);
    // The source products of the pods each root reaches.
    expect(input.products[1]!.sourceProducts.map((s) => s.product)).toContain("GTMSessionFetcherCore");
    const text = renderPodBinariesPackage(input);
    expect(text.match(/\.binaryTarget\(name: "MLKitVision"/g)).toHaveLength(1);
    expect(text).toContain('name: "MLKitVisionWrapper"');
  });

  it("names binary targets, folders and module maps from one source", async () => {
    const staged = await stagePodBinaries(paths, mlKit(), { iosMin: "15.1" });
    const text = readFileSync(path.join(staged.dir, "Package.swift"), "utf8");
    for (const m of text.matchAll(/\.binaryTarget\(name: "([^"]+)", path: "([^"]+)"\)/g)) {
      const [, name, rel] = m;
      // Row 42: the path is inside the package, named like the target, and holds the module map of that module.
      expect(rel).toBe(`xcframeworks/${name}.xcframework`);
      expect(readFileSync(path.join(staged.dir, rel!, "ios-arm64", "Headers", name!, "module.modulemap"), "utf8")).toContain(`module ${name} `);
    }
    expect(staged.binaryTargets).toEqual(["MLImage", "MLKit", "MLKitCommon", ...TEXT_RECOGNITION, "MLKitVision"]);
    expect(staged.products).toEqual(["GoogleMLKit"]);
  });

  it("stops on two binary pods that make one module", () => {
    const r = mlKit();
    r.wrapped.push(wrapped("MLKitVisionLegacy", "1.0.0", ["MLKitVision"]));
    r.resolution.binary.push(binary("MLKitVisionLegacy", "1.0.0", ["GoogleMLKit"]));
    expect(() => podBinariesInput(r, "15.1")).toThrow(
      new PodsError(`Two CocoaPods binaries make the module MLKitVision: MLKitVision 9.0.0 and MLKitVisionLegacy 1.0.0. rn-xtool cannot link both. See ${LINK}`),
    );
  });

  it("stops when the wrapper's name is a binary target's", () => {
    const r = mlKit();
    r.wrapped.push(wrapped("MLKitExtra", "1.0.0", ["GoogleMLKitWrapper"]));
    r.resolution.binary.push(binary("MLKitExtra", "1.0.0", ["GoogleMLKit"]));
    expect(() => podBinariesInput(r, "15.1")).toThrow(
      new PodsError(`The wrapper target GoogleMLKitWrapper would have the name of a binary target of MLKitExtra. See ${LINK}`),
    );
  });
});

describe("stagePodBinaries", () => {
  it("writes the package, hard links into the cache and the wrapper with its include folder", async () => {
    const r = mlKit();
    const staged = await stagePodBinaries(paths, r, { iosMin: "15.1" });
    expect(staged.dir).toBe(path.join(paths.iosBuild, POD_BINARIES_PACKAGE));
    expect(readFileSync(path.join(staged.dir, "Package.swift"), "utf8")).toBe(ML_KIT_PACKAGE);
    const all = files(staged.dir);
    expect(all).toContain("Sources/GoogleMLKitWrapper/wrapper.c");
    // Ruling 2 (G1): SwiftPM refuses a C target without its public headers folder.
    expect(all).toContain("Sources/GoogleMLKitWrapper/include/GoogleMLKitWrapper.h");
    expect(readFileSync(path.join(staged.dir, "Sources/GoogleMLKitWrapper/wrapper.c"), "utf8")).toBe(
      '// Generated by rn-xtool: GoogleMLKit\'s link to its source dependencies.\n#include "GoogleMLKitWrapper.h"\n\nvoid rn_xtool_GoogleMLKitWrapper(void) {}\n',
    );
    // GoogleMLKit is headers-only: no archive. The others: one each, hard-linked (same inode as the cache).
    expect(all.filter((f) => f.startsWith("archives/"))).toEqual(
      ["MLImage", "MLKitCommon", ...TEXT_RECOGNITION, "MLKitVision"].map((n) => `archives/lib${n}.a`).sort(),
    );
    const vision = r.wrapped.find((w) => w.pod === "MLKitVision")!.frameworks[0]!;
    expect(statSync(path.join(staged.dir, "archives/libMLKitVision.a")).ino).toBe(statSync(vision.archive!).ino);
    expect(statSync(path.join(staged.dir, "xcframeworks/MLKitVision.xcframework/Info.plist")).ino).toBe(
      statSync(path.join(vision.xcframework, "Info.plist")).ino,
    );
    expect(staged.links).toEqual({
      archives: ["MLImage", "MLKitCommon", ...TEXT_RECOGNITION, "MLKitVision"].map((n) => path.join(staged.dir, "archives", `lib${n}.a`)),
      frameworks: ["AVFoundation", "Accelerate", "CoreGraphics", "CoreImage", "CoreLocation", "CoreMedia", "CoreVideo", "Foundation", "LocalAuthentication", "UIKit"],
      libraries: ["c++", "sqlite3", "z"],
      weakFrameworks: [],
      emptyTargets: ["GTMDefines"],
    });
  });

  it("writes a .gitignore with * in pod-binaries", async () => {
    const staged = await stagePodBinaries(paths, mlKit(), { iosMin: "15.1" });
    expect(readFileSync(path.join(staged.dir, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("rebuilds the folder on every call", async () => {
    const first = await stagePodBinaries(paths, mlKit(), { iosMin: "15.1" });
    writeFileSync(path.join(first.dir, "stray.txt"), "left by hand");
    const r = mlKit();
    r.wrapped = r.wrapped.filter((w) => w.pod !== "MLKitTextRecognitionKorean");
    r.resolution.binary = r.resolution.binary.filter((b) => b.pod !== "MLKitTextRecognitionKorean");
    const second = await stagePodBinaries(paths, r, { iosMin: "15.1" });
    const all = files(second.dir);
    expect(all).not.toContain("stray.txt");
    expect(all.some((f) => f.includes("Korean"))).toBe(false);
    // No temporary or old tree is left beside it.
    expect(readdirSync(paths.iosBuild)).toEqual([POD_BINARIES_PACKAGE]);
  });

  it("refuses a folder that reaches node_modules through a link", async () => {
    const app = projectPaths(path.join(root, "linked-app"));
    const target = path.join(root, "node_modules", "some-lib", "build");
    mkdirSync(target, { recursive: true });
    mkdirSync(app.ios, { recursive: true });
    symlinkSync(target, app.iosBuild);
    await expect(stagePodBinaries(app, mlKit(), { iosMin: "15.1" })).rejects.toThrow(
      `rn-xtool writes CocoaPods binaries only outside node_modules, and ${path.join(app.iosBuild, POD_BINARIES_PACKAGE)} is inside it. See ${LINK}`,
    );
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses a folder under node_modules", async () => {
    const inside = projectPaths(path.join(root, "node_modules", "app"));
    mkdirSync(inside.ios, { recursive: true });
    await expect(stagePodBinaries(inside, mlKit(), { iosMin: "15.1" })).rejects.toThrow(
      `rn-xtool writes CocoaPods binaries only outside node_modules, and ${path.join(inside.iosBuild, POD_BINARIES_PACKAGE)} is inside it. See ${LINK}`,
    );
    expect(existsSync(path.join(inside.iosBuild, POD_BINARIES_PACKAGE))).toBe(false);
  });

  it("copies when a hard link crosses filesystems", async () => {
    const src = path.join(root, "src.txt");
    writeFileSync(src, "bytes");
    for (const code of ["EXDEV", "EPERM"]) {
      const dest = path.join(root, `dest-${code}.txt`);
      const failing = (async () => {
        throw Object.assign(new Error(code), { code });
      }) as unknown as typeof link;
      await linkOrCopy(src, dest, failing);
      expect(readFileSync(dest, "utf8")).toBe("bytes");
      expect(statSync(dest).ino).not.toBe(statSync(src).ino);
    }
    // Any other error is not a reason to copy.
    const other = (async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }) as unknown as typeof link;
    await expect(linkOrCopy(src, path.join(root, "x.txt"), other)).rejects.toThrow("EACCES");
    // Without an injected link, a real hard link.
    await linkOrCopy(src, path.join(root, "linked.txt"));
    expect(statSync(path.join(root, "linked.txt")).ino).toBe(statSync(src).ino);
  });
});

describe("appDeploymentTarget", () => {
  const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "bare", "ios", "HelloWorld.xcodeproj");

  it("reads the app's deployment target as the scaffolder does, so pod-binaries is never above the scaffolds", () => {
    expect(appDeploymentTarget(paths)).toBe("15.1");
    const xcodeproj = path.join(paths.ios, "HelloWorld.xcodeproj");
    cpSync(FIXTURE, xcodeproj, { recursive: true });
    expect(appDeploymentTarget(paths)).toBe("15.1");
    const pbxproj = path.join(xcodeproj, "project.pbxproj");
    writeFileSync(pbxproj, readFileSync(pbxproj, "utf8").replaceAll("IPHONEOS_DEPLOYMENT_TARGET = 15.1;", "IPHONEOS_DEPLOYMENT_TARGET = 16.0;"));
    expect(appDeploymentTarget(paths)).toBe("16.0");
    // React Native's floor below it.
    writeFileSync(pbxproj, readFileSync(pbxproj, "utf8").replaceAll("IPHONEOS_DEPLOYMENT_TARGET = 16.0;", "IPHONEOS_DEPLOYMENT_TARGET = 13.0;"));
    expect(appDeploymentTarget(paths)).toBe("15.1");
  });

  it("stages with the app's deployment target by default", async () => {
    cpSync(FIXTURE, path.join(paths.ios, "HelloWorld.xcodeproj"), { recursive: true });
    const staged = await stagePodBinaries(paths, mlKit());
    expect(readFileSync(path.join(staged.dir, "Package.swift"), "utf8")).toContain('platforms: [.iOS("15.1")],');
  });
});
