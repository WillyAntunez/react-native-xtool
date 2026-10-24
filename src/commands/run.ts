import { existsSync } from "node:fs";
import { nativeDepsFingerprint } from "../deps.js";
import { projectPaths } from "../paths.js";
import { readState, type BuildState } from "../state.js";
import { build } from "./build.js";
import { install } from "./install.js";
import { start } from "./start.js";

export interface RunDeps {
  build: (root: string, opts: { clean?: boolean }) => Promise<void>;
  install: (root: string) => Promise<void>;
  start: (root: string, opts: { clear?: boolean }) => Promise<void>;
  readState: (iosXtoolDir: string) => Promise<BuildState | undefined>;
  depsFingerprint: (root: string) => Promise<string>;
  exists: (path: string) => boolean;
  log: (s: string) => void;
}

const realDeps: RunDeps = {
  build,
  install,
  start,
  readState,
  depsFingerprint: nativeDepsFingerprint,
  exists: existsSync,
  log: (s) => console.log(s),
};

export async function run(
  root: string,
  opts: { clean?: boolean; force?: boolean },
  overrides: Partial<RunDeps> = {},
): Promise<void> {
  const d: RunDeps = { ...realDeps, ...overrides };
  if (opts.force !== true && opts.clean !== true && (await upToDate(root, d))) {
    d.log("Native app is up to date (no dependency changes); skipping build and install.");
  } else {
    await d.build(root, { clean: opts.clean });
    await d.install(root);
  }
  await d.start(root, {});
}

async function upToDate(root: string, d: RunDeps): Promise<boolean> {
  const paths = projectPaths(root);
  const state = await d.readState(paths.iosXtool).catch(() => undefined);
  if (!state?.depsFingerprint || !d.exists(paths.appBundle)) return false;
  return state.depsFingerprint === (await d.depsFingerprint(root));
}
