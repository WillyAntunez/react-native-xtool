import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ProjectPaths } from "../paths.js";
import { run, toolEnv } from "../tools/exec.js";

export const AUTOLINKING_CONFIG_COMMAND = [
  "npx",
  "expo-modules-autolinking",
  "react-native-config",
  "--json",
  "--platform",
  "ios",
];

function resolveRnDir(paths: ProjectPaths): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve("react-native/package.json", { paths: [paths.root] }));
}

/** RN writes `.spm-injected.json` inside `ios/<App>.xcodeproj/`; the bare `ios/` location is accepted too. */
function hasSpmMarker(iosDir: string): boolean {
  if (existsSync(path.join(iosDir, ".spm-injected.json"))) return true;
  try {
    return readdirSync(iosDir).some(
      (name) => name.endsWith(".xcodeproj") && existsSync(path.join(iosDir, name, ".spm-injected.json")),
    );
  } catch {
    return false;
  }
}

export function rnSpmArgs(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string },
  rnDir: string = resolveRnDir(paths),
): string[] {
  const mode = hasSpmMarker(paths.ios) ? "update" : "add";
  return [
    path.join(rnDir, "scripts", "setup-apple-spm.js"),
    mode,
    "--config-command",
    JSON.stringify(AUTOLINKING_CONFIG_COMMAND),
    ...(opts.rnArtifactsDir ? ["--download", "skip", "--artifacts", opts.rnArtifactsDir] : []),
  ];
}

export async function runRnSpm(paths: ProjectPaths, opts: { rnArtifactsDir?: string }): Promise<void> {
  await run("node", rnSpmArgs(paths, opts), { cwd: paths.ios, env: toolEnv(), nice: true });
}
