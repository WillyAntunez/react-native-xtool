import { describe, expect, it, vi } from "vitest";
import { auth, authArgs } from "../src/commands/auth.js";
import { buildProgram } from "../src/cli.js";

describe("authArgs", () => {
  it("defaults to `auth status` with no arguments", () => {
    expect(authArgs([])).toEqual(["auth", "status"]);
  });
  it("passes the arguments through after `auth`", () => {
    expect(authArgs(["login"])).toEqual(["auth", "login"]);
    expect(authArgs(["logout", "--foo"])).toEqual(["auth", "logout", "--foo"]);
  });
});

describe("auth", () => {
  const x = (runner = vi.fn(async () => {})) => ({
    loadConfig: async () => ({ metroPort: 8081 }),
    bin: () => "/bin/xtool",
    runner,
  });

  it("runs the managed xtool binary with the mapped arguments", async () => {
    const runner = vi.fn(async () => {});
    await auth("/p", ["login"], x(runner));
    expect(runner).toHaveBeenCalledWith("/bin/xtool", ["auth", "login"]);
  });

  it("runs `auth status` when no arguments are given", async () => {
    const runner = vi.fn(async () => {});
    await auth("/p", [], x(runner));
    expect(runner).toHaveBeenCalledWith("/bin/xtool", ["auth", "status"]);
  });
});

describe("auth command", () => {
  it("is registered with help text", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "auth");
    expect(cmd?.description()).toContain("xtool");
  });
});
