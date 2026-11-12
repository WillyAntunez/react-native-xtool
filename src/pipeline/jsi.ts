import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { jsiFramework, type RuntimeFramework } from "../frameworks.js";
import type { ProjectPaths } from "../paths.js";
import { expoPackageDir } from "../project/expo.js";
import { troubleshootingUrl } from "../docs.js";
import { packageRoot, runKeepingOutput, toolEnv } from "../tools/exec.js";
import { jsiObjectsDir, jsiScratchDir, writeJsiHeadersXcframework } from "./jsiHeaders.js";

export function jsiArgv(paths: ProjectPaths): string[] {
  return [path.join(packageRoot(), "scripts", "build-expo-modules-jsi.sh"), paths.root, paths.jsiOut];
}

/** The `ios-arm64` header dirs the JSI build compiles against, in place of `ios/build/xcframeworks`. */
export interface JsiRnHeaders {
  react: string;
  dependencies: string;
}

/** The header dirs of the adapted React Native artifacts at `artifactsRoot` (`<root>/debug/...`). */
export function jsiRnHeaderDirs(artifactsRoot: string): JsiRnHeaders {
  const headers = (xcframework: string) => path.join(artifactsRoot, "debug", `${xcframework}.xcframework`, "ios-arm64", "Headers");
  return { react: headers("ReactNativeHeaders"), dependencies: headers("ReactNativeDependenciesHeaders") };
}

/** The build script's header overrides: none without `h`. */
export function jsiEnv(h?: JsiRnHeaders): Record<string, string> {
  return h ? { RN_XTOOL_REACT_HEADERS: h.react, RN_XTOOL_DEPS_HEADERS: h.dependencies } : {};
}

/** Clang's words for a precompiled module file it cannot read (a killed build leaves them empty or cut short). */
const BAD_MODULE_FILE = /is not a valid (?:precompiled )?module file/;

/** The jsi build's failure, explained when its output shows a module cache a killed build left behind. */
function jsiFailure(e: unknown): unknown {
  const out = e instanceof Error ? `${String((e as { stdout?: unknown }).stdout ?? "")}\n${String((e as { stderr?: unknown }).stderr ?? "")}` : "";
  if (!(e instanceof Error) || !BAD_MODULE_FILE.test(out)) return e;
  return new Error(
    `${e.message}\n` +
      "The jsi step stopped on a precompiled module file in ExpoModulesJSI's module cache that is empty or cut short " +
      '("is not a valid module file"): a build interrupted during the jsi step leaves its module cache that way, and ' +
      "the next builds keep reading it. Run `rn-xtool build --clean`: it removes ios-xtool/jsi-out/.jsi-build, and " +
      `the jsi step builds ExpoModulesJSI again from the start. See ${troubleshootingUrl("interrupted-jsi-build")}`,
    { cause: e },
  );
}

/**
 * Builds ExpoModulesJSI.framework into `paths.jsiOut`. `rnHeaders` points the build at React Native headers outside
 * `ios/build/xcframeworks` (checked before building); `headersXcframework` then writes ExpoModulesJSIHeaders.xcframework
 * under `paths.expoPrecompiled` (the vendored Expo plugin's SDKs, which do not ship it). `clean` (`build --clean`)
 * removes the build's scratch first, module cache included, so a cache an interrupted build left cannot stop it.
 */
export async function buildExpoModulesJsi(
  paths: ProjectPaths,
  opts: { rnHeaders?: JsiRnHeaders; headersXcframework?: boolean; clean?: boolean } = {},
): Promise<RuntimeFramework> {
  if (opts.rnHeaders) {
    for (const dir of [opts.rnHeaders.react, opts.rnHeaders.dependencies]) {
      if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
        throw new Error(
          `ExpoModulesJSI needs React Native's headers at ${dir}, which does not exist. ` +
            "rnArtifactsDir must hold the adapted slots of the project's React Native version, as rn-xtool's rn-artifacts " +
            "step writes them.",
        );
      }
    }
  }
  const env = toolEnv(jsiEnv(opts.rnHeaders));
  if (!opts.rnHeaders) {
    // Overrides left in the user's shell must not redirect an Expo 58 or bare build.
    delete env.RN_XTOOL_REACT_HEADERS;
    delete env.RN_XTOOL_DEPS_HEADERS;
  }
  if (opts.clean) rmSync(jsiScratchDir(paths.jsiOut), { recursive: true, force: true });
  try {
    await runKeepingOutput("bash", jsiArgv(paths), { cwd: paths.root, nice: true, env });
  } catch (e) {
    throw jsiFailure(e);
  }
  if (opts.headersXcframework) {
    // The script built the copy this resolves (it resolves expo-modules-jsi the same way), so it exists here.
    const jsiDir = expoPackageDir(paths.root, "expo-modules-jsi")!;
    const jsiVersion = (JSON.parse(readFileSync(path.join(jsiDir, "package.json"), "utf8")) as { version: string }).version;
    await writeJsiHeadersXcframework({
      objectsDir: jsiObjectsDir(paths.jsiOut),
      jsiDir,
      jsiVersion,
      precompiledRoot: paths.expoPrecompiled,
    });
  }
  return jsiFramework(paths.jsiOut);
}
