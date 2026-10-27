import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { jsiFramework, type RuntimeFramework } from "../frameworks.js";
import type { ProjectPaths } from "../paths.js";
import { expoPackageDir } from "../project/expo.js";
import { packageRoot, run, toolEnv } from "../tools/exec.js";
import { jsiObjectsDir, writeJsiHeadersXcframework } from "./jsiHeaders.js";

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

/**
 * Builds ExpoModulesJSI.framework into `paths.jsiOut`. `rnHeaders` points the build at React Native headers outside
 * `ios/build/xcframeworks` (checked before building); `headersXcframework` then writes ExpoModulesJSIHeaders.xcframework
 * under `paths.expoPrecompiled` (SDK 57, which does not ship it).
 */
export async function buildExpoModulesJsi(
  paths: ProjectPaths,
  opts: { rnHeaders?: JsiRnHeaders; headersXcframework?: boolean } = {},
): Promise<RuntimeFramework> {
  if (opts.rnHeaders) {
    for (const dir of [opts.rnHeaders.react, opts.rnHeaders.dependencies]) {
      if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
        throw new Error(
          `ExpoModulesJSI needs React Native's headers at ${dir}, which does not exist. ` +
            "rnArtifactsDir must hold adapted 0.86.3 slots, as rn-xtool's rn-artifacts step writes them.",
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
  await run("bash", jsiArgv(paths), { cwd: paths.root, nice: true, env });
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
