#!/usr/bin/env node
// The drift watch's entry point for .github/workflows/drift-watch.yml. Not shipped in the npm package.
//   targets <daily>                                            → prints matrix=<json> for $GITHUB_OUTPUT
//   check --target <json> --dir <dir> --out <file> [--existing] → writes the target's result; exits 0, red or not
// Needs `npm run build` first: it imports the compiled modules from dist/.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkTarget, spawnRun } from "../dist/drift/check.js";
import { watchTargets } from "../dist/drift/targets.js";

const CLI = fileURLToPath(new URL("../bin/rn-xtool.js", import.meta.url));
const USAGE = [
  "usage: drift-watch.mjs targets daily",
  "       drift-watch.mjs check --target <json> --dir <dir> --out <file> [--existing]",
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
  default:
    fail(USAGE);
}
