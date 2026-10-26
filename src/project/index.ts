import { loadConfig } from "../config.js";
import { detectProjectKind } from "./detect.js";
import { readExpoProject } from "./expo.js";
import type { ProjectInfo, ReadProjectOptions } from "./types.js";

export type { ExpoProject, ProjectInfo, ProjectKind, ReadProjectOptions } from "./types.js";
export { DetectError, detectProjectKind } from "./detect.js";
export { buildVars, defaultBundleIdentifier, isInstalled, MissingBundleIdentifierError, readExpoProject } from "./expo.js";

export async function readProject(root: string, opts: ReadProjectOptions = {}): Promise<ProjectInfo> {
  const kind = detectProjectKind(root, (await loadConfig(root)).projectKind);
  if (kind === "expo") return readExpoProject(root, opts);
  throw new Error("bare projects: not wired yet");
}
