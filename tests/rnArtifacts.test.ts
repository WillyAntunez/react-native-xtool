import { spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import * as plist from "plist";
import { afterAll, describe, expect, it } from "vitest";
import {
  EMPTY_AR_ARCHIVE,
  headersXcframeworkInfoPlist,
  materialiseVirtualTree,
  parseVfsTemplate,
  readXcframeworkLibraries,
  renderHeadersModuleMap,
  type LinkFn,
} from "../src/pipeline/rnArtifacts.js";
import { makeFakeSlot086 } from "./support/fakeSlots.js";

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
