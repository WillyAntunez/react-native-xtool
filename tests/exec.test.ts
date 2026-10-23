import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageRoot, runArgv, toolEnv } from "../src/tools/exec.js";

describe("toolEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prepends shims and swiftly bin to PATH", () => {
    const shims = path.join(packageRoot(), "shims");
    const swiftly = path.join(homedir(), ".local/share/swiftly/bin");
    process.env.PATH = "/usr/bin:/bin";
    const parts = toolEnv().PATH!.split(path.delimiter);
    expect(parts[0]).toBe(shims);
    expect(parts[1]).toBe(swiftly);
    expect(parts.slice(2)).toEqual(["/usr/bin", "/bin"]);
  });

  it("removes SDKROOT and merges extra", () => {
    process.env.SDKROOT = "/some/sdk";
    const env = toolEnv({ FOO: "bar" });
    expect("SDKROOT" in env).toBe(false);
    expect(env.FOO).toBe("bar");
    expect(process.env.SDKROOT).toBe("/some/sdk");
  });
});

describe("runArgv", () => {
  it("passes through without nice", () => {
    expect(runArgv("node", ["a"], false)).toEqual(["node", ["a"]]);
  });
  it("wraps with nice -n 15", () => {
    expect(runArgv("node", ["a"], true)).toEqual(["nice", ["-n", "15", "node", "a"]]);
  });
});
