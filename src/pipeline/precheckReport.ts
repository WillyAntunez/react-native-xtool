/** A precheck stop: the message is what the user reads. */
export class PrecheckError extends Error {
  override name = "PrecheckError";
}

/**
 * The toolchain or the Darwin SDK is incomplete (`precheckToolchain`): xtool-build fails the same way, so the stop names
 * `rn-xtool setup` and not the way past the precheck.
 */
export class PrecheckToolchainError extends PrecheckError {}

/** What every stop the precheck did not plan for ends with: the way past it, and how to report it. */
export const PRECHECK_EXIT =
  "; if xtool-build builds this app, build with rn-xtool build --skip-precheck and report it with rn-xtool doctor --report";

/**
 * The error a precheck stop throws: a `PrecheckToolchainError`, and a message that already names `--skip-precheck`,
 * as they are; any other error, planned or not (rn-xtool's reading of SwiftPM's answers, `ENOSPC`, a bug), a
 * `PrecheckError` whose message ends with `PRECHECK_EXIT`.
 */
export function withExit(e: unknown): unknown {
  if (e instanceof PrecheckToolchainError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("--skip-precheck")) return e;
  return new PrecheckError(`${message}${PRECHECK_EXIT}`, { cause: e });
}

/** One compiler error: where it is, what it says, and the include stack clang printed before it. */
export interface Diagnostic {
  /** "" when the compiler named no file (a driver error, swiftc's `<unknown>:0`). */
  file: string;
  /** 0 when the compiler named no line. */
  line: number;
  message: string;
  /** The `In file included from <file>:<line>:` lines before it (clang's module-build lines and swiftc's include notes too), in order. */
  stack: string[];
}

/** clang's stale or broken module cache: the precheck clears the cache and runs once more (row 42). */
export const STALE_MODULE_CACHE =
  /module file .* is out of date|has been modified since the module file|malformed or corrupted AST file/;

const SHOWN = 10;
/** `<file>:<line>[:<col>]: <severity>: <message>`; the lazy file takes the first such split, so a message may hold `error:`. */
const LOCATED = /^(.+?):(\d+)(?::\d+)?: (fatal error|error|warning|note|remark): (.*)$/;
/** `error: …` or `<tool>: error: …` with no location. */
const UNLOCATED = /^(?:[^\s:]+: )?(fatal error|error|warning|note|remark): (.*)$/;
/** clang's context lines before a diagnostic: an include, or the module build that reached it. */
const STACK = /^(In file included from|(?:While building|In) module '[^']*' imported from) (.+):(\d+):$/;
/** A source excerpt or caret line: clang's `   21 | …`, swiftc's `1 | …` and `  |  \`- error: …`. */
const EXCERPT = /^\s*\d*\s*\|/;
/** swiftc's include trail, a note per include: `<file>:<line>:<col>: note: in file included from <file>:<line>:`. */
const SWIFT_TRAIL = /^in file included from (.+:\d+:)$/;

/** The errors (and fatal errors) in clang's or swiftc's output; warnings, notes and excerpts dropped (row 51). */
export function parseDiagnostics(output: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  let stack: string[] = [];
  // The stack resets at each diagnostic only: swiftc puts excerpts, blank lines and clang's
  // `N errors generated.` between its include-trail notes and the error they lead to.
  for (const raw of output.split(/\r?\n/)) {
    const text = raw.trimEnd();
    if (STACK.test(text)) {
      stack.push(text);
      continue;
    }
    if (EXCERPT.test(text)) continue;
    const found = diagnostic(text);
    if (!found) continue;
    if (found.severity === "note") {
      const trail = SWIFT_TRAIL.exec(found.message);
      if (trail) {
        stack.push(`In file included from ${trail[1]}`);
        continue;
      }
    }
    if (isError(found.severity)) diags.push({ file: found.file, line: found.line, message: found.message, stack });
    stack = [];
  }
  return diags;
}

function diagnostic(text: string): { file: string; line: number; severity: string; message: string } | undefined {
  const located = LOCATED.exec(text);
  if (located) {
    const [, file, line, severity, message] = located;
    return file === "<unknown>" ? { file: "", line: 0, severity, message } : { file, line: Number(line), severity, message };
  }
  const unlocated = UNLOCATED.exec(text);
  return unlocated ? { file: "", line: 0, severity: unlocated[1], message: unlocated[2] } : undefined;
}

function isError(severity: string): boolean {
  return severity === "error" || severity === "fatal error";
}

/** `✖ precheck — <file>:<line>: <message>` for the first ten, each with its stack (row 50), then `… and <n> more`. */
export function precheckErrorLines(diags: Diagnostic[], display: (file: string) => string): string[] {
  const lines = diags.slice(0, SHOWN).flatMap((d) => [
    d.file === "" ? `✖ precheck — ${d.message}` : `✖ precheck — ${display(d.file)}:${d.line}: ${d.message}`,
    ...d.stack.map((s) => `  ${s.replace(STACK, (_, from: string, file: string, line: string) => `${from} ${display(file)}:${line}:`)}`),
  ]);
  if (diags.length > SHOWN) lines.push(`… and ${diags.length - SHOWN} more`);
  return lines;
}

/** The stop after the error lines: names the log and the way past a false stop (row 39). */
export function precheckStop(count: number, log: string): PrecheckError {
  return new PrecheckError(
    `precheck: ${count} error(s) in the app's own sources before xtool-build (the first ten are above; all of them in ${log}). ` +
      "If xtool-build compiles these files, this is a false stop: build with rn-xtool build --skip-precheck " +
      "and report it with rn-xtool doctor --report",
  );
}
