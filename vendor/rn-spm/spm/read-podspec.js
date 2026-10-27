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
      // subspecs in `if fabric_enabled`). RN 0.76+ defaults to the new
      // architecture, so unless the caller has explicitly opted out, set
      // the env var here so `pod ipc spec` evaluates the full podspec.
      env: {
        ...process.env,
        RCT_NEW_ARCH_ENABLED: process.env.RCT_NEW_ARCH_ENABLED ?? '1',
      },
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

// Ruby constants. Podspecs commonly hoist a glob or extension list into a local
// and reuse it (react-native-screens: `source_files_exts = '{h,m,mm,cpp}'`,
// `source_files = ["ios/**/*.#{source_files_exts}"]`, `s.source_files =
// source_files`). The field regexes below only understand literals, so such a
// field read as missing and the library scaffolded with no sources.
//
// This pre-pass resolves the simple cases textually, so the regexes stay
// untouched: single-line `ident = 'str' | "str" | ["a", "b"]` assignments are
// collected (first assignment wins; `if`/`ENV[...]` conditions are NOT
// evaluated), then `#{ident}` inside the text is replaced by a known string
// constant, and a field assigned a bare known identifier (`s.x = ident`) is
// rewritten to the literal value (`s.x = ident`, `s.ios.x = ident`, and a
// subspec's `ss.x = ident`). `#{}` is only interpolated inside double-quoted
// strings, as in Ruby. Unknown interpolations/identifiers are left as they are.
function resolveRubyConstants(content /*: string */) /*: string */ {
  const strings /*: Map<string, string> */ = new Map();
  const arrays /*: Map<string, Array<{value: string, dq: boolean}>> */ =
    new Map();
  const assignRe = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.+?)[ \t]*$/gm;
  for (const m of content.matchAll(assignRe)) {
    const name = m[1];
    if (strings.has(name) || arrays.has(name)) continue;
    const rhs = m[2];
    const str = rhs.match(/^(?:"([^"]*)"|'([^']*)')$/);
    if (str != null) {
      strings.set(name, str[1] ?? str[2]);
      continue;
    }
    const arr = rhs.match(/^\[([^\]]*)\]$/);
    if (arr != null) {
      const items = [];
      for (const it of arr[1].matchAll(/"([^"]*)"|'([^']*)'/g)) {
        items.push({value: it[1] ?? it[2], dq: it[1] != null});
      }
      arrays.set(name, items);
    }
  }
  if (strings.size === 0 && arrays.size === 0) return content;
  const interpolate = (text /*: string */) =>
    text.replace(/#\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (whole, id) =>
      strings.has(id) ? (strings.get(id) /*: any */) : whole,
    );
  // Constants may be built from earlier ones: resolve the arrays' items too
  // (double-quoted items only).
  const arrayValues /*: Map<string, Array<string>> */ = new Map();
  for (const [k, v] of arrays) {
    arrayValues.set(k, v.map(i => (i.dq ? interpolate(i.value) : i.value)));
  }
  // Only double-quoted string literals interpolate; scan literal by literal
  // (a line never spans a string here) so `'ios/*.#{x}'` stays as written.
  const interpolated = content.replace(
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    lit => (lit[0] === '"' ? interpolate(lit) : lit),
  );
  const quote = (v /*: string */) => JSON.stringify(v);
  return interpolated.replace(
    /^(\s*[A-Za-z_]\w*(?:\.(?:ios|osx|tvos|visionos|watchos))?\.[A-Za-z_]+\s*=\s*)([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/gm,
    (whole, lhs, id) => {
      if (strings.has(id)) return lhs + quote((strings.get(id) /*: any */));
      if (arrayValues.has(id)) {
        return (
          lhs + '[' + (arrayValues.get(id) /*: any */).map(quote).join(', ') + ']'
        );
      }
      return whole;
    },
  );
}

// Comment-only lines are dropped so a commented-out `# s.header_dir` cannot win
// over the live one. A trailing `#` and a `#` inside a string survive: only the
// first non-whitespace character counts.
function readPodspecSource(podspecPath /*: string */) /*: string */ {
  return resolveRubyConstants(
    fs
      .readFileSync(podspecPath, 'utf8')
      .split('\n')
      .filter(line => !/^\s*#/.test(line))
      .join('\n'),
  );
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
 * Always returns a RawSpec; pure-JS, no Ruby dep required.
 */
function regexPodspec(podspecPath /*: string */) /*: RawSpec */ {
  const content = readPodspecSource(podspecPath);
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

  // Matches:  s.dependency "Name"  (with optional version constraint)
  function getDependencies(
    text /*: string */ = main,
    recv /*: string */ = MAIN_RECV,
  ) /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    const re = new RegExp(`${recv}\\.(?:ios\\.)?dependency\\s+["']([^"']+)["']`, 'g');
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
  const subspecs = none
    ? []
    : defaults.size > 0
      ? allSubspecs.filter(sub => defaults.has(sub.name))
      : allSubspecs;
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
        for (const k of Object.keys(found)) {
          acc[k] = acc[k] != null ? `${acc[k]} ${found[k]}` : found[k];
        }
        return acc;
      }, ({} /*: {[string]: string} */)),
    },
    resources: arrayUnion('resources'),
    requires_arc: layers.some(l =>
      new RegExp(`${l.recv}\\.requires_arc\\s*=\\s*true`).test(l.text),
    ),
    __header_dir_scopes__: headerDirScopes(
      layers.map((l, i) => ({
        headerDir:
          i === 0
            ? getIdentityField('header_dir')
            : getStringField('header_dir', l.text, l.recv),
        sourceFiles: getArrayField('source_files', l.text, l.recv),
      })),
    ),
    __regex_partial__: true,
    __warnings__: warnings,
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
 * `header_dir` covers only that subspec's sources.
 */
function headerDirScopes(
  layers /*: Array<{headerDir: ?string, sourceFiles: Array<string>}> */,
) /*: Array<{headerDir: string, sourceFiles: Array<string>}> */ {
  const mainDir = layers.length > 0 ? layers[0].headerDir : null;
  const scopes = [];
  const inherited = [];
  layers.forEach((l, i) => {
    if (i > 0 && l.headerDir === '') {
      // A subspec's `header_dir = ""` is the root namespace: no stubs for its
      // headers (they are not inherited under the main spec's header_dir).
      return;
    }
    if (i > 0 && l.headerDir != null && l.headerDir.length > 0) {
      scopes.push({headerDir: l.headerDir, sourceFiles: l.sourceFiles});
    } else {
      inherited.push(...l.sourceFiles);
    }
  });
  if (mainDir != null && mainDir.length > 0) {
    scopes.unshift({headerDir: mainDir, sourceFiles: inherited});
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
 */
function flattenSubspecs(rawSpec /*: RawSpec */) /*: PodspecModel */ {
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

  function mergeDependencies() /*: Array<string> */ {
    const out /*: Array<string> */ = [];
    for (const layer of layers) {
      // $FlowFixMe[incompatible-use] layer narrowed from `mixed`; runtime-validated below
      const deps = layer != null ? layer.dependencies : null;
      if (deps == null) continue;
      // pod ipc returns deps as: {name: [versionConstraint, ...], ...}
      // regex returns deps as: [name, name, ...]
      if (Array.isArray(deps)) {
        for (const d of deps) {
          if (typeof d === 'string') out.push(d);
        }
      } else if (typeof deps === 'object') {
        for (const name of Object.keys(deps)) {
          out.push(name);
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
            sourceFiles: mergeArrayFieldOf(l, 'source_files'),
          })),
        ),
    moduleName: specStringField('module_name'),
    frameworks: mergeArrayField('frameworks'),
    weakFrameworks: mergeArrayField('weak_frameworks'),
    libraries: mergeArrayField('libraries'),
    dependencies: mergeDependencies(),
    preprocessorDefines,
    compilerFlags,
    headerSearchPaths: mergeHeaderSearchPaths(),
    resources: mergeArrayField('resources'),
    requiresArc,
    warnings,
    partial,
    // Default: overridden in readPodspec, which can see the podspec source.
    usesInstallModulesDependencies: false,
  };
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
 * dep.
 */
function readPodspec(podspecPath /*: string */) /*: PodspecModel */ {
  if (!fs.existsSync(podspecPath)) {
    throw new Error(`readPodspec: file does not exist: ${podspecPath}`);
  }
  const podIpc = runPodIpcSpec(podspecPath);
  const raw = podIpc != null ? podIpc : regexPodspec(podspecPath);
  const model = flattenSubspecs(raw);
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
 * callers must treat it as read-only.
 */
function readPodspecCached(podspecPath /*: string */) /*: PodspecModel */ {
  const key = path.resolve(podspecPath);
  const cached = podspecModels.get(key);
  if (cached != null) {
    return cached;
  }
  const model = readPodspec(podspecPath);
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
};
