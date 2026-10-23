export interface XtoolYmlInput {
  bundleIdentifier: string;
  resources?: string[];
}

export const DEFAULT_RESOURCES = ["Frameworks", "ip.txt", "EXConstants.bundle"];

export function renderXtoolYml(i: XtoolYmlInput): string {
  const resources = i.resources ?? DEFAULT_RESOURCES;
  return [
    "version: 1",
    `bundleID: ${i.bundleIdentifier}`,
    "product: App",
    "infoPath: Info.plist",
    "skipLSP: true",
    "resources:",
    ...resources.map((r) => `  - ${r}`),
    "",
  ].join("\n");
}
