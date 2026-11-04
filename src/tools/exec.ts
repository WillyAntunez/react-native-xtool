import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

/** Root of the rn-xtool package (holds shims/, patches/, scripts/). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === "react-native-xtool") return dir;
      } catch {
        // unreadable package.json: keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("rn-xtool package root not found");
    dir = parent;
  }
}

export function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const prefix = [
    path.join(packageRoot(), "shims"),
    path.join(homedir(), ".local", "share", "swiftly", "bin"),
  ];
  env.PATH = [...prefix, ...(process.env.PATH ? [process.env.PATH] : [])].join(path.delimiter);
  delete env.SDKROOT;
  return env;
}

export function runArgv(cmd: string, args: string[], nice: boolean): [string, string[]] {
  return nice ? ["nice", ["-n", "15", cmd, ...args]] : [cmd, args];
}

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; nice?: boolean } = {},
): Promise<void> {
  const [bin, argv] = runArgv(cmd, args, opts.nice === true);
  await execa(bin, argv, {
    stdio: "inherit",
    cwd: opts.cwd,
    env: opts.env ?? toolEnv(),
    extendEnv: false,
  });
}

/** Whether an executable `name` is in `env.PATH`. */
export function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not in this folder
    }
  }
  return false;
}

/**
 * With `stdbuf` on PATH, the command runs under `stdbuf -oL`. A tee makes its stdout a pipe, which
 * C stdio (Swift's `print`) block-buffers: lines would show late and out of order with stderr. Line
 * buffering keeps them close to a terminal's. Without `stdbuf` the command runs as is.
 */
export function lineBufferedArgv(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  found: (name: string, env: NodeJS.ProcessEnv) => boolean = onPath,
): [string, string[]] {
  return found("stdbuf", env) ? ["stdbuf", ["-oL", cmd, ...args]] : [cmd, args];
}

/** How execa writes `lineBufferedArgv`'s wrapper in an error's command line. */
const LINE_BUFFERED = "stdbuf -oL ";

type TeeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nice?: boolean;
  /** How `stdbuf` is looked up; injectable for tests. */
  onPath?: (name: string, env: NodeJS.ProcessEnv) => boolean;
};

/** The argv of a teed command (line-buffered when it can be, under `nice` if asked) and its env. */
function teedArgv(
  cmd: string,
  args: string[],
  opts: TeeOptions,
  lineBuffered: boolean,
): { bin: string; argv: string[]; env: NodeJS.ProcessEnv; wrapped: boolean } {
  const env = opts.env ?? toolEnv();
  const [c, a] = lineBuffered ? lineBufferedArgv(cmd, args, env, opts.onPath) : [cmd, args];
  const [bin, argv] = runArgv(c, a, opts.nice === true);
  return { bin, argv, env, wrapped: c !== cmd };
}

/**
 * Keeps a failure printing as before. execa appends the output it kept to the error's message;
 * with `short`, that output was already shown live, so the same error object gets execa's one-line
 * message back, as `run` gives. A `stdbuf` wrapper is left out of the command line it names.
 */
async function failingAsBefore<T>(subprocess: Promise<T>, o: { short: boolean; wrapped?: boolean }): Promise<T> {
  try {
    return await subprocess;
  } catch (e) {
    if (e instanceof Error) {
      const short = (e as { shortMessage?: unknown }).shortMessage;
      if (o.short && typeof short === "string") e.message = short;
      if (o.wrapped) {
        const end = e.message.indexOf("\n");
        const first = end < 0 ? e.message : e.message.slice(0, end);
        e.message = first.replace(LINE_BUFFERED, "") + (end < 0 ? "" : e.message.slice(end));
      }
    }
    throw e;
  }
}

/**
 * Like `run` (stdin and stdout on the terminal), but stderr is also kept: it is shown live and,
 * when the command fails, execa's error carries it as `.stderr`, so a known failure can be explained.
 */
export async function runKeepingStderr(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; nice?: boolean } = {},
): Promise<void> {
  const [bin, argv] = runArgv(cmd, args, opts.nice === true);
  await failingAsBefore(
    execa(bin, argv, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: ["inherit", "pipe"],
      cwd: opts.cwd,
      env: opts.env ?? toolEnv(),
      extendEnv: false,
    }),
    { short: true },
  );
}

/**
 * Like `runKeepingStderr`, but stdout is kept too, for a tool that reports on stdout (xtool's
 * `Cancelled.` and `dev run`'s install errors). Both are shown live, stdout line-buffered when
 * `stdbuf` is on PATH; resolves with `${stdout}\n${stderr}`, and a failure carries them as `.stdout`
 * and `.stderr`.
 */
export async function runKeepingOutput(cmd: string, args: string[], opts: TeeOptions = {}): Promise<string> {
  const { bin, argv, env, wrapped } = teedArgv(cmd, args, opts, true);
  const r = await failingAsBefore(
    execa(bin, argv, {
      stdin: "inherit",
      stdout: ["inherit", "pipe"],
      stderr: ["inherit", "pipe"],
      cwd: opts.cwd,
      env,
      extendEnv: false,
    }),
    { short: true, wrapped },
  );
  return `${r.stdout}\n${r.stderr}`;
}

/**
 * Like `run`, but also returns the combined output (still shown live unless `echo: false`; shown,
 * stdout is line-buffered when `stdbuf` is on PATH). A failure carries it as `.stdout` and `.stderr`;
 * its message repeats it only when it was not shown.
 */
export async function runTee(
  cmd: string,
  args: string[],
  opts: TeeOptions & { echo?: boolean } = {},
): Promise<string> {
  const echo = opts.echo !== false;
  const { bin, argv, env, wrapped } = teedArgv(cmd, args, opts, echo);
  const out = echo ? (["inherit", "pipe"] as const) : "pipe";
  const r = await failingAsBefore(
    execa(bin, argv, {
      stdin: "inherit",
      stdout: out,
      stderr: out,
      cwd: opts.cwd,
      env,
      extendEnv: false,
    }),
    { short: echo, wrapped },
  );
  return `${r.stdout}\n${r.stderr}`;
}
