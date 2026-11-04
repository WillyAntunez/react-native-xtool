import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { runKeepingOutput, runKeepingStderr } from "../tools/exec.js";
import { xtoolBin } from "../tools/xtool.js";
import { ExitError } from "../exitError.js";
import { explainingXtool, explainXtoolOutput, xtoolCancelled } from "../tools/xtoolErrors.js";

export interface AuthDeps {
  loadConfig?: (root: string) => Promise<ExpoXtoolConfig>;
  bin?: (config: ExpoXtoolConfig) => string;
  /** Runs `xtool auth status|logout|…`: stdin and stdout on the terminal, stderr shown and kept. */
  runner?: (cmd: string, args: string[]) => Promise<void>;
  /**
   * Runs `xtool auth login` interactively: stdin on the terminal, stdout and stderr shown and kept,
   * since xtool reports a cancelled prompt on stdout and exits 0.
   */
  loginRunner?: (cmd: string, args: string[]) => Promise<string>;
}

/** `rn-xtool auth <args...>` maps to `xtool auth <args...>`; no arguments mean `xtool auth status`. */
export function authArgs(args: string[]): string[] {
  return ["auth", ...(args.length > 0 ? args : ["status"])];
}

/** The exit status of a run ended by Ctrl+C (128 + SIGINT), as before rn-xtool stayed alive for it. */
const INTERRUPTED = 130;

/**
 * While `xtool auth login` runs, Ctrl+C reaches xtool (same terminal), which cancels and prints
 * `Cancelled.`; rn-xtool stays alive to read that and explain it.
 */
const keepRunningOnSigint = (): void => {};

export async function auth(root: string, args: string[], x: AuthDeps = {}): Promise<void> {
  const config = await (x.loadConfig ?? loadConfig)(root);
  const bin = (x.bin ?? xtoolBin)(config);
  if (args[0] !== "login") {
    await explainingXtool(() => (x.runner ?? runKeepingStderr)(bin, authArgs(args)), { signIn: true });
    return;
  }
  process.on("SIGINT", keepRunningOnSigint);
  try {
    const output = await explainingXtool(() => (x.loginRunner ?? runKeepingOutput)(bin, authArgs(args)), {
      login: true,
    });
    const known = explainXtoolOutput(output, { login: true });
    if (known?.id === "login-interrupted") throw new ExitError(known.message, INTERRUPTED);
    if (xtoolCancelled(output)) throw new ExitError("", INTERRUPTED);
  } finally {
    process.off("SIGINT", keepRunningOnSigint);
  }
}
