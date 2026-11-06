/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

/*:: import type {PodspecModel, PreprocessorDefine} from './spm-types'; */

/**
 * read-podspec.js — produces a flattened, SPM-friendly view of an iOS
 * podspec for the scaffolder.
 *
 * Strategy: prefer `pod ipc spec <path>` (CocoaPods evaluates the Ruby DSL,
 * including `install_modules_dependencies(s)` and `$config[:...]`
 * interpolation, so the JSON output reflects the real spec). Fall back to a
 * best-effort regex parser when CocoaPods isn't available — handles simple
 * RN libs but skips subspec blocks and Ruby helpers with a warning.
 *
 * The output `PodspecModel` collapses the spec's default subspecs into a
 * single logical target view, since that's how RN consumers compile these
 * libraries in practice.
 */

const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/*::
type RawSpec = {[string]: unknown};
*/

// ---------------------------------------------------------------------------
// Pod-IPC primary path
// ---------------------------------------------------------------------------

/**
 * Runs `pod ipc spec <path>` and parses the JSON it prints. Returns null
 * on any failure: CocoaPods missing, command threw, output not JSON, etc.
 * Callers should treat null as a signal to fall back to the regex parser.
 */
/**
 * Strips RN-specific Ruby helpers from a podspec source so `pod ipc spec`
 * can evaluate it without RN's Podfile-side helpers loaded. The stripped
 * helpers (`install_modules_dependencies(s)`) typically inject the React-Core
 * / React-Fabric family — all of which the scaffolder collapses into the
 * single `ReactNative` product anyway, so dropping them is safe as long as
 * the podspec also has an explicit `s.dependency "React-Core"` (almost all
 * RN libs do). Writes the patched content to a temp file and returns its
 * path; caller deletes when done.
 */
function patchPodspecForPodIpc(podspecPath /*: string */) /*: string */ {
  const content = fs.readFileSync(podspecPath, 'utf8');
  // Comment out RN-Podfile-only helpers. We do NOT remove the lines so
  // line numbers in any pod ipc errors still match the original file.
  const patched = content
    .replace(
      /^(\s*)install_modules_dependencies\(([^)]*)\)/gm,
      '$1# install_modules_dependencies($2) # stripped for pod ipc',
    )
    .replace(
      /^(\s*)use_react_native!\(([^)]*)\)/gm,
      '$1# use_react_native!($2) # stripped for pod ipc',
    );
  // Write the patched copy NEXT TO the original podspec, not in os.tmpdir.
  // Podspecs commonly do `File.read(File.join(__dir__, 'package.json'))` or
  // similar, expecting the package.json sibling. Keeping the patched file
  // in the same directory makes those reads continue to work.
  const depDir = path.dirname(podspecPath);
  // pod ipc only accepts files ending in `.podspec` or `.podspec.json`.
  // Use a dotfile prefix so the patched copy is invisible to normal listing
  // but the suffix CocoaPods requires is preserved.
  const tmpFile = path.join(
    depDir,
    `.spm-scaffold-${process.pid}-${path.basename(podspecPath)}`,
  );
  fs.writeFileSync(tmpFile, patched, 'utf8');
  return tmpFile;
}

function runPodIpcSpec(podspecPath /*: string */) /*: RawSpec | null */ {
  // RN podspecs often call `install_modules_dependencies(s)`, a helper
  // defined by RN's Podfile-side scripts. `pod ipc spec` doesn't load
  // those, so the helper is undefined and the whole spec fails to parse.
  // Pre-process to strip those calls before invoking pod ipc.
  let patchedPath /*: ?string */ = null;
  try {
    patchedPath = patchPodspecForPodIpc(podspecPath);
  } catch {
    return null;
  }
  let result;
  try {
    result = spawnSync('pod', ['ipc', 'spec', patchedPath], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      // Many RN podspecs gate subspec definitions on `RCT_NEW_ARCH_ENABLED`
      // (e.g. safe-area-context wraps its Fabric `common` + `fabric`
      // subspecs in `if fabric_enabled`), and react-native-worklets gates its
      // `-DHERMES_V1_ENABLED` flag on `RCT_HERMES_V1_ENABLED`. Give both the
      // value React Native's CocoaPods setup gives them (`RN_POD_ENV`, which
      // the regex fallback evaluates with too), whatever the environment
      // says, so `pod ipc spec` reads the podspec as that setup would.
      env: {...process.env, ...RN_POD_ENV},
    });
  } catch {
    cleanupPatchedPodspec(patchedPath);
    return null;
  }
  cleanupPatchedPodspec(patchedPath);
  if (result == null || result.error != null) {
    return null;
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    return null;
  }
  if (typeof result.stdout !== 'string' || result.stdout.length === 0) {
    return null;
  }
  // Some podspecs print diagnostics to stdout during evaluation (e.g. skia:
  // `-- SK_GRAPHITE: OFF ...`) before `pod ipc` emits the JSON, and a
  // diagnostic can itself contain braces (`Building {module}`). `pod ipc`
  // pretty-prints the spec as a JSON object whose outermost braces sit at
  // column 0, so ANCHOR on a line-boundary `{`…`}` rather than the first/last
  // brace anywhere — otherwise a brace inside a diagnostic shifts the slice and
  // JSON.parse throws. When the authoritative parse is abandoned we log (not
  // silently drop to the much weaker, subspec-blind regex parser).
  const stdout = result.stdout;
  const startMatch = stdout.match(/^\{/m);
  const start = startMatch != null ? startMatch.index : -1;
  const lastLineBrace = stdout.lastIndexOf('\n}');
  const end =
    lastLineBrace >= 0 ? lastLineBrace + 2 : stdout.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) {
    console.warn(
      '[read-podspec] pod ipc spec produced no line-anchored JSON object; ' +
        'falling back to the regex parser (subspecs/helpers may be missed).',
    );
    return null;
  }
  try {
    return JSON.parse(stdout.slice(start, end));
  } catch (e) {
    console.warn(
      `[read-podspec] pod ipc spec JSON parse failed (${e.message}); ` +
        'falling back to the regex parser (subspecs/helpers may be missed).',
    );
    return null;
  }
}

function cleanupPatchedPodspec(patchedPath /*: ?string */) /*: void */ {
  if (patchedPath == null) return;
  try {
    fs.unlinkSync(patchedPath);
  } catch {
    // best-effort cleanup; the file is named with `.spm-scaffold-...tmp`
    // so a leftover is identifiable.
  }
}

// ---------------------------------------------------------------------------
// Regex fallback
// ---------------------------------------------------------------------------

// Ruby locals and conditions. Podspecs hoist globs, extension lists and flags
// into locals and set them under conditions; react-native-screens 4.24.0:
//
//   new_arch_enabled = ENV['RCT_NEW_ARCH_ENABLED'] == '1'
//   source_files_exts =
//     new_arch_enabled ? '{h,m,mm,cpp,swift}' : '{h,m,mm,swift}'
//   source_files = ["ios/**/*.#{source_files_exts}"]
//   if !new_arch_enabled
//     source_files.push("cpp/RNScreensTurboModule.cpp", ...)
//   end
//   ...
//   s.source_files = source_files
//   if !gamma_project_enabled
//     s.exclude_files = "ios/gamma/**/*.#{source_files_exts}"
//   else ...
//
// The field regexes below only understand literals, so this pre-pass runs the
// podspec's statements in order over a small, side-effect-free subset of Ruby
// and leaves the regexes a flat text:
//
// - values: string literals (single quotes verbatim, double quotes with
//   `#{expr}` interpolation), `%w[...]`, array literals, numbers, `true`,
//   `false`, `nil`, and locals (`name = expr`, also `+=` and `||=`; the last
//   assignment that runs wins, as in Ruby);
// - `ENV['X']` and `ENV.fetch('X', default)`: `RCT_NEW_ARCH_ENABLED` and
//   `RCT_HERMES_V1_ENABLED` are `1` (below), every other variable is unset.
//   The environment is never read, so a scaffold does not depend on the shell;
// - `==`, `!=`, `!`/`not`, `&&`/`and`, `||`/`or`, `+` on strings and arrays,
//   `a ? b : c`, `array.join(sep)`, `.to_s`, `.freeze`;
// - `if`/`elsif`/`else`/`unless`/`end` blocks and `stmt if cond` / `stmt
//   unless cond` modifiers, at the top level and inside the spec and subspec
//   blocks: a branch that does not run is blanked, the control lines of a
//   condition that was evaluated are dropped;
// - `local.push(...)`, `local.append(...)`, `local.concat(...)`, `local << x`;
// - `recv.<field> = expr` on the spec or a subspec (`s.`, `s.ios.`, `ss.`):
//   a value that is not already a literal is rewritten to the literal it
//   evaluates to. Inside a hash (`pod_target_xcconfig`, `resource_bundles`),
//   `=> local` is replaced by the local's value.
//
// Anything else (method calls, hashes, symbols, `$config[...]`, blocks other
// than the spec's, conditions on any of these) is not evaluated: the text
// stays as written, and a local assigned from it, or under such a condition, is
// unknown from there on. Both branches of such a condition stay visible, as
// before (react-native-vision-camera's `if enableFrameProcessors` subspec). A
// `source_files` or `exclude_files` value that uses something unknown is
// returned in `unresolved`, and the scaffolder refuses the library
// (unresolvedSourcesReason): a glob read in part gives a target that builds
// and lacks the library's classes, so the app crashes at start
// (react-native-screens 4.24.0 lost all of ios/).
//
// `RCT_NEW_ARCH_ENABLED` and `RCT_HERMES_V1_ENABLED` get the value React
// Native's CocoaPods setup gives every pod, `1` for both. React Native 0.87+
// sets both to `1` outright, and the prebuilt artifacts are V1 Hermes, so a
// `0` left in the shell could only break the build (and a persisted scaffold).
// react-native-worklets puts `hermes_v1_flag = ENV['RCT_HERMES_V1_ENABLED'] ==
// '1' ? '-DHERMES_V1_ENABLED' : ''` in OTHER_CFLAGS; without the define it
// includes the legacy Hermes inspector headers, which the prebuilt artifacts
// do not ship.
const RN_POD_ENV /*: {[string]: string} */ = {
  RCT_NEW_ARCH_ENABLED: '1',
  RCT_HERMES_V1_ENABLED: '1',
};

// A value the evaluator could not compute, and why.
class RubyUnresolved {
  /*:: why: string; */
  constructor(why /*: string */) {
    this.why = why;
  }
}
const isUnresolved = (v /*: mixed */) /*: boolean */ =>
  v instanceof RubyUnresolved;

// The source-glob fields an unevaluated expression must not reach silently.
const STRICT_FIELDS /*: Set<string> */ = new Set([
  'source_files',
  'exclude_files',
]);
const PLATFORM_SCOPES /*: Set<string> */ = new Set([
  'ios',
  'osx',
  'macos',
  'tvos',
  'visionos',
  'watchos',
]);

// Tokens of one Ruby expression. A double-quoted string keeps its parts:
// literal text and the source of each `#{...}`.
function tokenizeRubyExpr(src /*: string */) /*: Array<any> */ {
  const tokens = [];
  let i = 0;
  // The end of a `#{...}` starting at `from` (just past `#{`), or -1.
  const interpEnd = (from /*: number */) => {
    let depth = 1;
    let quote = '';
    for (let j = from; j < src.length; j++) {
      const c = src[j];
      if (quote !== '') {
        if (c === '\\') j++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j;
    }
    return -1;
  };
  const CLOSE = {'[': ']', '(': ')', '{': '}', '<': '>'};
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      let v = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== "'"; j++) {
        if (src[j] === '\\' && (src[j + 1] === "'" || src[j + 1] === '\\')) {
          v += src[++j];
        } else v += src[j];
      }
      if (j >= src.length) return [{t: 'bad', v: src.slice(i)}];
      tokens.push({t: 'str', parts: [v]});
      i = j + 1;
    } else if (c === '"') {
      const parts = [];
      let v = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') {
          const e = src[++j];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else if (src[j] === '#' && src[j + 1] === '{') {
          const end = interpEnd(j + 2);
          if (end < 0) return [{t: 'bad', v: src.slice(i)}];
          parts.push(v, {expr: src.slice(j + 2, end)});
          v = '';
          j = end;
        } else v += src[j];
      }
      if (j >= src.length) return [{t: 'bad', v: src.slice(i)}];
      parts.push(v);
      tokens.push({t: 'str', parts});
      i = j + 1;
    } else if (c === '%' && /^%w[[({<]/.test(src.slice(i, i + 3))) {
      const close = CLOSE[src[i + 2]];
      const end = src.indexOf(close, i + 3);
      if (end < 0) return [{t: 'bad', v: src.slice(i)}];
      tokens.push({
        t: 'words',
        v: src
          .slice(i + 3, end)
          .split(/\s+/)
          .filter(Boolean),
      });
      i = end + 1;
    } else if (/[0-9]/.test(c)) {
      const m = src.slice(i).match(/^[0-9][0-9_.]*/);
      const text = m != null ? m[0] : c;
      tokens.push({t: 'num', v: Number(text.replace(/_/g, ''))});
      i += text.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_]\w*(?:[?!](?=\())?/);
      const text = m != null ? m[0] : c;
      tokens.push({t: 'id', v: text});
      i += text.length;
    } else if (c === ':' && /[A-Za-z_"']/.test(src[i + 1] ?? '')) {
      tokens.push({t: 'bad', v: src.slice(i)}); // a symbol
      i = src.length;
    } else {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '&&', '||', '=>', '::', '<<', '=~'].includes(two)) {
        tokens.push({t: 'op', v: two});
        i += 2;
      } else {
        tokens.push({t: 'op', v: c});
        i++;
      }
    }
  }
  return tokens;
}

const rubyTruthy = (v /*: mixed */) /*: boolean */ => v !== false && v != null;

function rubyEqual(a /*: mixed */, b /*: mixed */) /*: boolean */ {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, k) => rubyEqual(x, b[k]));
  }
  return a === b;
}

// `#{v}`: Ruby's to_s for the values the evaluator knows.
function rubyToS(v /*: mixed */) /*: string | RubyUnresolved */ {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return new RubyUnresolved('an array or hash inside `#{...}`');
}

/**
 * Evaluates one Ruby expression with the locals in `env`. Returns the value,
 * or a RubyUnresolved saying why it cannot. `list` reads a bare comma list
 * (`s.x = "a", "b"`) as an array. Never runs anything.
 */
function evalRubyExpr(
  src /*: string */,
  env /*: Map<string, mixed> */,
  list /*:: ?: boolean */,
) /*: mixed */ {
  const tokens = tokenizeRubyExpr(src);
  let pos = 0;
  const peek = (v /*: string */) =>
    tokens[pos] != null &&
    (tokens[pos].t === 'op' || tokens[pos].t === 'id') &&
    tokens[pos].v === v;
  const take = (v /*: string */) => {
    if (!peek(v)) return false;
    pos++;
    return true;
  };
  const fail = (why /*: string */) => new RubyUnresolved(why);
  // Skips a balanced (...) / [...] / {...} group starting at `pos`.
  const skipGroup = () => {
    let depth = 0;
    do {
      const tk = tokens[pos++];
      if (tk == null) return;
      if (tk.t === 'op' && '([{'.includes(tk.v)) depth++;
      if (tk.t === 'op' && ')]}'.includes(tk.v)) depth--;
    } while (depth > 0);
  };
  // Comma-separated expressions up to `close` (already past the opener).
  const parseItems = (close /*: string */) => {
    const items = [];
    while (!peek(close)) {
      if (tokens[pos] == null) return fail(`a missing \`${close}\``);
      items.push(parseTernary());
      if (!take(',')) break;
    }
    if (!take(close)) return fail(`a missing \`${close}\``);
    return items.find(isUnresolved) ?? items;
  };
  function parsePrimary() /*: mixed */ {
    const tk = tokens[pos++];
    if (tk == null) return fail('an incomplete expression');
    if (tk.t === 'str') {
      let out = '';
      for (const part of tk.parts) {
        if (typeof part === 'string') {
          out += part;
          continue;
        }
        const inner = evalRubyExpr(part.expr, env);
        if (isUnresolved(inner)) return inner;
        const s = rubyToS(inner);
        if (isUnresolved(s)) return s;
        out += (s /*: any */);
      }
      return out;
    }
    if (tk.t === 'words') return tk.v;
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'bad') return fail(`\`${tk.v}\``);
    if (tk.t === 'op') {
      if (tk.v === '(') {
        const v = parseTernary();
        return take(')') ? v : fail('a missing `)`');
      }
      if (tk.v === '[') return parseItems(']');
      if (tk.v === '{') return fail('a hash');
      return fail(`\`${tk.v}\``);
    }
    // An identifier.
    const name = tk.v;
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'nil') return null;
    if (name === 'ENV') {
      if (take('[')) {
        const key = parseTernary();
        if (!take(']')) return fail('a missing `]`');
        if (isUnresolved(key)) return key;
        return typeof key === 'string' && Object.hasOwn(RN_POD_ENV, key)
          ? RN_POD_ENV[key]
          : null;
      }
      if (take('.') && take('fetch') && take('(')) {
        const args = parseItems(')');
        if (isUnresolved(args)) return args;
        const [key, fallback] = (args /*: any */);
        if (typeof key !== 'string') return fail('`ENV.fetch` of a non-string');
        return Object.hasOwn(RN_POD_ENV, key) ? RN_POD_ENV[key] : fallback;
      }
      return fail('`ENV` used other than `ENV[...]` or `ENV.fetch(...)`');
    }
    if (peek('(')) {
      skipGroup();
      return fail(`the method call \`${name}(...)\``);
    }
    if (!env.has(name)) return fail(`the unknown identifier \`${name}\``);
    const v = env.get(name);
    if (isUnresolved(v)) {
      return fail(`\`${name}\`, which ${(v /*: any */).why}`);
    }
    return v;
  }
  function parsePostfix() /*: mixed */ {
    let v = parsePrimary();
    while (peek('.') || peek('[')) {
      if (take('[')) {
        pos--;
        skipGroup();
        v = isUnresolved(v) ? v : fail('an index `[...]`');
        continue;
      }
      take('.');
      const m = tokens[pos++];
      const method = m != null && m.t === 'id' ? m.v : '?';
      let args = [];
      if (peek('(')) {
        pos++;
        const got = parseItems(')');
        if (isUnresolved(got)) {
          v = isUnresolved(v) ? v : got;
          continue;
        }
        args = (got /*: any */);
      }
      if (isUnresolved(v)) continue;
      if ((method === 'freeze' || method === 'to_s') && typeof v === 'string') {
        continue;
      }
      if (method === 'join' && Array.isArray(v)) {
        const sep = args.length > 0 ? args[0] : '';
        const parts = v.flat(Infinity).map(rubyToS);
        const bad = parts.find(isUnresolved);
        v =
          bad ?? (typeof sep === 'string' ? parts.join(sep) : fail('`join`'));
        continue;
      }
      v = fail(`the method call \`.${method}\``);
    }
    return v;
  }
  function parseUnary() /*: mixed */ {
    if (take('!')) {
      const v = parseUnary();
      return isUnresolved(v) ? v : !rubyTruthy(v);
    }
    return parsePostfix();
  }
  function parseAdd() /*: mixed */ {
    let l = parseUnary();
    while (take('+')) {
      const r = parseUnary();
      if (isUnresolved(l)) continue;
      if (isUnresolved(r)) l = r;
      else if (typeof l === 'string' && typeof r === 'string') l = l + r;
      else if (Array.isArray(l) && Array.isArray(r)) l = [...l, ...r];
      else l = fail('`+` on values other than two strings or two arrays');
    }
    return l;
  }
  function parseEq() /*: mixed */ {
    const l = parseAdd();
    if (peek('==') || peek('!=')) {
      const op = tokens[pos++].v;
      const r = parseAdd();
      if (isUnresolved(l)) return l;
      if (isUnresolved(r)) return r;
      return op === '==' ? rubyEqual(l, r) : !rubyEqual(l, r);
    }
    if (peek('=~') || peek('<') || peek('>')) {
      return fail(`the operator \`${tokens[pos].v}\``);
    }
    return l;
  }
  function parseNot() /*: mixed */ {
    if (take('not')) {
      const v = parseNot();
      return isUnresolved(v) ? v : !rubyTruthy(v);
    }
    return parseEq();
  }
  function parseAnd() /*: mixed */ {
    let l = parseNot();
    while (take('&&') || take('and')) {
      const r = parseNot();
      if (!isUnresolved(l) && rubyTruthy(l)) l = r;
    }
    return l;
  }
  function parseOr() /*: mixed */ {
    let l = parseAnd();
    while (take('||') || take('or')) {
      const r = parseAnd();
      if (!isUnresolved(l) && !rubyTruthy(l)) l = r;
    }
    return l;
  }
  function parseTernary() /*: mixed */ {
    const c = parseOr();
    if (!take('?')) return c;
    const a = parseTernary();
    if (!take(':')) return fail('a ternary without `:`');
    const b = parseTernary();
    if (isUnresolved(c)) return c;
    return rubyTruthy(c) ? a : b;
  }
  let value = parseTernary();
  if (list === true && peek(',')) {
    const items = [value];
    while (take(',')) items.push(parseTernary());
    value = items.find(isUnresolved) ?? items;
  }
  if (pos < tokens.length && !isUnresolved(value)) {
    const rest = tokens[pos];
    return fail(
      rest.t === 'op' || rest.t === 'id'
        ? `\`${rest.v}\` where it ends`
        : 'more than one expression',
    );
  }
  return value;
}

// A literal the field regexes read as written: quoted strings without
// `#{...}`, as one value, an array or a bare list.
function isPlainLiteral(rhs /*: string */) /*: boolean */ {
  const str = `(?:"[^"\\\\#]*"|'[^'\\\\]*')`;
  const list = `${str}(?:\\s*,\\s*${str})*`;
  return new RegExp(
    `^(?:${list}|\\[\\s*(?:${list}\\s*,?)?\\s*\\]|true|false)$`,
  ).test(rhs.trim());
}

// The literal a field is rewritten to, or null when the value has none.
function rubyLiteral(v /*: mixed */) /*: ?string */ {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const flat = v.flat(Infinity);
    if (!flat.every(x => typeof x === 'string')) return null;
    return '[' + flat.map(x => JSON.stringify(x)).join(', ') + ']';
  }
  return null;
}

// The podspec's logical statements: lines joined while a bracket or string is
// open or the line ends in `,`, `\`, an operator or `=`. A heredoc's body
// belongs to the statement that opens it. `code` is the statement without
// trailing comments.
function rubyStatements(
  lines /*: Array<string> */,
) /*: Array<{start: number, end: number, code: string}> */ {
  const out = [];
  const scan = (
    line /*: string */,
    state /*: {depth: number, quote: string} */,
  ) => {
    let code = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (state.quote !== '') {
        code += c;
        if (c === '\\') code += line[++i] ?? '';
        else if (c === state.quote) state.quote = '';
        continue;
      }
      if (c === '#') break;
      code += c;
      if (c === '"' || c === "'") state.quote = c;
      else if ('([{'.includes(c)) state.depth++;
      else if (')]}'.includes(c)) state.depth--;
    }
    return code;
  };
  let i = 0;
  while (i < lines.length) {
    const start = i;
    const state = {depth: 0, quote: ''};
    const codes = [];
    let heredoc = null;
    while (i < lines.length) {
      const code = scan(lines[i], state);
      codes.push(code);
      i++;
      const h = code.match(/<<([-~]?)(["']?)([A-Za-z_]\w*)\2\s*$/);
      if (h != null && state.quote === '') {
        heredoc = {indented: h[1] !== '', id: h[3]};
        break;
      }
      const open =
        state.depth > 0 ||
        state.quote !== '' ||
        /(?:,|\\|&&|\|\||[^=!<>]=|\+|\s\?|\s:)\s*$/.test(code);
      if (!open) break;
    }
    if (i >= lines.length && (state.depth > 0 || state.quote !== '')) {
      // Never closed: read the first line alone and go on from the next.
      const code = scan(lines[start], {depth: 0, quote: ''});
      out.push({start, end: start, code});
      i = start + 1;
      continue;
    }
    if (heredoc != null) {
      const {indented, id} = heredoc;
      while (i < lines.length) {
        const l = lines[i++];
        if ((indented ? l.trim() : l) === id) break;
      }
    }
    out.push({start, end: i - 1, code: codes.join('\n')});
  }
  return out;
}

// The index of a trailing `if`/`unless` modifier outside strings and brackets.
function modifierIndex(code /*: string */) /*: ?{at: number, kw: string} */ {
  let quote = '';
  let depth = 0;
  for (let i = 1; i < code.length; i++) {
    const c = code[i];
    if (quote !== '') {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && /\s/.test(code[i - 1])) {
      const m = code.slice(i).match(/^(if|unless)\s/);
      if (m != null) return {at: i, kw: m[1]};
    }
  }
  return null;
}

/*::
type Unresolved = {field: string, expr: string, why: string};
type Activity = {state: 'yes' | 'no' | 'maybe' | 'opaque', why: string};
*/

// Why a local set under `act` is unknown from there on.
function unknownUnder(act /*: Activity */) /*: RubyUnresolved */ {
  return new RubyUnresolved(
    act.state === 'maybe'
      ? `is set under \`${act.why}\`, a condition the reader cannot evaluate`
      : `is set inside \`${act.why}\`, a block the reader does not run`,
  );
}

// The branch an `elsif` opens, and what is known of the branches before it.
function elsifBranch(
  prior /*: string */,
  cond /*: string */,
) /*: {branch: string, prior: string} */ {
  if (prior === 'yes') return {branch: 'no', prior: 'yes'};
  if (prior === 'no') return {branch: cond, prior: cond};
  // An earlier branch may have run.
  return {
    branch: cond === 'no' ? 'no' : 'maybe',
    prior: cond === 'yes' ? 'yes' : 'maybe',
  };
}

/**
 * Runs the podspec's statements over the subset above. Returns the rewritten
 * text (same line count) and each `source_files`/`exclude_files` assignment
 * whose value could not be evaluated.
 */
function evaluateRubyLocals(
  content /*: string */,
) /*: {text: string, unresolved: Array<Unresolved>} */ {
  const lines = content.split('\n');
  const out = lines.slice();
  const env /*: Map<string, mixed> */ = new Map();
  const recvs /*: Set<string> */ = new Set();
  const unresolved /*: Array<Unresolved> */ = [];
  // `if` blocks (which branch is being read) and other blocks.
  const frames /*: Array<any> */ = [];
  const blank = (st /*: {start: number, end: number} */) => {
    for (let k = st.start; k <= st.end; k++) out[k] = '';
  };
  // Whether the statement being read runs: 'yes', 'no', 'maybe' (under a
  // condition it cannot evaluate) or 'opaque' (in a block it does not run),
  // with the condition or block that decides.
  const activity = () /*: Activity */ => {
    let act /*: Activity */ = {state: 'yes', why: ''};
    for (const f of frames) {
      const s = f.kind === 'if' ? f.branch : f.opaque ? 'opaque' : 'yes';
      if (s === 'no') return {state: 'no', why: ''};
      if (s !== 'yes' && act.state === 'yes') {
        act = {state: s, why: f.kind === 'if' ? f.cond : f.code};
      }
    }
    return act;
  };
  const condOf = (src /*: string */, negate /*: boolean */) => {
    const v = evalRubyExpr(src, env);
    if (isUnresolved(v)) return 'maybe';
    return rubyTruthy(v) !== negate ? 'yes' : 'no';
  };
  // Lines that stay as written: `#{local}` (a known string) in their
  // double-quoted literals, and `=> local` inside a hash, get the value.
  const interpolate = (
    st /*: {start: number, end: number} */,
    hash /*: boolean */,
  ) => {
    const known = (id /*: string */) => {
      const v = env.get(id);
      return typeof v === 'string' ? v : null;
    };
    for (let k = st.start; k <= st.end; k++) {
      out[k] = out[k].replace(
        /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
        lit =>
          lit[0] === '"'
            ? lit.replace(
                /#\{\s*([A-Za-z_]\w*)\s*\}/g,
                (whole, id) => known(id) ?? whole,
              )
            : lit,
      );
      if (hash) {
        out[k] = out[k].replace(
          /(=>\s*)([A-Za-z_]\w*)(?=\s*(?:,|\}|$))/g,
          (whole, arrow, id) => {
            const lit = env.has(id) ? rubyLiteral(env.get(id)) : null;
            return lit != null ? arrow + lit : whole;
          },
        );
      }
    }
  };
  const setLocal = (
    name /*: string */,
    value /*: mixed */,
    act /*: Activity */,
  ) => {
    env.set(name, act.state === 'yes' ? value : unknownUnder(act));
  };

  for (const st of rubyStatements(lines)) {
    const code = st.code.trim();
    if (code === '') continue;
    const act = activity();
    const oneLine = /[\s;]end\s*;?$/.test(code);
    const top = frames[frames.length - 1];
    let m;
    m = oneLine ? null : code.match(/^(if|unless)\s+([\s\S]+?)(?:\s+then)?$/);
    if (m != null) {
      // Under a branch that does not run, every branch is dead.
      const branch =
        act.state === 'no' || act.state === 'opaque'
          ? act.state
          : condOf(m[2], m[1] === 'unless');
      frames.push({
        kind: 'if',
        branch,
        prior: act.state === 'no' ? 'yes' : branch,
        cond: m[2],
        evaluated: branch !== 'maybe' && branch !== 'opaque',
        ctrl: [st],
      });
      continue;
    }
    if (top?.kind === 'if') {
      if ((m = code.match(/^elsif\s+([\s\S]+?)(?:\s+then)?$/))) {
        top.ctrl.push(st);
        if (top.branch === 'opaque') continue;
        const cond = top.prior === 'yes' ? 'no' : condOf(m[1], false);
        if (cond === 'maybe') top.evaluated = false;
        Object.assign(top, elsifBranch(top.prior, cond), {cond: m[1]});
        continue;
      }
      if (code === 'else') {
        top.ctrl.push(st);
        if (top.branch !== 'opaque') {
          top.branch = {yes: 'no', no: 'yes', maybe: 'maybe'}[top.prior];
        }
        continue;
      }
    }
    if (/^end\b/.test(code) && top != null) {
      frames.pop();
      // An evaluated condition leaves no control lines behind.
      if (activity().state === 'no' || (top.kind === 'if' && top.evaluated)) {
        for (const c of top.kind === 'if' ? top.ctrl : []) blank(c);
        blank(st);
      }
      continue;
    }
    const opensBlock =
      !oneLine &&
      (/^(?:case|begin|while|until|for|def|class|module)\b/.test(code) ||
        /\bdo(?:\s*\|[^|]*\|)?\s*$/.test(code) ||
        /=\s*(?:if|unless|case|begin)\b/.test(code));
    if (opensBlock) {
      // The spec's and its subspecs' blocks run; any other is opaque.
      const spec = code.match(/Pod::Spec\.new\s+do\s*\|\s*(\w+)\s*\|\s*$/);
      const sub = code.match(
        /^(\w+)\.subspec\s[\s\S]*\bdo\s*\|\s*(\w+)\s*\|\s*$/,
      );
      const recv =
        spec?.[1] ?? (sub != null && recvs.has(sub[1]) ? sub[2] : null);
      if (recv != null) recvs.add(recv);
      const assigned = code.match(/^([A-Za-z_]\w*)\s*=/);
      if (assigned != null) {
        setLocal(assigned[1], null, {state: 'opaque', why: code});
      }
      frames.push({kind: 'block', opaque: recv == null, code});
      if (act.state === 'no') blank(st);
      continue;
    }
    if (act.state === 'no') {
      blank(st);
      continue;
    }
    // A trailing `if`/`unless` modifier.
    let core = code;
    let stAct = act;
    const mod = modifierIndex(code);
    if (mod != null) {
      core = code.slice(0, mod.at).trim();
      const cond = code.slice(mod.at + mod.kw.length).trim();
      const c =
        act.state === 'yes' ? condOf(cond, mod.kw === 'unless') : act.state;
      if (c === 'no') {
        blank(st);
        continue;
      }
      if (c === 'maybe' && act.state === 'yes') {
        stAct = {state: 'maybe', why: cond};
      }
    }
    // `recv.field = expr` on the spec or a subspec. Under a condition it
    // cannot evaluate, or in a block it does not run, it is read as if it ran,
    // as the field regexes always did: a literal stays as written, an
    // expression is evaluated or, in a source glob, refused.
    const field = core.match(
      /^([A-Za-z_]\w*)(?:\.([a-z]+))?\.([a-z_]+)\s*=(?![=~>])\s*([\s\S]+)$/,
    );
    if (
      field != null &&
      recvs.has(field[1]) &&
      (field[2] == null || PLATFORM_SCOPES.has(field[2]))
    ) {
      const [, recv, scope, name, rhs] = field;
      // Only the spec's own and its `ios` scope count.
      if ((scope != null && scope !== 'ios') || isPlainLiteral(rhs)) continue;
      const lhs = `${recv}${scope != null ? '.' + scope : ''}.${name}`;
      const v = evalRubyExpr(rhs, env, true);
      const lit = isUnresolved(v) ? null : rubyLiteral(v);
      if (lit != null) {
        blank(st);
        const indent = (lines[st.start].match(/^\s*/) ?? [''])[0];
        out[st.start] = `${indent}${lhs} = ${lit}`;
      } else if (STRICT_FIELDS.has(name)) {
        unresolved.push({
          field: lhs,
          expr: rhs.trim(),
          why: isUnresolved(v)
            ? `it uses ${(v /*: any */).why}`
            : 'its value is not a string or an array of strings',
        });
      } else {
        interpolate(st, /^\{/.test(rhs.trim()));
      }
      continue;
    }
    // `name = expr`, `name += expr`, `name ||= expr`.
    const assign = core.match(
      /^([A-Za-z_]\w*)\s*(\+=|\|\|=|=)(?![=~>])\s*([\s\S]+)$/,
    );
    if (assign != null && !recvs.has(assign[1])) {
      const [, name, op, rhs] = assign;
      let v = evalRubyExpr(rhs, env);
      if (op !== '=' && !isUnresolved(v)) {
        const vars = new Map([
          ['old', env.has(name) ? env.get(name) : null],
          ['new', v],
        ]);
        v = evalRubyExpr(op === '+=' ? 'old + new' : 'old || new', vars);
      }
      if (isUnresolved(v)) {
        v = new RubyUnresolved(
          `is assigned \`${rhs.trim()}\`, which the reader cannot evaluate ` +
            `(${(v /*: any */).why})`,
        );
      }
      setLocal(name, v, stAct);
      interpolate(st, false);
      continue;
    }
    // `name.push(...)`, `name << x`; any other change to a local makes it
    // unknown.
    const change = core.match(/^([A-Za-z_]\w*)\s*(?:\.|\[|<<)/);
    if (change != null && env.has(change[1]) && !recvs.has(change[1])) {
      const name = change[1];
      const old = env.get(name);
      const add =
        core.match(/^\w+\s*\.(push|append|concat)\s*\(([\s\S]*)\)$/) ??
        core.match(/^\w+\s*\.(push|append|concat)\s+([\s\S]+)$/) ??
        core.match(/^\w+\s*(<<)\s*([\s\S]+)$/);
      let v /*: mixed */ = new RubyUnresolved(
        `is changed by \`${core}\`, which the reader cannot evaluate`,
      );
      if (add != null && Array.isArray(old)) {
        // `<<` adds one value; push/append/concat take a list.
        const args = evalRubyExpr(
          add[1] === '<<' ? `[(${add[2]})]` : `[${add[2]}]`,
          env,
        );
        if (Array.isArray(args)) {
          if (add[1] !== 'concat') v = [...old, ...args];
          else if (args.every(Array.isArray)) v = [...old, ...args.flat()];
        }
      }
      setLocal(name, v, stAct);
      continue;
    }
    interpolate(st, false);
  }
  return {text: out.join('\n'), unresolved};
}

// The library's own version. Podspecs load the package.json next to them
// (`package = JSON.parse(File.read(File.join(__dir__, "package.json")))`, or
// `File.dirname(__FILE__)`) and interpolate `#{package['version']}` (also
// `#{package["version"]}`, any variable name) into flags such as
// `-DWORKLETS_VERSION=...`. Those references are replaced by the version read
// from that package.json, inside double-quoted strings only (as in Ruby);
// anything else stays as written, so other interpolations are still dropped.
function resolvePackageVersion(
  content /*: string */,
  podspecDir /*: string */,
) /*: string */ {
  const loadRe =
    /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*JSON\.parse\(\s*File\.read\(\s*File\.join\(\s*(?:__dir__|File\.dirname\(\s*__FILE__\s*\))\s*,\s*(["'])package\.json\2\s*\)\s*\)\s*\)/gm;
  const vars = Array.from(content.matchAll(loadRe), m => m[1]);
  if (vars.length === 0) return content;
  let version = null;
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(podspecDir, 'package.json'), 'utf8'),
    ).version;
  } catch {
    return content;
  }
  if (typeof version !== 'string' || version.length === 0) return content;
  const ref = new RegExp(
    `#\\{\\s*(?:${Array.from(new Set(vars)).join('|')})\\s*\\[\\s*(["'])version\\1\\s*\\]\\s*\\}`,
    'g',
  );
  const v /*: string */ = version;
  // A double-quoted literal may hold `#{package["version"]}` with its own
  // quotes, so the scan steps over `#{...}` as a unit.
  return content.replace(
    /"(?:[^"\\\n#]|\\.|#\{[^}\n]*\}|#(?!\{))*"|'(?:[^'\\\n]|\\.)*'/g,
    lit => (lit[0] === '"' ? lit.replace(ref, () => v) : lit),
  );
}

// Comment-only lines are dropped so a commented-out `# s.header_dir` cannot win
// over the live one. A trailing `#` and a `#` inside a string survive: only the
// first non-whitespace character counts.
function readPodspecEvaluated(
  podspecPath /*: string */,
) /*: {text: string, unresolved: Array<Unresolved>} */ {
  return evaluateRubyLocals(
    resolvePackageVersion(
      fs
        .readFileSync(podspecPath, 'utf8')
        .split('\n')
        .filter(line => !/^\s*#/.test(line))
        .join('\n'),
      path.dirname(podspecPath),
    ),
  );
}
function readPodspecSource(podspecPath /*: string */) /*: string */ {
  return readPodspecEvaluated(podspecPath).text;
}

// The main spec's block variable: `Pod::Spec.new do |podspec|` -> `podspec`.
// Falls back to the two conventional names when the header is not found.
function mainReceiverName(content /*: string */) /*: string */ {
  const m = content.match(/Pod::Spec\.new\s+do\s*\|\s*(\w+)\s*\|/);
  return m != null ? m[1] : 's|spec';
}

// The main spec's receiver as a regex source. The lookbehind keeps it from
// matching INSIDE a longer identifier or a member chain: `ss.source_files` (a
// subspec's block variable) contains the substring `s.source_files`, which
// used to be read as the main spec's own field.
function mainRecvPattern(name /*: string */) /*: string */ {
  return `(?<![\\w.])(?:${name})`;
}

// A subspec that re-binds a receiver the identity regexes trust: inside
// `s.subspec "common" do |s|`, `s` is the CHILD, and no regex over flat text
// can see that. Any other block variable (`do |ss|`) is unambiguous.
function shadowingSubspecRe(name /*: string */) /*: RegExp */ {
  return new RegExp(
    `\\.subspec\\s+["'][^"']*["']\\s+do\\s*\\|\\s*(?:${name})\\s*\\|`,
  );
}

function subspecOpenRe(name /*: string */) /*: RegExp */ {
  return new RegExp(
    `(?:^|[;\\s])(?:${name})\\.subspec\\s+["']([^"']+)["']\\s+do\\s*\\|\\s*(\\w+)\\s*\\|[^\\n]*`,
    'g',
  );
}

// Ruby block openers/closers, line-based: enough to find the `end` that closes
// a subspec body. Strings and heredocs containing these words are not
// understood.
function blockDelta(line /*: string */) /*: number */ {
  const t = stripTrailingComment(line).trim();
  let d = 0;
  const startsBlock = /^(?:if|unless|case|begin|while|until|for|def)\b/.test(t);
  if (startsBlock) d++;
  else if (/\bdo(?:\s*\|[^|]*\|)?\s*$/.test(t)) d++;
  // `if … end` / `unless … end` opened and closed on the same line: net 0.
  if (startsBlock && /[\s;]end\s*;?$/.test(t)) d--;
  if (/^end\b/.test(t)) d--;
  return d;
}

// Drops a trailing `# comment`: the first `#` outside a quoted string.
function stripTrailingComment(line /*: string */) /*: string */ {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== '') {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * Splits `s.subspec "name" do |ss| ... end` blocks out of the source. Returns
 * the text without those blocks (the main spec's own statements) and each
 * block's name, receiver identifier and body. A block that re-binds `s`/`spec`
 * is left in place: with that receiver it cannot be told from the main spec.
 */
function splitSubspecs(
  content /*: string */,
  mainName /*: string */,
) /*: {main: string, subspecs: Array<{name: string, recv: string, body: string}>} */ {
  const subspecs = [];
  let main = '';
  let pos = 0;
  const mainRe = new RegExp(`^(?:${mainName})$`);
  for (const m of content.matchAll(subspecOpenRe(mainName))) {
    const start = m.index ?? 0;
    if (start < pos || mainRe.test(m[2])) continue;
    const bodyStart = start + m[0].length;
    // `s.subspec "a" do |ss| ss.x = 1 end`: the block closes on its own line.
    const tail = stripTrailingComment(
      m[0].replace(/^.*?\bdo\s*\|\s*\w+\s*\|/, ''),
    );
    if (/(?:^|[\s;])end\s*;?\s*$/.test(tail)) {
      subspecs.push({name: m[1], recv: m[2], body: tail});
      main += content.slice(pos, start);
      pos = bodyStart;
      continue;
    }
    const lines = content.slice(bodyStart).split('\n');
    let depth = 1;
    let len = 0;
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      len += lines[i - 1].length + 1;
      depth += blockDelta(lines[i]);
      if (depth <= 0) {
        end = bodyStart + len + lines[i].length;
        break;
      }
    }
    if (end < 0) continue; // unbalanced: leave the text to the main spec
    subspecs.push({name: m[1], recv: m[2], body: content.slice(bodyStart, end)});
    main += content.slice(pos, start);
    pos = end;
  }
  return {main: main + content.slice(pos), subspecs};
}

function hasShadowingSubspec(source /*: string */) /*: boolean */ {
  return shadowingSubspecRe(mainReceiverName(source)).test(source);
}

/**
 * Best-effort Ruby podspec parser. Extracts the literal-string and
 * literal-array fields most RN libs use, merges the `do |ss| … end` subspecs
 * (all of them, or the declared `default_subspecs`; `:none` merges nothing),
 * and reads `ios`-scoped fields. Ruby helper calls (install_modules_dependencies,
 * ENV[], $config[:...]) and most interpolation are not evaluated — a warning
 * is appended so the caller can surface it. Known limits: nested subspecs,
 * heredocs, `{ |x| … }` brace blocks and conditionals are not understood.
 * Always returns a RawSpec; pure-JS, no Ruby dep required. The subspecs named in
 * `opts.dropSubspecs` are left out, as if the podspec did not declare them.
 */
function regexPodspec(
  podspecPath /*: string */,
  opts /*:: ?: {dropSubspecs?: ReadonlyArray<string>} */,
) /*: RawSpec */ {
  const {text: content, unresolved} = readPodspecEvaluated(podspecPath);
  const dropped = new Set(opts?.dropSubspecs ?? []);
  const mainName = mainReceiverName(content);
  const MAIN_RECV = mainRecvPattern(mainName);
  const warnings /*: Array<string> */ = [];
  // The main spec's own statements, and each subspec block apart. The readers
  // below default to the main text and receiver; a subspec is read with the
  // same readers anchored on its block variable, then merged like
  // flattenSubspecs does for `pod ipc spec` output.
  const {main, subspecs: allSubspecs} = splitSubspecs(content, mainName);

  // Matches:  s.<field> = "value"   or   s.<field> = 'value'  — on `recv`
  // (the main spec unless told otherwise).
  function getStringFieldOn(
    name /*: string */,
    text /*: string */,
    recv /*: string */,
  ) /*: string | null */ {
    // `header_dir = ""` is meaningful (root namespace), so only it may be empty.
    const quant = name === 'header_dir' ? '*' : '+';
    const re = new RegExp(`${recv}\\.${name}\\s*=\\s*["']([^"']${quant})["']`);
    const m = text.match(re);
    return m ? m[1] : null;
  }

  // `s.ios.<field>` counts as `s.<field>` and wins over it. The other
  // platforms' scopes (`s.osx.`, `s.tvos.`, `s.visionos.`, `s.watchos.`) are
  // never read: the receiver pattern only matches `s.` followed by the field
  // name or `ios.`.
  function getStringField(
    name /*: string */,
    text /*: string */ = main,
    recv /*: string */ = MAIN_RECV,
  ) /*: string | null */ {
    return (
      getStringFieldOn(name, text, `${recv}\\.ios`) ??
      getStringFieldOn(name, text, recv)
    );
  }

  // The same, but only where the receiver starts the statement — so a subspec's
  // block variable (`ss.header_dir`, the shape react-native-screens and
  // react-native-svg ship) cannot answer for the spec itself.
  function getSpecStringField(name /*: string */) /*: string | null */ {
    for (const scope of ['ios\\.', '']) {
      const re = new RegExp(
        `(?:^|[;|])\\s*(?:${mainName})\\.${scope}${name}\\s*=\\s*["']([^"']+)["']`,
        'm',
      );
      const m = main.match(re);
      if (m) return m[1];
    }
    return null;
  }

  // The fields that identify the spec, and only when the receiver spelling
  // still says which scope declared them: a subspec re-binding `s` puts its own
  // `header_dir` exactly where the library's would be.
  const shadowedIdentity = hasShadowingSubspec(content);
  function getIdentityField(name /*: string */) /*: string | null */ {
    return shadowedIdentity ? null : getSpecStringField(name);
  }

  // Matches:
  //   s.<field> = ["a", "b"]            (array)
  //   s.<field> = "single"              (single value treated as 1-element array)
  //   s.<field> = "a", "b"              (Ruby bare list, no brackets)
  function getArrayField(
    name /*: string */,
    text /*: string */ = main,
    recv /*: string */ = MAIN_RECV,
  ) /*: Array<string> */ {
    return Array.from(
      new Set([
        ...getArrayFieldOn(name, text, recv),
        ...getArrayFieldOn(name, text, `${recv}\\.ios`),
      ]),
    );
  }

  function getArrayFieldOn(
    name /*: string */,
    text /*: string */,
    recv /*: string */,
  ) /*: Array<string> */ {
    const reArr = new RegExp(`${recv}\\.${name}\\s*=\\s*\\[([^\\]]*)\\]`);
    const mArr = text.match(reArr);
    if (mArr != null) {
      const inner = mArr[1];
      const out /*: Array<string> */ = [];
      const itemRe = /["']([^"']+)["']/g;
      while (true) {
        const m = itemRe.exec(inner);
        if (m == null) break;
        out.push(m[1]);
      }
      return out;
    }
    // Ruby bare list without brackets: s.<field> = "a", "b"
    const reList = new RegExp(
      `${recv}\\.${name}\\s*=\\s*((?:["'][^"']+["']\\s*,\\s*)*["'][^"']+["'])`,
    );
    const mList = text.match(reList);
    if (mList != null) {
      const out /*: Array<string> */ = [];
      const itemRe = /["']([^"']+)["']/g;
      while (true) {
        const m = itemRe.exec(mList[1]);
        if (m == null) break;
        out.push(m[1]);
      }
      if (out.length > 0) return out;
    }
    const single = getStringFieldOn(name, text, recv);
    return single != null ? [single] : [];
  }

  // Matches:  s.dependency "Name"  (with optional version constraint), and the call form s.dependency("Name", ...)
  function getDependencies(
    text /*: string */ = main,
    recv /*: string */ = MAIN_RECV,
  ) /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    const re = new RegExp(
      `${recv}\\.(?:ios\\.)?dependency(?:\\s*\\(\\s*|\\s+)["']([^"']+)["']`,
      'g',
    );
    while (true) {
      const m = re.exec(text);
      if (m == null) break;
      out.push(m[1]);
    }
    return out;
  }

  // Matches:
  //   s.framework "X"          → ["X"]
  //   s.framework = "X"        → ["X"]
  //   s.frameworks = ["X","Y"] → ["X","Y"]
  function getFrameworks(
    weak /*: boolean */,
    text /*: string */ = main,
    recv /*: string */ = MAIN_RECV,
  ) /*: Array<string> */ {
    const prefix = weak ? 'weak_framework' : 'framework';
    const out /*: Array<string> */ = [];
    // Plural form: s.frameworks = [...] or s.frameworks = "Foo"
    out.push(...getArrayField(`${prefix}s`, text, recv));
    // Singular form: s.framework = "Foo" — single value treated as a 1-elem list
    out.push(...getArrayField(prefix, text, recv));
    // Method-call form: s.framework "Foo", "Bar" — no `=`. `getArrayField`
    // only matches assignment, so handle this case separately.
    const callRe = new RegExp(
      `${recv}\\.(?:ios\\.)?${prefix}s?\\s+((?:["'][^"']+["']\\s*,?\\s*)+)`,
      'g',
    );
    while (true) {
      const m = callRe.exec(text);
      if (m == null) break;
      const itemRe = /["']([^"']+)["']/g;
      while (true) {
        const im = itemRe.exec(m[1]);
        if (im == null) break;
        out.push(im[1]);
      }
    }
    return Array.from(new Set(out));
  }

  // Matches:  'HEADER_SEARCH_PATHS' => '...'   or  => ["...","..."]
  // Returns the raw token strings (still containing $(PODS_TARGET_SRCROOT)
  // etc.); substitution happens at translation time.
  function getHeaderSearchPaths(
    text /*: string */ = main,
  ) /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    // Array form
    const arrRe = /["']HEADER_SEARCH_PATHS["']\s*=>\s*\[([\s\S]*?)\]/g;
    while (true) {
      const m = arrRe.exec(text);
      if (m == null) break;
      const itemRe = /["']((?:[^"'\\]|\\.)+)["']/g;
      while (true) {
        const im = itemRe.exec(m[1]);
        if (im == null) break;
        // Each entry can be a single path or a space-separated list of paths.
        for (const token of im[1].split(/\s+/)) {
          if (token.length > 0) {
            out.push(stripWrappingQuotes(token));
          }
        }
      }
    }
    // String form
    const strRe =
      /["']HEADER_SEARCH_PATHS["']\s*=>\s*["']((?:[^"'\\]|\\.)+)["']/g;
    while (true) {
      const m = strRe.exec(text);
      if (m == null) break;
      for (const token of m[1].split(/\s+/)) {
        if (token.length > 0) {
          out.push(stripWrappingQuotes(token));
        }
      }
    }
    return Array.from(new Set(out));
  }

  // Literal `'OTHER_CFLAGS' => '-DFOO=1'` and `'GCC_PREPROCESSOR_DEFINITIONS' =>
  // '$(inherited) BAR=1'` entries (also `[config=*Debug*]` keys), from any
  // xcconfig hash. Returned as {rawKey: space-joined values} so
  // flattenSubspecs lifts them like the `pod ipc` JSON. Only string literals
  // are read: an array, `.join` or interpolated value is not understood (an
  // interpolated token is dropped later, with the other unresolved ones).
  function getDefineXcconfig(
    text /*: string */,
  ) /*: {[string]: string} */ {
    const out /*: {[string]: string} */ = {};
    const re =
      /["']((?:OTHER_CFLAGS|GCC_PREPROCESSOR_DEFINITIONS)(?:\[config=\*\w+\*\])?)["']\s*=>\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
    while (true) {
      const m = re.exec(text);
      if (m == null) break;
      const value =
        m[2] != null ? m[2].replace(/\\(["\\])/g, '$1') : (m[3] ?? '');
      out[m[1]] = out[m[1]] != null ? `${out[m[1]]} ${value}` : value;
    }
    return out;
  }

  // Literal `'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '...'` entries from any
  // xcconfig hash, space-joined. A double-quoted value may hold `#{...}` with
  // its own quotes (react-native-vision-camera: `#{enableLocation ? "X" :
  // ""}`), so the scan steps over it as a unit; flattenSubspecs drops it.
  function getSwiftConditionsXcconfig(text /*: string */) /*: string */ {
    const out /*: Array<string> */ = [];
    const re =
      /["']SWIFT_ACTIVE_COMPILATION_CONDITIONS["']\s*=>\s*(?:"((?:[^"\\\n#]|\\.|#\{[^}\n]*\}|#(?!\{))*)"|'((?:[^'\\\n]|\\.)*)')/g;
    while (true) {
      const m = re.exec(text);
      if (m == null) break;
      out.push(m[1] ?? m[2] ?? '');
    }
    return out.join(' ');
  }

  // Surface known unparseable constructs so the caller can warn the user.
  if (shadowedIdentity) {
    warnings.push(
      "A subspec rebinds the spec variable (`do |s|`), so its `name`, `module_name` and `header_dir` cannot be told from the library's own — those are left unread. Install CocoaPods (`gem install cocoapods`) to enable full `pod ipc spec` parsing.",
    );
  }
  if (new RegExp(`(?:${mainName})\\.subspec\\b`).test(content)) {
    warnings.push(
      'Subspecs detected — regex parser merges their source/exclude/header, framework, dependency and define fields (default_subspecs honoured); nested subspecs, `{ }` brace blocks and heredocs are not understood. Install CocoaPods (`gem install cocoapods`) to enable full `pod ipc spec` parsing.',
    );
  }
  if (/install_modules_dependencies/.test(content)) {
    warnings.push(
      '`install_modules_dependencies(s)` detected — dependency wiring may be incomplete without CocoaPods.',
    );
  }
  if (/\bENV\[/.test(content) || /\$config\[/.test(content)) {
    warnings.push(
      'Env-var or Ruby-config interpolation detected — values may not translate cleanly without CocoaPods.',
    );
  }

  // Which subspecs count: like CocoaPods, all of them unless the spec declares
  // `default_subspecs` (or `default_subspec`), then only those.
  const defaults = new Set([
    ...getArrayField('default_subspecs'),
    ...getArrayField('default_subspec'),
  ]);
  // `default_subspecs = :none` selects no subspec at all.
  const none = new RegExp(
    `${MAIN_RECV}\\.default_subspecs?\\s*=\\s*:none\\b`,
  ).test(main);
  const subspecs = (
    none
      ? []
      : defaults.size > 0
        ? allSubspecs.filter(sub => defaults.has(sub.name))
        : allSubspecs
  ).filter(sub => !dropped.has(sub.name));
  // Layer 0 is the main spec; the rest are the selected subspecs, each read
  // with the same helpers anchored on its own block variable.
  const layers = [
    {text: main, recv: MAIN_RECV},
    ...subspecs.map(sub => ({
      text: sub.body,
      recv: `(?<![\\w.])${sub.recv}`,
    })),
  ];
  const unionOf = (read /*: (string, string) => Array<string> */) =>
    Array.from(new Set(layers.flatMap(l => read(l.text, l.recv))));
  const arrayUnion = (name /*: string */) =>
    unionOf((text, recv) => getArrayField(name, text, recv));
  // The spec's own value wins; otherwise the first subspec that sets one.
  const firstString = (name /*: string */) =>
    layers.reduce(
      (found, l) => found ?? getStringField(name, l.text, l.recv),
      (null /*: string | null */),
    );

  return {
    name: getIdentityField('name'),
    module_name: getIdentityField('module_name'),
    version: getSpecStringField('version'),
    source_files: arrayUnion('source_files'),
    public_header_files: arrayUnion('public_header_files'),
    private_header_files: arrayUnion('private_header_files'),
    exclude_files: arrayUnion('exclude_files'),
    header_mappings_dir: firstString('header_mappings_dir'),
    // Main spec only: a subspec's `header_dir` names that subspec's headers.
    header_dir: getIdentityField('header_dir'),
    frameworks: unionOf((t, r) => getFrameworks(false, t, r)),
    weak_frameworks: unionOf((t, r) => getFrameworks(true, t, r)),
    libraries: arrayUnion('libraries'),
    dependencies: unionOf((t, r) => getDependencies(t, r)),
    compiler_flags: tokenizeFlags(firstString('compiler_flags')),
    pod_target_xcconfig: {
      HEADER_SEARCH_PATHS: unionOf(text => getHeaderSearchPaths(text)),
      ...layers.reduce((acc, l) => {
        const found = getDefineXcconfig(l.text);
        const conditions = getSwiftConditionsXcconfig(l.text);
        if (conditions.length > 0) {
          found.SWIFT_ACTIVE_COMPILATION_CONDITIONS = conditions;
        }
        for (const k of Object.keys(found)) {
          acc[k] = acc[k] != null ? `${acc[k]} ${found[k]}` : found[k];
        }
        return acc;
      }, ({} /*: {[string]: string} */)),
    },
    resources: arrayUnion('resources'),
    // `swift_version` and `swift_versions` from every layer, literal only.
    swift_versions: unionOf((t, r) => [
      ...getArrayField('swift_versions', t, r),
      ...getArrayField('swift_version', t, r),
    ]),
    requires_arc: layers.some(l =>
      new RegExp(`${l.recv}\\.requires_arc\\s*=\\s*true`).test(l.text),
    ),
    __header_dir_scopes__: headerDirScopes(
      layers.map((l, i) => ({
        headerDir:
          i === 0
            ? getIdentityField('header_dir')
            : getStringField('header_dir', l.text, l.recv),
        headerMappingsDir: getStringField('header_mappings_dir', l.text, l.recv),
        sourceFiles: getArrayField('source_files', l.text, l.recv),
      })),
    ),
    // Each selected subspec's own dependencies, so a caller can tell which
    // subspec declares a dependency (flattenSubspecs: subspecDependencies).
    __subspec_dependencies__: Object.fromEntries(
      layers.slice(1).map((l, i) => [
        subspecs[i].name,
        getDependencies(l.text, l.recv),
      ]),
    ),
    __regex_partial__: true,
    __warnings__: warnings,
    __unresolved__: unresolved,
  };
}

// Strips outer quote-like characters from a captured token. Handles bare
// quotes (`"foo"`, `'foo'`) AND Ruby-escaped quotes (`\"foo\"`) which show
// up verbatim when the regex captures something like
// `"HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/x\""`.
function stripWrappingQuotes(s /*: string */) /*: string */ {
  return s.replace(/^\\?["']/, '').replace(/\\?["']$/, '');
}

function tokenizeFlags(value /*: string | null */) /*: Array<string> */ {
  if (value == null) return [];
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Split a flag string on whitespace while keeping quoted spans intact, so a
 * define like `-DWORKLETS_FEATURE_FLAGS="[A:false][B:true]"` stays one token
 * (the quotes are part of the macro value). A naive whitespace split would
 * shred any define whose value contains spaces.
 */
function shellTokenize(value /*: string */) /*: Array<string> */ {
  const tokens /*: Array<string> */ = [];
  let cur = '';
  let quote /*: string | null */ = null;
  let has = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote != null) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      cur += c;
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

/**
 * CocoaPods `header_dir` puts a spec's headers, flattened, under one namespace
 * (`<header_dir/Header.h>`). Layer 0 is the main spec: its `header_dir` covers
 * its own sources plus those of every subspec that sets none; a subspec's own
 * `header_dir` covers only that subspec's sources. A `header_mappings_dir`
 * keeps the path below it instead of flattening (`<header_dir/sub/Header.h>`):
 * each scope lists the mappings dirs of its layers, plus the main spec's, which
 * subspecs inherit.
 */
function headerDirScopes(
  layers /*: Array<{headerDir: ?string, headerMappingsDir?: ?string, sourceFiles: Array<string>}> */,
) /*: Array<{headerDir: string, headerMappingsDirs: Array<string>, sourceFiles: Array<string>}> */ {
  const mainDir = layers.length > 0 ? layers[0].headerDir : null;
  const mainMappings = layers.length > 0 ? layers[0].headerMappingsDir : null;
  const mappingsOf = (l /*: {headerMappingsDir?: ?string, ...} */) =>
    Array.from(
      new Set(
        [l.headerMappingsDir, mainMappings].filter(
          d => typeof d === 'string' && d.length > 0,
        ),
      ),
    );
  const scopes = [];
  const inherited = [];
  const inheritedMappings = [];
  layers.forEach((l, i) => {
    if (i > 0 && l.headerDir === '') {
      // A subspec's `header_dir = ""` is the root namespace: no stubs for its
      // headers (they are not inherited under the main spec's header_dir).
      return;
    }
    if (i > 0 && l.headerDir != null && l.headerDir.length > 0) {
      scopes.push({
        headerDir: l.headerDir,
        headerMappingsDirs: mappingsOf(l),
        sourceFiles: l.sourceFiles,
      });
    } else {
      inherited.push(...l.sourceFiles);
      inheritedMappings.push(...mappingsOf(l));
    }
  });
  if (mainDir != null && mainDir.length > 0) {
    scopes.unshift({
      headerDir: mainDir,
      headerMappingsDirs: Array.from(new Set(inheritedMappings)),
      sourceFiles: inherited,
    });
  }
  return scopes;
}

// ---------------------------------------------------------------------------
// Subspec flattening
// ---------------------------------------------------------------------------

/**
 * Merges a podspec's default subspecs (or all subspecs when no defaults are
 * declared) into a single logical view. RN libraries use subspecs for
 * platform/feature gating (`apple` vs `common`); consumers compile the
 * union anyway, so the flat view matches the actual build.
 *
 * Merge rules:
 *   - Array fields  → concat + dedup
 *   - String fields → top-level wins; if absent, take the first subspec's value
 *   - pod_target_xcconfig HEADER_SEARCH_PATHS → array-union across all selected subspecs
 *   - dependencies  → array-union of name strings (version constraints dropped)
 *
 * The subspecs named in `opts.dropSubspecs` are left out (their sources,
 * headers, settings and dependencies), and so are the spec's references to
 * them (`<Pod>/<subspec>`).
 */
function flattenSubspecs(
  rawSpec /*: RawSpec */,
  opts /*:: ?: {dropSubspecs?: ReadonlyArray<string>} */,
) /*: PodspecModel */ {
  const dropped = new Set(opts?.dropSubspecs ?? []);
  const warnings /*: Array<string> */ = [];
  // $FlowFixMe[prop-missing] dynamic shape
  const partial /*: boolean */ = rawSpec.__regex_partial__ === true;
  if (Array.isArray(rawSpec.__warnings__)) {
    // $FlowFixMe[incompatible-type] runtime-validated dynamic shape
    const rawWarnings /*: ReadonlyArray<string> */ = rawSpec.__warnings__;
    for (const w of rawWarnings) {
      warnings.push(w);
    }
  }

  // Determine which subspecs to merge. pod ipc returns:
  //   - `subspecs`: array of nested specs (or undefined)
  //   - `default_subspecs`: array of names (or undefined → use all subspecs)
  const subspecs = Array.isArray(rawSpec.subspecs) ? rawSpec.subspecs : [];
  let selected = subspecs;
  if (
    rawSpec.default_subspecs === 'none' ||
    rawSpec.default_subspec === 'none'
  ) {
    selected = []; // `default_subspecs = :none`
  } else if (Array.isArray(rawSpec.default_subspecs)) {
    const wanted = new Set(rawSpec.default_subspecs);
    selected = subspecs.filter(s => {
      // $FlowFixMe[prop-missing] dynamic shape
      const name = s != null && typeof s.name === 'string' ? s.name : null;
      return name != null && wanted.has(name);
    });
  }
  selected = selected.filter(
    // $FlowFixMe[prop-missing] dynamic shape
    s => !(s != null && typeof s.name === 'string' && dropped.has(s.name)),
  );
  const layers = [rawSpec, ...selected];

  function mergeArrayField(key /*: string */) /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    for (const layer of layers) {
      // $FlowFixMe[incompatible-use] layer narrowed from `mixed`; runtime-validated below
      const value = layer != null ? layer[key] : null;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string') out.push(v);
        }
      } else if (typeof value === 'string') {
        out.push(value);
      }
    }
    return Array.from(new Set(out));
  }

  function mergeArrayFieldOf(
    layer /*: mixed */,
    key /*: string */,
  ) /*: Array<string> */ {
    // $FlowFixMe[incompatible-use] dynamic shape
    const value = layer != null ? layer[key] : null;
    return (Array.isArray(value) ? value : [value]).filter(
      v => typeof v === 'string',
    );
  }

  // Only the spec's own value: a subspec's `header_dir` names that subspec's
  // headers, and several subspecs can disagree.
  function specStringField(key /*: string */) /*: string | null */ {
    // $FlowFixMe[incompatible-use] dynamic shape
    const value = rawSpec[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  function mergeStringField(key /*: string */) /*: string | null */ {
    for (const layer of layers) {
      // $FlowFixMe[incompatible-use] layer narrowed from `mixed`; runtime-validated below
      const value = layer != null ? layer[key] : null;
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  function mergeHeaderSearchPaths() /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    // HSP can live in any of the xcconfig blocks, and a single value often
    // PACKS multiple space-separated paths, each individually quoted, plus a
    // CocoaPods `/**` recursive-glob suffix (e.g. skia:
    // `"$(SRCROOT)/cpp/"/** "$(SRCROOT)/cpp/skia" ...`). Shell-tokenize to keep
    // each path intact, then strip ALL quotes (not just wrapping) per token.
    const XCCONFIG_KEYS = [
      'pod_target_xcconfig',
      'xcconfig',
      'user_target_xcconfig',
    ];
    for (const layer of layers) {
      if (layer == null || typeof layer !== 'object') continue;
      for (const xcKey of XCCONFIG_KEYS) {
        // $FlowFixMe[incompatible-use] layer narrowed from `mixed`
        const xc = layer[xcKey];
        if (xc == null || typeof xc !== 'object') continue;
        const hsp = xc.HEADER_SEARCH_PATHS;
        const values =
          typeof hsp === 'string'
            ? [hsp]
            : Array.isArray(hsp)
              ? hsp.filter(v => typeof v === 'string')
              : [];
        for (const v of values) {
          for (const tok of shellTokenize(v)) {
            const cleaned = tok.replace(/['"]/g, '');
            if (cleaned.length > 0) out.push(cleaned);
          }
        }
      }
    }
    return Array.from(new Set(out));
  }

  // Lift preprocessor defines from pod_target_xcconfig across all layers:
  // `-D` tokens in OTHER_CFLAGS, and NAME[=VALUE] entries in
  // GCC_PREPROCESSOR_DEFINITIONS (incl. per-config `[config=*Debug*]` keys).
  // Non-define compiler flags in OTHER_CFLAGS are intentionally dropped — only
  // `-D`s are safe to forward; arbitrary flags may be machine- or
  // example-app-specific. $(inherited), unresolved $(...) tokens, and invalid
  // C identifiers are skipped.
  //
  // `FOLLY_*` defines are never lifted: the prebuilt React Native headers ship
  // `folly/folly-config.h`, and `FOLLY_NO_CONFIG` (the usual
  // `folly_compiler_flags`) turns that include off without the full CocoaPods
  // define set, which breaks the build. What was dropped is named in a warning.
  const droppedFollyDefines /*: Set<string> */ = new Set();
  const isFollyDefine = (name /*: string */) /*: boolean */ =>
    name.startsWith('FOLLY_');
  // `REACT_NATIVE_{MAJOR,MINOR,PATCH}_VERSION=#{...}` is a community
  // convention computed in Ruby from react-native/package.json, always meaning
  // the installed React Native. The regex path cannot evaluate it, so those
  // (and only those) names take the installed version's number instead.
  const rnVersionMacros /*: {[string]: number} */ = readRnVersionMacros();
  const substitutedRnVersionDefines /*: Set<string> */ = new Set();
  function mergePreprocessorDefines() /*: Array<PreprocessorDefine> */ {
    const out /*: Array<PreprocessorDefine> */ = [];
    const seen /*: Set<string> */ = new Set();
    const validName = /^[A-Za-z_]\w*$/;
    const add = (
      name /*: string */,
      value /*: ?string */,
      config /*: ?('debug' | 'release') */,
    ) => {
      if (!validName.test(name)) return;
      if (isFollyDefine(name)) {
        droppedFollyDefines.add(value != null ? `${name}=${value}` : name);
        return;
      }
      if (
        value != null &&
        /#\{/.test(value) &&
        !/\$[({]/.test(value) &&
        Object.prototype.hasOwnProperty.call(rnVersionMacros, name)
      ) {
        value = String(rnVersionMacros[name]);
        substitutedRnVersionDefines.add(`${name}=${value}`);
      }
      if (
        /\$[({]|#\{/.test(name) ||
        (value != null && /\$[({]|#\{/.test(value))
      ) {
        return; // unresolved Xcode/Ruby token — don't emit a broken define
      }
      const key = `${name}|${config ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({name, value, config});
    };
    // Defines can live in the target xcconfig (pod_target_xcconfig) OR the
    // aggregate/user xcconfig (`s.xcconfig` / user_target_xcconfig). worklets
    // puts its version define in pod_target_xcconfig; reanimated puts its in
    // `s.xcconfig` — scan all three.
    const XCCONFIG_KEYS = [
      'pod_target_xcconfig',
      'xcconfig',
      'user_target_xcconfig',
    ];
    // `-DNAME[=VALUE]` in the spec's `compiler_flags` are defines too (the rest
    // of the flags stay in compilerFlags; see mergeCompilerFlags).
    for (const layer of layers) {
      for (const tok of compilerFlagTokens(layer)) {
        if (!tok.startsWith('-D') || tok.length === 2) continue;
        const body = tok.slice(2);
        const eq = body.indexOf('=');
        add(
          eq >= 0 ? body.slice(0, eq) : body,
          eq >= 0 ? body.slice(eq + 1) : null,
          null,
        );
      }
    }
    for (const layer of layers) {
      if (layer == null || typeof layer !== 'object') continue;
      for (const xcKey of XCCONFIG_KEYS) {
        // $FlowFixMe[incompatible-use] layer narrowed from `mixed`
        const xc = layer[xcKey];
        if (xc == null || typeof xc !== 'object') continue;
        for (const rawKey of Object.keys(xc)) {
          const cflags = /^OTHER_CFLAGS(?:\[config=\*(\w+)\*\])?$/i.exec(
            rawKey,
          );
          const ppDefs =
            /^GCC_PREPROCESSOR_DEFINITIONS(?:\[config=\*(\w+)\*\])?$/i.exec(
              rawKey,
            );
          if (cflags == null && ppDefs == null) continue;
          const cfgRaw = (
            (cflags?.[1] ?? ppDefs?.[1] ?? '') + ''
          ).toLowerCase();
          const config =
            cfgRaw === 'debug'
              ? 'debug'
              : cfgRaw === 'release'
                ? 'release'
                : null;
          // $FlowFixMe[incompatible-use] xc value access is intentional
          const val = xc[rawKey];
          const strs =
            typeof val === 'string'
              ? [val]
              : Array.isArray(val)
                ? val.filter(v => typeof v === 'string')
                : [];
          for (const s of strs) {
            for (const tok of shellTokenize(s)) {
              if (tok === '$(inherited)') continue;
              // OTHER_CFLAGS: only `-D` tokens are defines; others are flags.
              // GCC_PREPROCESSOR_DEFINITIONS: every token is `NAME[=VALUE]`.
              let body /*: ?string */ = null;
              if (cflags != null) {
                if (tok.startsWith('-D')) body = tok.slice(2);
              } else {
                body = tok;
              }
              if (body == null || body.length === 0) continue;
              const eq = body.indexOf('=');
              const name = eq >= 0 ? body.slice(0, eq) : body;
              const value = eq >= 0 ? body.slice(eq + 1) : null;
              add(name, value, config);
            }
          }
        }
      }
    }
    return out;
  }

  // A layer's dependency names. pod ipc returns deps as
  // {name: [versionConstraint, ...], ...}, the regex reader as [name, ...].
  // A reference to a dropped subspec (`<Pod>/<subspec>`) is left out.
  const ownName = specStringField('name');
  const refersToDropped = (d /*: string */) /*: boolean */ => {
    const [pod, sub] = d.split('/');
    return sub != null && dropped.has(sub) && (ownName == null || pod === ownName);
  };
  function dependencyNames(deps /*: unknown */) /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    if (Array.isArray(deps)) {
      for (const d of deps) {
        if (typeof d === 'string') out.push(d);
      }
    } else if (deps != null && typeof deps === 'object') {
      out.push(...Object.keys(deps));
    }
    return out.filter(d => !refersToDropped(d));
  }

  function mergeDependencies() /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    for (const layer of layers) {
      // $FlowFixMe[incompatible-use] layer narrowed from `mixed`; runtime-validated below
      out.push(...dependencyNames(layer != null ? layer.dependencies : null));
    }
    return Array.from(new Set(out));
  }

  // Each selected subspec's own dependencies, by subspec name.
  function subspecDependencies() /*: {[string]: Array<string>} */ {
    const out /*: {[string]: Array<string>} */ = {};
    // $FlowFixMe[prop-missing] dynamic shape
    const fromRegex = rawSpec.__subspec_dependencies__;
    if (fromRegex != null && typeof fromRegex === 'object') {
      for (const name of Object.keys(fromRegex)) {
        if (!dropped.has(name)) out[name] = dependencyNames(fromRegex[name]);
      }
      return out;
    }
    for (const sub of selected) {
      // $FlowFixMe[prop-missing] dynamic shape
      if (sub == null || typeof sub.name !== 'string') continue;
      // $FlowFixMe[prop-missing] dynamic shape
      out[sub.name] = dependencyNames(sub.dependencies);
    }
    return out;
  }

  // SWIFT_ACTIVE_COMPILATION_CONDITIONS tokens from every layer's xcconfig
  // hashes, each once. `$(inherited)`, an Xcode `$(...)` token and a Ruby
  // interpolation are left out, as for the C defines.
  function mergeSwiftConditions() /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    const XCCONFIG_KEYS = [
      'pod_target_xcconfig',
      'xcconfig',
      'user_target_xcconfig',
    ];
    for (const layer of layers) {
      if (layer == null || typeof layer !== 'object') continue;
      for (const xcKey of XCCONFIG_KEYS) {
        // $FlowFixMe[incompatible-use] layer narrowed from `mixed`
        const xc = layer[xcKey];
        if (xc == null || typeof xc !== 'object') continue;
        const val = xc.SWIFT_ACTIVE_COMPILATION_CONDITIONS;
        const strs =
          typeof val === 'string'
            ? [val]
            : Array.isArray(val)
              ? val.filter(v => typeof v === 'string')
              : [];
        for (const str of strs) {
          // An interpolation stays one token that is never a valid name.
          const tokens = str.replace(/#\{[^}]*\}/g, '#{}').split(/\s+/);
          for (const tok of tokens) {
            if (/^[A-Za-z_]\w*$/.test(tok)) out.push(tok);
          }
        }
      }
    }
    return Array.from(new Set(out));
  }

  function compilerFlagTokens(layer /*: unknown */) /*: Array<string> */ {
    // $FlowFixMe[incompatible-use] layer narrowed from `mixed`; runtime-validated below
    const value = layer != null ? layer.compiler_flags : null;
    const out /*: Array<string> */ = [];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v === 'string') {
        for (const tok of v.split(/\s+/)) {
          if (tok.length > 0) out.push(tok);
        }
      }
    }
    return out;
  }

  function mergeCompilerFlags() /*: Array<string> */ {
    const liftedDefines = new Set(
      mergePreprocessorDefines()
        .filter(d => d.config == null)
        .map(d => (d.value != null ? `${d.name}=${d.value}` : d.name)),
    );
    const out /*: Array<string> */ = [];
    for (const layer of layers) {
      for (const tok of compilerFlagTokens(layer)) {
        // A `-D` already emitted as a `.define(...)` is not repeated as a flag.
        if (tok.startsWith('-D') && liftedDefines.has(tok.slice(2))) continue;
        // A dropped `-DFOLLY_*` is not smuggled back in as a raw flag either.
        if (tok.startsWith('-DFOLLY_')) continue;
        out.push(tok);
      }
    }
    return out;
  }

  // $FlowFixMe[prop-missing] dynamic shape
  const reqArc /*: unknown */ = rawSpec.requires_arc;
  const requiresArc =
    reqArc === false || (Array.isArray(reqArc) && reqArc.length === 0)
      ? false
      : true; // RN ecosystem default

  const preprocessorDefines = mergePreprocessorDefines();
  const compilerFlags = mergeCompilerFlags();
  if (droppedFollyDefines.size > 0) {
    warnings.push(
      `Dropped Folly define(s) ${Array.from(droppedFollyDefines).join(', ')} — the prebuilt React Native headers ship folly-config.h, and defining them without the full CocoaPods set breaks the build.`,
    );
  }

  if (substitutedRnVersionDefines.size > 0) {
    warnings.push(
      `Resolved interpolated define(s) ${Array.from(substitutedRnVersionDefines).join(', ')} from the installed React Native version (${rnVersionMacros.REACT_NATIVE_MAJOR_VERSION}.${rnVersionMacros.REACT_NATIVE_MINOR_VERSION}.${rnVersionMacros.REACT_NATIVE_PATCH_VERSION}) — the regex parser cannot evaluate the Ruby expression.`,
    );
  }

  return {
    name: specStringField('name') ?? '',
    version: specStringField('version') ?? '',
    sourceFiles: mergeArrayField('source_files'),
    publicHeaderFiles: mergeArrayField('public_header_files'),
    privateHeaderFiles: mergeArrayField('private_header_files'),
    excludeFiles: mergeArrayField('exclude_files'),
    headerMappingsDir: mergeStringField('header_mappings_dir'),
    // ALL subspecs' header_mappings_dir values (not just the merged one). Each
    // implies a header search path of its parent dir so namespaced includes
    // (`<reanimated/apple/sensor/X.h>` for a header physically at
    // `apple/reanimated/apple/sensor/X.h` with mappings dir `apple/reanimated`)
    // resolve from the physical tree — CocoaPods does this via the
    // header_mappings_dir copy step, which SPM has no equivalent for.
    headerMappingsDirs: mergeArrayField('header_mappings_dir'),
    headerDir: specStringField('header_dir'),
    headerDirScopes: Array.isArray(rawSpec.__header_dir_scopes__)
      ? // $FlowFixMe[incompatible-type] built by headerDirScopes()
        rawSpec.__header_dir_scopes__
      : headerDirScopes(
          layers.map(l => ({
            // $FlowFixMe[incompatible-use] dynamic shape
            headerDir:
              l != null && typeof l.header_dir === 'string' ? l.header_dir : null,
            // $FlowFixMe[incompatible-use] dynamic shape
            headerMappingsDir:
              l != null && typeof l.header_mappings_dir === 'string'
                ? l.header_mappings_dir
                : null,
            sourceFiles: mergeArrayFieldOf(l, 'source_files'),
          })),
        ),
    moduleName: specStringField('module_name'),
    frameworks: mergeArrayField('frameworks'),
    weakFrameworks: mergeArrayField('weak_frameworks'),
    libraries: mergeArrayField('libraries'),
    dependencies: mergeDependencies(),
    subspecDependencies: subspecDependencies(),
    preprocessorDefines,
    swiftConditions: mergeSwiftConditions(),
    compilerFlags,
    headerSearchPaths: mergeHeaderSearchPaths(),
    resources: mergeArrayField('resources'),
    // The Swift versions the spec and its selected subspecs declare
    // (`swift_version` / `swift_versions`). A value Ruby would interpolate is
    // left out: an unreadable value counts as none, as in CocoaPods.
    swiftVersions: Array.from(
      new Set([
        ...mergeArrayField('swift_versions'),
        ...mergeArrayField('swift_version'),
      ]),
    ).filter(v => !v.includes('#{')),
    requiresArc,
    warnings,
    partial,
    // Default: overridden in readPodspec, which can see the podspec source.
    usesInstallModulesDependencies: false,
    // $FlowFixMe[incompatible-type] runtime-validated dynamic shape
    unresolvedSources: Array.isArray(rawSpec.__unresolved__)
      ? rawSpec.__unresolved__
      : [],
  };
}

/**
 * Why the podspec's source globs cannot be scaffolded, or null: each
 * `source_files`/`exclude_files` value the regex path could not evaluate. A
 * glob read in part gives a target that builds without some of the library's
 * files (react-native-screens 4.24.0 lost all of ios/, and the app crashed at
 * start), so the scaffolder refuses the library instead. Other callers (name
 * resolution, header search paths) keep reading the model as before.
 */
function unresolvedSourcesReason(
  podspecPath /*: string */,
  model /*: PodspecModel */,
) /*: ?string */ {
  const list /*: Array<Unresolved> */ = model.unresolvedSources ?? [];
  if (list.length === 0) return null;
  return (
    `${podspecPath}: ` +
    list
      .map(u => `\`${u.field} = ${u.expr}\` cannot be evaluated: ${u.why}`)
      .join('; ') +
    '. The podspec reader evaluates locals, string interpolation, arrays, ' +
    "ENV['...'], comparisons, ternaries and if/unless blocks; building from " +
    'the globs it could read would leave some of the library\'s files out of ' +
    'its target. Install CocoaPods (`gem install cocoapods`) so `pod ipc spec` ' +
    'reads the podspec, or give the library a Package.swift of its own.'
  );
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

/**
 * Reads and flattens a podspec at `podspecPath`. Tries `pod ipc spec` first
 * (full Ruby DSL evaluation); falls back to a regex parser when CocoaPods
 * isn't available.
 *
 * Throws when the file doesn't exist. Otherwise always returns a
 * PodspecModel — warnings on the model surface partial parses to the
 * caller, who can decide whether to proceed or abort scaffolding for that
 * dep. The subspecs named in `opts.dropSubspecs` are left out.
 */
function readPodspec(
  podspecPath /*: string */,
  opts /*:: ?: {dropSubspecs?: ReadonlyArray<string>} */,
) /*: PodspecModel */ {
  if (!fs.existsSync(podspecPath)) {
    throw new Error(`readPodspec: file does not exist: ${podspecPath}`);
  }
  const podIpc = runPodIpcSpec(podspecPath);
  const raw = podIpc != null ? podIpc : regexPodspec(podspecPath, opts);
  const model = flattenSubspecs(raw, opts);
  // Record whether the podspec calls `install_modules_dependencies(s)`. We
  // strip that helper before `pod ipc` and the regex parser can't expand it,
  // so the React-Core family it injects never lands in `model.dependencies`.
  // The scaffolder uses this as an implicit React-core marker (plain ObjC
  // modules using the helper have no `codegenConfig` to detect instead).
  try {
    const src = fs.readFileSync(podspecPath, 'utf8');
    model.usesInstallModulesDependencies =
      /\binstall_modules_dependencies\b/.test(src);
  } catch {
    // best-effort; leave the flattenSubspecs default (false)
  }
  return model;
}

// The installed React Native's version as the macros libraries derive from it.
function readRnVersionMacros() /*: {[string]: number} */ {
  const rnRoot = process.env.RN_SPM_RN_ROOT;
  if (rnRoot == null || rnRoot === '') {
    throw new Error(
      "RN_SPM_RN_ROOT is not set: rn-xtool's vendored SwiftPM scripts need the installed react-native directory",
    );
  }
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(rnRoot, 'package.json'), 'utf8'),
    );
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(pkg.version));
    if (m != null) {
      return {
        REACT_NATIVE_MAJOR_VERSION: Number(m[1]),
        REACT_NATIVE_MINOR_VERSION: Number(m[2]),
        REACT_NATIVE_PATCH_VERSION: Number(m[3]),
      };
    }
  } catch {
    // unreadable: the defines stay dropped
  }
  return {};
}

const podspecModels /*: Map<string, PodspecModel> */ = new Map();

/**
 * readPodspec memoized on the resolved path. `pod ipc spec` costs a process
 * spawn, and one autolinking run reads the same podspec from several sites
 * (name resolution, header search paths, scaffolding). The model is shared, so
 * callers must treat it as read-only. The key is the resolved path plus the
 * sorted `opts.dropSubspecs`.
 */
function readPodspecCached(
  podspecPath /*: string */,
  opts /*:: ?: {dropSubspecs?: ReadonlyArray<string>} */,
) /*: PodspecModel */ {
  const drop = [...(opts?.dropSubspecs ?? [])].sort();
  const key = [path.resolve(podspecPath), ...drop].join('\0');
  const cached = podspecModels.get(key);
  if (cached != null) {
    return cached;
  }
  const model = readPodspec(podspecPath, {dropSubspecs: drop});
  podspecModels.set(key, model);
  return model;
}

/**
 * The three fields that name a library, read WITHOUT `pod ipc spec`'s process
 * spawn — name resolution runs for every dep, including self-managed ones that
 * need nothing else from the podspec.
 *
 * Null when the answer cannot be trusted without Ruby: an interpolated value,
 * or a spec-level `header_dir`/`module_name` the regex could not read. Both
 * outrank the pod name, so a literal name alone is not enough — resolving
 * without them would pick the wrong prefix. A value only a subspec declares is
 * not the library's, so it neither answers nor defers — unless that subspec
 * re-binds `s` (or `spec`), which makes every field's scope unreadable.
 */
function readPodspecNames(
  podspecPath /*: string */,
) /*: ?{name: ?string, moduleName: ?string, headerDir: ?string} */ {
  const raw = regexPodspec(podspecPath);
  const field = (key /*: string */) /*: ?string */ => {
    // $FlowFixMe[prop-missing] RawSpec is dynamically shaped
    const value = raw[key];
    return typeof value === 'string' &&
      value.length > 0 &&
      !value.includes('#{')
      ? value
      : null;
  };
  const source = readPodspecSource(podspecPath);
  if (hasShadowingSubspec(source)) {
    return null;
  }
  const mainName = mainReceiverName(source);
  const declaredUnread = (
    key /*: string */,
    value /*: ?string */,
  ) /*: boolean */ =>
    value == null &&
    new RegExp(`(?:^|[;|])\\s*(?:${mainName})\\.${key}\\s*=`, 'm').test(source);

  const name = field('name');
  const moduleName = field('module_name');
  const headerDir = field('header_dir');
  if (
    declaredUnread('header_dir', headerDir) ||
    declaredUnread('module_name', moduleName)
  ) {
    return null;
  }
  return name == null && moduleName == null && headerDir == null
    ? null
    : {name, moduleName, headerDir};
}

/**
 * Every podspec in `dir`, sorted so two of them name a target the same way on
 * every machine (readdir order is unspecified). Skips a crashed run's leftover
 * `.spm-scaffold-<pid>-<name>.podspec` copy.
 */
function findPodspecs(dir /*: string */) /*: Array<string> */ {
  try {
    return fs
      .readdirSync(dir)
      .filter(e => e.endsWith('.podspec') && !e.startsWith('.spm-scaffold-'))
      .sort()
      .map(e => path.join(dir, e));
  } catch {
    return [];
  }
}

module.exports = {
  findPodspecs,
  readPodspec,
  readPodspecCached,
  readPodspecNames,
  runPodIpcSpec,
  regexPodspec,
  flattenSubspecs,
  unresolvedSourcesReason,
};
