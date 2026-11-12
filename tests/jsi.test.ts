import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPaths } from "../src/paths.js";
import { buildExpoModulesJsi, jsiEnv, jsiRnHeaderDirs } from "../src/pipeline/jsi.js";
import { jsiHeadersXcframeworkDir, jsiObjectsDir, jsiScratchDir } from "../src/pipeline/jsiHeaders.js";
import { packageRoot, runKeepingOutput, toolEnv } from "../src/tools/exec.js";
import { fakeExpo57Modules } from "./support/expo57.js";
import { FAKE_NATIVE_STATE, FAKE_SWIFT_HEADER, FAKE_SWIFT_INTERFACE } from "./support/fakeJsiBuild.js";

vi.mock("../src/tools/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/exec.js")>();
  return { ...actual, runKeepingOutput: vi.fn() };
});
const runMock = vi.mocked(runKeepingOutput);
beforeEach(() => runMock.mockReset());

const tmp: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "rn-xtool-jsi-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const SCRIPT = path.join(packageRoot(), "scripts", "build-expo-modules-jsi.sh");

describe("ExpoModulesJSI React Native header overrides", () => {
  it("passes the React Native header overrides", () => {
    expect(jsiEnv(jsiRnHeaderDirs("/a/0.86.3"))).toEqual({
      RN_XTOOL_REACT_HEADERS: "/a/0.86.3/debug/ReactNativeHeaders.xcframework/ios-arm64/Headers",
      RN_XTOOL_DEPS_HEADERS: "/a/0.86.3/debug/ReactNativeDependenciesHeaders.xcframework/ios-arm64/Headers",
    });
    expect(jsiEnv()).toEqual({});
  });

  it("stops when the React Native headers are missing", async () => {
    const root = mkTmp();
    const slots = mkTmp();
    const paths = projectPaths(root);
    await expect(buildExpoModulesJsi(paths, { rnHeaders: jsiRnHeaderDirs(slots) })).rejects.toThrow(
      `ExpoModulesJSI needs React Native's headers at ${slots}/debug/ReactNativeHeaders.xcframework/ios-arm64/Headers, which does not exist. ` +
        "rnArtifactsDir must hold the adapted slots of the project's React Native version, as rn-xtool's rn-artifacts step writes them.",
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it("stops when only the dependencies headers are missing", async () => {
    const slots = mkTmp();
    const h = jsiRnHeaderDirs(slots);
    mkdirSync(h.react, { recursive: true });
    await expect(buildExpoModulesJsi(projectPaths(mkTmp()), { rnHeaders: h })).rejects.toThrow(
      `ExpoModulesJSI needs React Native's headers at ${h.dependencies}, which does not exist. ` +
        "rnArtifactsDir must hold the adapted slots of the project's React Native version, as rn-xtool's rn-artifacts step writes them.",
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it("the script honours the overrides", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).toMatch(/^REACT_HEADERS="\$\{RN_XTOOL_REACT_HEADERS:-/m);
    expect(text).toMatch(/^DEPENDENCIES_HEADERS="\$\{RN_XTOOL_DEPS_HEADERS:-/m);
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });
});

describe("buildExpoModulesJsi", () => {
  it("runs the script as before when given no options, ignoring overrides left in the shell", async () => {
    const paths = projectPaths(mkTmp());
    vi.stubEnv("RN_XTOOL_REACT_HEADERS", "/stale/react");
    vi.stubEnv("RN_XTOOL_DEPS_HEADERS", "/stale/deps");
    let fw;
    try {
      fw = await buildExpoModulesJsi(paths);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(runMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = runMock.mock.calls[0]!;
    expect([cmd, args]).toEqual(["bash", [SCRIPT, paths.root, paths.jsiOut]]);
    expect(opts).toMatchObject({ cwd: paths.root, nice: true });
    expect(opts?.env?.RN_XTOOL_REACT_HEADERS).toBeUndefined();
    expect(opts?.env?.RN_XTOOL_DEPS_HEADERS).toBeUndefined();
    expect(opts?.env?.PATH).toBe(toolEnv().PATH);
    expect(fw.frameworkDir).toBe(path.join(paths.jsiOut, "ExpoModulesJSI.framework"));
    expect(existsSync(paths.expoPrecompiled)).toBe(false);
  });

  it("runs the script with the overrides, then writes the headers xcframework", async () => {
    const root = mkTmp();
    await fakeExpo57Modules(root);
    const paths = projectPaths(root);
    const h = jsiRnHeaderDirs(mkTmp());
    mkdirSync(h.react, { recursive: true });
    mkdirSync(h.dependencies, { recursive: true });
    runMock.mockImplementation(async () => {
      const objects = jsiObjectsDir(paths.jsiOut);
      mkdirSync(objects, { recursive: true });
      writeFileSync(path.join(objects, "ExpoModulesJSI-Swift.h"), FAKE_SWIFT_HEADER);
      writeFileSync(path.join(objects, "ExpoModulesJSI.swiftinterface"), FAKE_SWIFT_INTERFACE);
      const pub = path.join(root, "node_modules", "expo-modules-jsi", "apple", "Sources", "ExpoModulesJSI-Cxx", "include", "Public");
      mkdirSync(pub, { recursive: true });
      writeFileSync(path.join(pub, "NativeState.h"), FAKE_NATIVE_STATE);
    });

    await buildExpoModulesJsi(paths, { rnHeaders: h, headersXcframework: true });
    const env = runMock.mock.calls[0]![2]?.env;
    expect(env?.RN_XTOOL_REACT_HEADERS).toBe(h.react);
    expect(env?.RN_XTOOL_DEPS_HEADERS).toBe(h.dependencies);
    const xcframework = jsiHeadersXcframeworkDir(paths.expoPrecompiled);
    expect(JSON.parse(readFileSync(path.join(xcframework, "expo-package.json"), "utf8"))).toEqual({
      name: "expo-modules-jsi",
      version: "57.1.3",
    });
  });
});

describe("a build interrupted during jsi", () => {
  /** A jsi scratch as a killed build leaves it: one zero-byte module file in its module cache. */
  const poisoned = (jsiOut: string): string => {
    const pcm = path.join(jsiScratchDir(jsiOut), ".build", "out", "ModuleCache.noindex", "3O7AC8YK2FU8", "jsi-1QS40U1KVCYHX.pcm");
    mkdirSync(path.dirname(pcm), { recursive: true });
    writeFileSync(pcm, "");
    return pcm;
  };

  it("is the script's scratch folder", () => {
    expect(jsiScratchDir("/p/ios-xtool/jsi-out")).toBe("/p/ios-xtool/jsi-out/.jsi-build");
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/^WORK="\$OUT\/\.jsi-build"$/m);
    expect(jsiObjectsDir("/o").startsWith(`${jsiScratchDir("/o")}/`)).toBe(true);
  });

  it("--clean removes the jsi build's scratch before the script runs, and nothing else in jsi-out", async () => {
    const paths = projectPaths(mkTmp());
    poisoned(paths.jsiOut);
    const framework = path.join(paths.jsiOut, "ExpoModulesJSI.framework", "ExpoModulesJSI");
    mkdirSync(path.dirname(framework), { recursive: true });
    writeFileSync(framework, "last build");
    let scratchAtRun: boolean | undefined;
    runMock.mockImplementation(async () => {
      scratchAtRun = existsSync(jsiScratchDir(paths.jsiOut));
      return "";
    });
    await buildExpoModulesJsi(paths, { clean: true });
    expect(scratchAtRun).toBe(false);
    expect(readFileSync(framework, "utf8")).toBe("last build");
  });

  it("keeps the jsi build's scratch without --clean", async () => {
    const paths = projectPaths(mkTmp());
    const pcm = poisoned(paths.jsiOut);
    runMock.mockResolvedValue("");
    await buildExpoModulesJsi(paths);
    expect(existsSync(pcm)).toBe(true);
  });

  it("names the module cache and the remedy when the build fails on a module file cut short", async () => {
    const paths = projectPaths(mkTmp());
    const pcm = poisoned(paths.jsiOut);
    const failure = Object.assign(new Error(`Command failed with exit code 1: nice -n 15 bash ${SCRIPT} ${paths.root} ${paths.jsiOut}`), {
      stdout: "Building for debugging...\nerror: Build failed\n",
      stderr:
        `error: clang dependency scanning failure: module-include.input:1:1: fatal error: file '${pcm}' is not a valid ` +
        "module file: file too small to contain precompiled file magic\n",
    });
    runMock.mockRejectedValueOnce(failure);
    const error = (await buildExpoModulesJsi(paths).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      `${failure.message}\n` +
        "The jsi step stopped on a precompiled module file in ExpoModulesJSI's module cache that is empty or cut short " +
        '("is not a valid module file"): a build interrupted during the jsi step leaves its module cache that way, and the ' +
        "next builds keep reading it. Run `rm -rf ios-xtool/jsi-out/.jsi-build` in the project folder, then `rn-xtool " +
        "build`, or run `rn-xtool build --clean`, which removes that folder too; either way the jsi step builds " +
        "ExpoModulesJSI again from the start. See " +
        "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md#interrupted-build",
    );
    expect(error.cause).toBe(failure);
  });

  it("leaves a module file error outside the jsi build's scratch as it is", async () => {
    const paths = projectPaths(mkTmp());
    const failure = Object.assign(new Error("Command failed with exit code 1: bash x"), {
      stdout: "",
      stderr: "fatal error: file '/var/tmp/clang/ModuleCache/X/Foundation-1.pcm' is not a valid module file\n",
    });
    runMock.mockRejectedValueOnce(failure);
    await expect(buildExpoModulesJsi(paths)).rejects.toBe(failure);
  });

  it("leaves any other jsi failure as it is", async () => {
    const paths = projectPaths(mkTmp());
    const failure = Object.assign(new Error("Command failed with exit code 1: bash x"), {
      stdout: "",
      stderr: "error: cannot find 'jsi' in scope\n",
    });
    runMock.mockRejectedValueOnce(failure);
    await expect(buildExpoModulesJsi(paths)).rejects.toBe(failure);
  });
});
