import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(root, ".github", "workflows", "drift-watch.yml");
const SCRIPT = path.join(root, "scripts", "drift-watch.mjs");
const PACKAGE = path.join(root, "package.json");

const text = (): string => readFileSync(WORKFLOW, "utf8");
const lines = (): string[] => text().split("\n");
const indent = (l: string): number => l.length - l.trimStart().length;

/** The lines under the key on line `i`: every following line indented deeper (blank lines included). */
function block(all: string[], i: number): string[] {
  const own = indent(all[i]!);
  const out: string[] = [];
  for (const l of all.slice(i + 1)) {
    if (l.trim() !== "" && indent(l) <= own) break;
    out.push(l);
  }
  return out;
}

/** A job's lines: the `  <name>:` key under `jobs:` and its block. */
function job(name: string): string[] {
  const all = lines();
  const i = all.findIndex((l) => l === `  ${name}:`);
  expect(i, `job ${name}`).toBeGreaterThan(all.indexOf("jobs:"));
  return block(all, i);
}

/** The text of every `run:` step: the line itself and, for a block scalar, the lines below it. */
function runBlocks(): string[] {
  const all = lines();
  return all.flatMap((l, i) => (/^\s*(- )?run:/.test(l) ? [[l, ...block(all, i)].join("\n")] : []));
}

describe("drift-watch workflow", () => {
  it("runs daily, weekly and by hand", () => {
    const crons = [...text().matchAll(/cron:\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(crons).toEqual(["23 5 * * *", "47 5 * * 1"]);
    expect(text().match(/cron:/g)).toHaveLength(2);
    const all = lines();
    const dispatch = block(all, all.findIndex((l) => /^\s*workflow_dispatch:/.test(l))).join("\n");
    expect(dispatch).toMatch(/^\s{6}mode:/m);
    expect(dispatch).toMatch(/options:\s*\n\s*- daily\s*\n\s*- explore\s*$/m);
    expect(dispatch).toMatch(/^\s{6}drill:/m);
  });

  it("says how the schedule is kept alive", () => {
    expect(text()).toMatch(/^#.*60 days/m);
    expect(text()).toMatch(/^#.*workflow_dispatch/m);
  });

  it("picks the exploration on the weekly cron or the explore input", () => {
    const targets = job("targets").join("\n");
    expect(targets).toContain('"47 5 * * 1"');
    expect(targets).toContain("${{ inputs.mode }}");
    expect(targets).toMatch(/mode: \$\{\{ steps\.\w+\.outputs\.mode \}\}/);
    expect(targets).toMatch(/matrix: \$\{\{ steps\.\w+\.outputs\.matrix \}\}/);
  });

  it("reads the repository everywhere and writes issues only in the report job", () => {
    const all = lines();
    const permissionLines = all.flatMap((l, i) => (/^\s*permissions:/.test(l) ? block(all, i) : []));
    for (const l of all) if (/^\s*permissions:/.test(l)) expect(l.trim()).toBe("permissions:");
    expect(permissionLines.length).toBeGreaterThan(0);
    for (const l of permissionLines.filter((p) => p.trim() !== "")) {
      expect(["contents: read", "issues: write"]).toContain(l.trim());
    }
    expect(text().match(/issues: write/g)).toHaveLength(1);
    expect(job("report").map((l) => l.trim())).toContain("issues: write");
  });

  it("gives every job a read-only token unless it says otherwise", () => {
    // Without the top-level block, the jobs that run third-party create and install code get the repository's
    // default token permissions.
    const all = lines();
    const i = all.indexOf("permissions:");
    expect(i, "top-level permissions").toBeGreaterThan(-1);
    expect(i).toBeLessThan(all.indexOf("jobs:"));
    expect(block(all, i).filter((l) => l.trim() !== "")).toEqual(["  contents: read"]);
    for (const name of ["targets", "check", "explore", "explore-summary"]) {
      expect(job(name).some((l) => /^\s*permissions:/.test(l)), name).toBe(false);
    }
  });

  it("uses the workflow token and no secret", () => {
    expect(text()).not.toMatch(/secrets\./);
    expect(text()).toContain("GH_TOKEN: ${{ github.token }}");
    expect(job("report").join("\n")).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("hands the token only to the report step", () => {
    expect(text().match(/GH_TOKEN/g)).toHaveLength(1);
    const report = job("report");
    const step = report.findIndex((l) => l.trim() === "- name: Report drift");
    expect(step).toBeGreaterThan(-1);
    expect(block(report, step).join("\n")).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("runs on hosted Ubuntu without Swift", () => {
    const runsOn = [...text().matchAll(/runs-on:\s*(.+)/g)].map((m) => m[1]!.trim());
    expect(runsOn.length).toBe(5);
    for (const r of runsOn) expect(r).toBe("ubuntu-latest");
    expect(text()).not.toMatch(/setup-swift|swiftly|rn-xtool setup/);
  });

  it("pins each action to an existing major", () => {
    const uses = [...text().matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    const allowed = [
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "actions/upload-artifact@v4",
      "actions/download-artifact@v4",
    ];
    for (const u of uses) expect(allowed).toContain(u);
  });

  it("passes inputs and JSON through env, never into run text", () => {
    const runs = runBlocks();
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).not.toContain("${{");
  });

  it("calls only subcommands the script handles", () => {
    const handled = new Set([...readFileSync(SCRIPT, "utf8").matchAll(/case "([^"]+)"/g)].map((m) => m[1]));
    const called = [...text().matchAll(/node scripts\/drift-watch\.mjs (\S+)/g)].map((m) => m[1]);
    expect(new Set(called)).toEqual(new Set(["targets", "check", "report", "explore", "explore-summary"]));
    for (const sub of called) expect(handled, sub).toContain(sub);
  });

  it("checks each daily target in its own fresh directory, with English patch messages", () => {
    const check = job("check").join("\n");
    expect(check).toContain("if: needs.targets.outputs.mode == 'daily'");
    expect(check).toContain("fail-fast: false");
    expect(check).toContain("timeout-minutes: 30");
    expect(check).toMatch(/LC_ALL: C$/m);
    expect(check).toContain("TARGET: ${{ toJSON(matrix.target) }}");
    expect(check).toMatch(/rm -rf "\$dir"\n\s*node scripts\/drift-watch\.mjs check --target "\$TARGET" --dir "\$dir"/);
    expect(check).toContain("name: drift-${{ matrix.slug }}");
  });

  it("reports once per run, one report at a time", () => {
    const report = job("report").join("\n");
    expect(report).toMatch(/needs: \[targets, check\]/);
    expect(report).toContain("if: ${{ !cancelled() && needs.targets.outputs.mode == 'daily' }}");
    expect(report).toMatch(/concurrency:\s*\n\s*group: drift-watch-report\s*\n\s*cancel-in-progress: false/);
    expect(report).toContain("DRILL: ${{ inputs.drill }}");
    // `--drill=` keeps a value that starts with "-" a value; the script then refuses anything but a line id.
    expect(report).toContain('--drill="$DRILL"');
    expect(report).toContain("MATRIX: ${{ needs.targets.outputs.matrix }}");
    expect(report).toContain("actions/checkout@v4");
    expect(report).toContain("pattern: drift-*");
    expect(report).toContain("merge-multiple: true");
  });

  it("explores weekly into the summary and opens no issue", () => {
    const explore = job("explore").join("\n");
    expect(explore).toContain("if: needs.targets.outputs.mode == 'explore'");
    expect(explore).toContain("continue-on-error: true");
    expect(explore).toContain("name: explore-${{ matrix.slug }}");
    const summary = job("explore-summary").join("\n");
    expect(summary).toMatch(/needs: \[targets, explore\]/);
    expect(summary).toContain("if: ${{ !cancelled() && needs.targets.outputs.mode == 'explore' }}");
    expect(summary).toContain("pattern: explore-*");
    expect(`${explore}\n${summary}`).not.toMatch(/GH_TOKEN|issues:|gh issue/);
  });

  it("stops after a cancel instead of reporting partial results", () => {
    expect(text()).not.toContain("always()");
  });

  it("builds dist/ once, through npm ci, before any script runs", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepare).toBe("npm run build");
    expect(text()).not.toContain("npm run build");
    for (const name of ["targets", "check", "report", "explore", "explore-summary"]) {
      const steps = job(name).join("\n");
      const install = steps.indexOf("npm ci\n          test -f dist/drift/explore.js");
      expect(install, name).toBeGreaterThan(-1);
      expect(install, name).toBeLessThan(steps.indexOf("node scripts/drift-watch.mjs"));
    }
  });

  it("runs every job on Node 22, which the watched lines and rn-xtool's own dependencies need", () => {
    // react-native 0.87/0.88, expo 58 and create-expo 5 declare ^22.13.0 || ^24.3.0 || ...; Node 20 is end of life.
    const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as { engines: { node: string } };
    const floor = Number(/\d+/.exec(pkg.engines.node)![0]);
    for (const name of ["targets", "check", "report", "explore", "explore-summary"]) {
      const steps = job(name).join("\n");
      expect(steps, name).toMatch(/uses: actions\/setup-node@v4\n\s*with:\n(\s*\S.*\n)*?\s*node-version: 22\n/);
    }
    const versions = [...text().matchAll(/node-version:\s*(\S+)/g)].map((m) => m[1]);
    expect(versions).toEqual(["22", "22", "22", "22", "22"]);
    expect(22).toBeGreaterThanOrEqual(floor);
  });

  it("does not persist the checkout token", () => {
    const checkouts = text().match(/uses: actions\/checkout@v4/g) ?? [];
    expect(checkouts).toHaveLength(5);
    expect(text().match(/persist-credentials: false/g)).toHaveLength(5);
  });
});
