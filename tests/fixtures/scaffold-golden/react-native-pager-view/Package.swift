// swift-tools-version: 6.4;(experimentalMultiLang)
// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.
// AUTO-SCAFFOLDED-VERSION: 20
// rn-xtool-scaffold-revision: 3
// rn-xtool-swift-importer-paths: ["ios",".","rn-spm-swift"]
// Cache slot: 0.86.3/dual-flavor
// Edit the contents below if needed and re-run `npx patch-package <dep-name>`
// to persist across `npm install`. To regenerate from the podspec, remove
// this file (or just this marker) and re-run `npx react-native spm scaffold`.
//
// Package references are plain relative paths, computed when this file was
// scaffolded. They stay correct because the file is re-scaffolded per app
// and cache slot, and any node_modules relayout reinstalls this package
// (dropping the file) anyway.

import PackageDescription

// Mixed Swift + Objective-C target (one SwiftPM mixed-language target). Objective-C
// finds react-native-pager-view-Swift.h in the directory Swift Build writes it to,
// which belongs to the root build: the build passes it in
// RN_SPM_SWIFT_HEADERS_DIR. Swift sees the module's Objective-C through
// rn-spm-swift/umbrella.h.
let rnSpmSwiftHeadersDir = Context.environment["RN_SPM_SWIFT_HEADERS_DIR"]
    ?? (Context.packageDirectory + "/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos")
let rnSpmBridgingHeader = Context.packageDirectory + "/rn-spm-swift/umbrella.h"

let package = Package(
    name: "react-native-pager-view",
    platforms: [.iOS("16.4")],
    products: [
        .library(name: "react-native-pager-view", targets: ["react-native-pager-view"]),
    ],
    dependencies: [
        .package(name: "ReactNative", path: "../../../../xcframeworks"),
        .package(name: "React-GeneratedCode", path: "../../../ios"),
        .package(url: "https://github.com/siteline/swiftui-introspect", exact: "1.5.0"),
    ],
    targets: [
        .target(
            name: "react-native-pager-view",
            dependencies: [.product(name: "ReactHeaders", package: "ReactNative"), .product(name: "ReactNativeHeaders", package: "ReactNative"), .product(name: "ReactNativeDependenciesHeaders", package: "ReactNative"), .product(name: "ReactAppHeaders", package: "React-GeneratedCode"), .product(name: "SwiftUIIntrospect", package: "swiftui-introspect")],
            path: ".",
            sources: [
                "ios/Extensions.swift",
                "ios/PagerScrollDelegate.swift",
                "ios/PagerView.swift",
                "ios/PagerViewProps.swift",
                "ios/PagerViewProvider.swift",
                "ios/RCTOnPageScrollEvent.h",
                "ios/RCTOnPageScrollEvent.m",
                "ios/RNCPagerViewComponentView.h",
                "ios/RNCPagerViewComponentView.mm",
            ],
            publicHeadersPath: "ios",
            cSettings: [.define("RCT_NEW_ARCH_ENABLED", to: "1"), .headerSearchPath("ios"), .headerSearchPath("."), .headerSearchPath("rn-spm-swift"), .unsafeFlags(["-include", "react-native-spm-prefix.h"]), .unsafeFlags(["-I", rnSpmSwiftHeadersDir])],
            cxxSettings: [.define("RCT_NEW_ARCH_ENABLED", to: "1"), .headerSearchPath("ios"), .headerSearchPath("."), .headerSearchPath("rn-spm-swift"), .unsafeFlags(["-include", "react-native-spm-prefix.h"]), .unsafeFlags(["-I", rnSpmSwiftHeadersDir]), .unsafeFlags(["-std=c++20"]), .define("DEBUG", .when(configuration: .debug)), .define("NDEBUG", .when(configuration: .release))],
            swiftSettings: [.unsafeFlags(["-import-objc-header", rnSpmBridgingHeader])],
            linkerSettings: [.linkedFramework("UIKit"), .linkedFramework("Foundation"), .linkedFramework("CoreGraphics")]
        ),
    ],
    cxxLanguageStandard: .cxx20
)
