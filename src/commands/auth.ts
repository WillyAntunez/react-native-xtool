import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { run } from "../tools/exec.js";
import { xtoolBin } from "../tools/xtool.js";

export interface AuthDeps {
  loadConfig?: (root: string) => Promise<ExpoXtoolConfig>;
  bin?: (config: ExpoXtoolConfig) => string;
  /** Runs xtool interactively (inherited stdio: login prompts for the Apple ID). */
  runner?: typeof run;
}

/** `rn-xtool auth <args...>` maps to `xtool auth <args...>`; no arguments mean `xtool auth status`. */
export function authArgs(args: string[]): string[] {
  return ["auth", ...(args.length > 0 ? args : ["status"])];
}

export async function auth(root: string, args: string[], x: AuthDeps = {}): Promise<void> {
  const config = await (x.loadConfig ?? loadConfig)(root);
  const bin = (x.bin ?? xtoolBin)(config);
  await (x.runner ?? run)(bin, authArgs(args));
}
