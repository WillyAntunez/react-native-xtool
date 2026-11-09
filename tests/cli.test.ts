import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import { ExitError } from "../src/exitError.js";

const doctor = vi.hoisted(() => vi.fn(async () => ({ checks: [], ok: true })));
vi.mock("../src/commands/doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/doctor.js")>()),
  doctor,
}));

const doctorReport = vi.hoisted(() => vi.fn(async (): Promise<string> => "the report"));
vi.mock("../src/commands/report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/report.js")>()),
  doctorReport,
}));

const auth = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));
vi.mock("../src/commands/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/auth.js")>()),
  auth,
}));

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

  it("offers --skip-precheck on build and run", () => {
    for (const name of ["build", "run"]) {
      const cmd = buildProgram().commands.find((c) => c.name() === name)!;
      expect(cmd.options.map((o) => [o.flags, o.description])).toContainEqual([
        "--skip-precheck",
        "skip the check of the app's own sources before xtool-build",
      ]);
    }
  });

  it("doctor has --project and --report", () => {
    const doctorCmd = buildProgram().commands.find((c) => c.name() === "doctor")!;
    expect(doctorCmd.options.map((o) => [o.flags, o.description])).toEqual([
      ["--project", "check only the project (version gates and capabilities): no toolchain, login or device checks"],
      ["--report", "print a redacted report to paste into a GitHub issue"],
    ]);
  });

  describe("a failing action", () => {
    const failWith = async (e: unknown): Promise<{ printed: string[]; exitCode: typeof process.exitCode }> => {
      auth.mockRejectedValueOnce(e);
      const printed: string[] = [];
      const err = vi.spyOn(console, "error").mockImplementation((s: string) => void printed.push(s));
      const saved = process.exitCode;
      try {
        await buildProgram().parseAsync(["node", "rn-xtool", "auth", "login"]);
        return { printed, exitCode: process.exitCode };
      } finally {
        err.mockRestore();
        process.exitCode = saved;
      }
    };

    it("prints the error and exits 1", async () => {
      expect(await failWith(new Error("boom"))).toEqual({ printed: ["✖ boom"], exitCode: 1 });
    });

    it("exits with an ExitError's status, printing its message if it has one", async () => {
      expect(await failWith(new ExitError("Sign-in was interrupted.", 130))).toEqual({
        printed: ["✖ Sign-in was interrupted."],
        exitCode: 130,
      });
      expect(await failWith(new ExitError("", 130))).toEqual({ printed: [], exitCode: 130 });
    });
  });

  describe("doctor action", () => {
    const start = process.cwd();
    afterEach(() => {
      process.chdir(start);
      doctor.mockClear();
      doctorReport.mockClear();
    });

    async function runIn(args: string[]): Promise<unknown[]> {
      const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-cli-"));
      try {
        process.chdir(dir);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await buildProgram().parseAsync(["node", "rn-xtool", "doctor", ...args]);
        log.mockRestore();
        return [process.cwd(), ...doctor.mock.calls[0]!];
      } finally {
        process.chdir(start);
        await rm(dir, { recursive: true, force: true });
      }
    }

    it("--project checks the cwd, without app.json, in project-only mode", async () => {
      const [cwd, root, probes, opts] = await runIn(["--project"]);
      expect(root).toBe(cwd);
      expect(probes).toBeUndefined();
      expect(opts).toEqual({ projectOnly: true });
    });

    it("--report prints the report and exits 0", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-cli-"));
      const saved = process.exitCode;
      const printed: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((s: string) => void printed.push(s));
      try {
        process.chdir(dir);
        await buildProgram().parseAsync(["node", "rn-xtool", "doctor", "--report"]);
        expect(doctorReport).toHaveBeenCalledWith(undefined, { projectOnly: false });
        expect(printed).toEqual(["the report"]);
        expect(doctor).not.toHaveBeenCalled();
        expect(process.exitCode).not.toBe(1);
      } finally {
        log.mockRestore();
        process.exitCode = saved;
        process.chdir(start);
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("--report prints a failure through the redaction", async () => {
      const saved = process.exitCode;
      const printed: string[] = [];
      const err = vi.spyOn(console, "error").mockImplementation((s: string) => void printed.push(s));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      doctorReport.mockRejectedValueOnce(
        new Error(`boom in ${os.homedir()}/apps/demo for jane.doe@example.com at 192.168.50.23 token=ghp_abcdefghijklmnopqrstuvwxyz0123`),
      );
      try {
        await buildProgram().parseAsync(["node", "rn-xtool", "doctor", "--report"]);
        expect(printed).toEqual(["✖ boom in ~/apps/demo for <email> at <ip> token=<token>"]);
        expect(process.exitCode).toBe(1);
      } finally {
        err.mockRestore();
        log.mockRestore();
        process.exitCode = saved;
      }
    });

    it("--report --project reports on the cwd", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-cli-"));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        process.chdir(dir);
        await buildProgram().parseAsync(["node", "rn-xtool", "doctor", "--report", "--project"]);
        expect(doctorReport).toHaveBeenCalledWith(process.cwd(), { projectOnly: true });
      } finally {
        log.mockRestore();
        process.chdir(start);
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("plain doctor without app.json checks no project", async () => {
      const [, root, , opts] = await runIn([]);
      expect(root).toBeUndefined();
      expect(opts).toEqual({ projectOnly: false });
    });
  });
});
