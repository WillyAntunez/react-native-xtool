/**
 * A transfer that breaks off is named by the bytes it received, not by the file's size: the writes not yet flushed
 * are dropped when the stream breaks. A held write stream makes that loss certain, so the test does not depend on
 * timing (commit 47949d6's flake).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    // A write stream whose writes never complete: nothing reaches the file before the source breaks.
    createWriteStream: ((...args: Parameters<typeof fs.createWriteStream>) =>
      hold.on ? new Writable({ write: () => undefined }) : fs.createWriteStream(...args)) as typeof fs.createWriteStream,
  };
});

const { DownloadSizeError, downloadFile } = await import("../src/tools/download.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dl-broken-"));
  hold.on = true;
});
afterEach(() => {
  hold.on = false;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** A body that sends `n` bytes, then breaks. */
function brokenBody(n: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    async pull(c) {
      if (sent) {
        // The break comes after the bytes were read, as a reset connection's does.
        await new Promise((resolve) => setTimeout(resolve, 20));
        c.error(new Error("other side closed"));
        return;
      }
      sent = true;
      c.enqueue(new Uint8Array(n));
    },
  });
}

describe("downloadFile, a transfer that breaks off", () => {
  it("names the bytes it received", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(brokenBody(3000), { headers: { "content-length": "7000" } })));
    const err = await downloadFile("https://a.invalid/f", join(dir, "f"), { expectedBytes: 7000 }).catch((e: unknown) => e);
    expect((err as Error).cause).toBeInstanceOf(DownloadSizeError);
    expect((err as Error).message).toBe("Could not download https://a.invalid/f: downloaded 3000 bytes, expected 7000");
  });
});
