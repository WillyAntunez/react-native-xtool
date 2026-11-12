import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectPaths } from "../src/paths.js";
import { jsiScratchDir } from "../src/pipeline/jsiHeaders.js";
import { badModuleFileHint, explainBadModuleFile } from "../src/pipeline/moduleCache.js";

const tmp: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "rn-xtool-module-cache-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const DOCS = "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md#interrupted-build";

/** Clang's error for a module file a killed build left empty, as the build's output shows it. */
const clangError = (pcm: string, precompiled = false): string =>
  `error: clang dependency scanning failure: module-include.input:1:1: fatal error: file '${pcm}' is not a valid ` +
  `${precompiled ? "precompiled " : ""}module file: file too small to contain precompiled file magic\n`;

const APP_BUILD_HINT =
  "xtool dev build stopped on a precompiled module file in the app build's module cache (ios-xtool/.build) that is " +
  'empty or cut short ("is not a valid module file"): a build interrupted during xtool-build leaves its module cache ' +
  "that way, and the next builds keep reading it. `rn-xtool build --clean` does not remove ios-xtool/.build on Expo " +
  "projects. Run `rm -rf ios-xtool/.build` in the project folder, then `rn-xtool build`: its xtool-build starts cold " +
  `and takes several minutes. See ${DOCS}`;

const JSI_HINT =
  "The jsi step stopped on a precompiled module file in ExpoModulesJSI's module cache that is empty or cut short " +
  '("is not a valid module file"): a build interrupted during the jsi step leaves its module cache that way, and the ' +
  "next builds keep reading it. Run `rm -rf ios-xtool/jsi-out/.jsi-build` in the project folder, then `rn-xtool " +
  "build`, or run `rn-xtool build --clean`, which removes that folder too; either way the jsi step builds " +
  `ExpoModulesJSI again from the start. See ${DOCS}`;

describe("a module file a killed build left", () => {
  const paths = projectPaths("/p");
  const appPcm = "/p/ios-xtool/.build/out/ModuleCache.noindex/2Q3RU8WPC1BAT/React-2LKUWK1W8NI4W.pcm";
  const jsiPcm = path.join(jsiScratchDir(paths.jsiOut), ".build", "out", "ModuleCache.noindex", "3O7AC8YK2FU8", "jsi-1QS40U1KVCYHX.pcm");

  it("under ios-xtool/.build names the interrupted xtool-build and deleting that folder", () => {
    expect(badModuleFileHint(`Compiling…\n${clangError(appPcm)}`, paths.iosXtool)).toBe(APP_BUILD_HINT);
    expect(badModuleFileHint(clangError(appPcm, true), paths.iosXtool)).toBe(APP_BUILD_HINT);
  });

  it("under the jsi build's scratch names the interrupted jsi step, deleting that folder and --clean", () => {
    expect(badModuleFileHint(clangError(jsiPcm), paths.iosXtool)).toBe(JSI_HINT);
  });

  it("anywhere else gives no paragraph", () => {
    for (const pcm of [
      "/var/tmp/clang/ModuleCache/X/Foundation-1.pcm",
      "/p/ios-xtool/.precheck/ModuleCache/X/React-1.pcm",
      "/p/ios-xtool/.build-old/out/ModuleCache.noindex/X/React-1.pcm",
      "/other/ios-xtool/.build/out/ModuleCache.noindex/X/React-1.pcm",
      "ios-xtool/.build/out/ModuleCache.noindex/X/React-1.pcm",
    ]) {
      expect(badModuleFileHint(clangError(pcm), paths.iosXtool), pcm).toBeUndefined();
    }
  });

  it("gives no paragraph when one of the files it names is elsewhere, nor without clang's error", () => {
    const other = "/var/tmp/clang/ModuleCache/X/Foundation-1.pcm";
    expect(badModuleFileHint(`${clangError(appPcm)}${clangError(other)}`, paths.iosXtool)).toBeUndefined();
    expect(badModuleFileHint(`${clangError(appPcm)}${clangError(jsiPcm)}`, paths.iosXtool)).toBeUndefined();
    expect(badModuleFileHint("error: cannot find 'jsi' in scope\n", paths.iosXtool)).toBeUndefined();
    expect(badModuleFileHint(`${clangError(appPcm)}${clangError(appPcm.replace("React", "Yoga"))}`, paths.iosXtool)).toBe(
      APP_BUILD_HINT,
    );
  });

  it("finds the folder when the project is reached through a symlink and clang names the real path", () => {
    const real = realpathSync(mkTmp());
    mkdirSync(path.join(real, "ios-xtool"), { recursive: true });
    const link = path.join(mkTmp(), "app");
    symlinkSync(real, link);
    const pcm = path.join(real, "ios-xtool", ".build", "out", "ModuleCache.noindex", "X", "React-1.pcm");
    expect(badModuleFileHint(clangError(pcm), projectPaths(link).iosXtool)).toBe(APP_BUILD_HINT);
  });

  it("appends the paragraph to a failure's message, keeping the failure as its cause", () => {
    const failure = Object.assign(new Error("Command failed with exit code 1: nice -n 15 xtool dev build --configuration debug"), {
      exitCode: 1,
      stdout: "Building for debugging...\n",
      stderr: clangError(appPcm),
    });
    const explained = explainBadModuleFile(failure, paths.iosXtool) as Error;
    expect(explained.message).toBe(`${failure.message}\n${APP_BUILD_HINT}`);
    expect(explained.cause).toBe(failure);
  });

  it("leaves a failure without that error, or with the file elsewhere, as it is", () => {
    const plain = Object.assign(new Error("Command failed with exit code 1: xtool"), { stdout: "", stderr: "error: x\n" });
    expect(explainBadModuleFile(plain, paths.iosXtool)).toBe(plain);
    const elsewhere = Object.assign(new Error("Command failed with exit code 1: xtool"), {
      stdout: clangError("/var/tmp/clang/ModuleCache/X/Foundation-1.pcm"),
      stderr: "",
    });
    expect(explainBadModuleFile(elsewhere, paths.iosXtool)).toBe(elsewhere);
    expect(explainBadModuleFile("not an error", paths.iosXtool)).toBe("not an error");
  });
});
