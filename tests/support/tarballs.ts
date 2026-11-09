/**
 * The pinned upstream tarballs (`tests/tarballs.json`), fetched into `tests/.cache` by
 * `node scripts/fetch-test-tarballs.mjs`: pristine packages, and the two SwiftPM plugins with rn-xtool's bundled patch
 * applied, as an app that installed them would have them. Each tree is extracted under a temp `node_modules`,
 * once per test file, and removed after it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { packageRoot } from "../../src/tools/exec.js";
import { TAR_TIMEOUT_MS, hasTool, patchTool, tool } from "./tools.js";

const ROOT = packageRoot();
const CACHE = path.join(ROOT, "tests", ".cache");

/** A pinned tarball; a `heavy` one is fetched only on request ({@link HEAVY_FETCH_HINT}). */
export type TarballEntry = { spec: string; file: string; integrity: string; heavy?: true };
export const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "tests", "tarballs.json"), "utf8")) as TarballEntry[];
export const FETCH_HINT = "run: node scripts/fetch-test-tarballs.mjs";
export const HEAVY_FETCH_HINT = "run: RN_XTOOL_FETCH_HEAVY=1 node scripts/fetch-test-tarballs.mjs";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const entryOf = (spec: string) => MANIFEST.find((e) => e.spec === spec);
/** Whether `spec` is pinned as heavy: fetched only on request, and on CI never (its tests skip there). */
export const isHeavy = (spec: string): boolean => entryOf(spec)?.heavy === true;
const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf("@"));
const integrityOf = (file: string) => "sha512-" + createHash("sha512").update(readFileSync(file)).digest("base64");

const verified = new Map<string, string>();
/**
 * The cached tarball for `spec` (in `dir`, `tests/.cache` by default), checked against the manifest's integrity;
 * undefined when it is not cached. Throws when it is cached with another integrity: the tests that need it fail,
 * they do not skip.
 */
export function tarballPath(spec: string, dir = CACHE): string | undefined {
  const entry = entryOf(spec);
  if (!entry) return undefined;
  const file = path.join(dir, entry.file);
  if (verified.get(file) === entry.integrity) return file;
  if (!existsSync(file)) return undefined;
  if (integrityOf(file) !== entry.integrity) {
    throw new Error(`tests/.cache/${entry.file}: integrity mismatch; re-run node scripts/fetch-test-tarballs.mjs`);
  }
  verified.set(file, entry.integrity);
  return file;
}

let tools: boolean | undefined;
const hasTools = () =>
  (tools ??= ["tar", "patch"].every(hasTool));

/**
 * `""` when the tests of `spec` can run here, else a title suffix that says what they need: the spec in the manifest,
 * its tarball in `tests/.cache` (with {@link FETCH_HINT}, or {@link HEAVY_FETCH_HINT} for a heavy one), or `tar` and
 * `patch`. A cached tarball counts whatever its
 * integrity, so that a mismatch fails the tests ({@link tarballPath}) instead of skipping them.
 */
export function needsTarball(spec: string, dir = CACHE): string {
  const entry = entryOf(spec);
  if (!entry) return ` (needs ${spec} pinned in tests/tarballs.json)`;
  if (!existsSync(path.join(dir, entry.file))) {
    return ` (needs tests/.cache/${entry.file}; ${entry.heavy ? HEAVY_FETCH_HINT : FETCH_HINT})`;
  }
  if (!hasTools()) return " (needs tar and patch)";
  return "";
}

/** A fresh copy of the package, at `<tmp>/node_modules/<name>`. */
function extract(spec: string, prefix: string): string {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  tmp.push(base);
  const dir = path.join(base, "node_modules", nameOf(spec));
  mkdirSync(dir, { recursive: true });
  const r = tool("tar", ["-xzf", tarballPath(spec)!, "-C", dir, "--strip-components=1"], { timeout: TAR_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`tar failed for ${spec}: ${r.stderr}`);
  return dir;
}

const pristine = new Map<string, string>();
/** The pristine package, extracted once per run into `<tmp>/node_modules/<name>`; that dir, or undefined without it. */
export function packageFromTarball(spec: string): string | undefined {
  if (needsTarball(spec) !== "") return undefined;
  let dir = pristine.get(spec);
  if (!dir) pristine.set(spec, (dir = extract(spec, "tarball-")));
  return dir;
}

const patched = new Map<string, string>();
/**
 * The package's `scripts/spm` with `patches/<name>+<version>.patch` applied (`patch -p1 -F0` at `<tmp>`), in a copy of
 * its own, so the {@link packageFromTarball} tree stays pristine. Its `node_modules` links to rn-xtool's, where it finds
 * what an app would have installed (`@expo/config-plugins`, `yargs`, `micromatch`). Undefined without the tarball.
 */
export function patchedSpm(spec: "expo@58.0.21" | "react-native@0.88.1"): string | undefined {
  if (needsTarball(spec) !== "") return undefined;
  let spm = patched.get(spec);
  if (!spm) {
    const pkg = extract(spec, "patched-");
    const base = path.resolve(pkg, "..", "..");
    const patch = path.join(ROOT, "patches", `${nameOf(spec).replace("/", "+")}+${spec.slice(spec.lastIndexOf("@") + 1)}.patch`);
    const r = patchTool(["-p1", "-F0", "-d", base, "-i", patch]);
    if (r.status !== 0) throw new Error(`patch failed for ${spec}: ${r.stdout}${r.stderr}`);
    // So the patched copies load rn-xtool's yargs, micromatch and @expo/config-plugins versions, not an app's.
    symlinkSync(path.join(ROOT, "node_modules"), path.join(pkg, "node_modules"), "dir");
    patched.set(spec, (spm = path.join(pkg, "scripts", "spm")));
  }
  return spm;
}
