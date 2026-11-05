import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLVM_AR_MISSING, makeArRunner, wrapObject, type ArRunner } from "../../src/pods/ar.js";
import { PodsError } from "../../src/pods/format.js";
import { readBinary } from "../../src/pods/macho.js";
import { machO } from "../support/macho.js";

const LABEL = { pod: "MLKitTextRecognitionCommon", version: "5.0.0", rel: "Frameworks/MLKitTextRecognitionCommon.framework/MLKitTextRecognitionCommon" };
let dir: string;
let object: string;
let archive: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pods-ar-"));
  object = path.join(dir, "MLKitTextRecognitionCommon.o");
  archive = path.join(dir, "out", "libMLKitTextRecognitionCommon.a");
  writeFileSync(object, machO({ payload: "object" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake llvm-ar: records its arguments and writes `content` to the archive. */
function fakeAr(calls: string[][], content = "!<arch>\nmember"): ArRunner {
  return async (args) => {
    calls.push(args);
    writeFileSync(args[2]!, content);
    return "";
  };
}

describe("wrapObject", () => {
  it("runs llvm-ar rcs --format=darwin", async () => {
    const calls: string[][] = [];
    await wrapObject(object, archive, fakeAr(calls), LABEL);
    expect(calls).toEqual([["rcs", "--format=darwin", archive, object]]);
    expect(readFileSync(archive, "latin1")).toBe("!<arch>\nmember");
  });

  it("starts from an empty archive", async () => {
    const calls: string[][] = [];
    await wrapObject(object, archive, fakeAr(calls), LABEL);
    let existed: boolean | undefined;
    await wrapObject(object, archive, async (args) => {
      existed = (() => {
        try {
          readFileSync(args[2]!);
          return true;
        } catch {
          return false;
        }
      })();
      writeFileSync(args[2]!, "!<arch>\n");
      return "";
    }, LABEL);
    expect(existed).toBe(false);
  });

  it("names the pod and the object when llvm-ar fails", async () => {
    const failing: ArRunner = async () => {
      throw Object.assign(new Error("llvm-ar failed"), { stderr: "llvm-ar: error: bad object\nmore" });
    };
    await expect(wrapObject(object, archive, failing, LABEL)).rejects.toThrow(
      new PodsError(`llvm-ar could not wrap MLKitTextRecognitionCommon 5.0.0's object (${LABEL.rel}): llvm-ar: error: bad object`),
    );
  });

  it("names rn-xtool setup when llvm-ar is missing", async () => {
    const run = makeArRunner(path.join(dir, "no-such-llvm-ar"));
    await expect(run(["--version"])).rejects.toThrow(LLVM_AR_MISSING);
    const err = await wrapObject(object, archive, run, LABEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PodsError);
    expect((err as Error).message).toBe(LLVM_AR_MISSING);
    expect(LLVM_AR_MISSING).toBe(
      "llvm-ar was not found on the Swift toolchain's PATH; rn-xtool wraps CocoaPods binaries with it. Run `rn-xtool setup` to install Swift 6.4 through swiftly.",
    );
  });

  it("refuses a result that is not an ar archive", async () => {
    await expect(wrapObject(object, archive, fakeAr([], "!<thin>\n"), LABEL)).rejects.toThrow(
      `internal error: llvm-ar wrote ${archive} for MLKitTextRecognitionCommon 5.0.0, which does not start with !<arch>`,
    );
  });
});

const hasAr = await makeArRunner()(["--version"]).then(
  () => true,
  () => false,
);

describe.skipIf(!hasAr)("wrapObject with the toolchain's llvm-ar", () => {
  it("wraps a Mach-O object into a Darwin archive", async () => {
    await wrapObject(object, archive, makeArRunner(), LABEL);
    const shape = readBinary(readFileSync(archive));
    expect(readFileSync(archive).subarray(0, 8).toString("latin1")).toBe("!<arch>\n");
    expect(shape).toEqual({ shape: "ar", members: [{ name: "MLKitTextRecognitionCommon.o", info: { kind: "object", cpu: "arm64" } }] });
  });
});
