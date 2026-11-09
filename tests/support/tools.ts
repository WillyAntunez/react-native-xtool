/**
 * The external tools the tests run (tar, patch, swift, clang, node). `spawnSync` blocks the worker, so no vitest
 * timeout can interrupt a hung tool: each call carries its own timeout instead, under the 20 s test timeout, and a
 * hung process fails its test (`status` null, `error.code` ETIMEDOUT). Swift is the exception: a cold toolchain on a
 * hosted runner can take far longer than the others, so its calls use `SWIFT_TIMEOUT_MS`, inside tests that set
 * `SWIFT_TEST_TIMEOUT_MS`.
 */
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

export const TOOL_TIMEOUT_MS = 15_000;
/**
 * The timeout of a `tar` extraction of a pinned tarball: a heavy one (skia's prebuilt packages, hundreds of MB) takes
 * longer than {@link TOOL_TIMEOUT_MS} on a slow disk, and the sweep extracts while it collects its tests.
 */
export const TAR_TIMEOUT_MS = 60_000;
/** The timeout of a `swift` call. */
export const SWIFT_TIMEOUT_MS = 60_000;
/** The `it` timeout of a test that runs `swift`. */
export const SWIFT_TEST_TIMEOUT_MS = 90_000;

/** `cmd args` with a timeout and utf8 output (pass `encoding: "buffer"` for bytes). */
export function tool(cmd: string, args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, timeout: TOOL_TIMEOUT_MS, ...opts }) as SpawnSyncReturns<string>;
}

/**
 * `patch --batch --forward args`. GNU patch asks on the terminal about a reversed (already applied) or misplaced
 * patch; --batch never asks, and --forward makes it skip a reversed patch and fail, where --batch alone would silently
 * reverse it.
 */
export function patchTool(args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string> {
  return tool("patch", ["--batch", "--forward", ...args], opts);
}

/** Whether `cmd --version` runs. */
export function hasTool(cmd: string): boolean {
  return tool(cmd, ["--version"]).status === 0;
}
