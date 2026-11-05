import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as plist from "plist";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import { EMPTY_AR_ARCHIVE, readXcframeworkLibraries, swapIn } from "../../src/pipeline/rnArtifacts.js";
import { makeArRunner, type ArRunner } from "../../src/pods/ar.js";
import { PodsError } from "../../src/pods/format.js";
import { PLATFORM_IOS, readBinary } from "../../src/pods/macho.js";
import { parsePodSpec, selectedLayers } from "../../src/pods/spec.js";
import { POD_SLICE } from "../../src/pods/xcframework.js";
import { WRAPPED_STAMP, wrapPod, type WrappedPod } from "../../src/pods/wrap.js";
import { IOS_MIN } from "../../src/versions.js";
import { fixtureSpec } from "../support/podFixtures.js";
import { arArchive, fat, machO, type Cpu } from "../support/macho.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
const LIB = "@react-native-ml-kit/text-recognition";
const SHA = "b".repeat(64);
const IOS = { platform: PLATFORM_IOS, minos: "15.5" };
const SIMULATOR = { platform: 7, minos: "15.5" };
const obj = (cpu: Cpu = "arm64", payload = "code"): Buffer => machO({ cpu, build: cpu === "arm64" ? IOS : undefined, payload });
const lib = (cpu: Cpu = "arm64"): Buffer => arArchive([{ name: `${cpu}_object_with_a_long_name.o`, data: obj(cpu) }], { symdef: true });

let root: string;
let extracted: string;
let cache: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pods-wrap-"));
  extracted = path.join(root, "extracted");
  cache = path.join(root, "cache");
  mkdirSync(extracted);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, data: string | Buffer = ""): void {
  const p = path.join(extracted, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
}

/** `<rel>/<Name>.framework` with its binary, an umbrella header and a framework module map. */
function framework(rel: string, binary: Buffer | undefined, opts: { moduleMap?: string | false; extra?: Record<string, string> } = {}): void {
  const name = path.basename(rel, ".framework");
  if (binary !== undefined) write(`${rel}/${name}`, binary);
  write(`${rel}/Headers/${name}.h`, `// ${name}`);
  if (opts.moduleMap !== false) {
    write(`${rel}/Modules/module.modulemap`, opts.moduleMap ?? `framework module ${name} {\n  umbrella header "${name}.h"\n  export *\n  module * { export * }\n  link "c++"\n}\n`);
  }
  for (const [f, text] of Object.entries(opts.extra ?? {})) write(`${rel}/${f}`, text);
}

function podSpec(pod: string, extra: Record<string, unknown> = {}) {
  return parsePodSpec(
    {
      name: pod,
      version: "1.0.0",
      homepage: "https://example.invalid/pod",
      license: { type: "Copyright", text: "Copyright 2026 Example" },
      authors: "Example",
      source: { http: `https://example.invalid/dl/${pod}-1.0.0.tar.gz` },
      platforms: { ios: "15.5" },
      ...extra,
    },
    { pod, version: "1.0.0" },
  );
}

/** A fake llvm-ar that writes an archive holding the object, recording its arguments. */
function fakeAr(calls: string[][] = []): ArRunner {
  return async (args) => {
    calls.push(args);
    writeFileSync(args[2]!, arArchive([{ name: path.basename(args[3]!), data: readFileSync(args[3]!) }]));
    return "";
  };
}
const noAr: ArRunner = async () => {
  throw new Error("llvm-ar must not run");
};

async function wrap(pod: string, frameworks: string[] | Record<string, unknown>, ar: ArRunner = fakeAr(), sha = SHA): Promise<WrappedPod> {
  const spec = podSpec(pod, Array.isArray(frameworks) ? { vendored_frameworks: frameworks } : frameworks);
  const { layers } = selectedLayers(spec, []);
  return wrapPod({ pod, version: "1.0.0", sha256: sha, neededBy: LIB, extracted, spec, layers, headersOnly: false }, cache, ar);
}

/** The wrapped trees of SHA in the cache, temporary ones left out. */
const trees = (): string[] =>
  existsSync(path.join(cache, "wrapped")) ? readdirSync(path.join(cache, "wrapped")).filter((n) => new RegExp(`^${SHA}-[0-9a-f]{16}$`).test(n)) : [];
/** The one wrapped tree of SHA. */
const DEST = (): string => {
  const names = trees();
  if (names.length !== 1) throw new Error(`expected one wrapped tree, got ${names.join(", ")}`);
  return path.join(cache, "wrapped", names[0]!);
};

describe("wrapPod", () => {
  it("wraps a fat ar framework, a thin ar framework and an MH_OBJECT framework", async () => {
    const armLib = lib("arm64");
    framework("Frameworks/FatLib.framework", fat([{ cpu: "x86_64", data: lib("x86_64") }, { cpu: "arm64", data: armLib }]));
    framework("Frameworks/ThinLib.framework", armLib);
    framework("Frameworks/Obj.framework", obj());
    const calls: string[][] = [];
    const w = await wrap("MLKitFoo", ["Frameworks/FatLib.framework", "Frameworks/ThinLib.framework", "Frameworks/Obj.framework"], fakeAr(calls));
    expect(w).toEqual({
      pod: "MLKitFoo",
      version: "1.0.0",
      sha256: SHA,
      dir: DEST(),
      frameworks: ["FatLib", "Obj", "ThinLib"].map((name) => ({
        name,
        xcframework: path.join(DEST(), "xcframeworks", `${name}.xcframework`),
        archive: path.join(DEST(), "archives", `lib${name}.a`),
        privacy: [],
      })),
      warnings: [],
    });
    expect(readFileSync(path.join(DEST(), "archives", "libFatLib.a"))).toEqual(armLib);
    expect(readFileSync(path.join(DEST(), "archives", "libThinLib.a"))).toEqual(armLib);
    expect(readFileSync(path.join(DEST(), "archives", "libObj.a"))).toEqual(arArchive([{ name: "Obj.o", data: obj() }]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["rcs", "--format=darwin"]);
    for (const name of ["FatLib", "ThinLib", "Obj"]) {
      const xcf = path.join(DEST(), "xcframeworks", `${name}.xcframework`);
      expect(readXcframeworkLibraries(xcf)).toEqual([POD_SLICE]);
      const headers = path.join(xcf, "ios-arm64", "Headers", name);
      expect(readFileSync(path.join(headers, `${name}.h`), "utf8")).toBe(`// ${name}`);
      expect(readFileSync(path.join(headers, "module.modulemap"), "utf8")).toBe(
        `module ${name} {\n  umbrella header "${name}.h"\n  export *\n  module * { export * }\n  link "c++"\n}\n`,
      );
      expect(readFileSync(path.join(xcf, "ios-arm64", `lib${name}-ios-arm64.a`))).toEqual(EMPTY_AR_ARCHIVE);
    }
    expect(readdirSync(path.join(cache, "wrapped"))).toEqual([path.basename(DEST())]);
    expect(existsSync(path.join(DEST(), WRAPPED_STAMP))).toBe(true);
  });

  it.each([
    ["a fat ar", () => fat([{ cpu: "x86_64", data: lib("x86_64") }, { cpu: "arm64", data: lib() }], { fat64: true })],
    ["a fat object", () => fat([{ cpu: "arm64e", data: obj("arm64e") }, { cpu: "arm64", data: obj() }])],
    ["a thin ar", () => lib()],
    ["an object", () => obj()],
  ])("every staged archive starts with !<arch> (%s)", async (_what, binary) => {
    framework("Frameworks/One.framework", binary());
    const w = await wrap("MLKitOne", ["Frameworks/One.framework"]);
    const archive = readFileSync(w.frameworks[0]!.archive!);
    expect(archive.subarray(0, 8).toString("latin1")).toBe("!<arch>\n");
    expect(readBinary(archive).shape).toBe("ar");
  });

  it("refuses an archive llvm-ar did not write as one", async () => {
    framework("Frameworks/One.framework", obj());
    const bad: ArRunner = async (args) => {
      writeFileSync(args[2]!, "!<thin>\n");
      return "";
    };
    await expect(wrap("MLKitOne", ["Frameworks/One.framework"], bad)).rejects.toThrow("does not start with !<arch>");
    expect(trees()).toEqual([]);
  });

  it.each([
    ["x86_64", fat([{ cpu: "x86_64", data: lib("x86_64") }]), "x86_64"],
    ["arm64e", fat([{ cpu: "arm64e", data: obj("arm64e") }, { cpu: "x86_64", data: obj("x86_64") }]), "arm64e, x86_64"],
    ["a thin x86_64 object", obj("x86_64"), "x86_64"],
    [
      "an archive of LLVM bitcode only",
      fat([{ cpu: "arm64", data: arArchive([{ name: "bitcode.o", data: Buffer.from("BC\xc0\xde\x35\x14\x00\x00", "latin1") }]) }]),
      "no architecture",
    ],
    ["an empty archive", Buffer.from("!<arch>\n", "latin1"), "no architecture"],
  ])("stops on a framework without an arm64 device slice (%s)", async (_what, binary, arches) => {
    framework("Frameworks/MLKitFoo.framework", binary);
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      new PodsError(
        `MLKitFoo 1.0.0 (needed by ${LIB}) ships no arm64 device slice (it has ${arches}): Frameworks/MLKitFoo.framework/MLKitFoo. rn-xtool builds for iPhones only. Leave the library out with "exclude" in rn-xtool.config.json. See ${LINK}`,
      ),
    );
    expect(trees()).toEqual([]);
  });

  it("stops on a simulator slice, in an object and in an archive member", async () => {
    framework("Frameworks/MLKitFoo.framework", machO({ build: SIMULATOR }));
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      new PodsError(
        `MLKitFoo 1.0.0 (needed by ${LIB}) ships an arm64 slice built for the iOS simulator, not for iPhones (Frameworks/MLKitFoo.framework/MLKitFoo). Leave the library out with "exclude" in rn-xtool.config.json. See ${LINK}`,
      ),
    );
    framework("Frameworks/MLKitFoo.framework", arArchive([{ name: "a.o", data: obj() }, { name: "sim.o", data: machO({ build: SIMULATOR }) }]));
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      `ships an arm64 slice built for the iOS simulator, not for iPhones (Frameworks/MLKitFoo.framework/MLKitFoo, member sim.o).`,
    );
  });

  it("stops on a dynamic framework", async () => {
    framework("Frameworks/MLKitFoo.framework", machO({ filetype: "dylib", build: IOS }));
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      new PodsError(
        `MLKitFoo 1.0.0 (needed by ${LIB}) ships a dynamic framework (Frameworks/MLKitFoo.framework); rn-xtool links static CocoaPods binaries only. Leave the library out with "exclude" in rn-xtool.config.json. See ${LINK}`,
      ),
    );
  });

  it("stops on a Swift framework", async () => {
    framework("Frameworks/MLKitFoo.framework", lib(), { extra: { "Modules/MLKitFoo.swiftmodule/arm64-apple-ios.swiftinterface": "// swift" } });
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      new PodsError(
        `MLKitFoo 1.0.0 (needed by ${LIB}) ships a Swift framework (Frameworks/MLKitFoo.framework); rn-xtool links static CocoaPods binaries only. Leave the library out with "exclude" in rn-xtool.config.json. See ${LINK}`,
      ),
    );
  });

  it("stops on a binary it does not recognise, and on a framework without its binary", async () => {
    framework("Frameworks/MLKitFoo.framework", Buffer.from("!<thin>\n0000"));
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      new PodsError(
        `MLKitFoo 1.0.0 (needed by ${LIB}) ships a binary rn-xtool does not recognise (Frameworks/MLKitFoo.framework/MLKitFoo, which starts with !<thin>). See ${LINK}`,
      ),
    );
    rmSync(path.join(extracted, "Frameworks/MLKitFoo.framework/MLKitFoo"));
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      new PodsError(
        `MLKitFoo 1.0.0 (needed by ${LIB}) ships Frameworks/MLKitFoo.framework without its binary MLKitFoo. See ${LINK}`,
      ),
    );
  });

  it("stops on a module map it cannot rewrite, naming the file", async () => {
    framework("Frameworks/MLKitFoo.framework", lib(), { extra: { "Modules/module.private.modulemap": "framework module MLKitFoo_Private {}\n" } });
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(
      `MLKitFoo 1.0.0 (needed by ${LIB}): Frameworks/MLKitFoo.framework/Modules/module.private.modulemap names the framework bundle (a module.private.modulemap)`,
    );
  });

  it("generates a module map for a framework without one", async () => {
    framework("Frameworks/MLKitFoo.framework", lib(), { moduleMap: false });
    const w = await wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"]);
    expect(readFileSync(path.join(w.frameworks[0]!.xcframework, "ios-arm64", "Headers", "MLKitFoo", "module.modulemap"), "utf8")).toBe(
      'module MLKitFoo {\n  umbrella header "MLKitFoo.h"\n  export *\n  module * { export * }\n}\n',
    );
  });

  it("warns about a minos newer than IOS_MIN", async () => {
    framework("Frameworks/MLKitFoo.framework", arArchive([{ name: "a.o", data: obj() }, { name: "b.o", data: machO({ build: { platform: PLATFORM_IOS, minos: "17.0" } }) }]));
    const w = await wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"]);
    expect(w.warnings).toEqual([`⚠ MLKitFoo needs iOS 17.0; the app's minimum is ${IOS_MIN}; it fails to load on older iPhones`]);
  });

  it("warns about a spec platform newer than IOS_MIN, once, with the higher version", async () => {
    framework("Frameworks/MLKitFoo.framework", arArchive([{ name: "b.o", data: machO({ build: { platform: PLATFORM_IOS, minos: "17.0" } }) }]));
    const w = await wrap("MLKitFoo", { vendored_frameworks: ["Frameworks/MLKitFoo.framework"], platforms: { ios: "17.2" } });
    expect(w.warnings).toEqual([`⚠ MLKitFoo needs iOS 17.2; the app's minimum is ${IOS_MIN}; it fails to load on older iPhones`]);
    expect((await wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"], fakeAr(), "c".repeat(64))).warnings).toHaveLength(1);
  });

  it("does not warn about ML Kit's 15.5", async () => {
    framework("Frameworks/MLKitFoo.framework", lib());
    expect((await wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).warnings).toEqual([]);
  });

  it("stops on two vendored frameworks with one name, naming both", async () => {
    framework("Frameworks/MLKitFoo.framework", lib());
    write(
      "Other/MLKitFoo.xcframework/Info.plist",
      plist.build({
        AvailableLibraries: [{ LibraryIdentifier: "ios-arm64", LibraryPath: "MLKitFoo.framework", SupportedArchitectures: ["arm64"], SupportedPlatform: "ios" }],
        CFBundlePackageType: "XFWK",
        XCFrameworkFormatVersion: "1.0",
      }),
    );
    framework("Other/MLKitFoo.xcframework/ios-arm64/MLKitFoo.framework", lib());
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework", "Other/MLKitFoo.xcframework"])).rejects.toThrow(
      new PodsError(
        `MLKitFoo 1.0.0 (needed by ${LIB}) ships two frameworks named MLKitFoo: Frameworks/MLKitFoo.framework and Other/MLKitFoo.xcframework/ios-arm64/MLKitFoo.framework. rn-xtool makes one module of each name. Leave the library out with "exclude" in rn-xtool.config.json. See ${LINK}`,
      ),
    );
    expect(trees()).toEqual([]);
  });

  it("expands globs in vendored_frameworks", async () => {
    framework("Frameworks/A.framework", lib());
    framework("Frameworks/B.framework", lib());
    const w = await wrap("MLKitFoo", ["Frameworks/*.framework"]);
    expect(w.frameworks.map((f) => f.name)).toEqual(["A", "B"]);
  });

  it("makes GoogleMLKit's headers-only module MLKit with its own module map", async () => {
    const map = 'module MLKit {\n  umbrella header "MLKit.h"\n  export *\n}\n';
    write("MLKitCore/Sources/MLKit.h", "// MLKit umbrella");
    write("MLKitCore/Sources/module.modulemap", map);
    const spec = parsePodSpec(fixtureSpec("GoogleMLKit", "8.0.0"), { pod: "GoogleMLKit", version: "8.0.0" });
    const { layers } = selectedLayers(spec, ["TextRecognition"]);
    const w = await wrapPod(
      { pod: "GoogleMLKit", version: "8.0.0", sha256: SHA, neededBy: LIB, extracted, spec, layers, headersOnly: true },
      cache,
      noAr,
    );
    expect(w.frameworks).toEqual([{ name: "MLKit", xcframework: path.join(DEST(), "xcframeworks", "MLKit.xcframework"), privacy: [] }]);
    const headers = path.join(w.frameworks[0]!.xcframework, "ios-arm64", "Headers", "MLKit");
    expect(readdirSync(headers).sort()).toEqual(["MLKit.h", "module.modulemap"]);
    expect(readFileSync(path.join(headers, "module.modulemap"), "utf8")).toBe(map);
    expect(existsSync(path.join(DEST(), "archives"))).toBe(false);
  });

  it("writes a header module map for a headers-only pod that keeps none", async () => {
    write("Sources/A.h");
    write("Sources/B.h");
    const spec = podSpec("HeadersOnly", { source_files: "Sources/*.h" });
    const w = await wrapPod(
      { pod: "HeadersOnly", version: "1.0.0", sha256: SHA, neededBy: LIB, extracted, spec, layers: selectedLayers(spec, []).layers, headersOnly: true },
      cache,
      noAr,
    );
    expect(readFileSync(path.join(w.frameworks[0]!.xcframework, "ios-arm64", "Headers", "HeadersOnly", "module.modulemap"), "utf8")).toBe(
      'module HeadersOnly {\n  header "A.h"\n  header "B.h"\n  export *\n}\n',
    );
  });

  describe("a vendored xcframework", () => {
    const XCF = "Frameworks/MLKitFoo.xcframework";
    function xcframework(libraries: Record<string, unknown>[]): void {
      write(`${XCF}/Info.plist`, plist.build({ AvailableLibraries: libraries, CFBundlePackageType: "XFWK", XCFrameworkFormatVersion: "1.0" }));
    }
    const device = { LibraryIdentifier: "ios-arm64", LibraryPath: "MLKitFoo.framework", SupportedArchitectures: ["arm64"], SupportedPlatform: "ios" };
    const simulator = {
      LibraryIdentifier: "ios-arm64_x86_64-simulator",
      LibraryPath: "MLKitFoo.framework",
      SupportedArchitectures: ["arm64", "x86_64"],
      SupportedPlatform: "ios",
      SupportedPlatformVariant: "simulator",
    };

    it("reads the device slice of a vendored xcframework", async () => {
      xcframework([simulator, device]);
      framework(`${XCF}/ios-arm64_x86_64-simulator/MLKitFoo.framework`, machO({ build: SIMULATOR }));
      framework(`${XCF}/ios-arm64/MLKitFoo.framework`, lib());
      const w = await wrap("MLKitFoo", [XCF]);
      expect(w.frameworks.map((f) => f.name)).toEqual(["MLKitFoo"]);
      expect(readFileSync(w.frameworks[0]!.archive!)).toEqual(lib());
    });

    it("reads a library slice with its headers", async () => {
      xcframework([{ ...device, LibraryPath: "libMLKitFoo.a", HeadersPath: "Headers" }]);
      write(`${XCF}/ios-arm64/libMLKitFoo.a`, lib());
      write(`${XCF}/ios-arm64/Headers/MLKitFoo/MLKitFoo.h`, "// foo");
      write(`${XCF}/ios-arm64/Headers/module.modulemap`, 'module MLKitFoo {\n  header "MLKitFoo/MLKitFoo.h"\n  export *\n}\n');
      const w = await wrap("MLKitFoo", [XCF]);
      const headers = path.join(w.frameworks[0]!.xcframework, "ios-arm64", "Headers", "MLKitFoo");
      expect(readFileSync(path.join(headers, "MLKitFoo", "MLKitFoo.h"), "utf8")).toBe("// foo");
      expect(readFileSync(path.join(headers, "module.modulemap"), "utf8")).toContain('header "MLKitFoo/MLKitFoo.h"');
    });

    it("stops without a device slice", async () => {
      xcframework([simulator]);
      await expect(wrap("MLKitFoo", [XCF])).rejects.toThrow(
        new PodsError(
          `MLKitFoo 1.0.0 (needed by ${LIB}) ships no arm64 device slice (it has ios-arm64_x86_64-simulator): ${XCF}. rn-xtool builds for iPhones only. Leave the library out with "exclude" in rn-xtool.config.json. See ${LINK}`,
        ),
      );
    });

    it("stops on a device slice built for the simulator", async () => {
      xcframework([device]);
      framework(`${XCF}/ios-arm64/MLKitFoo.framework`, machO({ build: SIMULATOR }));
      await expect(wrap("MLKitFoo", [XCF])).rejects.toThrow(
        `ships an arm64 slice built for the iOS simulator, not for iPhones (${XCF}/ios-arm64/MLKitFoo.framework/MLKitFoo)`,
      );
    });

    it("stops on a dynamic framework in the device slice", async () => {
      xcframework([device]);
      framework(`${XCF}/ios-arm64/MLKitFoo.framework`, machO({ filetype: "dylib", build: IOS }));
      await expect(wrap("MLKitFoo", [XCF])).rejects.toThrow(`ships a dynamic framework (${XCF}/ios-arm64/MLKitFoo.framework)`);
    });
  });

  it("records the privacy manifests inside frameworks", async () => {
    framework("Frameworks/MLKitFoo.framework", lib(), { extra: { "PrivacyInfo.xcprivacy": "<plist/>" } });
    const w = await wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"]);
    expect(w.frameworks[0]!.privacy).toEqual(["Frameworks/MLKitFoo.framework/PrivacyInfo.xcprivacy"]);
  });

  it("reuses a stamped tree", async () => {
    framework("Frameworks/MLKitFoo.framework", obj(), { extra: { "PrivacyInfo.xcprivacy": "<plist/>" } });
    const first = await wrap("MLKitFoo", { vendored_frameworks: ["Frameworks/MLKitFoo.framework"], platforms: { ios: "17.0" } });
    const again = await wrap("MLKitFoo", { vendored_frameworks: ["Frameworks/MLKitFoo.framework"], platforms: { ios: "17.0" } }, noAr);
    expect(again).toEqual(first);
    expect(again.warnings).toHaveLength(1);
  });

  it("rebuilds a stamped tree whose files changed", async () => {
    framework("Frameworks/MLKitFoo.framework", lib());
    const w = await wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"]);
    writeFileSync(w.frameworks[0]!.archive!, "");
    expect(await wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).toEqual(w);
    expect(readFileSync(w.frameworks[0]!.archive!)).toEqual(lib());
  });

  it("keeps one wrapped tree per selection of one archive", async () => {
    framework("Frameworks/A.framework", lib());
    framework("Frameworks/B.framework", lib());
    const a = await wrap("MLKitFoo", ["Frameworks/A.framework"]);
    const ab = await wrap("MLKitFoo", ["Frameworks/A.framework", "Frameworks/B.framework"]);
    expect(ab.dir).not.toBe(a.dir);
    expect(ab.frameworks.map((f) => f.name)).toEqual(["A", "B"]);
    expect(readdirSync(path.join(a.dir, "archives"))).toEqual(["libA.a"]);
    expect(readdirSync(path.join(ab.dir, "archives"))).toEqual(["libA.a", "libB.a"]);
    expect(await wrap("MLKitFoo", ["Frameworks/A.framework"], noAr)).toEqual(a);
    const [x, y] = await Promise.all([
      wrap("MLKitFoo", ["Frameworks/B.framework"]),
      wrap("MLKitFoo", ["Frameworks/A.framework", "Frameworks/B.framework"], noAr),
    ]);
    expect(readdirSync(path.join(x.dir, "archives"))).toEqual(["libB.a"]);
    expect(y).toEqual(ab);
  });

  it("writes the stamp before the swap, and lets a tree another build stamped win", async () => {
    framework("Frameworks/MLKitFoo.framework", lib());
    const spec = podSpec("MLKitFoo", { vendored_frameworks: ["Frameworks/MLKitFoo.framework"] });
    const input = { pod: "MLKitFoo", version: "1.0.0", sha256: SHA, neededBy: LIB, extracted, spec, layers: selectedLayers(spec, []).layers, headersOnly: false };
    const stamped: boolean[] = [];
    const won: typeof swapIn = async (tmp, dest) => {
      stamped.push(existsSync(path.join(tmp, WRAPPED_STAMP)));
      cpSync(tmp, dest, { recursive: true });
      throw new Error("ENOTEMPTY: directory not empty");
    };
    const w = await wrapPod(input, cache, noAr, won);
    expect(stamped).toEqual([true]);
    expect(readdirSync(path.join(w.dir, "archives"))).toEqual(["libMLKitFoo.a"]);
  });

  it("two wraps of one pod both succeed", async () => {
    framework("Frameworks/MLKitFoo.framework", obj());
    const [a, b] = await Promise.all([
      wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"]),
      wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"]),
    ]);
    expect(a).toEqual(b);
    expect(readdirSync(path.join(cache, "wrapped"))).toEqual([path.basename(a.dir)]);
  });

  it("leaves no temporary tree after a stop", async () => {
    framework("Frameworks/MLKitFoo.framework", Buffer.from("!<thin>\n"));
    await expect(wrap("MLKitFoo", ["Frameworks/MLKitFoo.framework"])).rejects.toThrow(PodsError);
    expect(readdirSync(path.join(cache, "wrapped"))).toEqual([]);
  });
});

const hasAr = await makeArRunner()(["--version"]).then(
  () => true,
  () => false,
);

describe.skipIf(!hasAr)("wrapPod with the toolchain's llvm-ar", () => {
  it("wraps an MH_OBJECT framework into a thin arm64 archive", async () => {
    framework("Frameworks/MLKitTextRecognitionCommon.framework", fat([{ cpu: "x86_64", data: obj("x86_64") }, { cpu: "arm64", data: machO() }]));
    const w = await wrap("MLKitTextRecognitionCommon", ["Frameworks/MLKitTextRecognitionCommon.framework"], makeArRunner());
    const archive = readFileSync(w.frameworks[0]!.archive!);
    expect(archive.subarray(0, 8).toString("latin1")).toBe("!<arch>\n");
    expect(readBinary(archive)).toEqual({
      shape: "ar",
      members: [{ name: "MLKitTextRecognitionCommon.o", info: { kind: "object", cpu: "arm64" } }],
    });
  });
});
