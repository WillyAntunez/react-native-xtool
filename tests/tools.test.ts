import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mkTmp } from "./support/expoSpm.js";
import { SWIFT_TEST_TIMEOUT_MS, SWIFT_TIMEOUT_MS, TOOL_TIMEOUT_MS, hasTool, patchTool, tool } from "./support/tools.js";

describe("tests/support/tools", () => {
  it("fails a hung tool at its timeout instead of hanging the worker", () => {
    const started = Date.now();
    const r = tool("sleep", ["30"], { timeout: 200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.status).toBeNull();
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  });

  it("gives every tool a timeout well under the test timeout", () => {
    expect(TOOL_TIMEOUT_MS).toBe(15_000);
  });

  it("gives swift a longer timeout, and the tests that run it a longer test timeout still", () => {
    // A cold swift (first run, toolchain not in the page cache) is the slowest tool on a hosted runner.
    expect(SWIFT_TIMEOUT_MS).toBe(60_000);
    expect(SWIFT_TEST_TIMEOUT_MS).toBe(90_000);
    expect(SWIFT_TIMEOUT_MS).toBeLessThan(SWIFT_TEST_TIMEOUT_MS);
  });

  it("runs every swift call with the swift timeout, in a test with the swift test timeout", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
    let calls = 0;
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/\b(execa|tool)\("swift", \[/g)) {
        calls++;
        const call = src.slice(m.index, src.indexOf(");", m.index));
        expect(call, `${f}: ${call.slice(0, 40)}`).toContain("timeout: SWIFT_TIMEOUT_MS");
      }
      const swiftTests = src.match(/it\.skipIf\(!swift64\)\(/g)?.length ?? 0;
      expect(src.match(/\}, SWIFT_TEST_TIMEOUT_MS\);/g)?.length ?? 0, f).toBe(swiftTests);
    }
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("knows which tools are on PATH", () => {
    expect(hasTool("tar")).toBe(true);
    expect(hasTool("rn-xtool-no-such-tool")).toBe(false);
  });

  it("runs patch in batch and forward mode, so a patch that does not fit fails without asking or reversing", () => {
    const dir = mkTmp("tools-patch-");
    writeFileSync(path.join(dir, "a.txt"), "old\n");
    const diff = path.join(mkTmp("tools-diff-"), "a.patch");
    writeFileSync(diff, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n");
    expect(patchTool(["-p1", "-F0", "-d", dir, "-i", diff]).status).toBe(0);
    // Applied already: without --batch, GNU patch asks "Assume -R?" on the terminal; with --batch alone it reverses it.
    const again = patchTool(["-p1", "-F0", "-d", dir, "-i", diff]);
    expect(again.status).toBe(1);
    expect(again.stdout).toContain("Reversed (or previously applied) patch detected");
    expect(again.stdout).toContain("Skipping patch");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("new\n");
  });
});
