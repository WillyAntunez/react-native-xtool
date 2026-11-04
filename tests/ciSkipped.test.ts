import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../src/tools/exec.js";
import { setupFailedTests, skippedSummary, skippedTests } from "../scripts/ci-skipped.mjs";
import { mkTmp } from "./support/expoSpm.js";
import { tool } from "./support/tools.js";

const ROOT = "/repo";
const assertion = (status: string, ancestorTitles: string[], title: string) => ({
  ancestorTitles,
  fullName: [...ancestorTitles, title].join(" "),
  status,
  title,
  failureMessages: [],
});
/** A vitest JSON report: files out of order, one passed, two skipped and one todo test. */
const REPORT = {
  numTotalTests: 4,
  success: true,
  testResults: [
    {
      name: `${ROOT}/tests/zeta.test.ts`,
      status: "passed",
      assertionResults: [assertion("skipped", [], "needs a real iPhone")],
    },
    {
      name: `${ROOT}/tests/alpha.test.ts`,
      status: "passed",
      assertionResults: [
        assertion("passed", ["block"], "runs here"),
        assertion("todo", ["block", "inner"], "is not written yet"),
        assertion("skipped", ["block"], "needs ../app"),
      ],
    },
  ],
};
const NAMES = [
  "tests/alpha.test.ts › block › inner › is not written yet",
  "tests/alpha.test.ts › block › needs ../app",
  "tests/zeta.test.ts › needs a real iPhone",
];

describe("skippedTests", () => {
  it("lists skipped tests by name", () => {
    expect(skippedTests(REPORT, ROOT)).toEqual(NAMES);
  });

  it("counts pending tests as skipped and ignores failed ones", () => {
    const report = {
      testResults: [
        {
          name: `${ROOT}/tests/a.test.ts`,
          assertionResults: [assertion("pending", ["d"], "waits"), assertion("failed", ["d"], "broke")],
        },
      ],
    };
    expect(skippedTests(report, ROOT)).toEqual(["tests/a.test.ts › d › waits"]);
  });
});

/**
 * A red run, shaped like vitest 5's JSON for a probe file: a describe whose beforeAll throws marks its tests "skipped",
 * exactly like a gated skip, and the report records neither the suite error nor the test's mode.
 */
const FAILED_REPORT = {
  numFailedTestSuites: 2,
  numFailedTests: 0,
  success: false,
  testResults: [
    {
      name: `${ROOT}/tests/q.test.ts`,
      status: "passed",
      message: "",
      assertionResults: [assertion("skipped", [], "other file skip (needs w)")],
    },
    {
      name: `${ROOT}/tests/p.test.ts`,
      status: "failed",
      message: "",
      assertionResults: [
        assertion("skipped", ["gated (needs x)"], "a"),
        assertion("skipped", [], "plain skip (needs y)"),
        assertion("todo", [], "later"),
        assertion("passed", [], "passes"),
        assertion("skipped", ["broken setup"], "t1"),
        assertion("skipped", ["broken setup"], "t2 genuinely skipped (needs z)"),
        assertion("skipped", ["broken setup", "inner"], "t3"),
        assertion("pending", ["broken setup"], "t4 (runs only with X=1)"),
      ],
    },
  ],
};

describe("a failed run", () => {
  it("lists the tests of a block whose setup failed apart from the skips", () => {
    expect(setupFailedTests(FAILED_REPORT, ROOT)).toEqual(["tests/p.test.ts › broken setup › t1", "tests/p.test.ts › broken setup › inner › t3"]);
    expect(skippedTests(FAILED_REPORT, ROOT)).toEqual([
      "tests/p.test.ts › gated (needs x) › a",
      "tests/p.test.ts › plain skip (needs y)",
      "tests/p.test.ts › later",
      "tests/p.test.ts › broken setup › t2 genuinely skipped (needs z)",
      "tests/p.test.ts › broken setup › t4 (runs only with X=1)",
      "tests/q.test.ts › other file skip (needs w)",
    ]);
  });

  it("treats every skip of a passing file as a skip, whatever its title", () => {
    expect(setupFailedTests(REPORT, ROOT)).toEqual([]);
  });

  it("opens the summary by saying the run failed", () => {
    expect(skippedSummary(["tests/b.test.ts › needs x"], { setupFailed: ["tests/a.test.ts › block › t1"] })).toBe(
      "### Skipped tests\n\n**The run failed**; see the test log for its errors.\n\n" +
        "#### Did not run: setup failed (1)\n\nTheir block's setup (a `beforeAll`) failed; the test log has the error.\n\n" +
        "- `tests/a.test.ts › block › t1`\n\n" +
        "#### Skipped (1)\n\nThese did not run here; each title says what it needs.\n\n" +
        "- `tests/b.test.ts › needs x`\n",
    );
    expect(skippedSummary([], { setupFailed: [] })).toBe(
      "### Skipped tests\n\n**The run failed**; see the test log for its errors.\n",
    );
  });
});

describe("skippedSummary", () => {
  it("lists each name", () => {
    expect(skippedSummary(NAMES)).toBe(
      "### Skipped tests (3)\n\nThese did not run here; each title says what it needs.\n\n" +
        "- `tests/alpha.test.ts › block › inner › is not written yet`\n" +
        "- `tests/alpha.test.ts › block › needs ../app`\n" +
        "- `tests/zeta.test.ts › needs a real iPhone`\n",
    );
  });

  it("says when every test ran", () => {
    expect(skippedSummary([])).toBe("### Skipped tests\n\nNone: every test ran.\n");
  });

  it("says when there is no report", () => {
    expect(skippedSummary(undefined)).toBe("### Skipped tests\n\nNo test report: the test step did not finish.\n");
  });
});

describe("node scripts/ci-skipped.mjs", () => {
  const SCRIPT = path.join(packageRoot(), "scripts", "ci-skipped.mjs");
  const run = (args: string[], cwd: string) => tool(process.execPath, [SCRIPT, ...args], { cwd });

  it("prints the summary of a report, with paths relative to the working folder", () => {
    const dir = mkTmp("ci-skipped-");
    const report = path.join(dir, "report.json");
    const relocated = JSON.parse(JSON.stringify(REPORT).split(ROOT).join(dir)) as typeof REPORT;
    writeFileSync(report, JSON.stringify(relocated));
    const r = run([report], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(skippedSummary(NAMES));
  });

  it("says a failed run failed", () => {
    const dir = mkTmp("ci-skipped-failed-");
    const report = path.join(dir, "report.json");
    writeFileSync(report, JSON.stringify(FAILED_REPORT).split(ROOT).join(dir));
    const r = run([report], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      skippedSummary(skippedTests(FAILED_REPORT, ROOT), { setupFailed: setupFailedTests(FAILED_REPORT, ROOT) }),
    );
    expect(r.stdout).toContain("**The run failed**");
  });

  it("says there is no report when the file is missing or unreadable, and still exits 0", () => {
    const dir = mkTmp("ci-skipped-missing-");
    const missing = run([path.join(dir, "absent.json")], dir);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe(skippedSummary(undefined));
    writeFileSync(path.join(dir, "half.json"), '{"testResults": [');
    expect(run([path.join(dir, "half.json")], dir).stdout).toBe(skippedSummary(undefined));
  });
});
