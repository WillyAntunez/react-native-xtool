import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  removeStaleSweepDirs,
  shimGapKinds,
  sweepSkipReason,
  sweepTestTimeout,
  type SweepEntry,
} from "./support/podspecSweep.js";
import { HEAVY_FETCH_HINT, MANIFEST } from "./support/tarballs.js";
import { mkTmp } from "./support/expoSpm.js";
import { VENDORED_RN_SPM } from "./support/rnScaffold.js";

const { PODSPEC_TIMEOUT_MS } = createRequire(path.join(VENDORED_RN_SPM, "read-podspec.js"))("./read-podspec.js");

// The podspec reader sweep: every podspec of the libraries in tests/podspec-sweep.json, read with Ruby and with the
// reduced reader, against its reviewed golden in tests/fixtures/podspec-sweep (RN_XTOOL_SWEEP_WRITE=1 rewrites them).
// Off CI a library whose tarballs are not cached, or a machine without Ruby, skips; on CI both fail, except a heavy
// tarball (tests/tarballs.json), which CI does not fetch: the libraries that need one skip there.
const CI = process.env.CI === "true";
const skipReason = (entry: SweepEntry) => sweepSkipReason(entry, CI);
const skip = (entry: SweepEntry) => skipReason(entry) !== "";

describe("the podspec reader sweep", () => {
  for (const entry of SWEEP)
    for (const podspec of podspecsOf(entry))
      it.skipIf(skip(entry))(
        `reads ${entryName(entry)} ${podspec} as its golden${skipReason(entry)}`,
        () => expect(record(entry, podspec)).toEqual(golden(entry, podspec)),
        sweepTestTimeout(entry),
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

  it("gives a variant of an entry its own name and golden folder", () => {
    const variant: SweepEntry = { ...unpinned, with: ["react-native-worklets@0.13.1"], variant: "with-worklets" };
    expect(entryName(variant)).toBe("react-native-unpinned@0.0.1 on react-native@0.88.1 (with-worklets)");
    const orphans = orphanGoldens([unpinned, variant], false);
    expect(orphans).toContain("react-native-unpinned@0.0.1@rn-0.88.1/ (no goldens)");
    expect(orphans).toContain("react-native-unpinned@0.0.1@rn-0.88.1+with-worklets/ (no goldens)");
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

  it("gives a heavy library's reads more time than the reader gives a podspec", () => {
    expect([sweepTestTimeout(needsHeavy), sweepTestTimeout(unpinned)]).toEqual([180_000, 60_000]);
    expect(sweepTestTimeout(needsHeavy)).toBeGreaterThan(PODSPEC_TIMEOUT_MS);
  });

  it("removes only the sweep's own temp folders older than an hour", () => {
    const dir = mkTmp("sweep-stale-");
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
    const make = (name: string, age: number, file = false) => {
      const p = path.join(dir, name);
      if (file) writeFileSync(p, "");
      else mkdirSync(path.join(p, "node_modules"), { recursive: true });
      utimesSync(p, hoursAgo(age), hoursAgo(age));
    };
    make("rn-xtool-sweep-old", 2);
    make("rn-xtool-sweep-recent", 0.5);
    make("rn-xtool-sweep-file", 2, true);
    make("rn-xtool-shim-old", 2);
    make("other", 3);
    expect(removeStaleSweepDirs(dir, now)).toEqual(["rn-xtool-sweep-old"]);
    expect(readdirSync(dir).sort()).toEqual(["other", "rn-xtool-shim-old", "rn-xtool-sweep-file", "rn-xtool-sweep-recent"]);
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
