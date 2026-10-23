import path from "node:path";
import { packageRoot, run } from "../tools/exec.js";

/** patch-package rejects absolute --patch-dir, so pass it relative to the project. */
export function applyPatchesArgv(projectRoot: string): [string, string[]] {
  const patchDir = path.relative(path.resolve(projectRoot), path.join(packageRoot(), "patches"));
  return ["npx", ["patch-package", "--patch-dir", patchDir]];
}

/** patch-package is idempotent for already-applied patches and exits non-zero on failure. */
export async function applyPatches(projectRoot: string): Promise<void> {
  const [cmd, args] = applyPatchesArgv(projectRoot);
  await run(cmd, args, { cwd: projectRoot });
}
