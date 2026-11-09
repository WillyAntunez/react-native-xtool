#!/usr/bin/env node
// Finds bare GitHub mentions in Markdown: a `@name` in prose notifies that GitHub user (and a release note that holds
// one lists them as a contributor). Not shipped in the npm package.
//   node scripts/check-mentions.mjs [file…] → one line per bare mention and exit 1; nothing and exit 0 when clean.
//   With no file it checks every tracked Markdown file (`git ls-files '*.md'`). Run it from the repo root.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The opening line of a fenced block: its marker (three or more backticks or tildes) and the rest of the line. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * A bare mention: a `@` not preceded by a letter, digit, `_`, `` ` ``, `/`, `.`, `-` or `@`, followed by a GitHub login
 * (a letter or digit, then up to 38 more, single hyphens between them) that is not followed by `/` or a login
 * character. So `@scope/name` and `a@b.c` pass, and `@54` (a hunk number) is a mention, as GitHub treats it.
 * Fenced blocks and code spans are left out before this runs.
 */
const MENTION = /(?<![A-Za-z0-9_`/.@-])@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})(?![A-Za-z0-9/-])/g;

/**
 * `text` with its code spans blanked (newlines kept, so offsets and lines stay put). A code span is a run of backticks
 * closed by the next run of the same length; a run without one is plain text.
 */
function blankCodeSpans(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i++];
      continue;
    }
    const run = /^`+/.exec(text.slice(i))[0];
    const close = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
    close.lastIndex = i + run.length;
    const m = close.exec(text);
    const end = m ? m.index + run.length : i + run.length;
    out += m ? text.slice(i, end).replace(/[^\n]/g, " ") : run;
    i = end;
  }
  return out;
}

/**
 * The bare mentions of a Markdown text, as `{ line, word }` (1-based line, the login without its `@`). Fenced blocks
 * are skipped; a code span may cross a line break but not a blank line, which ends its paragraph.
 */
export function mentions(text) {
  const found = [];
  const lines = text.split("\n");
  let fence; // the open fence's marker
  let para = []; // the current paragraph's lines
  let first = 0; // the index of its first line
  const flush = () => {
    const masked = blankCodeSpans(para.join("\n"));
    for (const m of masked.matchAll(MENTION)) {
      found.push({ line: first + masked.slice(0, m.index).split("\n").length, word: m[1] });
    }
    para = [];
  };
  lines.forEach((l, i) => {
    const f = FENCE.exec(l);
    if (fence !== undefined) {
      // A fence closes on a run of its own character at least as long, with nothing after it.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === "") fence = undefined;
      return;
    }
    if (f) {
      flush();
      fence = f[1];
    } else if (l.trim() === "") {
      flush();
    } else {
      if (para.length === 0) first = i;
      para.push(l);
    }
  });
  flush();
  return found;
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
  const args = process.argv.slice(2);
  const files =
    args.length > 0 ? args : execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
  let failed = false;
  for (const file of files) {
    for (const { line, word } of mentions(readFileSync(file, "utf8"))) {
      process.stderr.write(`${file}:${line}: @${word} notifies a GitHub user; put it in a code span or drop the @\n`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
