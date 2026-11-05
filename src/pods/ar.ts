/**
 * The toolchain's `llvm-ar` wraps a vendored framework's `MH_OBJECT` binary into a thin `ar` archive with a Darwin
 * symbol index (`rcs --format=darwin`), so it links like the archives the other frameworks ship (spec goal 2.2).
 */
import { readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { toolEnv } from "../tools/exec.js";
import { SWIFT_VERSION } from "../versions.js";
import { PodsError } from "./format.js";

export const LLVM_AR_MISSING =
  "llvm-ar was not found on the Swift toolchain's PATH; rn-xtool wraps CocoaPods binaries with it. " +
  `Run \`rn-xtool setup\` to install Swift ${SWIFT_VERSION} through swiftly.`;

/** Runs `llvm-ar` with `args`; resolves to its stdout. A failure carries the tool's `stderr`. */
export type ArRunner = (args: string[]) => Promise<string>;

/** A missing tool rejects with a PodsError of LLVM_AR_MISSING. */
export function makeArRunner(bin = "llvm-ar", timeoutMs?: number): ArRunner {
  return async (args) => {
    try {
      const r = await execa(bin, args, { env: toolEnv(), extendEnv: false, timeout: timeoutMs });
      return r.stdout;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new PodsError(LLVM_AR_MISSING);
      throw e;
    }
  };
}

const AR_MAGIC = "!<arch>\n";

/** `llvm-ar rcs --format=darwin <archive> <object>` into a fresh archive, which must start with `!<arch>\n`. */
export async function wrapObject(
  object: string,
  archive: string,
  run: ArRunner,
  label: { pod: string; version: string; rel: string },
): Promise<void> {
  await mkdir(path.dirname(archive), { recursive: true });
  await rm(archive, { force: true });
  try {
    await run(["rcs", "--format=darwin", archive, object]);
  } catch (e) {
    if (e instanceof PodsError) throw e;
    const { stderr } = e as { stderr?: unknown };
    const first = (typeof stderr === "string" && stderr.trim() !== "" ? stderr : e instanceof Error ? e.message : String(e))
      .trim()
      .split("\n")[0];
    throw new PodsError(`llvm-ar could not wrap ${label.pod} ${label.version}'s object (${label.rel}): ${first}`);
  }
  const head = await readFile(archive).then(
    (b) => b.subarray(0, AR_MAGIC.length).toString("latin1"),
    () => "",
  );
  if (head !== AR_MAGIC) {
    throw new Error(`internal error: llvm-ar wrote ${archive} for ${label.pod} ${label.version}, which does not start with !<arch>`);
  }
}
