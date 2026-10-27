import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../e2e/clean-machine/e2e.sh");

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** Runs `e2e.sh project …` with a fake `docker` that logs its argv, a temp HOME, no container. */
async function project(args: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-harness-"));
  tmp.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const log = path.join(root, "docker.log");
  mkdirSync(path.join(home, ".cache"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(bin, "docker"), '#!/usr/bin/env bash\necho "$*" >> "$DOCKER_LOG"\n');
  chmodSync(path.join(bin, "docker"), 0o755);
  const result = await execa("bash", [SCRIPT, "project", ...args], {
    reject: false,
    all: true,
    env: { HOME: home, DOCKER_LOG: log, PATH: `${bin}:${process.env.PATH}` },
    extendEnv: false,
  });
  return { ...result, docker: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

describe("e2e.sh project", () => {
  it("project --bare defaults to React Native 0.88.0", async () => {
    const r = await project(["--bare", "demo"]);
    expect(r.exitCode).toBe(0);
    expect(r.docker).toContain("init 'demo' --version 0.88.0");
  });

  it("project --bare --rn 0.86.3 initialises that version", async () => {
    for (const args of [
      ["--bare", "app", "--rn", "0.86.3"],
      ["--bare", "--rn", "0.86.3", "app"],
    ]) {
      const r = await project(args);
      expect(r.exitCode).toBe(0);
      expect(r.docker).toContain("init 'app' --version 0.86.3");
    }
  });

  it("project --rn without --bare is refused", async () => {
    const r = await project(["--rn", "0.86.3"]);
    expect(r.exitCode).toBe(1);
    expect(r.all).toContain("--rn needs --bare");
    expect(r.docker).toBe("");
  });

  it("project --rn without a version is refused", async () => {
    for (const args of [["--bare", "--rn"], ["--bare", "app", "--rn"]]) {
      const r = await project(args);
      expect(r.exitCode).toBe(1);
      expect(r.all).toContain("--rn needs a version");
      expect(r.docker).toBe("");
    }
  });
});
