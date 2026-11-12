/**
 * The guard on the ExpoModulesJSI.swiftinterface rn-xtool's own jsi build writes. The build passes
 * `-no-verify-emitted-module-interface`, so an interface no compiler can read leaves the `jsi` step green and every
 * module that imports ExpoModulesJSI fails much later, at `xtool-build`. This stops the build at `jsi` instead.
 */
import { troubleshootingUrl } from "../docs.js";
import { SWIFT_VERSION } from "../versions.js";

export interface UnreadableLine {
  /** 1-based. */
  line: number;
  text: string;
}

/** The line with comments and string literal contents blanked to spaces, indices kept; `inBlock` carries a `/*` over. */
function codeOf(line: string, state: { inBlock: boolean }): string {
  const out = line.split("");
  let quote = false;
  for (let i = 0; i < out.length; i++) {
    const two = line.slice(i, i + 2);
    if (state.inBlock) {
      out[i] = " ";
      if (two === "*/") {
        out[++i] = " ";
        state.inBlock = false;
      }
    } else if (quote) {
      if (line[i] === '"') {
        quote = false;
      } else {
        out[i] = " ";
        if (line[i] === "\\" && i + 1 < out.length) out[++i] = " ";
      }
    } else if (two === "//") {
      for (let j = i; j < out.length; j++) out[j] = " ";
      break;
    } else if (two === "/*") {
      out[i] = out[++i] = " ";
      state.inBlock = true;
    } else if (line[i] === '"') {
      quote = true;
    }
  }
  return out.join("");
}

/** Whether a `where` clause starts at `i`: the keyword, after a space, a colon or a comma. */
const whereAt = (code: string, i: number): boolean => /^where\b/.test(code.slice(i, i + 6)) && /[\s:,]/.test(code[i - 1] ?? "");

/** The nesting change at `i`: `<`, `[` and `(` open, `>` (not an arrow's), `]` and `)` close. */
function nesting(code: string, i: number): number {
  const c = code[i]!;
  if ("<[(".includes(c)) return 1;
  return "])".includes(c) || (c === ">" && code[i - 1] !== "-") ? -1 : 0;
}

// Attributes (`@name`, `@name(…)`) and modifiers may stand before `extension` on its line.
const EXTENSION_HEAD = /^\s*(?:(?:@\w+(?:\([^()]*\))?|public|package|internal|fileprivate|private)\s+)*extension\s+/;

/**
 * The inheritance list of an `extension` declaration on `code` (comments and strings blanked), split at its commas: from
 * the colon after the extended type (never a `::` module selector, nor one inside `<>`, `[]` or `()`) to `where`, `{`
 * or the end of the line, whichever comes first; `open` tells whether the list reached the end of the line. Undefined
 * for a line that declares no extension or an extension without a list.
 */
function inheritanceSlots(code: string): { slots: string[]; open: boolean } | undefined {
  const head = EXTENSION_HEAD.exec(code);
  if (head === null) return undefined;
  let depth = 0;
  let colon = -1;
  for (let i = head[0].length; i < code.length && colon < 0; i++) {
    const c = code[i]!;
    const delta = nesting(code, i);
    if (delta !== 0) depth += delta;
    else if (depth > 0) continue;
    else if (c === "{" || whereAt(code, i)) return undefined;
    else if (c === ":" && code[i + 1] === ":") i++;
    else if (c === ":") colon = i;
  }
  if (colon < 0) return undefined;
  const slots: string[] = [];
  let start = colon + 1;
  depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i]!;
    const delta = nesting(code, i);
    if (delta !== 0) depth += delta;
    else if (depth > 0) continue;
    else if (c === ",") {
      slots.push(code.slice(start, i).trim());
      start = i + 1;
    } else if (c === "{" || whereAt(code, i)) {
      return { slots: [...slots, code.slice(start, i).trim()], open: false };
    }
  }
  return { slots: [...slots, code.slice(start).trim()], open: true };
}

/**
 * The lines that declare an extension whose inheritance list has an empty slot: none after the colon
 * (`extension <type> :<spaces>where …`, `… : {`, `extension X: where`), or one before or between commas (`: , P`,
 * `P,  where`, `P, {`). Swift 6.4 prints these as placeholders for conformances to an internal `~Copyable` protocol; no
 * Swift compiler parses them. A list that reaches the end of its line with an empty last slot is flagged only when the
 * next line with code does not continue it (it starts with `where`, `{` or `,`, or there is none): Swift accepts a list
 * that goes on on the next line. Comments and string literals are not read.
 */
export function unreadableInterfaceLines(text: string): UnreadableLine[] {
  const state = { inBlock: false };
  const lines = text.split("\n").map((t, i) => {
    const raw = t.replace(/\r$/, "");
    return { line: i + 1, text: raw, code: codeOf(raw, state) };
  });
  const continues = (index: number): boolean => {
    const next = lines.slice(index + 1).find((l) => l.code.trim() !== "");
    return next !== undefined && !/^\s*(?:where\b|\{|,)/.test(next.code);
  };
  return lines
    .filter((l, index) => {
      const list = inheritanceSlots(l.code);
      if (list === undefined) return false;
      const last = list.slots.length - 1;
      return list.slots.some((slot, i) => slot === "" && !(list.open && i === last && continues(index)));
    })
    .map(({ line, text: t }) => ({ line, text: t }));
}

export class UnreadableInterfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableInterfaceError";
  }
}

/** The `X.Y` of a version, for comparing toolchains: 6.4.1 and 6.4 are one Swift. */
const majorMinor = (version: string): string => version.split(".").slice(0, 2).join(".");

/**
 * The interface ExpoModulesJSIHeaders.xcframework ships: `text` itself. Throws UnreadableInterfaceError (naming the
 * first unreadable line and the interface's compiler) when it holds a line no Swift compiler can parse. When that
 * compiler is another Swift than SWIFT_VERSION, the one this release was verified with, the error names it as the
 * likely cause.
 */
export function readableJsiInterface(text: string, jsiVersion: string): string {
  const bad = unreadableInterfaceLines(text);
  if (bad.length === 0) return text;
  const compiler = /^\/\/ swift-compiler-version:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1] ?? "unknown compiler";
  const found = /\bSwift version (\d+\.\d+(?:\.\d+)*)/.exec(compiler)?.[1];
  const lever =
    found !== undefined && majorMinor(found) !== majorMinor(SWIFT_VERSION)
      ? ` It was written by Swift ${found}, and this rn-xtool release was verified with Swift ${SWIFT_VERSION}: a newer or ` +
        "older Swift is the likely cause."
      : "";
  const first = bad[0]!;
  throw new UnreadableInterfaceError(
    `The ExpoModulesJSI.swiftinterface built for expo-modules-jsi ${jsiVersion} (${compiler}) has ${bad.length} ` +
      `${bad.length === 1 ? "line" : "lines"} no Swift compiler can parse, for example line ${first.line}: ${first.text}. ` +
      `Every module that imports ExpoModulesJSI would fail to compile.${lever} ` +
      `See ${troubleshootingUrl("unreadable-expomodulesjsi-interface")}, and report it at ` +
      "https://github.com/WillyAntunez/react-native-xtool/issues with the output of `rn-xtool doctor --report`.",
  );
}
