import { build } from "./build.js";
import { install } from "./install.js";
import { start } from "./start.js";

export interface RunDeps {
  build: (root: string, opts: { clean?: boolean }) => Promise<void>;
  install: (root: string) => Promise<void>;
  start: (root: string, opts: { clear?: boolean }) => Promise<void>;
}

export async function run(
  root: string,
  opts: { clean?: boolean },
  overrides: Partial<RunDeps> = {},
): Promise<void> {
  const d: RunDeps = { build, install, start, ...overrides };
  await d.build(root, opts);
  await d.install(root);
  await d.start(root, {});
}
