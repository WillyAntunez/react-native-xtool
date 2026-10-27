import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as plist from "plist";
import { afterAll, describe, expect, it } from "vitest";
import {
  JSI_HEADERS_GENERATOR_VERSION,
  JSI_HEADERS_MODULE_MAP,
  jsiHeadersXcframeworkDir,
  jsiObjectsDir,
  writeJsiHeadersXcframework,
} from "../src/pipeline/jsiHeaders.js";
import { FAKE_NATIVE_STATE, FAKE_SWIFT_HEADER, FAKE_SWIFT_INTERFACE, makeFakeJsiBuild } from "./support/fakeJsiBuild.js";

const tmp: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "rn-xtool-jsi-headers-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]))
    .sort();
}

/** A fake build plus a precompiled root, and the synthesis inputs for them. */
function setup(jsiVersion = "57.1.3") {
  const dir = mkTmp();
  const { objectsDir, jsiDir } = makeFakeJsiBuild(dir);
  const precompiledRoot = path.join(dir, "ios", "build", "expo-precompiled");
  const xcframework = path.join(precompiledRoot, "expo-modules-jsi", "output", "headers", "xcframeworks", "ExpoModulesJSIHeaders.xcframework");
  const stamp = path.join(precompiledRoot, "expo-modules-jsi", "output", "headers", ".rn-xtool-jsi-headers.json");
  return { dir, objectsDir, jsiDir, precompiledRoot, xcframework, stamp, input: { objectsDir, jsiDir, jsiVersion, precompiledRoot } };
}

const SLICES = ["ios-arm64", "ios-arm64_x86_64-simulator"];

describe("ExpoModulesJSI headers paths", () => {
  it("names the build's objects dir and 58's xcframework path", () => {
    expect(jsiObjectsDir("/app/ios-xtool/jsi-out")).toBe(
      "/app/ios-xtool/jsi-out/.jsi-build/.build/out/Intermediates.noindex/ExpoModulesJSI.build/Debug-iphoneos/ExpoModulesJSI-t.build/Objects-normal/arm64",
    );
    expect(jsiHeadersXcframeworkDir("/app/ios/build/expo-precompiled")).toBe(
      "/app/ios/build/expo-precompiled/expo-modules-jsi/output/headers/xcframeworks/ExpoModulesJSIHeaders.xcframework",
    );
  });
});

describe("writeJsiHeadersXcframework", () => {
  it("writes 58's tarball layout", async () => {
    const s = setup();
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(jsiHeadersXcframeworkDir(s.precompiledRoot)).toBe(s.xcframework);
    expect(listFiles(s.xcframework)).toEqual(
      [
        "Info.plist",
        "expo-package.json",
        "ios-arm64/ExpoModulesJSI.swiftmodule/arm64-apple-ios.swiftinterface",
        "ios-arm64/Headers/ExpoModulesJSI/ExpoModulesJSI-Swift.h",
        "ios-arm64/Headers/ExpoModulesJSI/NativeState.h",
        "ios-arm64/Headers/ExpoModulesJSI/module.modulemap",
        "ios-arm64/libExpoModulesJSIHeaders.a",
        "ios-arm64_x86_64-simulator/Headers/ExpoModulesJSI/ExpoModulesJSI-Swift.h",
        "ios-arm64_x86_64-simulator/Headers/ExpoModulesJSI/NativeState.h",
        "ios-arm64_x86_64-simulator/Headers/ExpoModulesJSI/module.modulemap",
        "ios-arm64_x86_64-simulator/libExpoModulesJSIHeaders.a",
      ].sort(),
    );
    expect(readdirSync(path.join(s.xcframework, "ios-arm64_x86_64-simulator")).sort()).toEqual(["Headers", "libExpoModulesJSIHeaders.a"]);
    expect(JSI_HEADERS_MODULE_MAP).toBe(
      'module ExpoModulesJSI {\n  header "ExpoModulesJSI-Swift.h"\n  export *\n\n  explicit module Cxx {\n    requires cplusplus\n    header "NativeState.h"\n    export *\n  }\n}\n',
    );
    for (const slice of SLICES) {
      const headers = path.join(s.xcframework, slice, "Headers", "ExpoModulesJSI");
      expect(readFileSync(path.join(headers, "module.modulemap"), "utf8")).toBe(JSI_HEADERS_MODULE_MAP);
      expect(readFileSync(path.join(headers, "ExpoModulesJSI-Swift.h"), "utf8")).toBe(FAKE_SWIFT_HEADER);
      expect(readFileSync(path.join(headers, "NativeState.h"), "utf8")).toBe(FAKE_NATIVE_STATE);
      expect(readFileSync(path.join(s.xcframework, slice, "libExpoModulesJSIHeaders.a"))).toEqual(Buffer.from("!<arch>\n"));
    }
    expect(
      readFileSync(path.join(s.xcframework, "ios-arm64", "ExpoModulesJSI.swiftmodule", "arm64-apple-ios.swiftinterface"), "utf8"),
    ).toBe(FAKE_SWIFT_INTERFACE);
    expect(JSON.parse(readFileSync(path.join(s.xcframework, "expo-package.json"), "utf8"))).toEqual({
      name: "expo-modules-jsi",
      version: "57.1.3",
    });
    expect(readFileSync(path.join(s.xcframework, "expo-package.json"), "utf8")).toBe('{"name":"expo-modules-jsi","version":"57.1.3"}\n');
    expect(JSON.parse(readFileSync(s.stamp, "utf8"))).toEqual({
      generatorVersion: JSI_HEADERS_GENERATOR_VERSION,
      jsiVersion: "57.1.3",
      interfaceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.skipIf(spawnSync("ar", ["--version"]).status !== 0)("the placeholder archives are valid", async () => {
    const s = setup();
    await writeJsiHeadersXcframework(s.input);
    for (const slice of SLICES) {
      const r = spawnSync("ar", ["t", path.join(s.xcframework, slice, "libExpoModulesJSIHeaders.a")], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("Info.plist names one archive per slice", async () => {
    const s = setup();
    await writeJsiHeadersXcframework(s.input);
    const info = plist.parse(readFileSync(path.join(s.xcframework, "Info.plist"), "utf8")) as Record<string, plist.PlistValue>;
    const libs = info.AvailableLibraries as Record<string, plist.PlistValue>[];
    expect(libs.map((l) => l.LibraryIdentifier)).toEqual(SLICES);
    for (const lib of libs) {
      expect(lib.LibraryPath).toBe("libExpoModulesJSIHeaders.a");
      expect(lib.BinaryPath).toBe("libExpoModulesJSIHeaders.a");
      expect(lib.HeadersPath).toBe("Headers");
      expect(lib.SupportedPlatform).toBe("ios");
    }
    expect(libs[0]?.SupportedArchitectures).toEqual(["arm64"]);
    expect(libs[0]?.SupportedPlatformVariant).toBeUndefined();
    expect(libs[1]?.SupportedArchitectures).toEqual(["arm64", "x86_64"]);
    expect(libs[1]?.SupportedPlatformVariant).toBe("simulator");
    expect(info.CFBundlePackageType).toBe("XFWK");
    expect(info.XCFrameworkFormatVersion).toBe("1.0");
  });

  it("reuses an unchanged xcframework", async () => {
    const s = setup();
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    const files = [path.join(s.xcframework, "Info.plist"), path.join(s.xcframework, "expo-package.json"), s.stamp];
    const before = files.map((f) => statSync(f).mtimeMs);
    await new Promise((r) => setTimeout(r, 20));
    expect(await writeJsiHeadersXcframework(s.input)).toBe("current");
    expect(files.map((f) => statSync(f).mtimeMs)).toEqual(before);
  });

  it("rewrites when the interface changes", async () => {
    const s = setup();
    await writeJsiHeadersXcframework(s.input);
    const first = JSON.parse(readFileSync(s.stamp, "utf8")) as { interfaceSha256: string };
    writeFileSync(path.join(s.objectsDir, "ExpoModulesJSI.swiftinterface"), "// changed interface\n");
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(
      readFileSync(path.join(s.xcframework, "ios-arm64", "ExpoModulesJSI.swiftmodule", "arm64-apple-ios.swiftinterface"), "utf8"),
    ).toBe("// changed interface\n");
    const second = JSON.parse(readFileSync(s.stamp, "utf8")) as { interfaceSha256: string };
    expect(second.interfaceSha256).not.toBe(first.interfaceSha256);

    expect(await writeJsiHeadersXcframework({ ...s.input, jsiVersion: "57.1.4" })).toBe("written");
    expect(JSON.parse(readFileSync(s.stamp, "utf8")).jsiVersion).toBe("57.1.4");
    expect(JSON.parse(readFileSync(path.join(s.xcframework, "expo-package.json"), "utf8")).version).toBe("57.1.4");
    expect(await writeJsiHeadersXcframework({ ...s.input, jsiVersion: "57.1.4" })).toBe("current");
  });

  it("rewrites a stamped tree whose Info.plist is gone", async () => {
    const s = setup();
    await writeJsiHeadersXcframework(s.input);
    rmSync(path.join(s.xcframework, "Info.plist"));
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(existsSync(path.join(s.xcframework, "Info.plist"))).toBe(true);
  });

  it("a failed synthesis leaves no stamped xcframework", async () => {
    const s = setup();
    const nativeStateDir = path.join(s.jsiDir, "apple", "Sources", "ExpoModulesJSI-Cxx", "include", "Public");
    const nativeState = path.join(nativeStateDir, "NativeState.h");
    rmSync(nativeState);
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(
      `The ExpoModulesJSI build produced no NativeState.h (expected in ${nativeStateDir}); cannot make ExpoModulesJSIHeaders.xcframework for expo-modules-jsi 57.1.3.`,
    );
    expect(existsSync(s.xcframework)).toBe(false);
    expect(existsSync(s.stamp)).toBe(false);
    const xcframeworks = path.dirname(s.xcframework);
    expect(existsSync(xcframeworks) ? readdirSync(xcframeworks).filter((n) => n.includes(".tmp-")) : []).toEqual([]);

    writeFileSync(nativeState, FAKE_NATIVE_STATE);
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(existsSync(s.stamp)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("a copy failing mid-synthesis keeps the previous tree and its stamp", async () => {
    const s = setup();
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    const before = new Map(listFiles(s.xcframework).map((f) => [f, readFileSync(path.join(s.xcframework, f))]));
    const stampBefore = readFileSync(s.stamp, "utf8");
    // A changed interface makes the run rewrite; an unreadable Swift header passes the input check, then fails the copy.
    writeFileSync(path.join(s.objectsDir, "ExpoModulesJSI.swiftinterface"), "// changed interface\n");
    const swiftHeader = path.join(s.objectsDir, "ExpoModulesJSI-Swift.h");
    chmodSync(swiftHeader, 0o000);
    try {
      await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(swiftHeader, 0o644);
    }
    expect(readdirSync(path.dirname(s.xcframework)).filter((n) => n.includes(".tmp-") || n.includes(".old-"))).toEqual([]);
    expect(new Map(listFiles(s.xcframework).map((f) => [f, readFileSync(path.join(s.xcframework, f))]))).toEqual(before);
    expect(readFileSync(s.stamp, "utf8")).toBe(stampBefore);
    // The surviving stamp still describes the old interface, so the next good run rewrites.
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(
      readFileSync(path.join(s.xcframework, "ios-arm64", "ExpoModulesJSI.swiftmodule", "arm64-apple-ios.swiftinterface"), "utf8"),
    ).toBe("// changed interface\n");
  });

  it("a missing build output names it", async () => {
    const s = setup();
    rmSync(path.join(s.objectsDir, "ExpoModulesJSI.swiftinterface"));
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(
      `The ExpoModulesJSI build produced no ExpoModulesJSI.swiftinterface (expected in ${s.objectsDir}); cannot make ExpoModulesJSIHeaders.xcframework for expo-modules-jsi 57.1.3.`,
    );
    expect(existsSync(s.stamp)).toBe(false);
  });
});
