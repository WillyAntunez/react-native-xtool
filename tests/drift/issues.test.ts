import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { StepResult, TargetResult } from "../../src/drift/check.js";
import {
  applyDrill,
  commandRunner,
  type Gh,
  groupByLine,
  type IssueAction,
  issueBody,
  type LineResult,
  planIssueActions,
  readResults,
  reportExitCode,
  resultsFor,
  runReport,
  summaryMarkdown,
} from "../../src/drift/issues.js";
import type { WatchTarget } from "../../src/drift/targets.js";

const CTX = { runUrl: "https://github.com/o/r/actions/runs/1", date: "2026-10-30" };
const LIMIT =
  "The drift watch checks the project gates (G1–G3), the bundled patches (patch -F0 --dry-run) and the portable library manifests. It does not compile or run the app: a green line can still fail G4 or the build. The compat-suite CI closes that gap.";

const EXPO57: WatchTarget = {
  id: "expo-57/blank-typescript",
  slug: "expo-57-blank-typescript",
  line: "expo-57",
  title: "Drift: Expo SDK 57",
  kind: "expo",
  sdk: 57,
  template: "blank-typescript",
  createExpo: "5.1.5",
};
const EXPO58_BLANK: WatchTarget = {
  ...EXPO57,
  id: "expo-58/blank-typescript",
  slug: "expo-58-blank-typescript",
  line: "expo-58",
  title: "Drift: Expo SDK 58",
  sdk: 58,
};
const EXPO58_DEFAULT: WatchTarget = {
  ...EXPO58_BLANK,
  id: "expo-58/default",
  slug: "expo-58-default",
  template: "default",
};
function bare(minor: string, version: string): WatchTarget {
  return {
    id: `bare-${minor}`,
    slug: `bare-${minor}`,
    line: `bare-${minor}`,
    title: `Drift: React Native ${minor} (bare)`,
    kind: "bare",
    minor,
    version,
    cli: "20.2.0",
  };
}
const BARE086 = bare("0.86", "0.86.3");
const BARE087 = bare("0.87", "0.87.1");
const BARE088 = bare("0.88", "0.88.2");
const ALL = [EXPO57, EXPO58_BLANK, EXPO58_DEFAULT, BARE086, BARE087, BARE088];

const OK_STEPS: StepResult[] = [
  { step: "create", ok: true, output: "created" },
  { step: "gates", ok: true, output: "doctor ok" },
  { step: "patches", ok: true, output: "react-native+0.88.1.patch: ok" },
  { step: "manifests", ok: true, output: "react-native-worklets: not installed" },
];

function result(target: WatchTarget, status: TargetResult["status"], steps: StepResult[] = OK_STEPS): TargetResult {
  return { target, status, versions: { "react-native": target.version ?? "0.88.1" }, steps };
}
const green = (t: WatchTarget) => result(t, "green");
function red(t: WatchTarget, output = "patch failed"): TargetResult {
  return result(t, "red", [
    ...OK_STEPS.slice(0, 2),
    { step: "patches", ok: false, output },
    OK_STEPS[3]!,
  ]);
}
const unknown = (t: WatchTarget) =>
  result(t, "unknown", [{ step: "create", ok: false, output: "npm error code ECONNRESET" }]);

/** Every line green except the given results' lines. */
function linesWith(...over: TargetResult[]): LineResult[] {
  return groupByLine(ALL.map((t) => over.find((r) => r.target.id === t.id) ?? green(t)));
}

describe("lines", () => {
  it("rolls targets up into lines", () => {
    const status = (rs: TargetResult[]) => groupByLine(rs).map((l) => [l.line, l.status]);
    expect(status([red(EXPO58_BLANK), green(EXPO58_DEFAULT)])).toEqual([["expo-58", "red"]]);
    expect(status([unknown(EXPO58_BLANK), green(EXPO58_DEFAULT)])).toEqual([["expo-58", "unknown"]]);
    expect(status([green(EXPO58_BLANK), green(EXPO58_DEFAULT)])).toEqual([["expo-58", "green"]]);
    expect(status([unknown(EXPO58_BLANK), red(EXPO58_DEFAULT)])).toEqual([["expo-58", "red"]]);
    const [line] = groupByLine([green(EXPO58_BLANK), green(EXPO58_DEFAULT)]);
    expect(line!.title).toBe("Drift: Expo SDK 58");
    expect(line!.targets.map((t) => t.target.id)).toEqual(["expo-58/blank-typescript", "expo-58/default"]);
    expect(groupByLine(ALL.map(green)).map((l) => l.line)).toEqual([
      "expo-57",
      "expo-58",
      "bare-0.86",
      "bare-0.87",
      "bare-0.88",
    ]);
  });

  it("a target without a result could not run", () => {
    const rs = resultsFor([EXPO58_BLANK, EXPO58_DEFAULT], [green(EXPO58_BLANK)]);
    expect(rs[0]).toEqual(green(EXPO58_BLANK));
    expect(rs[1]).toEqual({
      target: EXPO58_DEFAULT,
      status: "unknown",
      versions: {},
      steps: [{ step: "create", ok: false, output: "no result: the check job did not finish" }],
    });
    expect(groupByLine(rs)[0]!.status).toBe("unknown");
  });

  it("drills a line red", () => {
    const lines = linesWith();
    const drilled = applyDrill(lines, "bare-0.88");
    const line = drilled.find((l) => l.line === "bare-0.88")!;
    expect(line.status).toBe("red");
    for (const t of line.targets) {
      expect(t.steps.at(-1)).toEqual({
        step: "drill",
        ok: false,
        output: "forced red by the workflow_dispatch input drill",
      });
    }
    expect(drilled.filter((l) => l.line !== "bare-0.88").every((l) => l.status === "green")).toBe(true);
    expect(lines.find((l) => l.line === "bare-0.88")!.status).toBe("green");
    expect(applyDrill(lines, "")).toEqual(lines);
    expect(() => applyDrill(lines, "x")).toThrow(
      'unknown drift line "x"; lines: expo-57, expo-58, bare-0.86, bare-0.87, bare-0.88',
    );
  });
});

describe("planIssueActions", () => {
  it("opens an issue for a newly broken line", () => {
    const actions = planIssueActions(linesWith(red(BARE088)), [], CTX);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "create", title: "Drift: React Native 0.88 (bare)" });
    expect((actions[0] as { body: string }).body).toBe(issueBody(linesWith(red(BARE088))[4]!, CTX));
  });

  it("updates the open issue instead of opening another", () => {
    const open = [
      { number: 12, title: "Drift: React Native 0.88 (bare)" },
      { number: 7, title: "Drift: React Native 0.88 (bare)" },
    ];
    const lines = linesWith(red(BARE088));
    expect(planIssueActions(lines, open, CTX)).toEqual([
      { type: "update", number: 7, body: issueBody(lines[4]!, CTX) },
    ]);
  });

  it("keeps the first-broken date and comments when the cause changes", () => {
    const before = issueBody(linesWith(red(BARE088, "Hunk #1 FAILED at 12."))[4]!, { ...CTX, date: "2026-10-28" });
    const open = [{ number: 7, title: "Drift: React Native 0.88 (bare)", body: before }];
    const lines = linesWith(red(BARE088, "expo+58.0.21.patch: Hunk #1 FAILED at 12."));
    const [action] = planIssueActions(lines, open, CTX);
    expect(action).toEqual({
      type: "update",
      number: 7,
      body: issueBody(lines[4]!, CTX, "2026-10-28"),
      comment: [
        "The cause changed on 2026-10-30. Failing now:",
        "",
        "```\nbare-0.88 patches: expo+58.0.21.patch: Hunk #1 FAILED at 12.\n```",
        "",
        "Last run: https://github.com/o/r/actions/runs/1",
      ].join("\n"),
    });
    expect((action as { body: string }).body).toMatch(/^rn-xtool's drift watch found this line broken on 2026-10-28\./);
  });

  it("comments when another step or target starts failing", () => {
    const before = issueBody(linesWith(red(EXPO58_BLANK))[1]!, { ...CTX, date: "2026-10-28" });
    const open = [{ number: 7, title: "Drift: Expo SDK 58", body: before }];
    const [action] = planIssueActions(linesWith(red(EXPO58_BLANK), red(EXPO58_DEFAULT)), open, CTX);
    expect((action as { comment?: string }).comment).toContain(
      "expo-58/blank-typescript patches: patch failed\nexpo-58/default patches: patch failed",
    );
  });

  it("updates without a comment while the cause stays the same", () => {
    const out = (t: string) => `npm error code ERESOLVE\nnpm error A complete log: /r/.npm/_logs/${t}-debug-0.log\ndone in 41s`;
    const before = issueBody(linesWith(red(BARE088, out("2026-10-28T05_23_11_123Z")))[4]!, {
      runUrl: "https://github.com/o/r/actions/runs/0",
      date: "2026-10-28",
    });
    const open = [{ number: 7, title: "Drift: React Native 0.88 (bare)", body: before }];
    const lines = linesWith(red(BARE088, out("2026-10-30T05_24_09_987Z").replace("41s", "38.5s")));
    expect(planIssueActions(lines, open, CTX)).toEqual([
      { type: "update", number: 7, body: issueBody(lines[4]!, CTX, "2026-10-28") },
    ]);
  });

  type NpmRun = { code: string; added: number; tmp: string; time: string; took: string; extra?: string; after?: string[] };
  const npm = (o: NpmRun) =>
    [
      `added ${o.added} packages, and audited ${o.added + 1} packages in ${o.took}`,
      ...(o.extra === undefined ? [] : [o.extra]),
      `npm error code ${o.code}`,
      "npm error ERESOLVE could not resolve",
      `npm error While resolving: DriftApp@0.0.1 in ${o.tmp}/DriftApp`,
      `npm error A complete log of this run can be found in: /r/.npm/_logs/${o.time}-debug-0.log`,
      `${o.added % 7} vulnerabilities`,
      ...(o.after ?? []),
    ].join("\n");
  const issueFor = (output: string) => [
    {
      number: 7,
      title: "Drift: React Native 0.88 (bare)",
      body: issueBody(linesWith(red(BARE088, output))[4]!, { runUrl: "https://x/0", date: "2026-10-28" }),
    },
  ];
  const DAY1 = {
    code: "ERESOLVE",
    added: 1234,
    tmp: "/tmp/runner-a1b2",
    time: "2026-10-28T05_23_11_123Z",
    took: "41s",
  };

  it("does not comment when only npm's noise changed", () => {
    const day2 = npm({
      code: "ERESOLVE",
      added: 1301,
      tmp: "/w/_temp/scratch-9f8e",
      time: "2026-10-30T05_24_09_987Z",
      took: "1m",
      extra: "npm warn deprecated inflight@1.0.6: leaks memory",
      after: ["npm notice New minor version of npm available!", "npm notice Changelog: <url>", "npm notice To update"],
    });
    const [action] = planIssueActions(linesWith(red(BARE088, day2)), issueFor(npm(DAY1)), CTX);
    expect(action).toMatchObject({ type: "update", number: 7 });
    expect(action).not.toHaveProperty("comment");
  });

  it("comments when an error line changed", () => {
    const day2 = npm({ ...DAY1, code: "ETARGET" });
    const [action] = planIssueActions(linesWith(red(BARE088, day2)), issueFor(npm(DAY1)), CTX);
    expect((action as { comment?: string }).comment).toContain("The cause changed on 2026-10-30.");
  });

  it("falls back to the last 5 lines when a step has no error line", () => {
    const out = (n: number, last: string) =>
      ["head line that drops off", "a", "b", "c", `resolved ${n} packages`, last].join("\n");
    const before = issueFor(out(10, "stopped at the prompt"));
    const same = planIssueActions(linesWith(red(BARE088, out(12, "stopped at the prompt"))), before, CTX)[0];
    expect(same).not.toHaveProperty("comment");
    const moved = planIssueActions(linesWith(red(BARE088, out(10, "stopped at the template"))), before, CTX)[0];
    expect(moved).toHaveProperty("comment");
    const top = planIssueActions(
      linesWith(red(BARE088, out(10, "stopped at the prompt").replace("head line", "other head"))),
      before,
      CTX,
    )[0];
    expect(top).not.toHaveProperty("comment");
  });

  it("reopens the line's last closed issue instead of opening a new one", () => {
    const closed = [
      { number: 5, title: "Drift: React Native 0.88 (bare)" },
      { number: 13, title: "Drift: Expo SDK 58" },
      { number: 11, title: "Drift: React Native 0.88 (bare)" },
    ];
    const lines = linesWith(red(BARE088));
    expect(planIssueActions(lines, [], CTX, closed)).toEqual([
      {
        type: "reopen",
        number: 11,
        body: issueBody(lines[4]!, CTX),
        comment: [
          "Broken again on 2026-10-30. Failing now:",
          "",
          "```\nbare-0.88 patches: patch failed\n```",
          "",
          "Last run: https://github.com/o/r/actions/runs/1",
        ].join("\n"),
      },
    ]);
    expect(planIssueActions(lines, [], CTX, [{ number: 13, title: "Drift: Expo SDK 58" }])[0]!.type).toBe("create");
    expect(planIssueActions(lines, [{ number: 20, title: "Drift: React Native 0.88 (bare)" }], CTX, closed)[0]).toMatchObject({
      type: "update",
      number: 20,
    });
  });

  it("closes the issue when the line is green again", () => {
    const actions = planIssueActions(linesWith(), [{ number: 7, title: "Drift: React Native 0.88 (bare)" }], CTX);
    expect(actions).toEqual([
      { type: "close", number: 7, comment: "Green again on 2026-10-30: https://github.com/o/r/actions/runs/1" },
    ]);
  });

  it("leaves issues alone when a line could not run", () => {
    const lines = linesWith(unknown(BARE088));
    expect(planIssueActions(lines, [{ number: 7, title: "Drift: React Native 0.88 (bare)" }], CTX)).toEqual([]);
    expect(reportExitCode(lines)).toBe(1);
    expect(reportExitCode(linesWith(red(BARE088)))).toBe(0);
    expect(reportExitCode(linesWith())).toBe(0);
  });

  it("fails the run when a target could not run on a red line", () => {
    const lines = groupByLine(resultsFor(ALL, ALL.filter((t) => t !== EXPO58_DEFAULT).map(green)));
    expect(reportExitCode(lines)).toBe(1);
    expect(reportExitCode(linesWith(red(EXPO58_BLANK), unknown(EXPO58_DEFAULT)))).toBe(1);
    expect(reportExitCode(applyDrill(lines, "expo-58"))).toBe(1);
    expect(reportExitCode(applyDrill(linesWith(), "expo-58"))).toBe(0);
  });

  it("never touches another line's issue", () => {
    const open = [
      { number: 3, title: "Drift: Expo SDK 58" },
      { number: 9, title: "Something else" },
    ];
    const actions = planIssueActions(linesWith(red(BARE088)), open, CTX);
    expect(actions.map((a) => [a.type, "number" in a ? a.number : a.title])).toEqual([
      ["close", 3],
      ["create", "Drift: React Native 0.88 (bare)"],
    ]);
  });
});

describe("issueBody", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

  it("writes the watch's limit into every issue", () => {
    const line = linesWith(red(BARE088, hundred)).find((l) => l.line === "bare-0.88")!;
    const body = issueBody(line, CTX);
    expect(body.startsWith("rn-xtool's drift watch found this line broken on 2026-10-30.")).toBe(true);
    expect(body).toContain("### bare-0.88");
    expect(body).toContain("react-native 0.88.2");
    expect(body).toMatch(/^line 41$/m);
    expect(body).toMatch(/^line 100$/m);
    expect(body).not.toMatch(/^line 40$/m);
    expect(body).toContain(LIMIT);
    expect(body).toMatch(/\n\nLast run: https:\/\/github\.com\/o\/r\/actions\/runs\/1\n\n<!-- drift-cause: [0-9a-f]{16} -->\n$/);
    expect(body.indexOf("### bare-0.88")).toBeLessThan(body.indexOf(LIMIT));
    expect(body.indexOf(LIMIT)).toBeLessThan(body.indexOf("Last run:"));
    expect(body).toContain("Output truncated: the last 60 of 100 lines.");
    expect(body).not.toContain("doctor ok");
  });

  it("names each target of the line", () => {
    const line = linesWith(red(EXPO58_DEFAULT)).find((l) => l.line === "expo-58")!;
    const body = issueBody(line, CTX);
    expect(body).toContain("### expo-58/blank-typescript");
    expect(body).toContain("### expo-58/default");
    expect(body.indexOf("### expo-58/blank-typescript")).toBeLessThan(body.indexOf("### expo-58/default"));
    expect(body).toContain("patch failed");
    expect(body).not.toContain("Output truncated");
  });

  it("keeps a huge output well under GitHub's body limit", () => {
    const wide = Array.from({ length: 100 }, (_, i) => `${"x".repeat(5000)} end ${i + 1}`).join("\n");
    const failing = (t: WatchTarget): TargetResult =>
      result(t, "red", [
        { step: "create", ok: true, output: "" },
        { step: "gates", ok: false, output: wide },
        { step: "patches", ok: false, output: wide },
        { step: "manifests", ok: false, output: wide },
      ]);
    const lines = applyDrill(linesWith(failing(EXPO58_BLANK), failing(EXPO58_DEFAULT)), "expo-58");
    const body = issueBody(lines.find((l) => l.line === "expo-58")!, CTX);
    expect(body.length).toBeLessThan(60_000);
    expect(body).toContain("end 100");
    expect(body).toMatch(/Output truncated: the last \d+ characters of the last 60 lines\./);
    expect(body).toContain(LIMIT);
    expect(body).toContain("Last run: https://github.com/o/r/actions/runs/1");
    expect(body).toContain("forced red by the workflow_dispatch input drill");
  });

  it("keeps a fence in the output from closing the block", () => {
    const line = linesWith(red(BARE088, "before\n```\nafter")).find((l) => l.line === "bare-0.88")!;
    const body = issueBody(line, CTX);
    expect(body).toContain("````\nbefore\n```\nafter\n````");
  });
});

describe("summaryMarkdown", () => {
  it("has one row per line", () => {
    const md = summaryMarkdown(linesWith(red(EXPO58_DEFAULT), unknown(BARE087)));
    const rows = md.split("\n").filter((l) => l.startsWith("| Drift:"));
    expect(rows).toEqual([
      "| Drift: Expo SDK 57 | green | |",
      "| Drift: Expo SDK 58 | red | expo-58/default: patches |",
      "| Drift: React Native 0.86 (bare) | green | |",
      "| Drift: React Native 0.87 (bare) | unknown (could not run) | bare-0.87: create |",
      "| Drift: React Native 0.88 (bare) | green | |",
    ]);
  });
});

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

describe("readResults", () => {
  it("reads the results, in subfolders too, and reports the unreadable ones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-report-"));
    temps.push(dir);
    await mkdir(path.join(dir, "result-bare-0.88"));
    await writeFile(path.join(dir, "result-bare-0.88", "bare-0.88.json"), JSON.stringify(red(BARE088)));
    await writeFile(path.join(dir, "expo-57-blank-typescript.json"), JSON.stringify(green(EXPO57)));
    await writeFile(path.join(dir, "bare-0.86.json"), "{ not json");
    await writeFile(path.join(dir, "bare-0.87.json"), JSON.stringify({ hello: 1 }));
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    const { results, errors } = await readResults(dir);
    expect(results.map((r) => r.target.id).sort()).toEqual(["bare-0.88", "expo-57/blank-typescript"]);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("bare-0.86.json");
    expect(errors.join("\n")).toContain("bare-0.87.json");
  });

  it("reads a missing folder as no results", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-report-"));
    temps.push(dir);
    const { results, errors } = await readResults(path.join(dir, "absent"));
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
  });
});

interface GhCall {
  args: string[];
  stdin?: string;
}

type Issue = { number: number; title: string; body?: string };

function fakeGh(
  open: Issue[] = [],
  fail: (args: string[]) => boolean = () => false,
  closed: Issue[] = [],
): { gh: Gh; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh: Gh = async (args, stdin) => {
    calls.push(stdin === undefined ? { args } : { args, stdin });
    if (fail(args)) return { exitCode: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" };
    if (args[0] === "issue" && args[1] === "list") {
      return { exitCode: 0, stdout: JSON.stringify(args.includes("closed") ? closed : open), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { gh, calls };
}

function sink(): { log: (l: string) => void; error: (l: string) => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { log: (l) => out.push(l), error: (l) => err.push(l), out, err };
}

describe("commandRunner", () => {
  it("feeds the input on stdin and keeps stdout and stderr apart", async () => {
    const node = commandRunner(process.execPath);
    const echo = "process.stdin.pipe(process.stdout); process.stderr.write('warning')";
    await expect(node(["-e", echo], "body text")).resolves.toEqual({ exitCode: 0, stdout: "body text", stderr: "warning" });
    await expect(node(["-e", "process.exit(3)"])).resolves.toEqual({ exitCode: 3, stdout: "", stderr: "" });
    const missing = await commandRunner("rn-xtool-no-such-command")([]);
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr).toContain("ENOENT");
  });
});

describe("runReport", () => {
  const LABEL = ["label", "create", "drift", "--color", "B60205", "--description", "rn-xtool drift watch", "--force"];
  const LIST = ["issue", "list", "--label", "drift", "--state", "open", "--json", "number,title,body", "--limit", "100"];
  const CLOSED = ["issue", "list", "--label", "drift", "--state", "closed", "--json", "number,title", "--limit", "100"];

  it("creates, updates and closes issues through gh", async () => {
    const lines = linesWith(red(BARE088), red(BARE087));
    const { gh, calls } = fakeGh([
      { number: 3, title: "Drift: Expo SDK 58" },
      { number: 7, title: "Drift: React Native 0.87 (bare)" },
    ]);
    const s = sink();
    const code = await runReport(lines, CTX, { dryRun: false }, { gh, ...s });
    expect(code).toBe(0);
    expect(calls.map((c) => c.args)).toEqual([
      LABEL,
      LIST,
      CLOSED,
      ["issue", "close", "3", "--comment", "Green again on 2026-10-30: https://github.com/o/r/actions/runs/1"],
      ["issue", "edit", "7", "--body-file", "-"],
      ["issue", "create", "--title", "Drift: React Native 0.88 (bare)", "--label", "drift", "--body-file", "-"],
    ]);
    expect(calls[4]!.stdin).toBe(issueBody(lines[3]!, CTX));
    expect(calls[5]!.stdin).toBe(issueBody(lines[4]!, CTX));
    expect(s.err).toEqual([]);
  });

  it("comments on the issue after updating it when the cause changed", async () => {
    const before = issueBody(linesWith(red(BARE088, "old cause"))[4]!, { ...CTX, date: "2026-10-28" });
    const { gh, calls } = fakeGh([{ number: 7, title: "Drift: React Native 0.88 (bare)", body: before }]);
    const s = sink();
    const lines = linesWith(red(BARE088, "new cause"));
    expect(await runReport(lines, CTX, { dryRun: false }, { gh, ...s })).toBe(0);
    expect(calls.slice(2).map((c) => c.args)).toEqual([
      ["issue", "edit", "7", "--body-file", "-"],
      ["issue", "comment", "7", "--body-file", "-"],
    ]);
    expect(calls[2]!.stdin).toBe(issueBody(lines[4]!, CTX, "2026-10-28"));
    expect(calls[3]!.stdin).toContain("The cause changed on 2026-10-30. Failing now:");
    expect(calls[3]!.stdin).toContain("bare-0.88 patches: new cause");
  });

  it("reopens the last closed issue of a line broken again", async () => {
    const { gh, calls } = fakeGh([], () => false, [{ number: 11, title: "Drift: React Native 0.88 (bare)" }]);
    const s = sink();
    const lines = linesWith(red(BARE088));
    expect(await runReport(lines, CTX, { dryRun: false }, { gh, ...s })).toBe(0);
    const [reopen] = planIssueActions(lines, [], CTX, [{ number: 11, title: "Drift: React Native 0.88 (bare)" }]);
    expect(calls.map((c) => c.args)).toEqual([
      LABEL,
      LIST,
      CLOSED,
      ["issue", "reopen", "11", "--comment", (reopen as { comment: string }).comment],
      ["issue", "edit", "11", "--body-file", "-"],
    ]);
    expect(calls[4]!.stdin).toBe(issueBody(lines[4]!, CTX));
  });

  it("lists the closed issues only when a line needs an issue", async () => {
    const { gh, calls } = fakeGh([{ number: 7, title: "Drift: React Native 0.88 (bare)" }]);
    const s = sink();
    expect(await runReport(linesWith(red(BARE088)), CTX, { dryRun: false }, { gh, ...s })).toBe(0);
    expect(calls.some((c) => c.args.includes("closed"))).toBe(false);
  });

  it("still opens the issue, and fails the run, when the closed issues cannot be listed", async () => {
    const { gh, calls } = fakeGh([], (a) => a.includes("closed"));
    const s = sink();
    expect(await runReport(linesWith(red(BARE088)), CTX, { dryRun: false }, { gh, ...s })).toBe(1);
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(["issue", "create"]);
    expect(s.err.join("\n")).toContain("gh issue list --state closed failed (exit 1): HTTP 403");
  });

  it("reads the issue list from stdout only", async () => {
    const gh: Gh = async (args) =>
      args[1] === "list"
        ? { exitCode: 0, stdout: JSON.stringify([{ number: 7, title: "Drift: React Native 0.88 (bare)" }]), stderr: "warning: x" }
        : { exitCode: 0, stdout: "", stderr: "" };
    const s = sink();
    expect(await runReport(linesWith(red(BARE088)), CTX, { dryRun: false }, { gh, ...s })).toBe(0);
    expect(s.err).toEqual(["gh issue list: warning: x"]);
  });

  it("prints the actions and calls no gh on a dry run", async () => {
    const { gh, calls } = fakeGh();
    const s = sink();
    const code = await runReport(linesWith(red(BARE088)), CTX, { dryRun: true }, { gh, ...s });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(s.out).toHaveLength(1);
    const action = JSON.parse(s.out[0]!) as IssueAction;
    expect(action).toMatchObject({ type: "create", title: "Drift: React Native 0.88 (bare)" });
  });

  it("handles the issues, then fails the run when a line could not run", async () => {
    const { gh, calls } = fakeGh([{ number: 4, title: "Drift: React Native 0.86 (bare)" }]);
    const s = sink();
    const lines = groupByLine(resultsFor(ALL, ALL.filter((t) => t !== BARE087).map(green)));
    const code = await runReport(lines, CTX, { dryRun: false }, { gh, ...s });
    expect(code).toBe(1);
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([LABEL.slice(0, 3), LIST.slice(0, 3), ["issue", "close", "4"]]);
    expect(s.err.join("\n")).toContain("bare-0.87: could not run: no result: the check job did not finish");
  });

  it("fails the run on a gh error and still handles the other lines", async () => {
    const { gh, calls } = fakeGh([{ number: 3, title: "Drift: Expo SDK 58" }], (a) => a[1] === "close");
    const s = sink();
    const code = await runReport(linesWith(red(BARE088)), CTX, { dryRun: false }, { gh, ...s });
    expect(code).toBe(1);
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(["issue", "create"]);
    expect(s.err.join("\n")).toContain("gh issue close 3 failed (exit 1): HTTP 403: Resource not accessible");
  });

  it("opens nothing when the open issues cannot be listed", async () => {
    for (const bad of [(a: string[]) => a[1] === "list", (a: string[]) => a[0] === "label"]) {
      const { gh, calls } = fakeGh([], bad);
      const s = sink();
      const code = await runReport(linesWith(red(BARE088)), CTX, { dryRun: false }, { gh, ...s });
      expect(code).toBe(1);
      expect(calls.some((c) => c.args[1] === "create" && c.args[0] === "issue")).toBe(false);
      expect(s.err.join("\n")).toContain("failed (exit 1): HTTP 403");
    }
  });

  it("fails the run on an unreadable issue list", async () => {
    const gh: Gh = async (args) => ({ exitCode: 0, stdout: args[1] === "list" ? "<html>" : "", stderr: "" });
    const s = sink();
    const code = await runReport(linesWith(red(BARE088)), CTX, { dryRun: false }, { gh, ...s });
    expect(code).toBe(1);
    expect(s.err.join("\n")).toContain("gh issue list gave an unreadable answer");
  });
});
