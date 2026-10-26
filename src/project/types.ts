export type ProjectKind = "expo" | "bare";

export interface ProjectInfo {
  kind: ProjectKind;
  root: string;
  name: string;
  slug: string;
  version: string;
  buildNumber: string;
  bundleIdentifier: string;
  moduleName: string;
  /** Sanitized name, as expo prebuild derives it (expo) or the app target name (bare). */
  iosTargetName: string;
  iosTargetDir: string;
  /** expo: ios/<target>/Info.plist; bare: from INFOPLIST_FILE. */
  infoPlistPath: string;
  rnVersion: string;
  sdkVersion?: number;
  hasExpoModules: boolean;
  hasExpoConstants: boolean;
  hasDevClient: boolean;
  bare?: unknown;
}

/** Alias kept for the migration. */
export type ExpoProject = ProjectInfo;

export interface ReadProjectOptions {
  /** Write a default `ios.bundleIdentifier` into a static app.json when it is missing (default true). */
  writeDefaults?: boolean;
  log?: (line: string) => void;
}
