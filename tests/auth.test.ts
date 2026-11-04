import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { auth, authArgs } from "../src/commands/auth.js";
import { buildProgram } from "../src/cli.js";
import { ExitError } from "../src/exitError.js";
import { capturingStdio, fakeTool } from "./support/stdio.js";

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
  type Runners = { runner?: (cmd: string, args: string[]) => Promise<void>; loginRunner?: (cmd: string, args: string[]) => Promise<string> };
  const x = (r: Runners = {}) => ({
    loadConfig: async () => ({ metroPort: 8081 }),
    bin: () => "/bin/xtool",
    runner: r.runner ?? vi.fn(async () => {}),
    loginRunner: r.loginRunner ?? vi.fn(async () => "Logged in.\n"),
  });
  const fixture = (name: string): string =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xtool-errors", `${name}.txt`), "utf8");
  const failed = (fields: object) => Object.assign(new Error("Command failed with exit code 1"), fields);

  it("runs `auth login` with the login runner, which keeps its output", async () => {
    const runner = vi.fn(async () => {});
    const loginRunner = vi.fn(async () => "Logged in.\n");
    await auth("/p", ["login"], x({ runner, loginRunner }));
    expect(loginRunner).toHaveBeenCalledWith("/bin/xtool", ["auth", "login"]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs `auth status` when no arguments are given", async () => {
    const runner = vi.fn(async () => {});
    await auth("/p", [], x({ runner }));
    expect(runner).toHaveBeenCalledWith("/bin/xtool", ["auth", "status"]);
  });

  it("explains a known failure", async () => {
    const loginRunner = vi.fn(async (): Promise<string> => {
      throw failed({ stderr: fixture("gsa-503"), stdout: "Logging in...\n", exitCode: 1 });
    });
    await expect(auth("/p", ["login"], x({ loginRunner }))).rejects.toThrow(
      /^Apple's sign-in service answered HTTP 503 \(Service Temporarily Unavailable\): .*issues\/404$/,
    );
    const runner = vi.fn(async () => {
      throw failed({ stderr: fixture("connect-timeout"), exitCode: 1 });
    });
    await expect(auth("/p", ["status"], x({ runner }))).rejects.toThrow(/^A connection xtool needs to sign in timed out/);
  });

  it("rethrows an unknown failure as is", async () => {
    const unknown = failed({ stderr: "Error: something new\n", stdout: "", exitCode: 1 });
    const loginRunner = vi.fn(async (): Promise<string> => {
      throw unknown;
    });
    await expect(auth("/p", ["login"], x({ loginRunner }))).rejects.toBe(unknown);
  });

  it("an interrupted 2FA prompt gets the verification-code hint and exit status 130", async () => {
    // xtool exits 0 after Ctrl+C: it prints `Cancelled.` instead of dying from the signal.
    const loginRunner = vi.fn(async () => `${fixture("login-interrupted")}\n`);
    const e = await auth("/p", ["login"], x({ loginRunner })).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ExitError);
    expect((e as ExitError).message).toMatch(/^Sign-in was interrupted\. .*issues\/407$/);
    expect((e as ExitError).status).toBe(130);
  });

  it("a login cancelled before the code prompt exits 130 without a hint, as Ctrl+C did", async () => {
    for (const output of ["Choice (0-1): Cancelled.\n\n", "Apple ID: Cancelled.\n\n", "Logging in...\nCancelled.\n\n"]) {
      const loginRunner = vi.fn(async () => output);
      const e = await auth("/p", ["login"], x({ loginRunner })).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(ExitError);
      expect(e).toMatchObject({ message: "", status: 130 });
    }
  });

  it("a login that succeeds resolves", async () => {
    const loginRunner = vi.fn(async () => "Logging in...\nCode: Logged in.\n- Apple ID: dev@example.com\n\n");
    await expect(auth("/p", ["login"], x({ loginRunner }))).resolves.toBeUndefined();
  });

  it("removes its SIGINT guard after login", async () => {
    const before = process.listenerCount("SIGINT");
    const during: number[] = [];
    const ok = vi.fn(async () => {
      during.push(process.listenerCount("SIGINT"));
      return "Logged in.\n";
    });
    await auth("/p", ["login"], x({ loginRunner: ok }));
    expect(process.listenerCount("SIGINT")).toBe(before);
    const failing = vi.fn(async (): Promise<string> => {
      during.push(process.listenerCount("SIGINT"));
      throw failed({ stdout: "Error: something new\n" });
    });
    await expect(auth("/p", ["login"], x({ loginRunner: failing }))).rejects.toThrow("Command failed");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(during).toEqual([before + 1, before + 1]);
  });

  it("adds no SIGINT guard outside login", async () => {
    const before = process.listenerCount("SIGINT");
    let during: number | undefined;
    const runner = vi.fn(async () => {
      during = process.listenerCount("SIGINT");
    });
    await auth("/p", ["status"], x({ runner }));
    expect(during).toBe(before);
  });

  it("prints an unknown failure as it did before", async () => {
    // stdout only for login: status and logout leave it on the terminal, where nothing can capture it.
    const tool = fakeTool("[ \"$2\" = login ] && echo 'Logging in...'\necho 'Error: something new' >&2\nexit 1");
    try {
      for (const args of [["login"], ["logout"]]) {
        const { result } = await capturingStdio(() =>
          auth("/p", args, { loadConfig: async () => ({ metroPort: 8081 }), bin: () => tool.bin }),
        );
        expect(result.status).toBe("rejected");
        // The CLI prints `✖ ${message}`: execa's line alone, as with inherited output.
        expect(((result as PromiseRejectedResult).reason as Error).message).toBe(
          `Command failed with exit code 1: ${tool.bin} auth ${args[0]}`,
        );
      }
    } finally {
      tool.cleanup();
    }
  });
});

describe("auth command", () => {
  it("is registered with help text", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "auth");
    expect(cmd?.description()).toContain("xtool");
  });
});
