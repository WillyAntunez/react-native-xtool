import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  podspecEnvLines,
  readerLines,
  readPodspecReads,
  type PodspecRead,
} from "../src/pipeline/podspecReads.js";

const LINK = "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md#podspec-reader";
const read = (podspec: string, over: Partial<PodspecRead> = {}): PodspecRead => ({
  podspec,
  reader: "ruby",
  ruby: "3.3.8",
  forced: false,
  env: [],
  helpers: [],
  ok: true,
  ...over,
});
const rubyRead = read("/proj/node_modules/a/A.podspec");
const reduced = (podspec: string): PodspecRead =>
  read(podspec, { reader: "reduced", ruby: undefined, why: "Ruby was not found" });
const forced = (podspec: string): PodspecRead =>
  read(podspec, { reader: "reduced", ruby: undefined, why: "RN_XTOOL_PODSPEC_READER=reduced is set", forced: true });

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readPodspecReads", () => {
  it("reads nothing without the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rn-xtool-reads-"));
    tmp.push(dir);
    expect(readPodspecReads(path.join(dir, "rn-xtool-podspec-reads.jsonl"))).toEqual([]);
  });

  it("skips a line it cannot parse", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rn-xtool-reads-"));
    tmp.push(dir);
    const file = path.join(dir, "rn-xtool-podspec-reads.jsonl");
    writeFileSync(file, `${JSON.stringify(rubyRead)}\n{"podspec": "/half\n\n${JSON.stringify(forced("/b/B.podspec"))}\n`);
    expect(readPodspecReads(file)).toEqual([rubyRead, forced("/b/B.podspec")]);
  });
});

describe("readerLines", () => {
  it("prints the reduced reader once per run", () => {
    const lines = readerLines([reduced("/proj/node_modules/a/A.podspec"), reduced("/proj/node_modules/b/B.podspec")]);
    expect(lines).toEqual([
      "⚠ Ruby was not found, so rn-xtool read the podspecs with its reduced reader, which evaluates a subset of Ruby; " +
        `install Ruby (sudo apt install ruby) to read them as CocoaPods does. See ${LINK}`,
    ]);
    expect(lines[0]!.startsWith("⚠ Ruby was not found, so rn-xtool read the podspecs")).toBe(true);
    expect(lines[0]!.endsWith(`See ${LINK}`)).toBe(true);
  });

  it("gives the install advice only when installing Ruby helps", () => {
    const old = read("/a/A.podspec", { reader: "reduced", ruby: undefined, why: "ruby 2.5.1 is older than 2.7.0" });
    expect(readerLines([old])).toEqual([
      "⚠ ruby 2.5.1 is older than 2.7.0, so rn-xtool read the podspecs with its reduced reader, which evaluates a subset " +
        `of Ruby; install Ruby (sudo apt install ruby) to read them as CocoaPods does. See ${LINK}`,
    ]);
    for (const why of [
      "ruby cannot load json",
      "ruby could not run the podspec reader (rbenv: version '3.1.2' is not installed)",
      "the podspec reader's Ruby shim is missing from /x/read-podspec-shim.rb",
    ]) {
      expect(readerLines([read("/a/A.podspec", { reader: "reduced", ruby: undefined, why })])).toEqual([
        `⚠ ${why}, so rn-xtool read the podspecs with its reduced reader, which evaluates a subset of Ruby. See ${LINK}`,
      ]);
    }
  });

  it("names the forced reader", () => {
    expect(readerLines([forced("/proj/node_modules/a/A.podspec"), forced("/proj/node_modules/b/B.podspec")])).toEqual([
      "⚠ RN_XTOOL_PODSPEC_READER=reduced is set, so rn-xtool read the podspecs with its reduced reader, which evaluates " +
        `a subset of Ruby; unset it to read them as CocoaPods does. See ${LINK}`,
    ]);
  });

  it("prints the reader's warning first", () => {
    const warning = "RN_XTOOL_PODSPEC_READER=REDUCED is not a reader rn-xtool knows (only reduced); reading podspecs with Ruby";
    expect(readerLines([read("/a/A.podspec", { warning }), read("/b/B.podspec", { warning })])).toEqual([`⚠ ${warning}`]);
    expect(readerLines([reduced("/a/A.podspec"), { ...reduced("/b/B.podspec"), warning }])).toEqual([
      `⚠ ${warning}`,
      expect.stringMatching(/^⚠ Ruby was not found, so rn-xtool read the podspecs/),
    ]);
  });

  it("says nothing when Ruby read every podspec", () => expect(readerLines([rubyRead])).toEqual([]));
});

describe("podspecEnvLines", () => {
  it("lists the ENV names per podspec", () => {
    const reads = [
      read("/proj/node_modules/x/X.podspec", { env: ["USE_FRAMEWORKS", "RCT_NEW_ARCH_ENABLED"] }),
      read("/proj/node_modules/y/Y.podspec"),
    ];
    expect(podspecEnvLines(reads, "/proj")).toEqual([
      "ℹ podspec ENV — node_modules/x/X.podspec: RCT_NEW_ARCH_ENABLED, USE_FRAMEWORKS",
    ]);
  });

  it("lists a podspec read in several runs once", () => {
    const x = read("/proj/node_modules/x/X.podspec", { env: ["USE_FRAMEWORKS"] });
    expect(podspecEnvLines([x, x], "/proj")).toEqual(["ℹ podspec ENV — node_modules/x/X.podspec: USE_FRAMEWORKS"]);
  });
});
