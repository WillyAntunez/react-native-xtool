import path from "node:path";
import { jsiFramework, type RuntimeFramework } from "../frameworks.js";
import type { ProjectPaths } from "../paths.js";
import { packageRoot, run } from "../tools/exec.js";

export function jsiArgv(paths: ProjectPaths): string[] {
  return [path.join(packageRoot(), "scripts", "build-expo-modules-jsi.sh"), paths.root, paths.jsiOut];
}

export async function buildExpoModulesJsi(paths: ProjectPaths): Promise<RuntimeFramework> {
  await run("bash", jsiArgv(paths), { cwd: paths.root, nice: true });
  return jsiFramework(paths.jsiOut);
}
