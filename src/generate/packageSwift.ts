import type { RuntimeFramework } from "../frameworks.js";
import type { PodsLinks } from "../pods/stage.js";
import type { ClangImporterInputs } from "./expoImporter.js";

/** The Expo-only pieces of the manifest; absent for a bare project without Expo modules. */
export interface ExpoPackageInputs {
  compileInterfacesDir: string;
  clangImporter?: ClangImporterInputs;
  jsiHeaders: boolean;
}

/**
 * What the App target compiles besides Swift, read from the Xcode project for bare apps. The app's
 * resources are not SwiftPM resources (those land in `App_App.bundle`): xtool.yml copies them to the
 * bundle root.
 */
export interface AppTargetInputs {
  /** Swift and C-family sources in one target (SwiftPM mixed-language target). */
  mixed: boolean;
  /** Absolute; passed to Swift with `-import-objc-header`. */
  bridgingHeader?: string;
  /** `KEY` or `KEY=VALUE`, as in GCC_PREPROCESSOR_DEFINITIONS. */
  defines: string[];
  /** Absolute. Bare: the app's own, then React Native's bare-name dirs and the pods' forwards (`bareIncludes.ts`). */
  headerSearchPaths: string[];
  /** CLANG_CXX_LANGUAGE_STANDARD, e.g. `gnu++20`. */
  cxxStandard?: string;
  /** Where Swift Build writes `App-Swift.h` (see `swiftHeadersDir`), for Objective-C sources. */
  swiftHeadersDir: string;
  /** Absolute; the Swift importer paths of the autolinked scaffolded libraries (see `scaffoldedImporterPaths`). */
  importerPaths?: string[];
}

export interface PackageSwiftInput {
  iosDir: string;
  frameworks: RuntimeFramework[];
  iosMin: string;
  expo?: ExpoPackageInputs;
  app: AppTargetInputs;
  /** Adds the {@link DEV_SUPPORT_TARGET} target and makes the App depend on it; absent or false: manifest unchanged. */
  devSupport?: boolean;
  /**
   * The binary pods' link inputs (`stagePodBinaries`): each archive by `-force_load` (absolute paths, in this manifest
   * only, regenerated on every build), their weak frameworks, frameworks and libraries. Absent or empty: unchanged.
   */
  pods?: PodsLinks;
}

export interface RenderedPackageSwift {
  manifest: string;
  /** `Package@swift-6.5.swift`, for a mixed target only (SE-0541: mixed targets need no flag). */
  manifest65?: string;
}

const TOOLS_VERSION = "// swift-tools-version: 6.0";
const MIXED_TOOLS_VERSION = "// swift-tools-version: 6.4;(experimentalMultiLang)";
const MIXED_TOOLS_VERSION_6_5 = "// swift-tools-version: 6.5";

const lit = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const flags = (list: string[]): string => `.unsafeFlags([${list.map(lit).join(", ")}])`;
const settingLines = (lines: string[]): string => lines.map((l) => `                ${l},\n`).join("");

/** The C-family target rn-xtool copies from templates/dev-support: the Metro auto-reload helper. */
export const DEV_SUPPORT_TARGET = "RNXtoolDevSupport";

/**
 * The helper's target. The settings restate what Swift Build already does (ARC, DEBUG=1); its `+load` class is kept
 * because Swift Build links each target's object file directly.
 */
const DEV_SUPPORT_TARGET_BLOCK = `        .target(
            name: ${lit(DEV_SUPPORT_TARGET)},
            path: ${lit(`Sources/${DEV_SUPPORT_TARGET}`)},
            cSettings: [
                .define("DEBUG", to: "1", .when(configuration: .debug)),
                .unsafeFlags(["-fobjc-arc"]),
            ],
            linkerSettings: [
                .linkedFramework("Network"),
                .linkedFramework("UIKit"),
            ]
        ),
`;

/** Xcode's spellings of CLANG_CXX_LANGUAGE_STANDARD → SwiftPM's `CXXLanguageStandard`. */
const CXX_VERSIONS: Record<string, string> = {
  "98": "98", "03": "03", "0x": "11", "11": "11", "1y": "14", "14": "14",
  "1z": "1z", "17": "17", "2a": "20", "20": "20", "2b": "2b", "23": "2b",
};

/** The app's C++ standard, C++20 when absent or unknown. */
function cxxStandard(value: string | undefined): { gnu: boolean; version: string } {
  const m = value?.match(/^(gnu|c)\+\+(\w+)$/);
  const version = m ? CXX_VERSIONS[m[2]!] : undefined;
  return m && version ? { gnu: m[1] === "gnu", version } : { gnu: false, version: "20" };
}

function cxxLanguageStandard(value: string | undefined): string {
  const { gnu, version } = cxxStandard(value);
  return `.${gnu ? "gnucxx" : "cxx"}${version}`;
}

/** The same standard as a clang flag, e.g. `-std=gnu++20`. */
function cxxStandardFlag(value: string | undefined): string {
  const { gnu, version } = cxxStandard(value);
  return `-std=${gnu ? "gnu" : "c"}++${version}`;
}

function cDefine(entry: string): string {
  const eq = entry.indexOf("=");
  return eq < 0 ? `.define(${lit(entry)})` : `.define(${lit(entry.slice(0, eq))}, to: ${lit(entry.slice(eq + 1))})`;
}

function expoSwiftSettings(expo: ExpoPackageInputs): string {
  const importer = expo.clangImporter;
  const importerFlags = importer
    ? [
        `-I${importer.swiftHeadersDir}`,
        ...importer.includeDirs.map((d) => `-I${d}`),
        ...importer.moduleMaps.map((m) => `-fmodule-map-file=${m}`),
      ].flatMap((f) => ["-Xcc", f])
    : [];
  return `                // CocoaPods sets these for the app; ExpoModulesProvider.swift registers debug-only
                // modules (expo-dev-launcher, expo-dev-menu) under EXPO_CONFIGURATION_DEBUG.
                .define("EXPO_CONFIGURATION_DEBUG", .when(configuration: .debug)),
                .define("EXPO_CONFIGURATION_RELEASE", .when(configuration: .release)),
${settingLines([flags(["-F", expo.compileInterfacesDir]), ...(importerFlags.length ? [flags(importerFlags)] : [])])}`;
}

/** Swift reads the bridging header with the target's include paths and defines, as Xcode passes them. */
function appSwiftSettings(app: AppTargetInputs): string {
  if (!app.bridgingHeader) return "";
  const clang = [...app.headerSearchPaths.map((p) => `-I${p}`), ...app.defines.map((d) => `-D${d}`)];
  return settingLines([flags(["-import-objc-header", app.bridgingHeader, ...clang.flatMap((f) => ["-Xcc", f])])]);
}

/** Swift builds a scaffolded library's module from its headers in each importer, the App too: give it what it needs. */
function importerSwiftSettings(app: AppTargetInputs): string {
  const paths = app.importerPaths ?? [];
  return paths.length ? settingLines([flags(paths.flatMap((p) => ["-Xcc", `-I${p}`]))]) : "";
}

/**
 * Objective-C/C++ settings; `-I swiftHeadersDir` lets them `#import "App-Swift.h"`. In a hybrid project that header
 * does `@import Expo;`, so they also get what Swift's clang importer gets (as clang flags, without `-Xcc`): the
 * compile-interfaces frameworks (`<ExpoModulesCore/Platform.h>`) and the importer's include dirs and module maps.
 * Swift Build does not apply the package's `cxxLanguageStandard` to a mixed target, so its ObjC++/C++ files get the
 * standard as `-std=` (C++ only: on a C/Objective-C file the flag is rejected) or compile with clang's default and
 * fail on React Native's C++20 headers.
 */
function appClangSettings(app: AppTargetInputs, expo: ExpoPackageInputs | undefined): string {
  if (!app.mixed) return "";
  const importer = expo?.clangImporter;
  const includes = [
    ...[...app.headerSearchPaths, app.swiftHeadersDir, ...(importer?.includeDirs ?? [])].flatMap((p) => ["-I", p]),
    ...(importer?.moduleMaps ?? []).map((m) => `-fmodule-map-file=${m}`),
    ...(expo ? ["-F", expo.compileInterfacesDir] : []),
  ];
  const shared = [...app.defines.map(cDefine), flags(includes)];
  const section = (name: string, lines: string[]) => `            ${name}: [\n${settingLines(lines)}            ],\n`;
  return section("cSettings", shared) + section("cxxSettings", [...shared, flags([cxxStandardFlag(app.cxxStandard)])]);
}

export function renderPackageSwift(i: PackageSwiftInput): RenderedPackageSwift {
  const ios = i.iosDir;
  const { expo, app } = i;
  const jsiHeaders = expo?.jsiHeaders === true;
  const searchPaths = [...new Set(i.frameworks.map((f) => f.searchPath))];
  const pods = i.pods;
  const archives = pods?.archives ?? [];
  const linkerFlags = [
    "-Xlinker",
    "-ObjC",
    ...searchPaths.flatMap((p) => ["-F", p]),
    // Each binary pod archive once, whole: its +load classes register at launch (spec goal 2.4); never -all_load.
    ...archives.flatMap((a) => ["-Xlinker", "-force_load", "-Xlinker", a]),
    ...(pods?.weakFrameworks ?? []).flatMap((w) => ["-Xlinker", "-weak_framework", "-Xlinker", w]),
    // Row 80: xtool's ld64.lld 21 crashes on ML Kit's MLKitTextRecognitionCommon object while it builds relative
    // method lists (ObjCMethListSection), so they stay absolute, as before Xcode 14, when binary pods are linked.
    ...(archives.length > 0 ? ["-Xlinker", "-no_objc_relative_method_lists"] : []),
  ];
  const runtime = new Set(i.frameworks.map((f) => f.name));
  const podFrameworks = [...new Set(pods?.frameworks ?? [])].filter((f) => !runtime.has(f)).sort();
  // c++ is linked already.
  const podLibraries = [...new Set(pods?.libraries ?? [])].filter((l) => l !== "c++").sort();
  const linkedFrameworks = [
    ...i.frameworks.map((f) => `                .linkedFramework(${lit(f.name)}),\n`),
    ...podFrameworks.map((f) => `                .linkedFramework(${lit(f)}),\n`),
    ...podLibraries.map((l) => `                .linkedLibrary(${lit(l)}),\n`),
  ].join("");
  const jsiPackage = jsiHeaders
    ? `        .package(name: "ExpoModulesJSIHeaders", path: ${lit(`${ios}/build/generated/autolinking/expo/ExpoModulesJSIHeaders`)}),\n`
    : "";
  const jsiProduct = jsiHeaders
    ? `                .product(name: "ExpoModulesJSIHeaders", package: "ExpoModulesJSIHeaders"),\n`
    : "";
  const devSupportDependency = i.devSupport ? `                ${lit(DEV_SUPPORT_TARGET)},\n` : "";
  const devSupportTarget = i.devSupport ? DEV_SUPPORT_TARGET_BLOCK : "";
  const manifest = `${app.mixed ? MIXED_TOOLS_VERSION : TOOLS_VERSION}
// Generated by rn-xtool. Do not edit; re-run \`rn-xtool build\`.
import PackageDescription

let package = Package(
    name: "AppXtool",
    platforms: [.iOS(${lit(i.iosMin)})],
    products: [
        .library(name: "App", targets: ["App"]),
    ],
    dependencies: [
        .package(name: "ReactNative", path: ${lit(`${ios}/build/xcframeworks`)}),
        .package(name: "React-GeneratedCode", path: ${lit(`${ios}/build/generated/ios`)}),
        .package(name: "Autolinked", path: ${lit(`${ios}/build/generated/autolinking`)}),
${jsiPackage}    ],
    targets: [
        .target(
            name: "App",
            dependencies: [
                .product(name: "ReactHeaders", package: "ReactNative"),
                .product(name: "ReactNativeHeaders", package: "ReactNative"),
                .product(name: "ReactNativeDependenciesHeaders", package: "ReactNative"),
                .product(name: "ReactCodegen", package: "React-GeneratedCode"),
                .product(name: "ReactAppDependencyProvider", package: "React-GeneratedCode"),
                .product(name: "Autolinked", package: "Autolinked"),
${jsiProduct}${devSupportDependency}            ],
            path: "Sources/App",
${appClangSettings(app, expo)}            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
${expo ? expoSwiftSettings(expo) : ""}${appSwiftSettings(app)}${importerSwiftSettings(app)}            ],
            linkerSettings: [
                .linkedLibrary("c++"),
                .unsafeFlags([${linkerFlags.map(lit).join(", ")}]),
${linkedFrameworks}            ]
        ),
${devSupportTarget}    ],
    swiftLanguageModes: [.v5],
    cxxLanguageStandard: ${cxxLanguageStandard(app.cxxStandard)}
)
`;
  if (!app.mixed) return { manifest };
  return { manifest, manifest65: manifest.replace(MIXED_TOOLS_VERSION, MIXED_TOOLS_VERSION_6_5) };
}
