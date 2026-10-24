import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

/** Root of the expo-xtool package (holds shims/, patches/, scripts/). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === "expo-xtool") return dir;
      } catch {
        // unreadable package.json: keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("expo-xtool package root not found");
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

/** Like `run`, but also returns the combined output (still shown live on the terminal). */
export async function runTee(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; nice?: boolean } = {},
): Promise<string> {
  const [bin, argv] = runArgv(cmd, args, opts.nice === true);
  const r = await execa(bin, argv, {
    stdin: "inherit",
    stdout: ["inherit", "pipe"],
    stderr: ["inherit", "pipe"],
    cwd: opts.cwd,
    env: opts.env ?? toolEnv(),
    extendEnv: false,
  });
  return `${r.stdout}\n${r.stderr}`;
}
