import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mkTmp } from "../support/expoSpm.js";
import { tool } from "../support/tools.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(root, ".github", "workflows", "ci.yml");

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = { "runs-on"?: string; "timeout-minutes"?: number; permissions?: unknown; steps: Step[] };
type Workflow = {
  on: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: unknown;
  jobs: Record<string, Job>;
};

const text = (): string => readFileSync(WORKFLOW, "utf8");
const doc = (): Workflow => parse(text()) as Workflow;
const steps = (): Step[] => Object.values(doc().jobs).flatMap((j) => j.steps);
const jobSteps = (job: string): Step[] => doc().jobs[job]!.steps;
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

/** The text of every `run:` step: the line itself and, for a block scalar, the lines below it. */
function runBlocks(): string[] {
  const all = lines();
  return all.flatMap((l, i) => (/^\s*(- )?run:/.test(l) ? [[l, ...block(all, i)].join("\n")] : []));
}

const RUNS = [
  "npm ci",
  "node scripts/fetch-test-tarballs.mjs",
  "npm run lint",
  // The scan runs before the tests, so a red suite never hides a leak.
  "npm run scan:private",
  // The podspec shim's tests fail without Ruby on CI: the step says which Ruby they ran on.
  "ruby --version",
  "npm test -- --reporter=default --reporter=json --outputFile=test-results.json",
  'node scripts/ci-skipped.mjs test-results.json >> "$GITHUB_STEP_SUMMARY"',
];
/** The shim-ruby-floor job: the podspec shim's tests on the oldest Ruby the shim supports. */
const FLOOR_RUNS = ["npm ci", "npx vitest run tests/podspecShim.test.ts"];
const SHIM = path.join(root, "vendor", "rn-spm", "spm", "read-podspec-shim.rb");

describe("CI workflow", () => {
  it("runs on PRs to main and on pushes to main", () => {
    const on = doc().on;
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect(on["pull_request"]).toEqual({ branches: ["main"] });
    expect(on["push"]).toEqual({ branches: ["main"] });
    expect(text()).not.toMatch(/schedule|pull_request_target|workflow_run|workflow_dispatch/);
  });

  it("reads the repository only", () => {
    expect(doc().permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(doc().jobs)) expect(job.permissions, name).toBeUndefined();
    expect(text().match(/permissions:/g)).toHaveLength(1);
  });

  it("keeps credentials and secrets out", () => {
    const checkouts = steps().filter((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkouts).toHaveLength(2);
    for (const c of checkouts) expect(c.with?.["persist-credentials"]).toBe(false);
    expect(text().match(/persist-credentials: false/g)).toHaveLength(2);
    expect(text()).not.toMatch(/secrets\./);
    expect(text()).not.toContain("GH_TOKEN");
    expect(text()).not.toMatch(/\btoken\b/i);
  });

  it("never puts an expression into run text", () => {
    const runs = runBlocks();
    expect(runs).toHaveLength(RUNS.length + FLOOR_RUNS.length);
    for (const r of runs) expect(r).not.toContain("${{");
    for (const s of steps()) if (s.run !== undefined) expect(s.run).not.toContain("${{");
  });

  it("uses Node 22 on hosted Ubuntu, and setup-ruby only for the Ruby floor", () => {
    const uses = (job: string) => jobSteps(job).flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses("test")).toEqual(["actions/checkout@v7", "actions/setup-node@v7"]);
    expect(uses("shim-ruby-floor")).toEqual(["actions/checkout@v7", "actions/setup-node@v7", "ruby/setup-ruby@v1"]);
    for (const node of steps().filter((s) => s.uses === "actions/setup-node@v7")) {
      expect(node.with?.["node-version"]).toBe(22);
      expect(node.with?.["cache"]).toBe("npm");
    }
    const runsOn = Object.values(doc().jobs).map((j) => j["runs-on"]);
    expect(runsOn).toEqual(["ubuntu-latest", "ubuntu-22.04"]);
  });

  it("runs the shim's tests on the Ruby floor the shim reports", () => {
    const ruby = jobSteps("shim-ruby-floor").find((s) => s.uses === "ruby/setup-ruby@v1")!;
    const floor = /^RN_XTOOL_RUBY_FLOOR = '(\d+\.\d+)\.\d+'$/m.exec(readFileSync(SHIM, "utf8"))?.[1];
    expect(ruby.with?.["ruby-version"]).toBe(floor);
  });

  it("stops a stuck job after 15 minutes", () => {
    // The fetch script's npm pack has no timeout of its own; the job's covers it.
    expect(Object.keys(doc().jobs)).toEqual(["test", "shim-ruby-floor"]);
    for (const job of Object.values(doc().jobs)) expect(job["timeout-minutes"]).toBe(15);
  });

  it("cancels the older run of the same PR, never a run on main", () => {
    // On main, two quick merges share ci-refs/heads/main: cancelling would leave the first merge without a result.
    expect(doc().concurrency).toEqual({
      group: "ci-${{ github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
  });

  it("lets no failing step or job pass", () => {
    const jobs = Object.values(doc().jobs) as (Job & { "continue-on-error"?: unknown })[];
    for (const job of jobs) expect(job["continue-on-error"]).toBeUndefined();
    for (const step of steps() as (Step & { "continue-on-error"?: unknown })[]) {
      expect(step["continue-on-error"], step.name ?? step.uses).toBeUndefined();
    }
    expect(text()).not.toMatch(/continue-on-error/);
  });

  it("runs the steps in order", () => {
    const runs = (job: string) => jobSteps(job).flatMap((s) => (s.run !== undefined ? [s.run.trim()] : []));
    expect(runs("test")).toEqual(RUNS);
    expect(runs("shim-ruby-floor")).toEqual(FLOOR_RUNS);
    for (const job of Object.keys(doc().jobs)) {
      const all = jobSteps(job);
      expect(all.findIndex((s) => s.uses?.startsWith("actions/checkout")), job).toBe(0);
      expect(all.findIndex((s) => s.uses?.startsWith("actions/setup-node")), job).toBe(1);
    }
  });

  it("lists the skipped tests in the summary, even when the tests fail", () => {
    const skipped = steps().find((s) => s.run?.includes("scripts/ci-skipped.mjs"))!;
    expect(skipped.name).toBe("List skipped tests");
    expect(skipped.if).toBe("${{ !cancelled() }}");
    expect(skipped.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
    const ignored = readFileSync(path.join(root, ".gitignore"), "utf8").split("\n");
    expect(ignored).toContain("test-results.json");
  });

  it("says what it runs and where the skipped tests are listed", () => {
    const header = lines().filter((l, i) => i < lines().findIndex((x) => x.startsWith("name:")));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header) if (l.trim() !== "") expect(l).toMatch(/^#/);
    const said = header.join("\n");
    expect(said).toMatch(/skipped/);
    expect(said).toMatch(/summary/);
    expect(said).toMatch(/\.scan-private\.local/);
  });

  it("never compiles or touches a device", () => {
    expect(text()).not.toMatch(/setup-swift|swiftly|rn-xtool setup|RN_XTOOL_E2E/);
  });
});

describe("the private scan in CI (no .scan-private.local)", () => {
  /** A git repo holding the scan script and one tracked file, with no local patterns file. */
  function repo(content: string): string {
    const dir = mkTmp("ci-scan-");
    mkdirSync(path.join(dir, "scripts"));
    copyFileSync(path.join(root, "scripts", "scan-private.sh"), path.join(dir, "scripts", "scan-private.sh"));
    writeFileSync(path.join(dir, "notes.txt"), content);
    expect(tool("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
    expect(tool("git", ["add", "."], { cwd: dir }).status).toBe(0);
    return dir;
  }

  it("passes with the generic patterns only", () => {
    const r = tool("bash", ["scripts/scan-private.sh"], { cwd: repo("nothing private here\n") });
    expect(r.stdout).toContain("generic patterns only");
    expect(r.stdout).toContain("scan-private: clean");
    expect(r.status, r.stderr).toBe(0);
  });

  it("still fails on a generic pattern", () => {
    const home = ["", "home", "someone", "app"].join("/");
    const r = tool("bash", ["scripts/scan-private.sh"], { cwd: repo(`built in ${home}\n`) });
    expect(r.stdout).toContain("generic patterns only");
    expect(r.stderr).toContain("private identifiers found");
    expect(r.status).toBe(1);
  });
});
