#!/usr/bin/env node
// The drift watch's entry point for .github/workflows/drift-watch.yml. Not shipped in the npm package.
//   targets <daily>                                            → prints matrix=<json> for $GITHUB_OUTPUT
//   check --target <json> --dir <dir> --out <file> [--existing] → writes the target's result; exits 0, red or not
//   report --results <dir> --targets <matrix json> [--drill <id>] [--dry-run]
//                                                              → keeps one `drift` issue per broken line (needs gh);
//                                                                exits 1 when a target could not run or gh failed
// Needs `npm run build` first: it imports the compiled modules from dist/.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkTarget, spawnRun } from "../dist/drift/check.js";
import {
  applyDrill,
  commandRunner,
  groupByLine,
  readResults,
  resultsFor,
  runReport,
  summaryMarkdown,
} from "../dist/drift/issues.js";
import { watchTargets } from "../dist/drift/targets.js";

const CLI = fileURLToPath(new URL("../bin/rn-xtool.js", import.meta.url));
const USAGE = [
  "usage: drift-watch.mjs targets daily",
  "       drift-watch.mjs check --target <json> --dir <dir> --out <file> [--existing]",
  "       drift-watch.mjs report --results <dir> --targets <matrix json> [--drill <id>] [--dry-run]",
].join("\n");

function fail(message) {
  console.error(message);
  process.exit(2);
}

/**
 * `npm view react-native versions --json`, with one retry; exits 1 when both attempts fail (the watch could not run).
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
  console.error(`drift-watch: npm view react-native versions failed twice; the watch could not run\n${last}`);
  process.exit(1);
}

const [sub, ...rest] = process.argv.slice(2);
switch (sub) {
  case "targets": {
    if (rest[0] !== "daily" || rest.length !== 1) fail(USAGE);
    const targets = watchTargets(await reactNativeVersions());
    console.log(`matrix=${JSON.stringify({ include: targets.map((t) => ({ target: t, slug: t.slug })) })}`);
    break;
  }
  case "check": {
    let values;
    try {
      ({ values } = parseArgs({
        args: rest,
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
    const target = JSON.parse(values.target);
    const result = await checkTarget(target, path.resolve(values.dir), {
      run: spawnRun,
      cli: CLI,
      existing: values.existing,
    });
    await mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
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
    let targets;
    try {
      targets = JSON.parse(values.targets).include.map((e) => e.target);
      if (!targets.every((t) => typeof t?.id === "string" && typeof t.line === "string")) throw new Error("bad target");
    } catch (e) {
      fail(`--targets is not the matrix "targets daily" prints: ${e.message}`);
    }
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
  default:
    fail(USAGE);
}
