import { loadConfig } from "../config.js";
import { readBareProject } from "./bare.js";
import { detectProjectKind } from "./detect.js";
import { readExpoProject } from "./expo.js";
import type { ProjectInfo, ReadProjectOptions } from "./types.js";

export type { ExpoProject, ProjectInfo, ProjectKind, ReadProjectOptions } from "./types.js";
export type { BareTargetContent, TargetFile } from "./pbxproj.js";
export { readTargetContent } from "./pbxproj.js";
export { DetectError, detectProjectKind } from "./detect.js";
export { RN_CLI_MISSING } from "./bare.js";
export { buildVars, defaultBundleIdentifier, isInstalled, MissingBundleIdentifierError, readExpoProject } from "./expo.js";

export async function readProject(root: string, opts: ReadProjectOptions = {}): Promise<ProjectInfo> {
  const kind = detectProjectKind(root, (await loadConfig(root)).projectKind);
  if (kind === "expo") return readExpoProject(root, opts);
  return readBareProject(root, opts);
}
