import { describe, expect, it } from "vitest";
import { podspecReaderHere } from "../src/tools/podspecReader.js";
import { SWEEP, golden, nameDifferences, orphanGoldens, podspecsOf, record, type SweepEntry } from "./support/podspecSweep.js";
import { needsRuby } from "./support/ruby.js";
import { needsTarball } from "./support/tarballs.js";

// The podspec reader sweep: every podspec of the libraries in tests/podspec-sweep.json, read with Ruby and with the
// reduced reader, against its reviewed golden in tests/fixtures/podspec-sweep (RN_XTOOL_SWEEP_WRITE=1 rewrites them).
// Off CI a library whose tarballs are not cached, or a machine without Ruby, skips; on CI both fail.
const CI = process.env.CI === "true";

/** `""` when the entry's podspecs can be read here, else a title suffix that says what they need. */
function skipReason(entry: SweepEntry): string {
  if (CI) return "";
  const tarballs = [entry.spec, entry.rn, ...(entry.with ?? [])].map((spec) => needsTarball(spec)).join("");
  return tarballs + needsRuby;
}
const skip = (entry: SweepEntry) => skipReason(entry) !== "";

describe("the podspec reader sweep", () => {
  for (const entry of SWEEP)
    for (const podspec of podspecsOf(entry))
      it.skipIf(skip(entry))(`reads ${entry.spec} ${podspec} as its golden${skipReason(entry)}`, () => {
        expect(record(entry, podspec)).toEqual(golden(entry, podspec));
      });

  it("keeps every library's names under both readers", () => expect(nameDifferences()).toEqual([]));
  it("has a golden for every podspec and no other", () => expect(orphanGoldens()).toEqual([]));
  it.runIf(CI)("runs with Ruby on CI", () => expect(podspecReaderHere().reader).toBe("ruby"));
});
