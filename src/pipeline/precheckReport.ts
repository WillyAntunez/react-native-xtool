/** A precheck stop: the message is what the user reads. */
export class PrecheckError extends Error {
  override name = "PrecheckError";
}

/** One compiler error: where it is, what it says, and the include stack clang printed before it. */
export interface Diagnostic {
  /** "" when the compiler named no file (a driver error, swiftc's `<unknown>:0`). */
  file: string;
  /** 0 when the compiler named no line. */
  line: number;
  message: string;
  /** The `In file included from <file>:<line>:` lines before it (and clang's module-build lines), in order. */
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

/** The errors (and fatal errors) in clang's or swiftc's output; warnings, notes and excerpts dropped (row 51). */
export function parseDiagnostics(output: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  let stack: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const text = raw.trimEnd();
    if (STACK.test(text)) {
      stack.push(text);
      continue;
    }
    const diag = EXCERPT.test(text) ? undefined : diagnostic(text, stack);
    if (diag) diags.push(diag);
    stack = [];
  }
  return diags;
}

function diagnostic(text: string, stack: string[]): Diagnostic | undefined {
  const located = LOCATED.exec(text);
  if (located) {
    const [, file, line, severity, message] = located;
    if (!isError(severity)) return undefined;
    return file === "<unknown>" ? { file: "", line: 0, message, stack } : { file, line: Number(line), message, stack };
  }
  const unlocated = UNLOCATED.exec(text);
  if (unlocated && isError(unlocated[1])) return { file: "", line: 0, message: unlocated[2], stack };
  return undefined;
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
