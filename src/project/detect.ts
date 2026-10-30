import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectKind } from "./types.js";

export class DetectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectError";
  }
}

/** A refusal of the installed versions: a bare line's floor, G1 (the Expo pins) or a hybrid app's gate. */
export class VersionGateError extends DetectError {
  constructor(message: string) {
    super(message);
    this.name = "VersionGateError";
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
  // An Expo project whose app.json is flat (no "expo" key) reads as bare: say how to keep it Expo.
  const expoHint = pkg?.dependencies?.expo
    ? '. package.json depends on expo but no Expo config was found (no app.config.* and no "expo" key in app.json), so ' +
      'it was read as a bare React Native project; if this is an Expo project, add "projectKind": "expo" to rn-xtool.config.json'
    : "";
  if (!existsSync(path.join(root, "ios"))) {
    if (expoHint) throw new DetectError(`${root}: no ios/ directory${expoHint}`);
    throw new DetectError(
      `${root}: not an Expo project and no ios/ directory found. For a bare React Native project, create it with ` +
        "`npx @react-native-community/cli init` (no ios/ directory means there is nothing to build).",
    );
  }
  const projects = xcodeprojs(root);
  if (projects.length === 0) {
    throw new DetectError(`${root}: ios/ has no .xcodeproj, so this is not a bare React Native iOS project${expoHint}`);
  }
  if (projects.length > 1) {
    throw new DetectError(`ios/ holds more than one .xcodeproj (${projects.join(", ")}); rn-xtool needs exactly one${expoHint}`);
  }
  return "bare";
}
