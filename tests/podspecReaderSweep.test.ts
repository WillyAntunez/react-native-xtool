import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { podspecReaderHere } from "../src/tools/podspecReader.js";
import { packageRoot } from "../src/tools/exec.js";
import {
  SWEEP,
  entryName,
  golden,
  goldenText,
  nameDifferences,
  orphanGoldens,
  podspecsOf,
  record,
  shimGapKinds,
  type SweepEntry,
} from "./support/podspecSweep.js";
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
      it.skipIf(skip(entry))(`reads ${entryName(entry)} ${podspec} as its golden${skipReason(entry)}`, () => {
        expect(record(entry, podspec)).toEqual(golden(entry, podspec));
      });

  it("keeps every library's names under both readers", () => expect(nameDifferences()).toEqual([]));
  it("lists each library once per React Native", () => {
    const names = SWEEP.map(entryName);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });
  it("has a golden for every podspec and no other", () => expect(orphanGoldens()).toEqual([]));
  it.runIf(CI)("runs with Ruby on CI", () => expect(podspecReaderHere().reader).toBe("ruby"));
});

describe("the sweep's guards", () => {
  // A library that is pinned nowhere: a mistyped entry of tests/podspec-sweep.json.
  const unpinned: SweepEntry = { spec: "react-native-unpinned@0.0.1", rn: "react-native@0.88.1" };
  const needs = " (needs react-native-unpinned@0.0.1 pinned in tests/tarballs.json)";

  it("reports an entry without goldens, and on CI what it needs", () => {
    expect(orphanGoldens([unpinned], false)).toContain("react-native-unpinned@0.0.1@rn-0.88.1/ (no goldens)");
    expect(orphanGoldens([unpinned], false)).not.toContain(`react-native-unpinned@0.0.1 on react-native@0.88.1${needs}`);
    expect(orphanGoldens([unpinned], true)).toContain(`react-native-unpinned@0.0.1 on react-native@0.88.1${needs}`);
  });

  it("gives a library read against two React Natives a golden folder for each", () => {
    const older: SweepEntry = { ...unpinned, rn: "react-native@0.86.3" };
    const orphans = orphanGoldens([unpinned, older], false);
    expect(orphans).toContain("react-native-unpinned@0.0.1@rn-0.88.1/ (no goldens)");
    expect(orphans).toContain("react-native-unpinned@0.0.1@rn-0.86.3/ (no goldens)");
  });

  it("refuses to write a gap of the shim as a golden", () => {
    const gap = { shim: { error: "Foo.podspec: undefined method `bar'", kind: "method" } };
    expect(() => goldenText(gap)).toThrow("a gap of the shim (method): Foo.podspec: undefined method `bar'");
    const raised = { shim: { error: "Foo.podspec: the podspec raised", kind: "raised" } };
    expect(goldenText(raised)).toBe(`${JSON.stringify(raised, null, 2)}\n`);
  });

  it("fails loudly when the shim's gap kinds parse empty", () => {
    expect([...shimGapKinds("const SHIM_GAP_KINDS = [\n  'method',\n  'constant',\n];")]).toEqual(["method", "constant"]);
    expect(() => shimGapKinds('const SHIM_GAP_KINDS = ["method", "constant"];')).toThrow("SHIM_GAP_KINDS parsed empty");
    expect(() => shimGapKinds("const GAPS = ['method'];")).toThrow("SHIM_GAP_KINDS not found");
  });

  it("refuses to write an absolute path into a golden", () => {
    for (const dir of [tmpdir(), packageRoot(), "/home/me"]) {
      expect(() => goldenText({ shim: { warnings: [path.join(dir, "Foo.podspec")] } })).toThrow("the golden would hold the absolute path");
    }
    expect(goldenText({ shim: { warnings: ["<project>/node_modules/foo/Foo.podspec"] } })).toContain("<project>");
  });
});
