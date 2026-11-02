#!/usr/bin/env node
// Lists the tests a CI run skipped, from vitest's JSON report, for the job summary. Not shipped in the npm package.
//   node scripts/ci-skipped.mjs <report.json> → prints the Markdown summary; exits 0, even without a report
// Run it from the repo root: the names are relative to the working folder.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIPPED = new Set(["skipped", "pending", "todo"]);
/** How a deliberately skipped test says what it needs (the repo's title convention). */
const SAYS_WHAT_IT_NEEDS = /\((needs|runs only) /;

/**
 * Every assertion of the report that did not run (skipped, pending or todo), as `tests/x.test.ts › describe › title`,
 * with `setupFailed` set when it is likely under a failed `beforeAll`. Vitest's JSON gives those tests the status
 * "skipped", as it does a gated skip, and records neither the suite error nor the test's mode: in a file that failed,
 * a skipped or pending test whose name does not say what it needs counts as one whose setup failed. Files are sorted by
 * their path relative to `root`, each file's tests kept in report order.
 */
function notRun(report, root) {
  const files = (report?.testResults ?? [])
    .map((file) => ({
      rel: path.relative(root, file.name).split(path.sep).join("/"),
      failed: file.status === "failed",
      tests: file.assertionResults ?? [],
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files.flatMap(({ rel, failed, tests }) =>
    tests
      .filter((t) => SKIPPED.has(t.status))
      .map((t) => {
        const name = [rel, ...(t.ancestorTitles ?? []), t.title].join(" › ");
        return { name, setupFailed: failed && t.status !== "todo" && !SAYS_WHAT_IT_NEEDS.test(name) };
      }),
  );
}

/** The tests that did not run because they were skipped (each title says what it needs), or are todo. */
export function skippedTests(report, root) {
  return notRun(report, root)
    .filter((t) => !t.setupFailed)
    .map((t) => t.name);
}

/** The tests that did not run because the setup of their block failed, in a file that failed. */
export function setupFailedTests(report, root) {
  return notRun(report, root)
    .filter((t) => t.setupFailed)
    .map((t) => t.name);
}

/** Whether the report is of a run that failed. */
export function runFailed(report) {
  return report?.success === false || (report?.numFailedTestSuites ?? 0) > 0 || (report?.numFailedTests ?? 0) > 0;
}

const list = (names) => names.map((n) => `- \`${n}\`\n`).join("");

/**
 * The job-summary section for those names; `undefined` when the test step left no report. `failed` is given for a run
 * that failed, with the tests whose setup failed: the summary then opens by saying so and lists those apart.
 */
export function skippedSummary(names, failed) {
  if (names === undefined) return "### Skipped tests\n\nNo test report: the test step did not finish.\n";
  if (failed) {
    const parts = ["### Skipped tests\n\n**The run failed**; see the test log for its errors.\n"];
    if (failed.setupFailed.length > 0) {
      parts.push(
        `#### Did not run: setup failed (${failed.setupFailed.length})\n\n` +
          "Their block's setup (a `beforeAll`) failed; the test log has the error.\n\n" +
          list(failed.setupFailed),
      );
    }
    if (names.length > 0) {
      parts.push(`#### Skipped (${names.length})\n\nThese did not run here; each title says what it needs.\n\n${list(names)}`);
    }
    return parts.join("\n");
  }
  if (names.length === 0) return "### Skipped tests\n\nNone: every test ran.\n";
  return `### Skipped tests (${names.length})\n\nThese did not run here; each title says what it needs.\n\n${list(names)}`;
}

const self = fileURLToPath(import.meta.url);
const isMain = () => {
  try {
    return realpathSync(path.resolve(process.argv[1] ?? "")) === realpathSync(self);
  } catch {
    return false;
  }
};
if (isMain()) {
  let report;
  try {
    report = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
  } catch {
    report = undefined;
  }
  const root = process.cwd();
  const names = report === undefined ? undefined : skippedTests(report, root);
  const failed = report !== undefined && runFailed(report) ? { setupFailed: setupFailedTests(report, root) } : undefined;
  process.stdout.write(skippedSummary(names, failed));
}
