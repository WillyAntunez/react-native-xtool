import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { projectPaths } from "../src/paths.js";
import { adaptSlot, ArtifactLayoutError, isHeadersSpecSlot } from "../src/pipeline/rnArtifacts.js";
import {
  downloadArtifactsArgv,
  prepareRnArtifacts,
  rawSlotComplete,
  type Flavor,
} from "../src/pipeline/rnArtifactsStep.js";
import type { RnRunner } from "../src/pipeline/rnSpm.js";
import { makeFakeSlot086, makeFakeSlot088 } from "./support/fakeSlots.js";

const tmp: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const RN_DIR = "/fake/node_modules/react-native";

/** A downloader stand-in: writes the slot `layout(flavor)` picks into the `--output` dir. */
function fakeDownloader(layout: (flavor: Flavor) => "086" | "088") {
  return vi.fn<RnRunner>(async (_cmd, args) => {
    const output = args[args.indexOf("--output") + 1]!;
    const flavor = args[args.indexOf("--flavor") + 1] as Flavor;
    (layout(flavor) === "086" ? makeFakeSlot086 : makeFakeSlot088)(output);
    return { exitCode: 0, output: "" };
  });
}

function setup(layout: (flavor: Flavor) => "086" | "088" = () => "086") {
  const cacheRoot = mkTmp("rn-cache-");
  const paths = projectPaths(mkTmp("rn-app-"));
  const runner = fakeDownloader(layout);
  const adapt = vi.fn(adaptSlot);
  const logs: string[] = [];
  const deps = { runner, adapt, cacheRoot, rnDir: RN_DIR, log: (s: string) => logs.push(s) };
  return { cacheRoot, paths, runner, adapt, logs, deps };
}

const flavorsDownloaded = (runner: ReturnType<typeof fakeDownloader>) =>
  runner.mock.calls.map(([, args]) => args[args.indexOf("--flavor") + 1]);

describe("prepareRnArtifacts", () => {
  it("downloads each flavor with the vendored downloader and RN_SPM_RN_ROOT", async () => {
    const t = setup();
    await prepareRnArtifacts(t.paths, "0.86.3", t.deps);
    expect(t.runner).toHaveBeenCalledTimes(2);
    for (const flavor of ["debug", "release"] as const) {
      expect(t.runner).toHaveBeenCalledWith(
        "node",
        downloadArtifactsArgv("0.86.3", flavor, path.join(t.cacheRoot, "0.86.3", flavor)),
        { cwd: t.paths.ios, env: { RN_SPM_RN_ROOT: RN_DIR } },
      );
    }
  });

  it("builds the downloader argv from the vendored scripts", () => {
    const argv = downloadArtifactsArgv("0.86.3", "release", "/c/0.86.3/release");
    expect(argv[0]).toMatch(/vendor[/\\]rn-spm[/\\]spm[/\\]download-spm-artifacts\.js$/);
    expect(argv.slice(1)).toEqual([
      "--version", "0.86.3", "--flavor", "release", "--output", "/c/0.86.3/release", "--allow-pre-headers-spec",
    ]);
  });

  it("adapts pre-headers-spec slots and returns the adapted root", async () => {
    const t = setup();
    const root = await prepareRnArtifacts(t.paths, "0.86.3", t.deps);
    expect(root).toBe(path.join(t.paths.rnArtifacts, "0.86.3"));
    for (const flavor of ["debug", "release"]) {
      expect(t.adapt).toHaveBeenCalledWith(path.join(t.cacheRoot, "0.86.3", flavor), path.join(root, flavor), "0.86.3");
      expect(isHeadersSpecSlot(path.join(root, flavor))).toBe(true);
      // The raw slot in RN's cache is left as downloaded.
      expect(isHeadersSpecSlot(path.join(t.cacheRoot, "0.86.3", flavor))).toBe(false);
    }
  });

  it("passes headers-spec slots through", async () => {
    const t = setup(() => "088");
    const root = await prepareRnArtifacts(t.paths, "0.87.1", t.deps);
    expect(root).toBe(path.join(t.cacheRoot, "0.87.1"));
    expect(t.adapt).not.toHaveBeenCalled();
  });

  it("skips the download when the raw slot is complete", async () => {
    const t = setup();
    makeFakeSlot086(path.join(t.cacheRoot, "0.86.3", "debug"));
    makeFakeSlot086(path.join(t.cacheRoot, "0.86.3", "release"));
    await prepareRnArtifacts(t.paths, "0.86.3", t.deps);
    expect(t.runner).not.toHaveBeenCalled();
  });

  it("re-runs the downloader when the raw slot is incomplete", async () => {
    // React.xcframework present but no artifacts.json (what the 0.86.3 slot looks like before E4).
    const a = setup();
    makeFakeSlot086(path.join(a.cacheRoot, "0.86.3", "debug"));
    makeFakeSlot086(path.join(a.cacheRoot, "0.86.3", "release"));
    rmSync(path.join(a.cacheRoot, "0.86.3", "debug", "artifacts.json"));
    await prepareRnArtifacts(a.paths, "0.86.3", a.deps);
    expect(flavorsDownloaded(a.runner)).toEqual(["debug"]);

    // artifacts.json names an xcframework that is gone.
    const b = setup();
    makeFakeSlot086(path.join(b.cacheRoot, "0.86.3", "debug"));
    makeFakeSlot086(path.join(b.cacheRoot, "0.86.3", "release"));
    rmSync(path.join(b.cacheRoot, "0.86.3", "release", "hermes-engine.xcframework"), { recursive: true });
    await prepareRnArtifacts(b.paths, "0.86.3", b.deps);
    expect(flavorsDownloaded(b.runner)).toEqual(["release"]);
  });

  it("re-runs the downloader when a headers-spec slot lacks companion entries", async () => {
    const t = setup(() => "088");
    makeFakeSlot088(path.join(t.cacheRoot, "0.87.1", "debug"));
    makeFakeSlot088(path.join(t.cacheRoot, "0.87.1", "release"));
    const json = path.join(t.cacheRoot, "0.87.1", "release", "artifacts.json");
    const entries = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
    delete entries.ReactNativeHeaders;
    writeFileSync(json, JSON.stringify(entries));
    await prepareRnArtifacts(t.paths, "0.87.1", t.deps);
    expect(flavorsDownloaded(t.runner)).toEqual(["release"]);
  });

  it("reuses a current adapted slot", async () => {
    const t = setup();
    await prepareRnArtifacts(t.paths, "0.86.3", t.deps);
    t.adapt.mockClear();
    const root = await prepareRnArtifacts(t.paths, "0.86.3", t.deps);
    expect(root).toBe(path.join(t.paths.rnArtifacts, "0.86.3"));
    expect(t.adapt).not.toHaveBeenCalled();
  });

  it("fails with the downloader's output", async () => {
    const t = setup();
    t.runner.mockResolvedValue({ exitCode: 1, output: "boom" });
    await expect(prepareRnArtifacts(t.paths, "0.86.3", t.deps)).rejects.toThrow(
      /Downloading React Native 0\.86\.3 debug artifacts failed \(exit 1\):\nboom/,
    );
  });

  it("stops when the flavors disagree on the layout", async () => {
    const t = setup((f) => (f === "debug" ? "086" : "088"));
    const err = await prepareRnArtifacts(t.paths, "0.86.3", t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactLayoutError);
    expect((err as Error).message).toContain(
      `React Native 0.86.3 artifacts in ${path.join(t.cacheRoot, "0.86.3", "debug")} have a layout rn-xtool does not recognise: ReactNativeHeaders.xcframework is missing.`,
    );
    expect(t.adapt).not.toHaveBeenCalled();
  });
});

describe("rawSlotComplete", () => {
  it("accepts complete slots of either layout and rejects a missing one", () => {
    const dir = mkTmp("rn-slot-");
    expect(rawSlotComplete(path.join(dir, "none"))).toBe(false);
    makeFakeSlot086(path.join(dir, "086"));
    makeFakeSlot088(path.join(dir, "088"));
    expect(rawSlotComplete(path.join(dir, "086"))).toBe(true);
    expect(rawSlotComplete(path.join(dir, "088"))).toBe(true);
    rmSync(path.join(dir, "088", "hermes-headers", "hermes"), { recursive: true });
    expect(rawSlotComplete(path.join(dir, "088"))).toBe(false);
    writeFileSync(path.join(dir, "086", "artifacts.json"), "{not json");
    expect(rawSlotComplete(path.join(dir, "086"))).toBe(false);
  });
});

describe("projectPaths", () => {
  it("the adapted artifacts live under ios/build", () => {
    expect(projectPaths("/p").rnArtifacts).toBe("/p/ios/build/rn-artifacts");
  });
});
