/**
 * Cache writes that survive a crash or a power loss (spec row 76): a file is synced before it is renamed into place,
 * and its folder after, so a name in the cache never points at lost bytes. Trees are not synced file by file; their
 * stamps record the file count and the bytes, checked before reuse (`treeMeasure`).
 */
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

/**
 * `RN_XTOOL_NO_FSYNC=1` skips the fsync calls: the unit tests set it (tests/support/setup.ts), so thousands of small
 * cache writes do not stall on a busy disk. rn-xtool never sets it.
 */
function skipped(): boolean {
  return process.env.RN_XTOOL_NO_FSYNC === "1";
}

async function sync(p: string): Promise<void> {
  if (skipped()) return;
  const handle = await open(p, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function syncSync(p: string): void {
  if (skipped()) return;
  const fd = openSync(p, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Called through this object, so tests can watch them. */
export const durable = {
  syncFile: (file: string): Promise<void> => sync(file),
  syncDir: (dir: string): Promise<void> => sync(dir),
  syncFileSync: (file: string): void => syncSync(file),
  syncDirSync: (dir: string): void => syncSync(dir),
};

/** The files (links included) below `dir` and their bytes, the file named `skip` at the top left out. */
export function treeMeasure(dir: string, skip: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (abs: string, top: boolean): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (top && e.name === skip) continue;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) {
        walk(p, false);
      } else {
        files++;
        if (e.isFile()) bytes += lstatSync(p).size;
      }
    }
  };
  walk(dir, true);
  return { files, bytes };
}

/** Whether `dir` still holds what its stamp recorded; false when it cannot be read. */
export function treeIntact(dir: string, skip: string, recorded: { files?: unknown; bytes?: unknown }): boolean {
  try {
    const now = treeMeasure(dir, skip);
    return now.files === recorded.files && now.bytes === recorded.bytes;
  } catch {
    return false;
  }
}
