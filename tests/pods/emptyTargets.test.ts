import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_TARGETS_DIR, emptyArm64Object, emptyTargetsOf, writeEmptyTargetObjects } from "../../src/pods/emptyTargets.js";
import { PLATFORM_IOS, highestMinIos, platformProblem, readBinary } from "../../src/pods/macho.js";
import { mergedPodTable } from "../../src/project/podTable.js";
import { tool } from "../support/tools.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pods-empty-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CLANG = [path.join(homedir(), ".local", "share", "swiftly", "bin", "clang"), "clang"].find((c) => tool(c, ["--version"]).status === 0);

describe("emptyArm64Object", () => {
  it("is an arm64 iOS object without code", () => {
    const o = emptyArm64Object("16.4");
    const shape = readBinary(o);
    expect(shape.shape).toBe("macho");
    if (shape.shape !== "macho") return;
    expect(shape.info.kind).toBe("object");
    expect(shape.info.cpu).toBe("arm64");
    expect(highestMinIos(o)).toBe("16.4");
    expect(platformProblem(o)).toBeUndefined();
    expect(o.readUInt32LE(0xb8 + 8)).toBe(PLATFORM_IOS);
    expect(emptyArm64Object("15.1").equals(o)).toBe(false);
    expect(highestMinIos(emptyArm64Object("17.0.2"))).toBe("17.0.2");
  });

  // What G1 linked: clang's object for an empty C file. Checked against the toolchain's clang where it is installed.
  it.runIf(CLANG !== undefined)("is byte for byte what clang writes for an empty C file", () => {
    const c = path.join(root, "empty.c");
    writeFileSync(c, "");
    for (const minos of ["15.1", "16.4"]) {
      const out = path.join(root, `empty-${minos}.o`);
      const r = tool(CLANG!, ["-target", `arm64-apple-ios${minos}`, "-c", c, "-o", out]);
      expect(r.status, r.stderr).toBe(0);
      expect(emptyArm64Object(minos).equals(readFileSync(out))).toBe(true);
    }
  });
});

describe("writeEmptyTargetObjects", () => {
  it("writes <Target>.o where Swift Build links it, and keeps one that is there", async () => {
    const iosXtool = path.join(root, "ios-xtool");
    expect(await writeEmptyTargetObjects(iosXtool, ["GTMDefines", "Other"], "16.4")).toEqual(["GTMDefines", "Other"]);
    const dir = path.join(iosXtool, ...EMPTY_TARGETS_DIR);
    expect(dir).toBe(path.join(iosXtool, ".build", "out", "Products", "Debug-iphoneos"));
    expect(readFileSync(path.join(dir, "GTMDefines.o")).equals(emptyArm64Object("16.4"))).toBe(true);
    // The object the builder writes is kept as it is.
    expect(await writeEmptyTargetObjects(iosXtool, ["GTMDefines", "Other"], "16.4")).toEqual([]);
    // Nothing to write, nothing made.
    const none = path.join(root, "none");
    mkdirSync(none);
    expect(await writeEmptyTargetObjects(none, [], "16.4")).toEqual([]);
    expect(existsSync(path.join(none, ".build"))).toBe(false);
  });

  it("rewrites an object that is not the builder's (row 84)", async () => {
    const iosXtool = path.join(root, "ios-xtool");
    const dir = path.join(iosXtool, ...EMPTY_TARGETS_DIR);
    mkdirSync(dir, { recursive: true });
    // A write cut short, a foreign file, and one written for another minimum.
    writeFileSync(path.join(dir, "Short.o"), "");
    writeFileSync(path.join(dir, "Foreign.o"), "built");
    writeFileSync(path.join(dir, "Older.o"), emptyArm64Object("15.1"));
    expect(await writeEmptyTargetObjects(iosXtool, ["Short", "Foreign", "Older"], "16.4")).toEqual(["Short", "Foreign", "Older"]);
    for (const t of ["Short", "Foreign", "Older"]) expect(readFileSync(path.join(dir, `${t}.o`)).equals(emptyArm64Object("16.4"))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["Foreign.o", "Older.o", "Short.o"]);
  });

  it("refuses a target name that is a path", async () => {
    await expect(writeEmptyTargetObjects(root, ["../x"], "16.4")).rejects.toThrow("internal error: ../x is not a target name");
  });
});

describe("emptyTargetsOf", () => {
  it("collects the empty targets of the linked table pods", () => {
    const table = mergedPodTable();
    expect(emptyTargetsOf(table, ["GoogleToolboxForMac", "AppAuth", "GoogleToolboxForMac"])).toEqual(["GTMDefines"]);
    expect(emptyTargetsOf(table, ["AppAuth", "Unknown"])).toEqual([]);
  });
});
