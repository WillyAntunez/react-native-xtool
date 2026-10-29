/**
 * The drift watch's report: rolls the targets' results up into lines and keeps one open GitHub issue (label `drift`)
 * per broken line. A red line updates its open issue (with a comment when the cause changed), reopens its last closed
 * one, or opens one; a green line closes its issues; a line that could not run leaves them alone and fails the run
 * instead. Every `gh` call goes through an injected `Gh`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { lineId, SUPPORTED_LINES } from "../versions.js";
import type { StepResult, TargetResult } from "./check.js";
import type { WatchTarget } from "./targets.js";

export interface LineResult {
  line: string;
  title: string;
  status: "green" | "red" | "unknown";
  targets: TargetResult[];
}

export interface OpenIssue {
  number: number;
  title: string;
  /** The current body, when listed: it carries the first-broken date and the cause the issue describes. */
  body?: string;
}

export type IssueAction =
  | { type: "create"; title: string; body: string }
  /** `comment` only when the cause differs from the one the current body describes: edits notify nobody. */
  | { type: "update"; number: number; body: string; comment?: string }
  | { type: "reopen"; number: number; body: string; comment: string }
  | { type: "close"; number: number; comment: string };

export interface ReportContext {
  runUrl: string;
  /** YYYY-MM-DD */
  date: string;
}

/** Runs `gh` with `args` and `stdin` as its input; resolves with its exit code, stdout and stderr; never rejects. */
export type Gh = (args: string[], stdin?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const NO_RESULT: StepResult = { step: "create", ok: false, output: "no result: the check job did not finish" };
const DRILL: StepResult = { step: "drill", ok: false, output: "forced red by the workflow_dispatch input drill" };

const LIMIT =
  "The drift watch checks the project gates (G1–G3), the bundled patches (patch -F0 --dry-run) and the portable " +
  "library manifests. It does not compile or run the app: a green line can still fail G4 or the build. The " +
  "compat-suite CI closes that gap.";

/** Each target's result, in target order; a target without one (its check crashed or never ran) could not run. */
export function resultsFor(targets: WatchTarget[], results: TargetResult[]): TargetResult[] {
  return targets.map((t) => {
    const r = results.find((x) => x.target.id === t.id);
    return r === undefined ? { target: t, status: "unknown", versions: {}, steps: [NO_RESULT] } : { ...r, target: t };
  });
}

/** One entry per line, in the order the targets come: red if any target is red, else unknown if any is, else green. */
export function groupByLine(results: TargetResult[]): LineResult[] {
  const lines: LineResult[] = [];
  for (const r of results) {
    let line = lines.find((l) => l.line === r.target.line);
    if (line === undefined) {
      line = { line: r.target.line, title: r.target.title, status: "green", targets: [] };
      lines.push(line);
    }
    line.targets.push(r);
  }
  for (const line of lines) {
    const has = (s: TargetResult["status"]) => line.targets.some((t) => t.status === s);
    line.status = has("red") ? "red" : has("unknown") ? "unknown" : "green";
  }
  return lines;
}

/**
 * The workflow_dispatch input `drill`: "" changes nothing; a line id turns that line red with a drill step on each of
 * its targets (their own statuses stay, so a target that could not run still fails the run).
 */
export function applyDrill(lines: LineResult[], drill: string): LineResult[] {
  if (drill === "") return lines;
  const ids = SUPPORTED_LINES.map(lineId);
  if (!ids.includes(drill)) throw new Error(`unknown drift line "${drill}"; lines: ${ids.join(", ")}`);
  if (!lines.some((l) => l.line === drill)) throw new Error(`drift line "${drill}" has no target in this run`);
  return lines.map((l) =>
    l.line !== drill
      ? l
      : { ...l, status: "red", targets: l.targets.map((t) => ({ ...t, steps: [...t.steps, DRILL] })) },
  );
}

/**
 * What to do with the `drift` issues. A red line updates the lowest-numbered open issue with its exact title, keeping
 * its first-broken date and adding a comment when the cause changed; without one it reopens the highest-numbered
 * closed issue with that title (`closed`), else opens one. A green line closes every open issue with its title; a line
 * that could not run touches nothing. Issues with any other title are never touched.
 */
export function planIssueActions(
  lines: LineResult[],
  open: OpenIssue[],
  ctx: ReportContext,
  closed: OpenIssue[] = [],
): IssueAction[] {
  const actions: IssueAction[] = [];
  for (const line of lines) {
    const mine = open.filter((i) => i.title === line.title).sort((a, b) => a.number - b.number);
    if (line.status === "red") {
      const first = mine[0];
      const last = closed.filter((i) => i.title === line.title).sort((a, b) => b.number - a.number)[0];
      if (first !== undefined) {
        const since = first.body === undefined ? undefined : FIRST_BROKEN.exec(first.body)?.[1];
        const action: IssueAction = { type: "update", number: first.number, body: issueBody(line, ctx, since) };
        if (first.body !== undefined && CAUSE.exec(first.body)?.[1] !== causeOf(line)) {
          action.comment = causeComment(`The cause changed on ${ctx.date}.`, line, ctx);
        }
        actions.push(action);
      } else if (last !== undefined) {
        const comment = causeComment(`Broken again on ${ctx.date}.`, line, ctx);
        actions.push({ type: "reopen", number: last.number, body: issueBody(line, ctx), comment });
      } else {
        actions.push({ type: "create", title: line.title, body: issueBody(line, ctx) });
      }
    } else if (line.status === "green") {
      const comment = `Green again on ${ctx.date}: ${ctx.runUrl}`;
      for (const i of mine) actions.push({ type: "close", number: i.number, comment });
    }
  }
  return actions;
}

/** The last lines of a failing step's output that go into an issue. */
const TAIL_LINES = 60;
/** Characters of step output in one issue body, all blocks together: GitHub refuses a body over 65,536. */
const OUTPUT_BUDGET = 40_000;
/** Characters of one step's output when few steps fail. */
const BLOCK_MAX = 8_000;

/** The tail of `output`: its last 60 lines, cut to `maxChars` from the end, with a note when anything was left out. */
function tail(output: string, maxChars: number): { text: string; note?: string } {
  const all = output.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  let text = all.slice(-TAIL_LINES).join("\n");
  if (text.length > maxChars) {
    text = text.slice(-maxChars);
    const of = all.length > TAIL_LINES ? ` of the last ${TAIL_LINES} lines` : "";
    return { text, note: `Output truncated: the last ${maxChars} characters${of}.` };
  }
  if (all.length <= TAIL_LINES) return { text };
  return { text, note: `Output truncated: the last ${TAIL_LINES} of ${all.length} lines.` };
}

/** A code fence longer than any run of backticks in `text`, so the output cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

const FIRST_BROKEN = /^rn-xtool's drift watch found this line broken on (\d{4}-\d{2}-\d{2})\./;
const CAUSE = /<!-- drift-cause: ([0-9a-f]+) -->/;

/**
 * Run-to-run noise in step output: timestamps (npm's log names), durations, temp and scratch folders, then any digits
 * (package counts and the like), so a line whose only change is a number reads the same.
 */
function denoise(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}[_:]\d{2}[_:]\d{2}(?:[_.:]\d+)?Z?/g, "#")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b/g, "#")
    .replace(/\S+/g, (word) => (word.includes("/tmp/") || word.includes("scratch") ? "#" : word))
    .replace(/\d+/g, "#")
    .trim();
}
/** A line that says what failed. `ERR!` and `✖` end in a non-word character, so they are matched without `\b`. */
const ERROR_LINE = /\b(?:error|failed|not found|cannot)\b|ERR!|✖/i;

/** The failing steps of a line, one entry per target and step. */
function failingSteps(line: LineResult): { id: string; step: string; output: string }[] {
  return line.targets.flatMap((t) => t.steps.filter((s) => !s.ok).map((s) => ({ id: t.target.id, ...s })));
}

/**
 * A fingerprint of what is broken: each failing target and step, with its error lines (deduplicated and sorted), or
 * its last 5 lines when it has none, all without run-to-run noise. npm's chatter around an unchanged error therefore
 * keeps the same cause, and only a new error line, a new failing step or a new failing target changes it. Only the
 * tail the issue shows (60 lines) is read.
 */
function causeOf(line: LineResult): string {
  const steps = failingSteps(line).map((f) => {
    const lines = tail(f.output, Infinity).text.split("\n").map(denoise).filter((l) => l !== "");
    const errors = [...new Set(lines.filter((l) => ERROR_LINE.test(l)))].sort();
    return [f.id, f.step, errors.length > 0 ? errors : lines.slice(-5)];
  });
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 16);
}

/** The line of a step's output that says what failed: the first error or failure line, else the last line. */
function headline(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const line = lines.find((l) => /error|fail|✖/i.test(l)) ?? lines.at(-1) ?? "(no output)";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** A comment that says what fails now, one line per failing step, fenced so no output can mention anyone. */
function causeComment(lead: string, line: LineResult, ctx: ReportContext): string {
  const steps = failingSteps(line).map((f) => `${f.id} ${f.step}: ${headline(f.output)}`);
  return [`${lead} Failing now:`, "", fenced(steps.join("\n")), "", `Last run: ${ctx.runUrl}`].join("\n");
}

/**
 * A broken line's issue body: each target's versions and failing steps' tails, then the watch's limit and the run.
 * `since` is the date the line was first found broken (an update keeps it); a hidden marker records the cause.
 */
export function issueBody(line: LineResult, ctx: ReportContext, since: string = ctx.date): string {
  const failing = line.targets.reduce((n, t) => n + t.steps.filter((s) => !s.ok).length, 0);
  const maxChars = Math.min(BLOCK_MAX, Math.floor(OUTPUT_BUDGET / Math.max(1, failing)));
  const parts = [`rn-xtool's drift watch found this line broken on ${since}.`];
  for (const t of line.targets) {
    parts.push(`### ${t.target.id}`);
    const versions = Object.entries(t.versions).map(([name, v]) => `${name} ${v}`);
    parts.push(`Versions: ${versions.length > 0 ? versions.join(", ") : "none installed"}`);
    const failed = t.steps.filter((s) => !s.ok);
    if (failed.length === 0) parts.push("Every step passed.");
    for (const s of failed) {
      parts.push(`Failed step: ${s.step}`);
      const { text, note } = tail(s.output, maxChars);
      if (note !== undefined) parts.push(note);
      parts.push(fenced(text === "" ? "(no output)" : text));
    }
  }
  parts.push(LIMIT, `Last run: ${ctx.runUrl}`, `<!-- drift-cause: ${causeOf(line)} -->`);
  return `${parts.join("\n\n")}\n`;
}

const STATUS_TEXT: Record<LineResult["status"], string> = {
  green: "green",
  red: "red",
  unknown: "unknown (could not run)",
};

/** The run's step summary: one row per line with its title, its status and its failing steps. */
export function summaryMarkdown(lines: LineResult[]): string {
  const rows = lines.map((l) => {
    const failing = l.targets
      .map((t) => ({ id: t.target.id, steps: t.steps.filter((s) => !s.ok).map((s) => s.step) }))
      .filter((t) => t.steps.length > 0)
      .map((t) => `${t.id}: ${t.steps.join(", ")}`)
      .join("; ");
    return `| ${l.title} | ${STATUS_TEXT[l.status]} |${failing === "" ? " " : ` ${failing} `}|`;
  });
  return ["## Drift watch", "", "| Line | Status | Failing steps |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

/**
 * 1 when the watch could not run somewhere: a line is unknown, or a target is (a crashed check next to a red target
 * leaves its line red, but must still fail the run so the failure email goes out); else 0.
 */
export function reportExitCode(lines: LineResult[]): number {
  return lines.some((l) => l.status === "unknown" || l.targets.some((t) => t.status === "unknown")) ? 1 : 0;
}

function isTargetResult(x: unknown): x is TargetResult {
  const r = x as Partial<TargetResult> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.target?.id === "string" &&
    (r.status === "green" || r.status === "red" || r.status === "unknown") &&
    typeof r.versions === "object" &&
    r.versions !== null &&
    Array.isArray(r.steps)
  );
}

/** Every `*.json` result under `dir`, subfolders included; a missing folder holds none. Unreadable files are errors. */
export async function readResults(dir: string): Promise<{ results: TargetResult[]; errors: string[] }> {
  let files: string[];
  try {
    files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { results: [], errors: [] };
    throw e;
  }
  const results: TargetResult[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (isTargetResult(parsed)) results.push(parsed);
      else errors.push(`${f}: not a drift watch result`);
    } catch (e) {
      errors.push(`${f}: unreadable result: ${(e as Error).message}`);
    }
  }
  return { results, errors };
}

/**
 * A `Gh` for any command: spawns it without a shell, writes `stdin` to it and keeps stdout apart from stderr, so a
 * warning cannot spoil a JSON answer; a command that cannot start gives 127.
 */
export function commandRunner(cmd: string): Gh {
  return (args, stdin) =>
    new Promise((resolve) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const child = spawn(cmd, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      child.stdout?.on("data", (c: Buffer) => out.push(c));
      child.stderr?.on("data", (c: Buffer) => err.push(c));
      const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");
      child.on("error", (e) => resolve({ exitCode: 127, stdout: text(out), stderr: `${text(err)}${e.message}` }));
      child.on("close", (code, signal) =>
        resolve({
          exitCode: code ?? 128,
          stdout: text(out),
          stderr: `${text(err)}${signal === null ? "" : `\nkilled by ${signal}`}`,
        }),
      );
      if (stdin !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(stdin);
      }
    });
}

const firstLine = (text: string): string => text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

/** The issues in a `gh issue list --json number,title[,body]` answer; throws on anything else. */
function parseIssues(stdout: string): OpenIssue[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("not a list");
  return parsed.map((i: Partial<OpenIssue>) => {
    if (typeof i?.number !== "number" || typeof i.title !== "string") throw new Error("not an issue");
    const issue: OpenIssue = { number: i.number, title: i.title };
    if (typeof i.body === "string") issue.body = i.body;
    return issue;
  });
}

/**
 * Handles the drift issues for `lines` and returns the exit code. Dry run: prints the actions as JSON lines (against
 * no issue) and calls no `gh`. Otherwise: makes sure the label exists, lists the open drift issues (and, when a line
 * needs an issue, the newest 100 closed ones) and applies each action. A `gh` failure is printed and fails the run
 * (GitHub's failure email is the fallback), but the other actions still run. When the label or the open list fails,
 * nothing is opened, so a broken list cannot open duplicates; when only the closed list fails, a new issue is opened.
 */
export async function runReport(
  lines: LineResult[],
  ctx: ReportContext,
  opts: { dryRun: boolean },
  deps: { gh: Gh; log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  let code = reportExitCode(lines);
  for (const t of lines.flatMap((l) => l.targets)) {
    if (t.status !== "unknown") continue;
    deps.error(`${t.target.id}: could not run: ${firstLine(t.steps.find((s) => !s.ok)?.output ?? "")}`);
  }
  if (opts.dryRun) {
    for (const a of planIssueActions(lines, [], ctx)) deps.log(JSON.stringify(a));
    return code;
  }
  /** stdout on success; undefined (printed) on failure. stderr never mixes into stdout, and a warning is printed. */
  const call = async (what: string, args: string[], stdin?: string): Promise<string | undefined> => {
    const r = await deps.gh(args, stdin);
    if (r.exitCode !== 0) {
      const said = [r.stderr.trim(), r.stdout.trim()].filter((t) => t !== "").join("\n");
      deps.error(`${what} failed (exit ${r.exitCode}): ${said}`);
      return undefined;
    }
    if (r.stderr.trim() !== "") deps.error(`${what}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  const list = async (what: string, state: string, fields: string): Promise<OpenIssue[] | undefined> => {
    const args = ["issue", "list", "--label", "drift", "--state", state, "--json", fields, "--limit", "100"];
    const stdout = await call(what, args);
    if (stdout === undefined) return undefined;
    try {
      return parseIssues(stdout);
    } catch {
      deps.error(`${what} gave an unreadable answer: ${stdout.slice(0, 200)}`);
      return undefined;
    }
  };
  const label = ["label", "create", "drift", "--color", "B60205", "--description", "rn-xtool drift watch", "--force"];
  if ((await call("gh label create drift", label)) === undefined) return 1;
  const open = await list("gh issue list", "open", "number,title,body");
  if (open === undefined) return 1;
  let actions = planIssueActions(lines, open, ctx);
  if (actions.some((a) => a.type === "create")) {
    const closed = await list("gh issue list --state closed", "closed", "number,title");
    if (closed === undefined) code = 1;
    else actions = planIssueActions(lines, open, ctx, closed);
  }
  for (const a of actions) {
    let done: string | undefined;
    const n = "number" in a ? String(a.number) : "";
    if (a.type === "create") {
      const args = ["issue", "create", "--title", a.title, "--label", "drift", "--body-file", "-"];
      done = await call(`gh issue create "${a.title}"`, args, a.body);
      if (done !== undefined) deps.log(`opened "${a.title}" ${done.trim()}`);
    } else if (a.type === "update") {
      done = await call(`gh issue edit ${n}`, ["issue", "edit", n, "--body-file", "-"], a.body);
      if (done !== undefined && a.comment !== undefined) {
        done = await call(`gh issue comment ${n}`, ["issue", "comment", n, "--body-file", "-"], a.comment);
      }
      if (done !== undefined) deps.log(`updated #${n}${a.comment === undefined ? "" : " (the cause changed)"}`);
    } else if (a.type === "reopen") {
      done = await call(`gh issue reopen ${n}`, ["issue", "reopen", n, "--comment", a.comment]);
      if (done !== undefined) done = await call(`gh issue edit ${n}`, ["issue", "edit", n, "--body-file", "-"], a.body);
      if (done !== undefined) deps.log(`reopened #${n}`);
    } else {
      done = await call(`gh issue close ${n}`, ["issue", "close", n, "--comment", a.comment]);
      if (done !== undefined) deps.log(`closed #${n}`);
    }
    if (done === undefined) code = 1;
  }
  return code;
}
