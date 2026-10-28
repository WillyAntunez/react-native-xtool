import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeFramework } from "../src/frameworks.js";
import {
  checkFrameworkSymbols,
  frameworkOrigin,
  LLVM_NM_MISSING,
  makeNmRunner,
  nmExportArgs,
  nmImportArgs,
  parseNmExports,
  parseNmImports,
  symbolGapMessage,
  symbolGaps,
  type NmRunner,
} from "../src/pipeline/symbols.js";
import { fakeExpo58Modules } from "./support/expo58.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (...p: string[]) => path.join(here, "fixtures", ...p);
const nmText = (name: string) => readFileSync(fixture("nm", name), "utf8");

/** ../app's crash pair: core 58.0.26 lacks what expo-file-system 58.0.13 was built against. */
const CLASS_TYPES_TQ = "_$s15ExpoModulesCore9AnyModuleP11_classTypesSayAA12SharedObjectCmGvgZTq";
const CLASS_TYPES = "_$s15ExpoModulesCore9AnyModulePAAE11_classTypesSayAA12SharedObjectCmGvgZ";

function fw(id: string, name: string, frameworkDir = `/fw/${name}.framework`): RuntimeFramework {
  return { id, name, executable: name, searchPath: path.dirname(frameworkDir), frameworkDir };
}

const fileSystem = fw("expo-file-system", "ExpoFileSystem");
const font = fw("expo-font", "ExpoFont");
const core = fw("expo-modules-core", "ExpoModulesCore");
const jsi = fw("expo-modules-jsi", "ExpoModulesJSI");

const crashScan = () => [
  { fw: fileSystem, imports: parseNmImports(nmText("ExpoFileSystem.undefined.txt")), exports: new Set<string>() },
  { fw: core, imports: new Map<string, string[]>(), exports: parseNmExports(nmText("ExpoModulesCore.defined.txt")) },
];

const REMEDY = (pkg: string) =>
  `The app would crash at launch (dyld: Symbol not found). Its precompiled binary was built against another ${pkg}`;

describe("llvm-nm output", () => {
  it("parses llvm-nm imports per library", () => {
    const imports = parseNmImports(nmText("ExpoFileSystem.undefined.txt"));
    expect([...imports.keys()].sort()).toEqual(["ExpoModulesCore", "Foundation"]);
    expect(imports.get("ExpoModulesCore")).toEqual([
      "_$s15ExpoModulesCore5FieldCMn",
      "_$s15ExpoModulesCore6RecordMp",
      "_$s15ExpoModulesCore7PromiseVMa",
      CLASS_TYPES_TQ,
      CLASS_TYPES,
    ]);
    expect(imports.get("Foundation")).toEqual(["_NSFileSize"]);
  });

  it("parses exported symbols", () => {
    const exports = parseNmExports(nmText("ExpoModulesCore.defined.txt"));
    expect(exports).toEqual(
      new Set([
        "_$s15ExpoModulesCore5FieldCMn",
        "_$s15ExpoModulesCore6RecordMp",
        "_$s15ExpoModulesCore7PromiseVMa",
        "_EXGrantedKey",
        "_EXStatusKey",
      ]),
    );
  });
});

describe("symbolGaps", () => {
  it("finds the ../app crash pair", () => {
    const gaps = symbolGaps(crashScan());
    expect(gaps).toEqual([{ framework: fileSystem, from: core, missing: [CLASS_TYPES_TQ, CLASS_TYPES] }]);
  });

  it("ignores weak imports and system libraries", () => {
    const text = [
      "                 (undefined) weak external _$s15ExpoModulesCore3NewV (from ExpoModulesCore)",
      "                 (undefined) external _NSFileSize (from Foundation)",
    ].join("\n");
    const gaps = symbolGaps([
      { fw: fileSystem, imports: parseNmImports(text), exports: new Set() },
      { fw: core, imports: new Map(), exports: new Set(["_$s15ExpoModulesCore4OldV"]) },
    ]);
    expect(gaps).toEqual([]);
  });

  it("matches libraries by executable name", () => {
    const hermes: RuntimeFramework = { ...fw("hermes", "hermesvm"), name: "hermesvm", executable: "hermesvm" };
    const react = fw("react", "React");
    const gaps = symbolGaps([
      { fw: react, imports: parseNmImports("(undefined) external _hermes_new (from hermesvm)"), exports: new Set() },
      { fw: hermes, imports: new Map(), exports: new Set(["_hermes_old"]) },
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].from.id).toBe("hermes");
    expect(gaps[0].missing).toEqual(["_hermes_new"]);
  });
});

describe("frameworkOrigin", () => {
  it("names packages where the build resolves them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbols-origin-"));
    await fakeExpo58Modules(root);
    expect(frameworkOrigin(root, fileSystem)).toEqual({
      pkg: "expo-file-system",
      version: "58.0.13",
      dir: "node_modules/expo/node_modules/expo-file-system",
      builtByRnXtool: false,
    });
    expect(frameworkOrigin(root, fw("expo-modules-worklets", "ExpoModulesWorklets"))).toEqual({
      pkg: "expo-modules-core",
      version: "58.0.28",
      dir: "node_modules/expo-modules-core",
      builtByRnXtool: false,
    });
    expect(frameworkOrigin(root, fw("react", "React"))).toEqual({
      pkg: "react-native",
      version: "0.88.1",
      dir: "node_modules/react-native",
      builtByRnXtool: false,
    });
    expect(frameworkOrigin(root, jsi)).toEqual({
      pkg: "expo-modules-jsi",
      version: "58.0.21",
      dir: "node_modules/expo-modules-jsi",
      builtByRnXtool: true,
    });
    expect(frameworkOrigin(root, fw("left-pad", "LeftPad"))).toEqual({ pkg: "left-pad", builtByRnXtool: false });
  });
});

describe("symbolGapMessage", () => {
  it("writes the G4 text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbols-text-"));
    await fakeExpo58Modules(root, { "expo-modules-core": "58.0.26" });
    const [crash] = symbolGaps(crashScan());
    expect(symbolGapMessage(root, [crash])).toBe(
      "ExpoFileSystem.framework (expo-file-system 58.0.13, from node_modules/expo/node_modules/expo-file-system) needs 2 " +
        "symbols that ExpoModulesCore.framework (expo-modules-core 58.0.26, from node_modules/expo-modules-core) does not " +
        `export, for example ${CLASS_TYPES_TQ}. ${REMEDY("expo-modules-core")}. Run \`npx expo install --fix\`, remove any ` +
        "pin or lockfile hold on expo-modules-core, reinstall, and build again.",
    );

    const fontGap = { framework: font, from: core, missing: [CLASS_TYPES_TQ, CLASS_TYPES] };
    const lines = symbolGapMessage(root, [crash, fontGap]).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(symbolGapMessage(root, [crash]));
    expect(lines[1]).toBe(
      "ExpoFont.framework (expo-font 58.0.11, from node_modules/expo/node_modules/expo-font) needs 2 symbols that " +
        "ExpoModulesCore.framework (expo-modules-core 58.0.26, from node_modules/expo-modules-core) does not export, for " +
        `example ${CLASS_TYPES_TQ}. ${REMEDY("expo-modules-core")}. Run \`npx expo install --fix\`, remove any pin or ` +
        "lockfile hold on expo-modules-core, reinstall, and build again.",
    );

    const jsiGap = { framework: fileSystem, from: jsi, missing: ["_$s14ExpoModulesJSI19JavaScriptEncodableP6encode"] };
    const jsiText = symbolGapMessage(root, [jsiGap]);
    expect(jsiText).toContain(
      "needs 1 symbol that ExpoModulesJSI.framework (expo-modules-jsi 58.0.21, built by rn-xtool from node_modules/expo-modules-jsi)",
    );
    expect(jsiText).toContain(
      "another expo-modules-jsi (expo-modules-core 58.0.26 declares expo-modules-jsi ~58.0.21). Run `npx expo install --fix`, " +
        "remove any pin or lockfile hold on expo-modules-jsi,",
    );
  });
});

describe("checkFrameworkSymbols", () => {
  it("runs llvm-nm twice per framework", async () => {
    const calls: string[][] = [];
    const nm: NmRunner = async (args) => {
      calls.push(args);
      return "";
    };
    const fws = [fw("expo-modules-core", "ExpoModulesCore", "/x/ExpoModulesCore.framework"), { ...jsi, frameworkDir: "/y/J.framework" }];
    await expect(checkFrameworkSymbols("/nowhere", fws, nm)).resolves.toBeUndefined();
    expect(calls).toEqual([
      nmImportArgs("/x/ExpoModulesCore.framework/ExpoModulesCore"),
      nmExportArgs("/x/ExpoModulesCore.framework/ExpoModulesCore"),
      nmImportArgs("/y/J.framework/ExpoModulesJSI"),
      nmExportArgs("/y/J.framework/ExpoModulesJSI"),
    ]);
    expect(nmImportArgs("/b")).toEqual(["--arch=arm64", "-m", "--undefined-only", "/b"]);
    expect(nmExportArgs("/b")).toEqual(["--arch=arm64", "--defined-only", "--extern-only", "-j", "/b"]);
  });

  it("stops when llvm-nm is missing", async () => {
    await expect(makeNmRunner("rn-xtool-no-such-llvm-nm")(["--version"])).rejects.toMatchObject({ message: LLVM_NM_MISSING });
  });
});

const hasNm = await makeNmRunner()(["--version"]).then(
  () => true,
  () => false,
);

describe.skipIf(!hasNm)("checkFrameworkSymbols on real Mach-O binaries", () => {
  const dir = fixture("macho-symbols");
  const mod = fw("fixture-mod", "Mod", path.join(dir, "Mod.framework"));
  const coreV1 = fw("fixture-core", "Core", path.join(dir, "Core-v1", "Core.framework"));
  const coreV2 = fw("fixture-core", "Core", path.join(dir, "Core-v2", "Core.framework"));

  it("catches a missing import on real Mach-O binaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbols-macho-"));
    const message = await checkFrameworkSymbols(root, [mod, coreV1]).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    expect(message).toContain("_core_new");
    expect(message).toContain("needs 1 symbol");
    expect(message).not.toContain("_core_weak");
    await expect(checkFrameworkSymbols(root, [mod, coreV2])).resolves.toBeUndefined();
  });
});
