// The include scanner of B1 (spec "B. The app target's checks", rows 33–35, R6): the `#import`/`#include` lines
// clang would see as taken or possibly taken in one source file, with their line numbers. Pure string work: the
// only outside contact is `ScanEnv.hasInclude`, which answers `__has_include`.
//
// Certainty rule (R6): an include is `certain` only when every enclosing condition is definitely taken. A condition
// the scanner cannot evaluate (an unknown name, a function-like macro, an operator outside the small grammar below)
// is `undefined`, never a guess, and makes its includes uncertain. Not returned: anything in a definitely false
// branch, includes in comments, `#include MACRO` (row 34), and `@import` (row 35).

export interface ScannedInclude {
  /** 1-based, in the original text (a continued directive keeps its first line's number). */
  line: number;
  spelling: string;
  angle: boolean;
  /** Every enclosing condition is definitely taken (and it is not `#include_next`). */
  certain: boolean;
}

export interface ScanEnv {
  defines: ReadonlyMap<string, string>;
  /** `undefined`: the pass cannot know. */
  hasInclude(spelling: string, angle: boolean): boolean | undefined;
}

/** The defines B1 assumes: React Native's new architecture, a Debug build, and the iOS device values. */
export const B1_DEFINES: ReadonlyMap<string, string> = new Map([
  ["RCT_NEW_ARCH_ENABLED", "1"],
  ["DEBUG", "1"],
  ["TARGET_OS_MAC", "1"],
  ["TARGET_OS_IPHONE", "1"],
  ["TARGET_OS_IOS", "1"],
  ["TARGET_OS_OSX", "0"],
  ["TARGET_OS_MACCATALYST", "0"],
  ["TARGET_OS_TV", "0"],
  ["TARGET_OS_WATCH", "0"],
  ["TARGET_OS_VISION", "0"],
  ["TARGET_OS_SIMULATOR", "0"],
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `B1_DEFINES` overlaid with the target's `KEY` / `KEY=VALUE` entries (`KEY` alone is `1`). An entry whose key is
 * not an identifier (a build-setting reference such as `$(inherited)`) defines nothing.
 */
export function definesOf(targetDefines: readonly string[]): Map<string, string> {
  const out = new Map(B1_DEFINES);
  for (const entry of targetDefines) {
    const eq = entry.indexOf("=");
    const key = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    if (!IDENTIFIER.test(key)) continue;
    out.set(key, eq < 0 ? "1" : entry.slice(eq + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Lexer: BOM, line splicing, comments. Yields the directives with their original line numbers.

interface Directive {
  line: number;
  /** `if`, `ifdef`, `include`, … ("" for the null directive). */
  name: string;
  /** The text after the name, comments blanked. */
  rest: string;
}

/** Physical lines joined at a trailing backslash; each logical line keeps its first physical line's number. */
function logicalLines(text: string): { line: number; text: string }[] {
  const physical = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const out: { line: number; text: string }[] = [];
  let start = -1;
  let acc = "";
  for (let i = 0; i < physical.length; i++) {
    const cur = physical[i]!;
    const spliced = /\\[ \t]*$/.exec(cur);
    if (start < 0) start = i;
    acc += spliced ? cur.slice(0, spliced.index) : cur;
    if (spliced && i < physical.length - 1) continue;
    out.push({ line: start + 1, text: acc });
    start = -1;
    acc = "";
  }
  return out;
}

/**
 * Each logical line with its comments replaced by one space. String and character literals are copied as they are
 * (a directive's `"X.h"` must survive) but skipped, so a `//` or `/*` inside one opens no comment; a literal ends at
 * the end of its line at the latest. A block comment carries over to the following lines.
 */
function withoutComments(lines: { line: number; text: string }[]): { line: number; text: string }[] {
  let inBlock = false;
  return lines.map(({ line, text }) => {
    let out = "";
    let i = 0;
    while (i < text.length) {
      if (inBlock) {
        const end = text.indexOf("*/", i);
        if (end < 0) {
          i = text.length;
          break;
        }
        inBlock = false;
        out += " ";
        i = end + 2;
        continue;
      }
      const c = text[i]!;
      if (c === "/" && text[i + 1] === "/") break;
      if (c === "/" && text[i + 1] === "*") {
        inBlock = true;
        i += 2;
        continue;
      }
      if (c === "'" && inNumber(out)) {
        out += c; // a digit separator (`1'000`), not a character literal
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += c;
      i++;
    }
    return { line, text: out };
  });
}

/** The text ends inside a preprocessing number (`1'0`, `0x1F`): a `'` that follows is a digit separator. */
function inNumber(before: string): boolean {
  const run = /[0-9A-Za-z_.']*$/.exec(before)![0];
  return /^[0-9]/.test(run) || /^\.[0-9]/.test(run);
}

function directives(text: string): Directive[] {
  const out: Directive[] = [];
  for (const { line, text: clean } of withoutComments(logicalLines(text))) {
    const m = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)?(.*)$/s.exec(clean);
    if (m) out.push({ line, name: m[1] ?? "", rest: m[2]!.trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluator: a three-valued `#if` expression. A value is an integer, or `undefined` when the scanner cannot know it.

type Value = number | undefined;
type Tri = boolean | undefined;

type Token =
  | { kind: "num"; value: Value }
  | { kind: "id"; name: string }
  | { kind: "has"; spelling: string; angle: boolean }
  | { kind: "op"; op: string };

/** Thrown for an expression outside the grammar; the whole condition is then `undefined`. */
class Unsupported extends Error {}

const OPERATORS = ["&&", "||", "==", "!=", "<=", ">=", "!", "<", ">", "(", ")"];

function integer(spelling: string): Value {
  const m = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)?$/.exec(spelling);
  if (!m) return undefined;
  const digits = m[1]!;
  if (/^0[xX]/.test(digits)) return parseInt(digits.slice(2), 16);
  if (digits.length > 1 && digits.startsWith("0")) return parseInt(digits.slice(1), 8);
  return parseInt(digits, 10);
}

function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const rest = expr.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const num = /^[0-9][0-9A-Za-z_.']*/.exec(rest);
    if (num) {
      out.push({ kind: "num", value: integer(num[0]) });
      i += num[0].length;
      continue;
    }
    const has = /^__has_include\s*\(\s*(?:<([^>]*)>|"([^"]*)")\s*\)/.exec(rest);
    if (has) {
      out.push({ kind: "has", spelling: has[1] ?? has[2]!, angle: has[1] !== undefined });
      i += has[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (id) {
      out.push({ kind: "id", name: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (!op) throw new Unsupported(rest);
    out.push({ kind: "op", op });
    i += op.length;
  }
  return out;
}

function truth(v: Value): Tri {
  return v === undefined ? undefined : v !== 0;
}

function fromTri(t: Tri): Value {
  return t === undefined ? undefined : t ? 1 : 0;
}

/** Recursive descent over `|| && == != < > <= >= !`, parentheses, integers, names, `defined` and `__has_include`. */
class Evaluator {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly lookup: (name: string) => { defined: Tri; value: Value },
    private readonly hasInclude: ScanEnv["hasInclude"],
  ) {}

  run(): Value {
    if (this.tokens.length === 0) throw new Unsupported("empty");
    const v = this.or();
    if (this.pos !== this.tokens.length) throw new Unsupported("trailing tokens");
    return v;
  }

  private peekOp(...ops: string[]): string | undefined {
    const t = this.tokens[this.pos];
    return t?.kind === "op" && ops.includes(t.op) ? t.op : undefined;
  }

  private expectOp(op: string): void {
    if (!this.peekOp(op)) throw new Unsupported(`expected ${op}`);
    this.pos++;
  }

  // Kleene logic: a definite operand decides when it can (`0 && ?` is 0, `1 || ?` is 1); otherwise `undefined`.
  private or(): Value {
    let left = this.and();
    while (this.peekOp("||")) {
      this.pos++;
      const right = this.and();
      const l = truth(left);
      const r = truth(right);
      left = l === true || r === true ? 1 : l === false && r === false ? 0 : undefined;
    }
    return left;
  }

  private and(): Value {
    let left = this.equality();
    while (this.peekOp("&&")) {
      this.pos++;
      const right = this.equality();
      const l = truth(left);
      const r = truth(right);
      left = l === false || r === false ? 0 : l === true && r === true ? 1 : undefined;
    }
    return left;
  }

  private equality(): Value {
    let left = this.relational();
    for (let op = this.peekOp("==", "!="); op; op = this.peekOp("==", "!=")) {
      this.pos++;
      const right = this.relational();
      if (left === undefined || right === undefined) left = undefined;
      else left = fromTri(op === "==" ? left === right : left !== right);
    }
    return left;
  }

  private relational(): Value {
    let left = this.unary();
    for (let op = this.peekOp("<", ">", "<=", ">="); op; op = this.peekOp("<", ">", "<=", ">=")) {
      this.pos++;
      const right = this.unary();
      if (left === undefined || right === undefined) {
        left = undefined;
        continue;
      }
      if (op === "<") left = fromTri(left < right);
      else if (op === ">") left = fromTri(left > right);
      else if (op === "<=") left = fromTri(left <= right);
      else left = fromTri(left >= right);
    }
    return left;
  }

  private unary(): Value {
    if (this.peekOp("!")) {
      this.pos++;
      const t = truth(this.unary());
      return t === undefined ? undefined : fromTri(!t);
    }
    return this.primary();
  }

  private primary(): Value {
    const t = this.tokens[this.pos++];
    if (!t) throw new Unsupported("missing operand");
    if (t.kind === "num") return t.value;
    if (t.kind === "has") return fromTri(this.hasInclude(t.spelling, t.angle));
    if (t.kind === "op") {
      if (t.op !== "(") throw new Unsupported(t.op);
      const v = this.or();
      this.expectOp(")");
      return v;
    }
    if (t.name === "defined") return fromTri(this.lookup(this.definedOperand()).defined);
    if (this.peekOp("(")) {
      // A function-like macro (`__has_feature(x)`, `SOME_MACRO(1)`): skip its arguments; its value is unknown.
      this.skipParens();
      return undefined;
    }
    return this.lookup(t.name).value;
  }

  private definedOperand(): string {
    const paren = this.peekOp("(") !== undefined;
    if (paren) this.pos++;
    const t = this.tokens[this.pos++];
    if (t?.kind !== "id") throw new Unsupported("defined without a name");
    if (paren) this.expectOp(")");
    return t.name;
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const t = this.tokens[this.pos++];
      if (!t) throw new Unsupported("unbalanced parentheses");
      if (t.kind === "op" && t.op === "(") depth++;
      if (t.kind === "op" && t.op === ")") depth--;
    } while (depth > 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Branch stack and the scan.

interface Group {
  /** The state of the code around the group. */
  outer: Tri;
  /** The current branch's own state. */
  branch: Tri;
  /** An earlier branch's condition was definitely true: every later branch is false. */
  done: boolean;
  /** An earlier branch's condition was unknown: a later branch is at best unknown. */
  maybeDone: boolean;
}

function both(a: Tri, b: Tri): Tri {
  if (a === false || b === false) return false;
  return a === true && b === true ? true : undefined;
}

/** Opens or advances a group with a branch whose own condition is `cond`. */
function enter(group: Group, cond: Tri): void {
  group.branch = group.done || cond === false ? false : group.maybeDone ? undefined : cond;
  if (cond === true) group.done = true;
  if (cond === undefined) group.maybeDone = true;
}

const INCLUDES = new Set(["include", "import", "include_next"]);

/** The name a directive such as `#ifdef X` or `#define X 1` starts with. */
function firstName(rest: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
}

export function scanIncludes(text: string, env: ScanEnv): ScannedInclude[] {
  const list = directives(text);
  const stack: Group[] = [];
  /** Names the file defines or undefines where it may run: their values are no longer the env's. */
  const changed = new Set<string>();
  const state = (): Tri => (stack.length === 0 ? true : both(stack.at(-1)!.outer, stack.at(-1)!.branch));

  const lookup = (name: string): { defined: Tri; value: Value } => {
    const v = changed.has(name) ? undefined : env.defines.get(name);
    if (v === undefined) return { defined: undefined, value: undefined };
    return { defined: true, value: integer(v) };
  };
  const evaluate = (expr: string): Tri => {
    try {
      return truth(new Evaluator(tokenize(expr), lookup, (s, a) => env.hasInclude(s, a)).run());
    } catch (e) {
      if (e instanceof Unsupported) return undefined;
      throw e;
    }
  };
  const isDefined = (rest: string): Tri => {
    const name = firstName(rest);
    return name === undefined ? undefined : lookup(name).defined;
  };
  const not = (t: Tri): Tri => (t === undefined ? undefined : !t);

  const out: ScannedInclude[] = [];
  list.forEach((d, index) => {
    const here = state();
    switch (d.name) {
      case "if":
      case "ifdef":
      case "ifndef": {
        const group: Group = { outer: here, branch: false, done: false, maybeDone: false };
        let cond: Tri = false;
        if (here !== false) {
          cond = d.name === "if" ? evaluate(d.rest) : d.name === "ifdef" ? isDefined(d.rest) : not(isDefined(d.rest));
          if (cond === undefined && d.name === "ifndef" && index === 0 && isGuard(list, d.rest)) cond = true;
        }
        enter(group, cond);
        stack.push(group);
        return;
      }
      case "elif":
      case "elifdef":
      case "elifndef":
      case "else": {
        const group = stack.at(-1);
        if (!group) return;
        let cond: Tri = true;
        if (group.outer === false || group.done) cond = false;
        else if (d.name === "elif") cond = evaluate(d.rest);
        else if (d.name === "elifdef") cond = isDefined(d.rest);
        else if (d.name === "elifndef") cond = not(isDefined(d.rest));
        enter(group, cond);
        return;
      }
      case "endif":
        stack.pop();
        return;
      case "define":
      case "undef": {
        const name = firstName(d.rest);
        if (here !== false && name !== undefined) changed.add(name);
        return;
      }
    }
    if (!INCLUDES.has(d.name) || here === false) return;
    const m = /^(?:<([^>]*)>|"([^"]*)")/.exec(d.rest);
    if (!m) return; // `#include MACRO`: not checked (row 34)
    const spelling = m[1] ?? m[2]!;
    if (spelling === "") return;
    out.push({
      line: d.line,
      spelling,
      angle: m[1] !== undefined,
      certain: here === true && d.name !== "include_next",
    });
  });
  return out;
}

/** The file's first directive `#ifndef X` is a guard when the next directive is `#define X`. */
function isGuard(list: Directive[], rest: string): boolean {
  const name = firstName(rest);
  const next = list[1];
  return name !== undefined && next?.name === "define" && firstName(next.rest) === name;
}
