import type { RuntimeFramework } from "../frameworks.js";
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
  /** Absolute. */
  headerSearchPaths: string[];
  /** CLANG_CXX_LANGUAGE_STANDARD, e.g. `gnu++20`. */
  cxxStandard?: string;
  /** Where Swift Build writes `App-Swift.h` (see `swiftHeadersDir`), for Objective-C sources. */
  swiftHeadersDir: string;
}

export interface PackageSwiftInput {
  iosDir: string;
  frameworks: RuntimeFramework[];
  iosMin: string;
  expo?: ExpoPackageInputs;
  app: AppTargetInputs;
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

/** Xcode's spellings of CLANG_CXX_LANGUAGE_STANDARD → SwiftPM's `CXXLanguageStandard`. */
const CXX_VERSIONS: Record<string, string> = {
  "98": "98", "03": "03", "0x": "11", "11": "11", "1y": "14", "14": "14",
  "1z": "1z", "17": "17", "2a": "20", "20": "20", "2b": "2b", "23": "2b",
};

function cxxLanguageStandard(value: string | undefined): string {
  const m = value?.match(/^(gnu|c)\+\+(\w+)$/);
  const version = m ? CXX_VERSIONS[m[2]!] : undefined;
  if (!m || !version) return ".cxx20";
  return `.${m[1] === "gnu" ? "gnucxx" : "cxx"}${version}`;
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

/**
 * Objective-C/C++ settings; `-I swiftHeadersDir` lets them `#import "App-Swift.h"`. In a hybrid project that header
 * does `@import Expo;`, so they also get what Swift's clang importer gets (as clang flags, without `-Xcc`): the
 * compile-interfaces frameworks (`<ExpoModulesCore/Platform.h>`) and the importer's include dirs and module maps.
 */
function appClangSettings(app: AppTargetInputs, expo: ExpoPackageInputs | undefined): string {
  if (!app.mixed) return "";
  const importer = expo?.clangImporter;
  const includes = [
    ...[...app.headerSearchPaths, app.swiftHeadersDir, ...(importer?.includeDirs ?? [])].flatMap((p) => ["-I", p]),
    ...(importer?.moduleMaps ?? []).map((m) => `-fmodule-map-file=${m}`),
    ...(expo ? ["-F", expo.compileInterfacesDir] : []),
  ];
  const body = settingLines([...app.defines.map(cDefine), flags(includes)]);
  return ["cSettings", "cxxSettings"].map((name) => `            ${name}: [\n${body}            ],\n`).join("");
}

export function renderPackageSwift(i: PackageSwiftInput): RenderedPackageSwift {
  const ios = i.iosDir;
  const { expo, app } = i;
  const jsiHeaders = expo?.jsiHeaders === true;
  const searchPaths = [...new Set(i.frameworks.map((f) => f.searchPath))];
  const linkerFlags = ["-Xlinker", "-ObjC", ...searchPaths.flatMap((p) => ["-F", p])];
  const linkedFrameworks = i.frameworks
    .map((f) => `                .linkedFramework(${lit(f.name)}),\n`)
    .join("");
  const jsiPackage = jsiHeaders
    ? `        .package(name: "ExpoModulesJSIHeaders", path: ${lit(`${ios}/build/generated/autolinking/expo/ExpoModulesJSIHeaders`)}),\n`
    : "";
  const jsiProduct = jsiHeaders
    ? `                .product(name: "ExpoModulesJSIHeaders", package: "ExpoModulesJSIHeaders"),\n`
    : "";
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
${jsiProduct}            ],
            path: "Sources/App",
${appClangSettings(app, expo)}            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
${expo ? expoSwiftSettings(expo) : ""}${appSwiftSettings(app)}            ],
            linkerSettings: [
                .linkedLibrary("c++"),
                .unsafeFlags([${linkerFlags.map(lit).join(", ")}]),
${linkedFrameworks}            ]
        ),
    ],
    swiftLanguageModes: [.v5],
    cxxLanguageStandard: ${cxxLanguageStandard(app.cxxStandard)}
)
`;
  if (!app.mixed) return { manifest };
  return { manifest, manifest65: manifest.replace(MIXED_TOOLS_VERSION, MIXED_TOOLS_VERSION_6_5) };
}
