import { createRequire } from "node:module";
import path from "node:path";
import { packageRoot, run } from "../tools/exec.js";

/** The patch-package pinned in this CLI's own dependencies, not whatever npx would fetch. */
function patchPackageScript(): string {
  const pkgJson = createRequire(import.meta.url).resolve("patch-package/package.json");
  return path.join(path.dirname(pkgJson), "index.js");
}

/** patch-package rejects absolute --patch-dir, so pass it relative to the project. */
export function applyPatchesArgv(projectRoot: string): [string, string[]] {
  const patchDir = path.relative(path.resolve(projectRoot), path.join(packageRoot(), "patches"));
  return ["node", [patchPackageScript(), "--patch-dir", patchDir]];
}

/** patch-package is idempotent for already-applied patches and exits non-zero on failure. */
export async function applyPatches(projectRoot: string): Promise<void> {
  const [cmd, args] = applyPatchesArgv(projectRoot);
  await run(cmd, args, { cwd: projectRoot });
}
