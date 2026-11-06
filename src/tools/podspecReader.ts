import { createRequire } from "node:module";
import path from "node:path";
import type { DoctorCheck } from "../commands/doctor.js";
import { packageRoot } from "./exec.js";

/** Which reader the vendored scaffolder reads podspecs with (`podspecReader` in vendor/rn-spm/spm/read-podspec.js). */
export type PodspecReaderChoice =
  | { reader: "ruby"; ruby: string; forced: false; warning: string | null }
  | { reader: "reduced"; why: string; forced: boolean; warning: string | null };

type PodspecReader = (opts: { env?: NodeJS.ProcessEnv }) => PodspecReaderChoice;

/** The reader rn-xtool's vendored scaffolder picks in `env`: its own `podspecReader`, never a copy of its rules. */
export function podspecReaderHere(env: NodeJS.ProcessEnv = process.env): PodspecReaderChoice {
  const file = path.join(packageRoot(), "vendor", "rn-spm", "spm", "read-podspec.js");
  return (createRequire(import.meta.url)(file) as { podspecReader: PodspecReader }).podspecReader({ env });
}

const REDUCED = "podspecs are read with the reduced reader";

/** doctor's `ruby` check: a reader other than Ruby, or a Ruby with a warning, is a warning, never a failure. */
export function rubyCheck(c: PodspecReaderChoice): Omit<DoctorCheck, "name"> {
  if (c.reader === "ruby") {
    return c.warning ? { status: "warn", detail: `${c.ruby}; ${c.warning}` } : { status: "ok", detail: c.ruby };
  }
  if (c.forced) return { status: "warn", detail: `${c.why} — ${REDUCED}` };
  const why = c.why === "Ruby was not found" ? "not found" : c.why;
  return { status: "warn", detail: `${why} — ${REDUCED}; sudo apt install ruby` };
}
