#!/usr/bin/env node
// The drift watch's entry point for .github/workflows/drift-watch.yml. Not shipped in the npm package.
//   targets <daily|explore>                                    → prints matrix=<json> for $GITHUB_OUTPUT
//   check --target <json> --dir <dir> --out <file> [--existing] → writes the target's result; exits 0, red or not
//   report --results <dir> --targets <matrix json> [--drill <id>] [--dry-run]
//                                                              → keeps one `drift` issue per broken line (needs gh);
//                                                                exits 1 when a target could not run or gh failed
//   explore --target <json> --dir <dir> --out <file> [--existing]
//                                                              → writes the target's capability row; exits 0
//   explore-summary --results <dir> --targets <matrix json>    → writes the exploration table to the summary; exits 0
// Needs `npm run build` first: it imports the compiled modules from dist/.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkTarget, spawnRun } from "../dist/drift/check.js";
import {
  applyDrill,
  checkDrill,
  commandRunner,
  groupByLine,
  readResults,
  resultsFor,
  runReport,
  summaryMarkdown,
} from "../dist/drift/issues.js";
import { exploreRowsFor, exploreTable, exploreTarget, readExploreRows } from "../dist/drift/explore.js";
import { exploreTargets, watchTargets } from "../dist/drift/targets.js";

const CLI = fileURLToPath(new URL("../bin/rn-xtool.js", import.meta.url));
const USAGE = [
  "usage: drift-watch.mjs targets <daily|explore>",
  "       drift-watch.mjs check --target <json> --dir <dir> --out <file> [--existing]",
  "       drift-watch.mjs report --results <dir> --targets <matrix json> [--drill <id>] [--dry-run]",
  "       drift-watch.mjs explore --target <json> --dir <dir> --out <file> [--existing]",
  "       drift-watch.mjs explore-summary --results <dir> --targets <matrix json>",
].join("\n");

function fail(message) {
  console.error(message);
  process.exit(2);
}

/**
 * `npm view react-native versions --json`, with one retry; undefined (after printing why) when both attempts fail.
 * The output carries stderr too, so the JSON array is cut out of it: an npm notice or warning must not break the parse.
 */
async function reactNativeVersions() {
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await spawnRun("npm", ["view", "react-native", "versions", "--json"], process.cwd());
    if (r.exitCode === 0) {
      try {
        const versions = JSON.parse(r.output.slice(r.output.indexOf("["), r.output.lastIndexOf("]") + 1));
        if (Array.isArray(versions)) return versions;
        last = `unexpected answer: ${r.output.slice(0, 200)}`;
      } catch (e) {
        last = `unreadable answer: ${e.message}`;
      }
    } else {
      last = r.output;
    }
  }
  console.error(`drift-watch: npm view react-native versions failed twice\n${last}`);
  return undefined;
}

/** The parsed options of `check` and `explore`, which take the same ones. */
function targetOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        target: { type: "string" },
        dir: { type: "string" },
        out: { type: "string" },
        existing: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  if (values.target === undefined || values.dir === undefined || values.out === undefined) fail(USAGE);
  return values;
}

/** The targets of a matrix "targets" printed (`{"include":[{"target":…}]}`); exits 2 when it is not one. */
function matrixTargets(json) {
  try {
    const targets = JSON.parse(json).include.map((e) => e.target);
    if (!targets.every((t) => typeof t?.id === "string" && typeof t.line === "string")) throw new Error("bad target");
    return targets;
  } catch (e) {
    fail(`--targets is not the matrix "targets" prints: ${e.message}`);
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const [sub, ...rest] = process.argv.slice(2);
switch (sub) {
  case "targets": {
    if (!["daily", "explore"].includes(rest[0]) || rest.length !== 1) fail(USAGE);
    const versions = await reactNativeVersions();
    if (versions === undefined && rest[0] === "daily") {
      console.error("drift-watch: the watch could not run");
      process.exit(1);
    }
    // The exploration is report only (failure row 10): without the list, its bare rows read "could not create".
    const targets = rest[0] === "daily" ? watchTargets(versions) : exploreTargets(versions ?? []);
    console.log(`matrix=${JSON.stringify({ include: targets.map((t) => ({ target: t, slug: t.slug })) })}`);
    break;
  }
  case "check": {
    const values = targetOptions(rest);
    const target = JSON.parse(values.target);
    const result = await checkTarget(target, path.resolve(values.dir), {
      run: spawnRun,
      cli: CLI,
      existing: values.existing,
    });
    await writeJson(values.out, result);
    console.log(`${target.id}: ${result.status}`);
    for (const s of result.steps) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.step}`);
    break;
  }
  case "report": {
    let values;
    try {
      ({ values } = parseArgs({
        args: rest,
        options: {
          results: { type: "string" },
          targets: { type: "string" },
          drill: { type: "string", default: "" },
          "dry-run": { type: "boolean", default: false },
        },
      }));
    } catch (e) {
      fail(`${e.message}\n${USAGE}`);
    }
    if (values.results === undefined || values.targets === undefined) fail(USAGE);
    try {
      checkDrill(values.drill);
    } catch (e) {
      fail(e.message);
    }
    const targets = matrixTargets(values.targets);
    const { results, errors } = await readResults(path.resolve(values.results));
    for (const e of errors) console.error(`drift-watch: ${e}`);
    let lines;
    try {
      lines = applyDrill(groupByLine(resultsFor(targets, results)), values.drill);
    } catch (e) {
      fail(e.message);
    }
    const env = process.env;
    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : "(not run in GitHub Actions)";
    const ctx = { runUrl, date: new Date().toISOString().slice(0, 10) };
    const code = await runReport(lines, ctx, { dryRun: values["dry-run"] }, {
      gh: commandRunner("gh"),
      log: (l) => console.log(l),
      error: (l) => console.error(`drift-watch: ${l}`),
    });
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summaryMarkdown(lines));
    process.exitCode = errors.length > 0 ? 1 : code;
    break;
  }
  case "explore": {
    const values = targetOptions(rest);
    const target = JSON.parse(values.target);
    const row = await exploreTarget(target, path.resolve(values.dir), { run: spawnRun, existing: values.existing });
    await writeJson(values.out, row);
    console.log(exploreTable([row]));
    break;
  }
  case "explore-summary": {
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: { results: { type: "string" }, targets: { type: "string" } } }));
    } catch (e) {
      fail(`${e.message}\n${USAGE}`);
    }
    if (values.results === undefined || values.targets === undefined) fail(USAGE);
    const targets = matrixTargets(values.targets);
    const { rows, errors } = await readExploreRows(path.resolve(values.results));
    for (const e of errors) console.error(`drift-watch: ${e}`);
    const summary = `## Older lines (exploration, report only)\n\n${exploreTable(exploreRowsFor(targets, rows))}`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    break;
  }
  default:
    fail(USAGE);
}
