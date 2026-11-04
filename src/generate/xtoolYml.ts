export interface XtoolYmlInput {
  bundleIdentifier: string;
  resources?: string[];
  /** The app icon PNG, relative to xtool.yml; xtool copies it into the app and sets CFBundleIconFile. */
  iconPath?: string;
}

/** Bundled by every app; `EXConstants.bundle` joins them when expo-constants is installed. */
export const BASE_RESOURCES = ["Frameworks", "ip.txt"];
export const DEFAULT_RESOURCES = [...BASE_RESOURCES, "EXConstants.bundle"];

export function renderXtoolYml(i: XtoolYmlInput): string {
  const resources = i.resources ?? DEFAULT_RESOURCES;
  return [
    "version: 1",
    `bundleID: ${i.bundleIdentifier}`,
    "product: App",
    "infoPath: Info.plist",
    ...(i.iconPath !== undefined ? [`iconPath: ${i.iconPath}`] : []),
    "skipLSP: true",
    "resources:",
    ...resources.map((r) => `  - ${r}`),
    "",
  ].join("\n");
}
