import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mentions } from "../scripts/check-mentions.mjs";
import { mkTmp } from "./support/expoSpm.js";
import { tool } from "./support/tools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-mentions.mjs");

/** Every tracked Markdown file, and the local PR and notes files under `.superpowers/` when that folder exists. */
function markdownFiles(): string[] {
  const r = tool("git", ["ls-files", "*.md"], { cwd: ROOT });
  expect(r.status, r.stderr).toBe(0);
  const tracked = r.stdout.split("\n").filter((f) => f !== "");
  const local = path.join(ROOT, ".superpowers");
  const notes = existsSync(local)
    ? readdirSync(local).filter((f) => f.endsWith(".md")).map((f) => path.join(".superpowers", f))
    : [];
  return [...tracked, ...notes];
}

describe("mentions", () => {
  it("finds a bare user mention", () => expect(mentions("use @import here\n")).toEqual([{ line: 1, word: "import" }]));

  it("passes code spans, fences, scoped names and e-mail addresses", () =>
    expect(mentions("`@import` and ``a `@x` b``\n```\n@y\n```\n@scope/name a@b.c\n")).toEqual([]));

  it("refuses hunk numbers written as mentions", () =>
    expect(mentions("at @54 and @d11")).toEqual([{ line: 1, word: "54" }, { line: 1, word: "d11" }]));

  it("passes a code span across a line break and a ~~~ fence with an info string, and counts lines past them", () =>
    expect(mentions("a `x\n@y` b\n~~~ sh\n@z\n```\n@w\n~~~\n\n`open\n\nthen @v\n")).toEqual([{ line: 11, word: "v" }]));

  it("reads CRLF line ends, as GitHub sends a PR description", () =>
    expect(mentions("```\r\n@x\r\n```\r\n\r\n`a\r\n@b`\r\nthanks @c\r\n")).toEqual([{ line: 7, word: "c" }]));

  it("finds none in the tracked markdown or the local PR and notes files", () => {
    const hits = markdownFiles().flatMap((f) =>
      mentions(readFileSync(path.join(ROOT, f), "utf8")).map((m) => `${f}:${m.line}: @${m.word}`),
    );
    expect(hits).toEqual([]);
  });
});

describe("node scripts/check-mentions.mjs", () => {
  it("names each bare mention of the files and fails, and passes a clean file silently", () => {
    const dir = mkTmp("mentions-");
    writeFileSync(path.join(dir, "bad.md"), "ok\nthanks @someone\n");
    writeFileSync(path.join(dir, "good.md"), "`@someone` a@b.c\n");
    const bad = tool("node", [SCRIPT, "bad.md", "good.md"], { cwd: dir });
    expect(bad.stderr).toBe("bad.md:2: @someone notifies a GitHub user; put it in a code span or drop the @\n");
    expect(bad.stdout).toBe("");
    expect(bad.status).toBe(1);
    const good = tool("node", [SCRIPT, "good.md"], { cwd: dir });
    expect([good.stdout, good.stderr, good.status]).toEqual(["", "", 0]);
  });
});
