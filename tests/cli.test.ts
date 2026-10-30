import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";

const doctor = vi.hoisted(() => vi.fn(async () => ({ checks: [], ok: true })));
vi.mock("../src/commands/doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/doctor.js")>()),
  doctor,
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

  it("doctor has --project", () => {
    const doctorCmd = buildProgram().commands.find((c) => c.name() === "doctor")!;
    expect(doctorCmd.options.map((o) => [o.flags, o.description])).toEqual([
      ["--project", "check only the project (version gates and capabilities): no toolchain, login or device checks"],
    ]);
  });

  describe("doctor action", () => {
    const start = process.cwd();
    afterEach(() => {
      process.chdir(start);
      doctor.mockClear();
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

    it("plain doctor without app.json checks no project", async () => {
      const [, root, , opts] = await runIn([]);
      expect(root).toBeUndefined();
      expect(opts).toEqual({ projectOnly: false });
    });
  });
});
