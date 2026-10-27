import { spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import * as plist from "plist";
import { afterAll, describe, expect, it } from "vitest";
import { packageRoot } from "../src/tools/exec.js";
import {
  ADAPTED_STAMP,
  ADAPTER_VERSION,
  adaptedSlotIsCurrent,
  adaptSlot,
  ArtifactLayoutError,
  EMPTY_AR_ARCHIVE,
  headersXcframeworkInfoPlist,
  isHeadersSpecSlot,
  materialiseVirtualTree,
  parseVfsTemplate,
  readXcframeworkLibraries,
  renderHeadersModuleMap,
  type LinkFn,
} from "../src/pipeline/rnArtifacts.js";
import { makeFakeSlot086, makeFakeSlot088 } from "./support/fakeSlots.js";

const tmp: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
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

const copyLink: LinkFn = (from, to) => copyFile(from, to);

function fakeSlot(): { slot: string; react: string; template: string } {
  const slot = mkTmp("rn-slot-086-");
  makeFakeSlot086(slot);
  const react = path.join(slot, "React.xcframework");
  return { slot, react, template: readFileSync(path.join(react, "React-VFS-template.yaml"), "utf8") };
}

async function materialised(): Promise<string> {
  const { react, template } = fakeSlot();
  const out = mkTmp("rn-vfs-");
  await materialiseVirtualTree(react, parseVfsTemplate(template), out, copyLink);
  return out;
}

describe("RN 0.86 artifact adapter pieces", () => {
  it("parses the VFS template into virtual and external paths", () => {
    expect(parseVfsTemplate(fakeSlot().template)).toEqual([
      { virtual: "React/RCTBridge.h", external: "${ROOT_PATH}/Headers/React_Core/React/RCTBridge.h" },
      {
        virtual: "React_RCTAppDelegate/RCTReactNativeFactory.h",
        external: "${ROOT_PATH}/Headers/React_RCTAppDelegate/React_RCTAppDelegate/RCTReactNativeFactory.h",
      },
      { virtual: "yoga/Yoga.h", external: "${ROOT_PATH}/Headers/Yoga/yoga/Yoga.h" },
      {
        virtual: "ReactCommon/RCTPerformanceLoggerUtils.h",
        external: "${ROOT_PATH}/Headers/React_NativeModulesApple/ReactCommon/RCTPerformanceLoggerUtils.h",
      },
    ]);
  });

  it("rejects a VFS template entry that escapes the virtual root", () => {
    const evil = [
      "roots:",
      "  - name: '${ROOT_PATH}/Headers'",
      "    type: 'directory'",
      "    contents:",
      "      - name: '..'",
      "        type: 'directory'",
      "        contents:",
      "          - name: 'x.h'",
      "            type: 'file'",
      "            external-contents: '${ROOT_PATH}/Headers/x.h'",
    ].join("\n");
    expect(() => parseVfsTemplate(evil)).toThrow(/\.\./);
  });

  it("materialises the virtual tree with VFS fallthrough", async () => {
    const { react, template } = fakeSlot();
    // A physical file that shadows a virtual one: the VFS mapping wins, fallthrough does not overwrite it.
    writeFileSync(path.join(react, "Headers", "ReactCommon", "RCTPerformanceLoggerUtils.h"), "// physical decoy\n");
    const out = mkTmp("rn-vfs-");
    const { missing } = await materialiseVirtualTree(react, parseVfsTemplate(template), out, copyLink);

    expect(missing).toEqual([]);
    expect(listFiles(out)).toEqual(
      [
        "React/RCTBridge.h",
        "ReactCommon/RCTPerformanceLoggerUtils.h",
        "ReactCommon/RCTTurboModuleWithJSIBindings.h",
        "React_RCTAppDelegate/RCTReactNativeFactory.h",
        // fallthrough of the physical React_RCTAppDelegate/ dir (same name as a virtual top-level dir)
        "React_RCTAppDelegate/React_RCTAppDelegate/RCTReactNativeFactory.h",
        "yoga/Yoga.h",
      ].sort(),
    );
    expect(existsSync(path.join(out, "React_Core"))).toBe(false);
    expect(readFileSync(path.join(out, "React/RCTBridge.h"), "utf8")).toContain("React_Core/React/RCTBridge.h");
    expect(readFileSync(path.join(out, "ReactCommon/RCTPerformanceLoggerUtils.h"), "utf8")).toContain(
      "React_NativeModulesApple/ReactCommon/RCTPerformanceLoggerUtils.h",
    );

    rmSync(path.join(react, "Headers", "Yoga", "yoga", "Yoga.h"));
    const again = await materialiseVirtualTree(react, parseVfsTemplate(template), mkTmp("rn-vfs-"), copyLink);
    expect(again.missing).toEqual(["yoga/Yoga.h"]);
  });

  it("renders the headers module map in 0.88's form from the files present", async () => {
    const out = await materialised();
    rmSync(path.join(out, "React"), { recursive: true });
    expect(renderHeadersModuleMap(out)).toBe(
      'module ReactCommon {\n  header "ReactCommon/RCTPerformanceLoggerUtils.h"\n  header "ReactCommon/RCTTurboModuleWithJSIBindings.h"\n  export *\n}\n\nmodule React_RCTAppDelegate {\n  header "React_RCTAppDelegate/RCTReactNativeFactory.h"\n  export *\n}\n\nmodule yoga {\n  header "yoga/Yoga.h"\n  export *\n}\n',
    );
  });

  it("the empty archive is a valid ar archive", () => {
    expect(EMPTY_AR_ARCHIVE.toString()).toBe("!<arch>\n");
  });

  it.skipIf(spawnSync("ar", ["--version"]).status !== 0)("ar lists the empty archive without members", () => {
    const file = path.join(mkTmp("rn-ar-"), "libEmpty.a");
    writeFileSync(file, EMPTY_AR_ARCHIVE);
    const r = spawnSync("ar", ["t", file], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("headers Info.plist names one library per slice", () => {
    const { react } = fakeSlot();
    const info = plist.parse(headersXcframeworkInfoPlist("ReactNativeHeaders", readXcframeworkLibraries(react))) as Record<
      string,
      unknown
    >;
    const libs = info.AvailableLibraries as Record<string, unknown>[];
    expect(libs.map((l) => l.LibraryIdentifier)).toEqual(["ios-arm64", "ios-arm64_x86_64-simulator"]);
    expect(libs[0]).toEqual({
      BinaryPath: "libReactNativeHeaders-ios-arm64.a",
      HeadersPath: "Headers",
      LibraryIdentifier: "ios-arm64",
      LibraryPath: "libReactNativeHeaders-ios-arm64.a",
      SupportedArchitectures: ["arm64"],
      SupportedPlatform: "ios",
    });
    expect(libs[1]).toMatchObject({
      LibraryPath: "libReactNativeHeaders-ios-arm64_x86_64-simulator.a",
      HeadersPath: "Headers",
      SupportedArchitectures: ["arm64", "x86_64"],
      SupportedPlatformVariant: "simulator",
    });
    expect(info.CFBundlePackageType).toBe("XFWK");
    expect(info.XCFrameworkFormatVersion).toBe("1.0");
  });

  it("reading an xcframework without Info.plist names the file", () => {
    const dir = mkTmp("rn-xcfw-");
    expect(() => readXcframeworkLibraries(dir)).toThrow(path.join(dir, "Info.plist"));
  });
});

const RN088_SLOT =
  process.env.RN_XTOOL_RN088_SLOT ?? path.join(homedir(), "Library", "Caches", "ReactNative", "spm-artifacts", "0.88.0", "debug");
const RN088_HEADERS = path.join(RN088_SLOT, "ReactNativeHeaders.xcframework", "ios-arm64", "Headers");

describe.skipIf(!existsSync(path.join(RN088_HEADERS, "module.modulemap")))("RN 0.88.0 headers module table", () => {
  it("the module table renders 0.88.0's own map", () => {
    expect(renderHeadersModuleMap(RN088_HEADERS)).toBe(readFileSync(path.join(RN088_HEADERS, "module.modulemap"), "utf8"));
  });
});

const downloader = () =>
  createRequire(path.join(packageRoot(), "vendor", "rn-spm", "spm", "download-spm-artifacts.js"))("./download-spm-artifacts.js") as {
    validateArtifactsCache: (dir: string) => string | null;
    REQUIRED_ARTIFACTS: string[];
  };

const REACT_MODULE_MAP = 'framework module React {\n  umbrella header "React-umbrella.h"\n  export *\n  module * { export * }\n}\n';
const SLICES = ["ios-arm64", "ios-arm64_x86_64-simulator"];

/** A fresh fake 0.86 slot and a not-yet-existing `dest` beside it. */
function adaptCase(): { src: string; dest: string } {
  const src = mkTmp("rn-slot-086-");
  makeFakeSlot086(src);
  return { src, dest: path.join(mkTmp("rn-adapted-"), "debug") };
}

const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

describe("adaptSlot", () => {
  it("builds React.xcframework with flat React headers, the 0.86 umbrella and the React module map", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3");
    for (const slice of SLICES) {
      const fw = path.join(dest, "React.xcframework", slice, "React.framework");
      const srcFw = path.join(src, "React.xcframework", slice, "React.framework");
      expect(existsSync(path.join(fw, "Headers", "RCTBridge.h"))).toBe(true);
      expect(readFileSync(path.join(fw, "Headers", "React-umbrella.h"), "utf8")).toBe(
        readFileSync(path.join(srcFw, "Headers", "React_Core", "React_Core-umbrella.h"), "utf8"),
      );
      expect(readFileSync(path.join(fw, "Modules", "module.modulemap"), "utf8")).toBe(REACT_MODULE_MAP);
      expect(statSync(path.join(fw, "React")).ino).toBe(statSync(path.join(srcFw, "React")).ino);
      expect(existsSync(path.join(fw, "Info.plist"))).toBe(true);
      expect(existsSync(path.join(fw, "Headers", "React_Core"))).toBe(false);
      expect(existsSync(path.join(fw, "_CodeSignature"))).toBe(false);
    }
    // the fixture signs one slice: the signature is of the 0.86 framework, so it is never carried over
    expect(existsSync(path.join(src, "React.xcframework", "ios-arm64", "React.framework", "_CodeSignature", "CodeResources"))).toBe(true);
    expect(readFileSync(path.join(dest, "React.xcframework", "Info.plist"), "utf8")).toBe(
      readFileSync(path.join(src, "React.xcframework", "Info.plist"), "utf8"),
    );
  });

  it("builds ReactNativeHeaders.xcframework from the rest of the virtual tree plus hermes", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3");
    const xc = path.join(dest, "ReactNativeHeaders.xcframework");
    for (const slice of SLICES) {
      const headers = path.join(xc, slice, "Headers");
      for (const rel of [
        "React_RCTAppDelegate/RCTReactNativeFactory.h",
        "yoga/Yoga.h",
        "ReactCommon/RCTTurboModuleWithJSIBindings.h",
        "hermes/hermes.h",
        "module.modulemap",
      ]) {
        expect(existsSync(path.join(headers, rel)), rel).toBe(true);
      }
      expect(existsSync(path.join(headers, "React"))).toBe(false);
      expect(readFileSync(path.join(headers, "module.modulemap"), "utf8")).toContain("module yoga {");
      expect(readFileSync(path.join(xc, slice, `libReactNativeHeaders-${slice}.a`))).toEqual(EMPTY_AR_ARCHIVE);
    }
    expect(readXcframeworkLibraries(xc).map((l) => l.LibraryIdentifier)).toEqual(SLICES);
  });

  it("wraps the dependency headers", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3");
    const xc = path.join(dest, "ReactNativeDependenciesHeaders.xcframework");
    expect(existsSync(path.join(xc, "ios-arm64", "Headers", "folly", "dynamic.h"))).toBe(true);
    expect(existsSync(path.join(xc, "ios-arm64", "Headers", "module.modulemap"))).toBe(false);
    expect(readFileSync(path.join(xc, "ios-arm64", "libReactNativeDependenciesHeaders-ios-arm64.a"))).toEqual(EMPTY_AR_ARCHIVE);
    expect(readXcframeworkLibraries(xc).map((l) => l.LibraryIdentifier)).toEqual(SLICES);
  });

  it("RN's validateArtifactsCache accepts the adapted slot", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3");
    const { validateArtifactsCache, REQUIRED_ARTIFACTS } = downloader();
    expect(validateArtifactsCache(dest)).toBeNull();
    for (const name of ["ReactNativeDependencies", "hermes-engine"]) {
      const link = path.join(dest, `${name}.xcframework`);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(path.join(src, `${name}.xcframework`));
    }
    const json = JSON.parse(readFileSync(path.join(dest, "artifacts.json"), "utf8")) as Record<string, { xcframeworkPath: string; url: string }>;
    expect(Object.keys(json).sort()).toEqual([...REQUIRED_ARTIFACTS].sort());
    const srcJson = JSON.parse(readFileSync(path.join(src, "artifacts.json"), "utf8")) as Record<string, { url: string }>;
    expect(json.ReactNativeHeaders?.url).toBe(srcJson.React?.url);
    expect(json.ReactNativeDependenciesHeaders?.url).toBe(srcJson.ReactNativeDependencies?.url);
    expect(json["hermes-engine"]?.url).toBe(srcJson["hermes-engine"]?.url);
    for (const [name, entry] of Object.entries(json)) expect(entry.xcframeworkPath).toBe(path.join(dest, `${name}.xcframework`));
    expect(existsSync(path.join(dest, "hermes-headers", "hermes", "hermes.h"))).toBe(true);
  });

  it("stops on an unknown layout naming the file and the version", async () => {
    const cases: [string, RegExp][] = [
      ["React.xcframework/React-VFS-template.yaml", /0\.86\.3.*React\.xcframework\/React-VFS-template\.yaml is missing/],
      [
        "React.xcframework/ios-arm64_x86_64-simulator/React.framework/Headers/React_Core/React_Core-umbrella.h",
        /0\.86\.3.*React\.xcframework\/ios-arm64_x86_64-simulator\/React\.framework\/Headers\/React_Core\/React_Core-umbrella\.h is missing/,
      ],
      ["React.xcframework/Headers/Yoga/yoga/Yoga.h", /0\.86\.3.*React\.xcframework\/Headers\/Yoga\/yoga\/Yoga\.h is missing/],
    ];
    for (const [rel, message] of cases) {
      const { src, dest } = adaptCase();
      rmSync(path.join(src, rel));
      const run = adaptSlot(src, dest, "0.86.3");
      await expect(run).rejects.toBeInstanceOf(ArtifactLayoutError);
      await expect(run).rejects.toThrow(message);
      await expect(run).rejects.toThrow("https://github.com/WillyAntunez/react-native-xtool/issues");
      expect(existsSync(dest)).toBe(false);
    }
  });

  it("stops when a directory stands where a file is expected, naming it", async () => {
    const cases = [
      "React.xcframework/Headers/Yoga/yoga/Yoga.h",
      "React.xcframework/ios-arm64/React.framework/Headers/React_Core/React_Core-umbrella.h",
      "React.xcframework/React-VFS-template.yaml",
    ];
    for (const rel of cases) {
      const { src, dest } = adaptCase();
      rmSync(path.join(src, rel));
      mkdirSync(path.join(src, rel));
      const run = adaptSlot(src, dest, "0.86.3");
      await expect(run).rejects.toBeInstanceOf(ArtifactLayoutError);
      await expect(run).rejects.toThrow(`0.86.3 artifacts in ${src} have a layout rn-xtool does not recognise: ${rel} is not a file.`);
      expect(existsSync(dest)).toBe(false);
    }
  });

  it("stops on a VFS template without React headers", async () => {
    for (const template of ["version: 0\nroots: []\n", null]) {
      const { src, dest } = adaptCase();
      const file = path.join(src, "React.xcframework", "React-VFS-template.yaml");
      const text = template ?? readFileSync(file, "utf8").replace(/- name: 'React'\n/, "- name: 'NotReact'\n");
      writeFileSync(file, text);
      await expect(adaptSlot(src, dest, "0.86.3")).rejects.toThrow(/0\.86\.3.*React\.xcframework\/React-VFS-template\.yaml/);
      expect(existsSync(dest)).toBe(false);
    }
  });

  it("detects headers-spec slots", () => {
    const old = mkTmp("rn-slot-086-");
    makeFakeSlot086(old);
    const spec = mkTmp("rn-slot-088-");
    makeFakeSlot088(spec);
    expect(isHeadersSpecSlot(old)).toBe(false);
    expect(isHeadersSpecSlot(spec)).toBe(true);
  });

  it("stamps the adapted slot and reuses it until artifacts.json changes", async () => {
    const { src, dest } = adaptCase();
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(false);
    await adaptSlot(src, dest, "0.86.3");
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(true);
    const stamp = JSON.parse(readFileSync(path.join(dest, ADAPTED_STAMP), "utf8")) as Record<string, unknown>;
    expect(stamp.adapterVersion).toBe(ADAPTER_VERSION);

    const srcJson = path.join(src, "artifacts.json");
    const original = readFileSync(srcJson, "utf8");
    writeFileSync(srcJson, original.replace("example.invalid", "example.test"));
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(false);
    writeFileSync(srcJson, original);
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(true);

    writeFileSync(path.join(dest, ADAPTED_STAMP), JSON.stringify({ ...stamp, adapterVersion: 0 }));
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(false);
  });

  it("a moved project re-adapts", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3");
    const project = path.dirname(dest);
    const moved = `${project}-moved`;
    renameSync(project, moved);
    tmp.push(moved);
    const newDest = path.join(moved, path.basename(dest));
    expect(await adaptedSlotIsCurrent(src, newDest)).toBe(false);

    await adaptSlot(src, newDest, "0.86.3");
    expect(await adaptedSlotIsCurrent(src, newDest)).toBe(true);
    expect(downloader().validateArtifactsCache(newDest)).toBeNull();
  });

  it("a failed adaptation leaves no stamped tree", async () => {
    const { src, dest } = adaptCase();
    let calls = 0;
    const failing: LinkFn = async (from, to) => {
      calls += 1;
      if (calls === 3) throw errno("ENOSPC");
      await copyFile(from, to);
    };
    await expect(adaptSlot(src, dest, "0.86.3", { hardLink: failing })).rejects.toThrow(/ENOSPC/);
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(path.dirname(dest))).toEqual([]);

    await adaptSlot(src, dest, "0.86.3");
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(true);
  });

  it("a failed re-adapt keeps the current stamped tree", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3");
    let calls = 0;
    const failing: LinkFn = async (from, to) => {
      calls += 1;
      if (calls === 3) throw errno("ENOSPC");
      await copyFile(from, to);
    };
    await expect(adaptSlot(src, dest, "0.86.3", { hardLink: failing })).rejects.toThrow(/ENOSPC/);
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(true);
    expect(readdirSync(path.dirname(dest))).toEqual([path.basename(dest)]);
  });

  it("never writes a generated file through a link into the source slot", async () => {
    const { src, dest } = adaptCase();
    // A root-level virtual module.modulemap is linked where the generated headers map goes.
    const react = path.join(src, "React.xcframework");
    const sourceMap = path.join(react, "Headers", "module.modulemap");
    writeFileSync(sourceMap, "// source slot module map\n");
    const template = path.join(react, "React-VFS-template.yaml");
    writeFileSync(
      template,
      readFileSync(template, "utf8") +
        "      - name: 'module.modulemap'\n        type: 'file'\n        external-contents: '${ROOT_PATH}/Headers/module.modulemap'\n",
    );
    await expect(adaptSlot(src, dest, "0.86.3")).rejects.toThrow(/EEXIST/);
    expect(readFileSync(sourceMap, "utf8")).toBe("// source slot module map\n");
    expect(readdirSync(path.dirname(dest))).toEqual([]);
  });

  it("re-adapts over a stale adapted tree", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3");
    const srcJson = path.join(src, "artifacts.json");
    writeFileSync(srcJson, readFileSync(srcJson, "utf8").replace("example.invalid", "example.test"));
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(false);
    await adaptSlot(src, dest, "0.86.3");
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(true);
    expect(readdirSync(path.dirname(dest))).toEqual([path.basename(dest)]);
  });

  it("falls back to copying when hard links fail", async () => {
    const { src, dest } = adaptCase();
    await adaptSlot(src, dest, "0.86.3", {
      hardLink: async () => {
        throw errno("EXDEV");
      },
    });
    const bin = (root: string) => path.join(root, "React.xcframework", "ios-arm64", "React.framework", "React");
    expect(readFileSync(bin(dest))).toEqual(readFileSync(bin(src)));
    expect(statSync(bin(dest)).ino).not.toBe(statSync(bin(src)).ino);
    expect(await adaptedSlotIsCurrent(src, dest)).toBe(true);
  });

  it("propagates link errors other than EXDEV, EPERM and EMLINK", async () => {
    const { src, dest } = adaptCase();
    const failing: LinkFn = async () => {
      throw errno("EACCES");
    };
    await expect(adaptSlot(src, dest, "0.86.3", { hardLink: failing })).rejects.toThrow(/EACCES/);
    expect(existsSync(dest)).toBe(false);
  });
});

const RN086_SLOT =
  process.env.RN_XTOOL_RN086_SLOT ?? path.join(homedir(), "Library", "Caches", "ReactNative", "spm-artifacts", "0.86.3", "debug");
/** The four 0.88.0 headers 0.86.3 does not ship (the spike's proven map). */
const ABSENT_IN_086 = [
  "CoreModules/RCTInspectorWebSocketReporter.h",
  "react/cxxstableapi/FrameworksGuard.h",
  "react/cxxstableapi/PrivateGuard.h",
  "react/cxxstableapi/UmbrellaGuard.h",
];
const moduleNames = (map: string) => [...map.matchAll(/^module (\S+) \{/gm)].map((m) => m[1]);

const runRealSlots =
  process.env.RN_XTOOL_REAL_SLOTS === "1" && existsSync(path.join(RN086_SLOT, "artifacts.json")) && existsSync(RN088_SLOT);

describe.skipIf(!runRealSlots)("real RN 0.86.3 slot (runs only with RN_XTOOL_REAL_SLOTS=1, a 0.86.3 slot with artifacts.json and the 0.88.0 slot)", () => {
  // Beside the slot, so hard links work (os.tmpdir() may be tmpfs: the binaries would be copied into RAM).
  const dest = path.join(path.dirname(RN086_SLOT), `rn-xtool-test-adapted-${process.pid}`);
  afterAll(() => rmSync(dest, { recursive: true, force: true }));

  it("adapts the real 0.86.3 slot to 0.88's module set", { timeout: 300_000 }, async () => {
    await adaptSlot(RN086_SLOT, dest, "0.86.3");

    const ours = readFileSync(path.join(dest, "ReactNativeHeaders.xcframework", "ios-arm64", "Headers", "module.modulemap"), "utf8");
    const theirs = readFileSync(path.join(RN088_HEADERS, "module.modulemap"), "utf8");
    expect(moduleNames(theirs)).toHaveLength(14);
    expect(moduleNames(ours)).toEqual(moduleNames(theirs));
    const removed = ABSENT_IN_086.map((h) => `  header "${h}"\n`);
    for (const line of removed) expect(theirs).toContain(line);
    expect(ours).toBe(removed.reduce((text, line) => text.replace(line, ""), theirs));

    const depsOurs = path.join(dest, "ReactNativeDependenciesHeaders.xcframework", "ios-arm64", "Headers");
    const depsTheirs = path.join(RN088_SLOT, "ReactNativeDependenciesHeaders.xcframework", "ios-arm64", "Headers");
    const files = listFiles(depsOurs);
    expect(files).toEqual(listFiles(depsTheirs));
    for (const rel of files) expect(readFileSync(path.join(depsOurs, rel)).equals(readFileSync(path.join(depsTheirs, rel))), rel).toBe(true);
    expect(downloader().validateArtifactsCache(dest)).toBeNull();
  });
});
