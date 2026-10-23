import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("buildProgram", () => {
  it("names the program in help output", () => {
    expect(buildProgram().helpInformation()).toContain("expo-xtool");
  });

  it("reports the package.json version", () => {
    expect(buildProgram().version()).toBe(pkg.version);
  });
});
