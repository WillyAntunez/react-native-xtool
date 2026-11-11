import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { UnreadableInterfaceError } from "../src/pipeline/jsiInterface.js";
import {
  FAKE_NATIVE_STATE,
  FAKE_NATIVE_STATE_FLAT,
  FAKE_RETAINED_POINTER,
  FAKE_SWIFT_HEADER,
  FAKE_SWIFT_INTERFACE,
  makeFakeJsiBuild,
} from "./support/fakeJsiBuild.js";

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

/** A fake build (in jsi 57's header layout unless `layout` says otherwise) plus a precompiled root, and the synthesis inputs for them. */
function setup(jsiVersion = "57.1.3", layout: "public" | "flat" = "public") {
  const dir = mkTmp();
  const { objectsDir, jsiDir } = makeFakeJsiBuild(dir, { layout });
  const include = path.join(jsiDir, "apple", "Sources", "ExpoModulesJSI-Cxx", "include");
  const precompiledRoot = path.join(dir, "ios", "build", "expo-precompiled");
  const xcframework = path.join(precompiledRoot, "expo-modules-jsi", "output", "headers", "xcframeworks", "ExpoModulesJSIHeaders.xcframework");
  const stamp = path.join(precompiledRoot, "expo-modules-jsi", "output", "headers", ".rn-xtool-jsi-headers.json");
  return { dir, objectsDir, jsiDir, include, precompiledRoot, xcframework, stamp, input: { objectsDir, jsiDir, jsiVersion, precompiledRoot } };
}

const SLICES = ["ios-arm64", "ios-arm64_x86_64-simulator"];

/** The files of 58's tarball layout. */
const LAYOUT_58 = [
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
];

/** Asserts that a failed run left neither the xcframework, a half-written `*.tmp-*` tree nor the stamp. */
function expectNothingWritten(s: ReturnType<typeof setup>) {
  expect(existsSync(s.xcframework)).toBe(false);
  expect(existsSync(s.stamp)).toBe(false);
  const xcframeworks = path.dirname(s.xcframework);
  expect(existsSync(xcframeworks) ? readdirSync(xcframeworks).filter((n) => n.includes(".tmp-")) : []).toEqual([]);
}

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
    expect(listFiles(s.xcframework)).toEqual([...LAYOUT_58].sort());
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

  it("writes jsi 56's layout: NativeState.h from include/ with its local includes", async () => {
    const s = setup("56.0.14", "flat");
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(listFiles(s.xcframework)).toEqual(
      [
        ...LAYOUT_58,
        "ios-arm64/Headers/ExpoModulesJSI/RetainedSwiftPointer.h",
        "ios-arm64_x86_64-simulator/Headers/ExpoModulesJSI/RetainedSwiftPointer.h",
      ].sort(),
    );
    for (const slice of SLICES) {
      const headers = path.join(s.xcframework, slice, "Headers", "ExpoModulesJSI");
      expect(readFileSync(path.join(headers, "NativeState.h"), "utf8")).toBe(FAKE_NATIVE_STATE_FLAT);
      expect(readFileSync(path.join(headers, "RetainedSwiftPointer.h"), "utf8")).toBe(FAKE_RETAINED_POINTER);
      expect(readFileSync(path.join(headers, "module.modulemap"), "utf8")).toBe(JSI_HEADERS_MODULE_MAP);
    }
  });

  it("prefers include/Public when both layouts hold NativeState.h", async () => {
    const s = setup();
    writeFileSync(path.join(s.include, "NativeState.h"), "// the other NativeState.h\n");
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    for (const slice of SLICES) {
      expect(readFileSync(path.join(s.xcframework, slice, "Headers", "ExpoModulesJSI", "NativeState.h"), "utf8")).toBe(
        FAKE_NATIVE_STATE,
      );
    }
    expect(listFiles(s.xcframework)).toEqual([...LAYOUT_58].sort());
  });

  it("names a local include that is not next to NativeState.h", async () => {
    const s = setup("56.0.14", "flat");
    rmSync(path.join(s.include, "RetainedSwiftPointer.h"));
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(
      `NativeState.h of expo-modules-jsi 56.0.14 includes "RetainedSwiftPointer.h", which is not next to it in ${s.include}; ` +
        "cannot make ExpoModulesJSIHeaders.xcframework.",
    );
    expectNothingWritten(s);
  });

  it("names the header that holds an include that is not there", async () => {
    const s = setup("56.0.14", "flat");
    writeFileSync(path.join(s.include, "RetainedSwiftPointer.h"), `${FAKE_RETAINED_POINTER}#include "Missing.h"\n`);
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(
      `RetainedSwiftPointer.h of expo-modules-jsi 56.0.14 includes "Missing.h", which is not next to it in ${s.include}; ` +
        "cannot make ExpoModulesJSIHeaders.xcframework.",
    );
    expectNothingWritten(s);
  });

  it.each([
    ["a relative path out of the folder", () => "../Outside.h"],
    ["an absolute path", (s: ReturnType<typeof setup>) => path.join(s.dir, "Outside.h")],
  ])("refuses an include that points outside the folder: %s", async (_how, include) => {
    const s = setup("56.0.14", "flat");
    // The header exists where the include points, so only the folder check stops the copy.
    writeFileSync(path.join(s.include, "..", "Outside.h"), "#pragma once\n");
    writeFileSync(path.join(s.dir, "Outside.h"), "#pragma once\n");
    writeFileSync(path.join(s.include, "RetainedSwiftPointer.h"), `${FAKE_RETAINED_POINTER}#include "${include(s)}"\n`);
    const before = listFiles(s.dir);
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(
      `RetainedSwiftPointer.h of expo-modules-jsi 56.0.14 includes "${include(s)}", which points outside ${s.include}; ` +
        "cannot make ExpoModulesJSIHeaders.xcframework.",
    );
    expectNothingWritten(s);
    expect(listFiles(s.dir)).toEqual(before);
  });

  it("resolves an include next to the header that holds it, in a nested folder", async () => {
    const s = setup("56.0.14", "flat");
    writeFileSync(path.join(s.include, "NativeState.h"), `${FAKE_NATIVE_STATE_FLAT}#include "detail/Inner.h"\n`);
    mkdirSync(path.join(s.include, "detail"));
    writeFileSync(path.join(s.include, "detail", "Inner.h"), '#pragma once\n#include "Leaf.h"\n');
    writeFileSync(path.join(s.include, "detail", "Leaf.h"), "// detail/Leaf.h\n");
    // A header of the same name next to NativeState.h is not the one detail/Inner.h includes.
    writeFileSync(path.join(s.include, "Leaf.h"), "// Leaf.h\n");
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    const headers = path.join(s.xcframework, "ios-arm64", "Headers", "ExpoModulesJSI");
    expect(listFiles(headers)).toEqual(
      ["ExpoModulesJSI-Swift.h", "NativeState.h", "RetainedSwiftPointer.h", "detail/Inner.h", "detail/Leaf.h", "module.modulemap"].sort(),
    );
    expect(readFileSync(path.join(headers, "detail", "Leaf.h"), "utf8")).toBe("// detail/Leaf.h\n");
  });

  it("names a nested header's include that is not next to it", async () => {
    const s = setup("56.0.14", "flat");
    writeFileSync(path.join(s.include, "NativeState.h"), `${FAKE_NATIVE_STATE_FLAT}#include "detail/Inner.h"\n`);
    mkdirSync(path.join(s.include, "detail"));
    writeFileSync(path.join(s.include, "detail", "Inner.h"), '#pragma once\n#include "RetainedSwiftPointer.h"\n');
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(
      `detail/Inner.h of expo-modules-jsi 56.0.14 includes "RetainedSwiftPointer.h", which is not next to it in ` +
        `${path.join(s.include, "detail")}; cannot make ExpoModulesJSIHeaders.xcframework.`,
    );
    expectNothingWritten(s);
  });

  it("follows #import as #include", async () => {
    const s = setup("56.0.14", "flat");
    writeFileSync(path.join(s.include, "NativeState.h"), `${FAKE_NATIVE_STATE_FLAT}#import "Imported.h"\n`);
    writeFileSync(path.join(s.include, "Imported.h"), "#pragma once\n");
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(listFiles(path.join(s.xcframework, "ios-arm64", "Headers", "ExpoModulesJSI"))).toContain("Imported.h");
  });

  it("follows quoted includes transitively, each once", async () => {
    const s = setup("56.0.14", "flat");
    writeFileSync(path.join(s.include, "RetainedSwiftPointer.h"), `${FAKE_RETAINED_POINTER}#include "Extra.h"\n`);
    writeFileSync(path.join(s.include, "Extra.h"), '#pragma once\n#include "RetainedSwiftPointer.h"\n#include "NativeState.h"\n');
    writeFileSync(path.join(s.include, "Unused.h"), "#pragma once\n");
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(listFiles(path.join(s.xcframework, "ios-arm64", "Headers", "ExpoModulesJSI"))).toEqual(
      ["Extra.h", "ExpoModulesJSI-Swift.h", "NativeState.h", "RetainedSwiftPointer.h", "module.modulemap"].sort(),
    );
  });

  it.skipIf(spawnSync("ar", ["--version"]).status !== 0)("the placeholder archives are valid (needs ar)", async () => {
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
    const nativeState = path.join(s.include, "Public", "NativeState.h");
    rmSync(nativeState);
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(
      `expo-modules-jsi 57.1.3 ships no NativeState.h (looked in ${s.include}/Public and ${s.include}); cannot make ExpoModulesJSIHeaders.xcframework.`,
    );
    expectNothingWritten(s);

    writeFileSync(nativeState, FAKE_NATIVE_STATE);
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    expect(existsSync(s.stamp)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("a copy failing mid-synthesis keeps the previous tree and its stamp (needs a non-root user)", async () => {
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

  it("stops at the jsi step on an unreadable interface, leaving no stamped tree", async () => {
    const s = setup("56.0.14", "flat");
    writeFileSync(
      path.join(s.objectsDir, "ExpoModulesJSI.swiftinterface"),
      "// swift-compiler-version: Swift version 6.4.1 (swift-6.4.1-RELEASE)\nextension Swift::Set :  where Element : SomethingElse {}\n",
    );
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(UnreadableInterfaceError);
    expectNothingWritten(s);
  });

  it("refuses an unreadable interface even when the stamp says the tree is current", async () => {
    const s = setup();
    expect(await writeJsiHeadersXcframework(s.input)).toBe("written");
    const stamp = JSON.parse(readFileSync(s.stamp, "utf8")) as { interfaceSha256: string };
    const bad = "extension Swift::Set :  where Element : SomethingElse {}\n";
    writeFileSync(path.join(s.objectsDir, "ExpoModulesJSI.swiftinterface"), bad);
    // A stamp that already names the unreadable interface, as a tree written before the guard existed would.
    stamp.interfaceSha256 = createHash("sha256").update(bad).digest("hex");
    writeFileSync(s.stamp, JSON.stringify(stamp));
    await expect(writeJsiHeadersXcframework(s.input)).rejects.toThrow(UnreadableInterfaceError);
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
