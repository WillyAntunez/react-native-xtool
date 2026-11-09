/**
 * The podspec reader's Ruby shim (`vendor/rn-spm/spm/read-podspec-shim.rb`), run on a podspec written into a temp
 * folder, as rn-xtool runs it: in the podspec's folder, with `PATH`, `HOME`, `LANG` and React Native's two pod
 * variables only. Each folder is removed after the test file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { packageRoot } from "../../src/tools/exec.js";
import { hasTool, tool } from "./tools.js";

export const SHIM = path.join(packageRoot(), "vendor", "rn-spm", "spm", "read-podspec-shim.rb");

const hasRuby = hasTool("ruby");
// CI installs Ruby: a missing one there fails the file instead of skipping the shim's tests.
if (!hasRuby && process.env.CI === "true") throw new Error("ruby is not on PATH; CI must run the podspec shim's tests");
/** `""` when `ruby` runs here, else a title suffix that says the tests need it. */
export const needsRuby = hasRuby ? "" : " (needs ruby)";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp folder, removed after the test file. */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rn-xtool-shim-"));
  tmp.push(dir);
  return dir;
}

export type ShimRun = { status: number; json: any; stdout: string; podspec: string };

/**
 * Writes `body` as `Foo.podspec` and `files` (paths relative to it) into a temp library folder, runs the shim on it
 * there with `ruby <shim> <podspec> <out.json> <root>` (`root` defaults to that folder), and returns the exit status,
 * the parsed out file (undefined when the shim wrote none), the shim's stdout and the podspec's path.
 */
export function runShim(
  body: string,
  opts: { files?: Record<string, string>; env?: Record<string, string>; root?: string } = {},
): ShimRun {
  const base = tempDir();
  const lib = path.join(base, "lib");
  mkdirSync(lib);
  const podspec = path.join(lib, "Foo.podspec");
  writeFileSync(podspec, body);
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(lib, file)), { recursive: true });
    writeFileSync(path.join(lib, file), text);
  }
  const out = path.join(base, "out.json");
  const inherited = Object.fromEntries(
    (["PATH", "HOME", "LANG"] as const).flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])),
  );
  const r = tool("ruby", [SHIM, podspec, out, opts.root ?? lib], {
    cwd: lib,
    env: { ...inherited, RCT_NEW_ARCH_ENABLED: "1", RCT_HERMES_V1_ENABLED: "1", ...opts.env },
  });
  return {
    status: r.status ?? -1,
    json: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined,
    stdout: r.stdout,
    podspec,
  };
}
