import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { ProjectPaths } from "../paths.js";
import { run, toolEnv } from "../tools/exec.js";

export function appConfigArgs(expoConstantsDir: string, root: string, dest: string): string[] {
  return [path.join(expoConstantsDir, "scripts", "getAppConfig.js"), root, dest, "ios", "true", "development"];
}

export async function generateAppConfig(paths: ProjectPaths): Promise<void> {
  const dest = path.join(paths.iosXtool, "EXConstants.bundle");
  await mkdir(dest, { recursive: true });
  const require = createRequire(path.join(paths.root, "package.json"));
  const expoDir = path.dirname(require.resolve("expo/package.json", { paths: [paths.root] }));
  const constantsDir = path.dirname(require.resolve("expo-constants/package.json", { paths: [expoDir] }));
  await run("node", appConfigArgs(constantsDir, paths.root, dest), {
    cwd: paths.root,
    env: toolEnv({ EXPO_CONSTANTS_ALLOW_NON_PODS: "1" }),
  });
}
