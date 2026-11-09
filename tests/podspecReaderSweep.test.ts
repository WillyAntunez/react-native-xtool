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
  isHeavyEntry,
  nameDifferences,
  orphanGoldens,
  podspecsOf,
  record,
  shimGapKinds,
  sweepSkipReason,
  type SweepEntry,
} from "./support/podspecSweep.js";
import { HEAVY_FETCH_HINT, MANIFEST } from "./support/tarballs.js";
import { mkTmp } from "./support/expoSpm.js";

// The podspec reader sweep: every podspec of the libraries in tests/podspec-sweep.json, read with Ruby and with the
// reduced reader, against its reviewed golden in tests/fixtures/podspec-sweep (RN_XTOOL_SWEEP_WRITE=1 rewrites them).
// Off CI a library whose tarballs are not cached, or a machine without Ruby, skips; on CI both fail, except a heavy
// tarball (tests/tarballs.json), which CI does not fetch: the libraries that need one skip there.
const CI = process.env.CI === "true";
const skipReason = (entry: SweepEntry) => sweepSkipReason(entry, CI);
const skip = (entry: SweepEntry) => skipReason(entry) !== "";
// A heavy library's read can copy hundreds of MB (skia's podspec copies its prebuilt frameworks into the library):
// tens of seconds on a slow or busy disk, past the suite's 20 s.
const timeout = (entry: SweepEntry) => (isHeavyEntry(entry) ? 120_000 : undefined);

describe("the podspec reader sweep", () => {
  for (const entry of SWEEP)
    for (const podspec of podspecsOf(entry))
      it.skipIf(skip(entry))(
        `reads ${entryName(entry)} ${podspec} as its golden${skipReason(entry)}`,
        () => expect(record(entry, podspec)).toEqual(golden(entry, podspec)),
        timeout(entry),
      );

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

  // A library that needs a heavy tarball, with a cache folder that holds nothing.
  const heavy = MANIFEST.find((e) => e.heavy)!;
  const needsHeavy: SweepEntry = { spec: "react-native-unpinned@0.0.1", rn: "react-native@0.88.1", with: [heavy.spec] };
  const heavyNeeds = ` (needs tests/.cache/${heavy.file}; ${HEAVY_FETCH_HINT})`;

  it("skips a library whose heavy tarball is missing, on CI too, and only for it there", () => {
    const empty = mkTmp("sweep-empty-cache-");
    expect(sweepSkipReason(needsHeavy, true, empty)).toBe(heavyNeeds);
    expect(sweepSkipReason(needsHeavy, false, empty)).toContain(heavyNeeds);
    expect(sweepSkipReason(needsHeavy, false, empty)).toContain(needs);
    expect(sweepSkipReason(unpinned, true, empty)).toBe("");
  });

  it("knows a library that needs a heavy tarball", () => {
    expect([isHeavyEntry(needsHeavy), isHeavyEntry(unpinned)]).toEqual([true, false]);
  });

  it("does not report a heavy tarball as missing on CI", () => {
    const empty = mkTmp("sweep-empty-cache-");
    const orphans = orphanGoldens([needsHeavy], true, empty).join("\n");
    expect(orphans).toContain(needs);
    expect(orphans).not.toContain(heavy.file);
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
