import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectKind } from "./types.js";

export class DetectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectError";
  }
}

const APP_CONFIG_FILES = ["app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs", "app.config.json"];

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function hasExpoConfig(root: string): boolean {
  if (APP_CONFIG_FILES.some((f) => existsSync(path.join(root, f)))) return true;
  const app = readJson(path.join(root, "app.json"));
  return app !== undefined && typeof app === "object" && app !== null && "expo" in app;
}

function xcodeprojs(root: string): string[] {
  try {
    return readdirSync(path.join(root, "ios"))
      .filter((n) => n.endsWith(".xcodeproj"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * `expo` iff package.json depends on `expo` and an Expo config exists; otherwise `bare` iff `ios/` holds exactly one
 * `.xcodeproj`. `override` (the `projectKind` config key) skips detection.
 */
export function detectProjectKind(root: string, override?: ProjectKind): ProjectKind {
  if (override) return override;
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg?.dependencies?.expo && hasExpoConfig(root)) return "expo";
  if (!existsSync(path.join(root, "ios"))) {
    throw new DetectError(
      `${root}: not an Expo project and no ios/ directory found. For a bare React Native project, create it with ` +
        "`npx @react-native-community/cli init` (no ios/ directory means there is nothing to build).",
    );
  }
  const projects = xcodeprojs(root);
  if (projects.length === 0) throw new DetectError(`${root}: ios/ has no .xcodeproj, so this is not a bare React Native iOS project`);
  if (projects.length > 1) {
    throw new DetectError(`ios/ holds more than one .xcodeproj (${projects.join(", ")}); expo-xtool needs exactly one`);
  }
  return "bare";
}
