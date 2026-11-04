import { homedir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  lineBufferedArgv,
  onPath,
  packageRoot,
  runArgv,
  runKeepingOutput,
  runKeepingStderr,
  runTee,
  toolEnv,
} from "../src/tools/exec.js";
import { explainingXtool } from "../src/tools/xtoolErrors.js";
import { capturingStdio, fakeTool } from "./support/stdio.js";

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

describe("runTee", () => {
  it("returns stdout and stderr while still running the command", async () => {
    const out = await runTee("sh", ["-c", "echo Wrote to x/App.ipa; echo oops >&2"], { env: process.env, echo: false });
    expect(out).toContain("Wrote to x/App.ipa");
    expect(out).toContain("oops");
  });

  describe("on a failure", () => {
    const failing = fakeTool("echo '[1/4] Compiling X'\necho 'error: unknown failure' >&2\nexit 1");
    afterAll(() => failing.cleanup());

    it("fails with the message `run` gives: the output was already shown live", async () => {
      const { result, stdout, stderr } = await capturingStdio(() =>
        runTee(failing.bin, ["dev", "build"], { env: process.env, onPath: () => false }),
      );
      expect(stdout).toContain("[1/4] Compiling X");
      expect(stderr).toContain("error: unknown failure");
      const e = (result as PromiseRejectedResult).reason as Failure;
      expect(e.message).toBe(`Command failed with exit code 1: ${failing.bin} dev build`);
      expect(e.stdout).toBe("[1/4] Compiling X");
      expect(e.stderr).toBe("error: unknown failure");
    });

    it("still lets a known xtool failure be explained from its output", async () => {
      const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xtool-errors");
      for (const [name, explained] of [
        ["device-not-registered", /^Apple has no iPhone registered /],
        ["app-id-limit", /^Apple refused to register another App ID/],
      ] as const) {
        const xtool = fakeTool(`cat '${path.join(fixtures, `${name}.txt`)}'\nexit 1`);
        try {
          const { result } = await capturingStdio(() =>
            explainingXtool(() => runTee(xtool.bin, ["dev", "build"], { env: process.env, onPath: () => false })),
          );
          expect(((result as PromiseRejectedResult).reason as Error).message).toMatch(explained);
        } finally {
          xtool.cleanup();
        }
      }
    });

    it("keeps the output in the message when it was not shown", async () => {
      const e = (await runTee(failing.bin, [], { env: process.env, echo: false }).catch((x: unknown) => x)) as Failure;
      expect(e.message).toContain("[1/4] Compiling X");
      expect(e.message).toContain("error: unknown failure");
    });
  });
});

type Failure = { stderr?: unknown; stdout?: unknown; exitCode?: number; message: string };

describe("runKeepingStderr", () => {
  const tool = fakeTool("echo out\necho 'Error: x' >&2\nexit 1");
  afterAll(() => tool.cleanup());

  it("shows stderr live and keeps only stderr", async () => {
    const { result, stderr } = await capturingStdio(() => runKeepingStderr(tool.bin, [], { env: process.env }));
    expect(result.status).toBe("rejected");
    const e = (result as PromiseRejectedResult).reason as Failure;
    expect(e.exitCode).toBe(1);
    expect(e.stderr).toContain("Error: x");
    expect(e.stdout).toBeUndefined();
    expect(stderr).toContain("Error: x");
  });

  it("fails with the message `run` gives, not the output a second time", async () => {
    const { result } = await capturingStdio(() => runKeepingStderr(tool.bin, ["a"], { env: process.env }));
    expect(((result as PromiseRejectedResult).reason as Failure).message).toBe(
      `Command failed with exit code 1: ${tool.bin} a`,
    );
  });

  it("resolves when the command succeeds", async () => {
    await expect(runKeepingStderr("sh", ["-c", "exit 0"], { env: process.env })).resolves.toBeUndefined();
  });
});

describe("runKeepingOutput", () => {
  const failing = fakeTool("printf 'Code: '\necho 'Error: x' >&2\nexit 1");
  const ok = fakeTool("printf 'Code: '\necho 'Cancelled.'\necho warn >&2");
  afterAll(() => {
    failing.cleanup();
    ok.cleanup();
  });

  it("shows stdout and stderr live and keeps both", async () => {
    const { result, stdout, stderr } = await capturingStdio(() => runKeepingOutput(failing.bin, [], { env: process.env }));
    const e = (result as PromiseRejectedResult).reason as Failure;
    expect(e.stdout).toBe("Code: ");
    expect(e.stderr).toBe("Error: x");
    expect(stdout).toBe("Code: ");
    expect(stderr).toBe("Error: x\n");
  });

  it("fails with the message `run` gives, not the output a second time", async () => {
    const { result } = await capturingStdio(() => runKeepingOutput(failing.bin, ["auth", "login"], { env: process.env }));
    expect(((result as PromiseRejectedResult).reason as Failure).message).toBe(
      `Command failed with exit code 1: ${failing.bin} auth login`,
    );
  });

  it("resolves with the output of a command that succeeds", async () => {
    const { result } = await capturingStdio(() => runKeepingOutput(ok.bin, [], { env: process.env }));
    expect(result).toEqual({ status: "fulfilled", value: "Code: Cancelled.\nwarn" });
  });
});

describe("line-buffered tees", () => {
  // A fake stdbuf on PATH records its arguments and runs the rest, so nothing depends on the host's stdbuf.
  const stdbuf = fakeTool('echo "$@" > "$(dirname "$0")/stdbuf-args"\nshift\nexec "$@"');
  const fakeStdbuf = `${stdbuf.dir}/stdbuf`;
  const tool = fakeTool("echo out\necho 'Error: x' >&2\nexit 1");
  const env = { ...process.env, PATH: `${stdbuf.dir}${path.delimiter}${process.env.PATH ?? ""}` };
  const argsFile = `${stdbuf.dir}/stdbuf-args`;
  const used = (): string | undefined => (existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim() : undefined);
  const has = () => true;
  const hasNot = () => false;
  afterEach(() => rmSync(argsFile, { force: true }));
  afterAll(() => {
    stdbuf.cleanup();
    tool.cleanup();
  });
  beforeAll(() => renameSync(stdbuf.bin, fakeStdbuf));

  it("runs the command under stdbuf -oL when stdbuf is on PATH", () => {
    const asked: [string, string | undefined][] = [];
    const found = (name: string, e: NodeJS.ProcessEnv) => (asked.push([name, e.PATH]), true);
    expect(lineBufferedArgv("/x/xtool", ["auth", "login"], { PATH: "/p" }, found)).toEqual([
      "stdbuf",
      ["-oL", "/x/xtool", "auth", "login"],
    ]);
    expect(asked).toEqual([["stdbuf", "/p"]]);
    expect(lineBufferedArgv("/x/xtool", ["auth", "login"], { PATH: "/p" }, hasNot)).toEqual([
      "/x/xtool",
      ["auth", "login"],
    ]);
  });

  it("looks stdbuf up in the PATH it runs with", () => {
    expect(onPath("stdbuf", env)).toBe(true);
    expect(onPath("stdbuf", { PATH: tool.dir })).toBe(false);
    expect(onPath("stdbuf", {})).toBe(false);
  });

  it("runKeepingOutput uses it, and prints the failure without it", async () => {
    const { result } = await capturingStdio(() => runKeepingOutput(tool.bin, ["auth", "login"], { env, onPath: has }));
    expect(used()).toBe(`-oL ${tool.bin} auth login`);
    expect(((result as PromiseRejectedResult).reason as Failure).message).toBe(
      `Command failed with exit code 1: ${tool.bin} auth login`,
    );
    const nice = await capturingStdio(() => runKeepingOutput(tool.bin, ["dev"], { env, nice: true, onPath: has }));
    expect(((nice.result as PromiseRejectedResult).reason as Failure).message).toBe(
      `Command failed with exit code 1: nice -n 15 ${tool.bin} dev`,
    );
  });

  it("runKeepingOutput runs the command as is without stdbuf", async () => {
    await capturingStdio(() => runKeepingOutput(tool.bin, [], { env, onPath: hasNot }));
    expect(used()).toBeUndefined();
  });

  it("runTee uses it when it shows the output, and prints the failure as without it", async () => {
    const without = await capturingStdio(() => runTee(tool.bin, ["dev"], { env, onPath: hasNot }));
    expect(used()).toBeUndefined();
    const withIt = await capturingStdio(() => runTee(tool.bin, ["dev"], { env, onPath: has }));
    expect(used()).toBe(`-oL ${tool.bin} dev`);
    expect(((withIt.result as PromiseRejectedResult).reason as Failure).message).toBe(
      ((without.result as PromiseRejectedResult).reason as Failure).message,
    );
  });

  it("runTee does not use it when the output is not shown", async () => {
    await runTee(tool.bin, [], { env, echo: false, onPath: has }).catch(() => undefined);
    expect(used()).toBeUndefined();
  });

  it("runKeepingStderr does not use it: stdout stays on the terminal", async () => {
    await capturingStdio(() => runKeepingStderr("true", [], { env }));
    expect(used()).toBeUndefined();
  });
});
