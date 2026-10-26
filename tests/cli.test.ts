import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("buildProgram", () => {
  it("names the program in help output", () => {
    expect(buildProgram().helpInformation()).toContain("rn-xtool");
  });

  it("reports the package.json version", () => {
    expect(buildProgram().version()).toBe(pkg.version);
  });

  it("offers install --network with an optional IP", () => {
    const installCmd = buildProgram().commands.find((c) => c.name() === "install")!;
    const flags = installCmd.options.map((o) => o.flags);
    expect(flags).toEqual(["--network [ip]", "--udid <udid>", "--pair-record <file>"]);
  });

  it("offers setup --wifi with an explicit --yes", () => {
    const setupCmd = buildProgram().commands.find((c) => c.name() === "setup")!;
    expect(setupCmd.options.map((o) => o.flags)).toEqual(["--xcode-xip <path>", "--wifi", "--yes", "--udid <udid>"]);
  });

  it("offers run --network", () => {
    const runCmd = buildProgram().commands.find((c) => c.name() === "run")!;
    expect(runCmd.options.map((o) => o.flags)).toContain("--network [ip]");
  });
});
