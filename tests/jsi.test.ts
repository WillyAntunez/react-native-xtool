import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPaths } from "../src/paths.js";
import { buildExpoModulesJsi, jsiEnv, jsiRnHeaderDirs } from "../src/pipeline/jsi.js";
import { jsiHeadersXcframeworkDir, jsiObjectsDir } from "../src/pipeline/jsiHeaders.js";
import { packageRoot, run, toolEnv } from "../src/tools/exec.js";
import { fakeExpo57Modules } from "./support/expo57.js";
import { FAKE_NATIVE_STATE, FAKE_SWIFT_HEADER, FAKE_SWIFT_INTERFACE } from "./support/fakeJsiBuild.js";

vi.mock("../src/tools/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/exec.js")>();
  return { ...actual, run: vi.fn() };
});
const runMock = vi.mocked(run);
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
        "rnArtifactsDir must hold adapted 0.86.3 slots, as rn-xtool's rn-artifacts step writes them.",
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it("stops when only the dependencies headers are missing", async () => {
    const slots = mkTmp();
    const h = jsiRnHeaderDirs(slots);
    mkdirSync(h.react, { recursive: true });
    await expect(buildExpoModulesJsi(projectPaths(mkTmp()), { rnHeaders: h })).rejects.toThrow(
      `ExpoModulesJSI needs React Native's headers at ${h.dependencies}, which does not exist. ` +
        "rnArtifactsDir must hold adapted 0.86.3 slots, as rn-xtool's rn-artifacts step writes them.",
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
