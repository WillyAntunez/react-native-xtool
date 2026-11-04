import { createRequire } from "node:module";
import path from "node:path";

/** `request` resolved as a file in `dir` would resolve it; undefined when it cannot be. */
function resolveFrom(dir: string, request: string): string | undefined {
  try {
    return createRequire(path.join(dir, "package.json")).resolve(request);
  } catch {
    return undefined;
  }
}

function packageDir(dir: string, pkg: string): string | undefined {
  const manifest = resolveFrom(dir, `${pkg}/package.json`);
  return manifest === undefined ? undefined : path.dirname(manifest);
}

/** `pkg` as Expo CLI would load it: resolved from expo → @expo/cli first (npm nests the copy Expo uses there when
 *  another version sits at the root; Node's search from there still reaches a hoisted copy), else from the project
 *  root, with createRequire(<dir>/package.json) as packageDirFrom in src/project/expo.ts does. Undefined when it is not
 *  found or throws while loading. Never throws. Used by install (toqr) and start (dnssd-advertise) only. */
export function requireFromProject(root: string, pkg: string): unknown {
  const expo = packageDir(root, "expo");
  const cli = expo === undefined ? undefined : packageDir(expo, "@expo/cli");
  const file = (cli === undefined ? undefined : resolveFrom(cli, pkg)) ?? resolveFrom(root, pkg);
  if (file === undefined) return undefined;
  try {
    return createRequire(file)(file) as unknown;
  } catch {
    return undefined;
  }
}
