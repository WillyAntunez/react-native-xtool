/**
 * Miniature React Native artifact slots (`~/Library/Caches/ReactNative/spm-artifacts/<v>/<flavor>`) for adapter tests.
 * File contents are placeholders; only the layout mirrors the real slots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as plist from "plist";

const SLICES = [
  { id: "ios-arm64", archs: ["arm64"] },
  { id: "ios-arm64_x86_64-simulator", archs: ["arm64", "x86_64"], variant: "simulator" },
] as const;

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** An xcframework Info.plist with the two iOS slices; `binary` maps a slice to its BinaryPath/LibraryPath. */
function xcframeworkInfoPlist(binary: (slice: string) => { binaryPath: string; libraryPath: string; headersPath?: string }): string {
  return plist.build({
    AvailableLibraries: SLICES.map((s) => {
      const b = binary(s.id);
      return {
        BinaryPath: b.binaryPath,
        ...(b.headersPath ? { HeadersPath: b.headersPath } : {}),
        LibraryIdentifier: s.id,
        LibraryPath: b.libraryPath,
        SupportedArchitectures: [...s.archs],
        SupportedPlatform: "ios",
        ...("variant" in s ? { SupportedPlatformVariant: s.variant } : {}),
      };
    }),
    CFBundlePackageType: "XFWK",
    XCFrameworkFormatVersion: "1.0",
  });
}

function frameworkInfoPlist(name: string): string {
  return plist.build({ CFBundleExecutable: name, CFBundleIdentifier: `com.example.${name}`, CFBundlePackageType: "FMWK" });
}

const header = (rel: string) => `// ${rel}\n#pragma once\n`;

/** RN 0.86's VFS mappings, physical path relative to `${ROOT_PATH}/Headers`, in template order. */
const VFS_086: readonly (readonly [virtualDir: string, file: string, physical: string])[] = [
  ["React", "RCTBridge.h", "React_Core/React/RCTBridge.h"],
  ["React_RCTAppDelegate", "RCTReactNativeFactory.h", "React_RCTAppDelegate/React_RCTAppDelegate/RCTReactNativeFactory.h"],
  ["yoga", "Yoga.h", "Yoga/yoga/Yoga.h"],
  ["ReactCommon", "RCTPerformanceLoggerUtils.h", "React_NativeModulesApple/ReactCommon/RCTPerformanceLoggerUtils.h"],
];

/** React-VFS-template.yaml in RN's own format (one root, nested directories, single-quoted scalars). */
function vfsTemplate086(): string {
  const lines = ["version: 0", "case-sensitive: false", "roots:", "  - name: '${ROOT_PATH}/Headers'", "    type: 'directory'", "    contents:"];
  for (const [dir, file, physical] of VFS_086) {
    lines.push(
      `      - name: '${dir}'`,
      "        type: 'directory'",
      "        contents:",
      `          - name: '${file}'`,
      "            type: 'file'",
      `            external-contents: '\${ROOT_PATH}/Headers/${physical}'`,
    );
  }
  return lines.join("\n") + "\n";
}

/** The physical `Headers/` of RN 0.86's React.framework (also copied to the top of React.xcframework). */
function writeReactHeaders086(headersDir: string): void {
  for (const [, , physical] of VFS_086) write(path.join(headersDir, physical), header(physical));
  write(path.join(headersDir, "React_Core", "React_Core-umbrella.h"), '#import "RCTBridge.h"\n');
  write(path.join(headersDir, "ReactCommon", "RCTTurboModuleWithJSIBindings.h"), header("ReactCommon/RCTTurboModuleWithJSIBindings.h"));
}

function writeArtifactsJson(dir: string, names: readonly string[]): void {
  const entries = Object.fromEntries(
    names.map((n) => [n, { xcframeworkPath: path.join(dir, `${n}.xcframework`), url: `https://example.invalid/${n}.tar.gz` }]),
  );
  write(path.join(dir, "artifacts.json"), JSON.stringify(entries, null, 2) + "\n");
}

/**
 * A pre-headers-spec slot as RN 0.86.x ships it: React.framework with per-pod physical headers and a clang VFS
 * template; the physical headers also sit in a top-level `React.xcframework/Headers/` (what `${ROOT_PATH}/Headers`
 * resolves to); dependency headers inside ReactNativeDependencies.xcframework/Headers; no ReactNativeHeaders.
 */
export function makeFakeSlot086(dir: string): void {
  const react = path.join(dir, "React.xcframework");
  write(path.join(react, "Info.plist"), xcframeworkInfoPlist(() => ({ binaryPath: "React.framework/React", libraryPath: "React.framework" })));
  write(path.join(react, "React-VFS-template.yaml"), vfsTemplate086());
  writeReactHeaders086(path.join(react, "Headers"));
  for (const { id } of SLICES) {
    const fw = path.join(react, id, "React.framework");
    write(path.join(fw, "React"), `bin-${id}`);
    write(path.join(fw, "Info.plist"), frameworkInfoPlist("React"));
    writeReactHeaders086(path.join(fw, "Headers"));
  }

  const deps = path.join(dir, "ReactNativeDependencies.xcframework");
  write(
    path.join(deps, "Info.plist"),
    xcframeworkInfoPlist(() => ({
      binaryPath: "ReactNativeDependencies.framework/ReactNativeDependencies",
      libraryPath: "ReactNativeDependencies.framework",
    })),
  );
  write(path.join(deps, "Headers", "folly", "dynamic.h"), header("folly/dynamic.h"));
  for (const { id } of SLICES) {
    write(path.join(deps, id, "ReactNativeDependencies.framework", "ReactNativeDependencies"), `bin-${id}`);
  }

  write(
    path.join(dir, "hermes-engine.xcframework", "Info.plist"),
    xcframeworkInfoPlist(() => ({ binaryPath: "hermesvm.framework/hermesvm", libraryPath: "hermesvm.framework" })),
  );
  write(path.join(dir, "hermes-headers", "hermes", "hermes.h"), header("hermes/hermes.h"));
  writeArtifactsJson(dir, ["React", "ReactNativeDependencies", "hermes-engine"]);
}

/**
 * A headers-spec slot as RN 0.87.1+ ships it: flat React.framework headers, ReactNativeHeaders and
 * ReactNativeDependenciesHeaders xcframeworks (headers plus a placeholder static library per slice).
 */
export function makeFakeSlot088(dir: string): void {
  const react = path.join(dir, "React.xcframework");
  write(path.join(react, "Info.plist"), xcframeworkInfoPlist(() => ({ binaryPath: "React.framework/React", libraryPath: "React.framework" })));
  for (const { id } of SLICES) {
    const fw = path.join(react, id, "React.framework");
    write(path.join(fw, "React"), `bin-${id}`);
    write(path.join(fw, "Info.plist"), frameworkInfoPlist("React"));
    write(path.join(fw, "Headers", "RCTBridge.h"), header("React/RCTBridge.h"));
    write(path.join(fw, "Headers", "React-umbrella.h"), '#import "RCTBridge.h"\n');
    write(
      path.join(fw, "Modules", "module.modulemap"),
      'framework module React {\n  umbrella header "React-umbrella.h"\n  export *\n  module * { export * }\n}\n',
    );
  }

  const headersXcframework = (name: string, files: Record<string, string>) => {
    const xc = path.join(dir, `${name}.xcframework`);
    const lib = (slice: string) => `lib${name}-${slice}.a`;
    write(path.join(xc, "Info.plist"), xcframeworkInfoPlist((s) => ({ binaryPath: lib(s), libraryPath: lib(s), headersPath: "Headers" })));
    for (const { id } of SLICES) {
      write(path.join(xc, id, lib(id)), "!<arch>\n");
      for (const [rel, content] of Object.entries(files)) write(path.join(xc, id, "Headers", rel), content);
    }
  };
  headersXcframework("ReactNativeHeaders", {
    "yoga/Yoga.h": header("yoga/Yoga.h"),
    "hermes/hermes.h": header("hermes/hermes.h"),
    "module.modulemap": 'module yoga {\n  header "yoga/Yoga.h"\n  export *\n}\n',
  });
  headersXcframework("ReactNativeDependenciesHeaders", { "folly/dynamic.h": header("folly/dynamic.h") });

  const deps = path.join(dir, "ReactNativeDependencies.xcframework");
  write(
    path.join(deps, "Info.plist"),
    xcframeworkInfoPlist(() => ({
      binaryPath: "ReactNativeDependencies.framework/ReactNativeDependencies",
      libraryPath: "ReactNativeDependencies.framework",
    })),
  );
  for (const { id } of SLICES) {
    write(path.join(deps, id, "ReactNativeDependencies.framework", "ReactNativeDependencies"), `bin-${id}`);
  }

  write(
    path.join(dir, "hermes-engine.xcframework", "Info.plist"),
    xcframeworkInfoPlist(() => ({ binaryPath: "hermesvm.framework/hermesvm", libraryPath: "hermesvm.framework" })),
  );
  write(path.join(dir, "hermes-headers", "hermes", "hermes.h"), header("hermes/hermes.h"));
  writeArtifactsJson(dir, ["React", "ReactNativeDependencies", "hermes-engine", "ReactNativeHeaders", "ReactNativeDependenciesHeaders"]);
}
