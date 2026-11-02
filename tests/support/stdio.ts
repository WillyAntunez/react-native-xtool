import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/**
 * Runs `fn` with this process's stdout and stderr writes captured instead of printed: what a tee
 * shows live. Keeps a fake tool's output out of the test run's output.
 */
export async function capturingStdio<T>(
  fn: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; stdout: string; stderr: string }> {
  const seen = { stdout: "", stderr: "" };
  const spies = (["stdout", "stderr"] as const).map((name) =>
    vi.spyOn(process[name], "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
      seen[name] += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      done?.();
      return true;
    }),
  );
  try {
    const [result] = await Promise.allSettled([fn()]);
    return { result: result!, ...seen };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

/** An executable sh script in a fresh temp folder; `cleanup` removes the folder. */
export function fakeTool(body: string): { bin: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-tool-"));
  const bin = join(dir, "fake-xtool");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
