import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fsyncSync wrapped, so the test sees whether durable's sync calls reach the disk.
const fsyncSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  fsyncSync.mockImplementation(fs.fsyncSync);
  return { ...fs, fsyncSync };
});
const { durable } = await import("../../src/pods/durable.js");

let dir: string;
let file: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pods-durable-"));
  file = path.join(dir, "spec.json");
  writeFileSync(file, "{}");
  saved = process.env.RN_XTOOL_NO_FSYNC;
  fsyncSync.mockClear();
});
afterEach(() => {
  if (saved === undefined) delete process.env.RN_XTOOL_NO_FSYNC;
  else process.env.RN_XTOOL_NO_FSYNC = saved;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** FileHandle.prototype.sync, watched. */
async function watchHandleSync() {
  const { open } = await import("node:fs/promises");
  const handle = await open(file, "r");
  const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
  await handle.close();
  return vi.spyOn(proto, "sync");
}

describe("durable", () => {
  it("unit tests run with RN_XTOOL_NO_FSYNC=1 (tests/support/setup.ts)", () => {
    expect(saved).toBe("1");
  });

  it("fsyncs files and folders without RN_XTOOL_NO_FSYNC, as rn-xtool does for its users", async () => {
    delete process.env.RN_XTOOL_NO_FSYNC;
    const handleSync = await watchHandleSync();
    await durable.syncFile(file);
    await durable.syncDir(dir);
    expect(handleSync).toHaveBeenCalledTimes(2);
    durable.syncFileSync(file);
    durable.syncDirSync(dir);
    expect(fsyncSync).toHaveBeenCalledTimes(2);
  });

  it("skips fsync under RN_XTOOL_NO_FSYNC=1", async () => {
    process.env.RN_XTOOL_NO_FSYNC = "1";
    const handleSync = await watchHandleSync();
    await durable.syncFile(file);
    await durable.syncDir(dir);
    durable.syncFileSync(file);
    durable.syncDirSync(dir);
    expect(handleSync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
  });
});
