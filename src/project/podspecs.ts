/**
 * Reading the project's dependencies and their podspecs as text: where each dependency is installed, which podspec
 * files autolinking would read, and the lines that always apply. A leaf module, shared by capabilities.ts,
 * earlyChecks.ts and the pipeline's scaffoldResources.ts. Nothing is evaluated.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * `<spec>.<name> =` or `<spec>.ios.<name> =`: a pod attribute being set for iOS, not a Ruby variable or a `==` test.
 * Another platform's attribute (`<spec>.osx.<name> =`, `.tvos.`, `.visionos.`, `.watchos.`) does not count.
 */
export function attribute(name: string): RegExp {
  return new RegExp(`(?<![\\w.])[A-Za-z_]\\w*\\.(?:ios\\.)?${name}\\s*=(?!=)`);
}

export function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory `pkg` resolves to from `root`, along Node's node_modules lookup paths (a package whose `exports`
 * hides package.json still counts).
 */
function packageDir(root: string, pkg: string): string | undefined {
  const lookup = createRequire(path.join(root, "package.json")).resolve.paths(pkg) ?? [];
  return lookup.map((dir) => path.join(dir, pkg)).find((dir) => existsSync(path.join(dir, "package.json")));
}

/** The `*.podspec` files directly in `dir`, sorted. */
function podspecsIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".podspec"))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * The podspec files of the package at `dir`, where autolinking looks: the package root (React Native's CLI), `ios/`
 * (Expo modules) and the `podspecPath` an `expo-module.config.json` declares under `apple`, else `ios`. A declared
 * path is listed whether or not it exists; readers skip the files they cannot read.
 */
export function podspecFiles(dir: string): string[] {
  const config = readJson(path.join(dir, "expo-module.config.json"));
  const declared: unknown = (config?.apple ?? config?.ios)?.podspecPath;
  const declaredFiles = (Array.isArray(declared) ? declared : [declared])
    .filter((p): p is string => typeof p === "string")
    .map((p) => path.join(dir, p));
  return [...new Set([...podspecsIn(dir), ...podspecsIn(path.join(dir, "ios")), ...declaredFiles])];
}

/** Not autolinked: react-native's own podspecs describe the core, whose artifacts are reported on their own. */
const NOT_AUTOLINKED = new Set(["react-native"]);

/**
 * The package.json `dependencies` of `root` (sorted by name, react-native left out) that resolve from it, with the
 * directory each resolves to. Listed packages that are not installed are left out.
 */
export function dependencyDirs(root: string): { name: string; dir: string }[] {
  const deps = readJson(path.join(root, "package.json"))?.dependencies;
  const names = deps !== null && typeof deps === "object" ? Object.keys(deps).filter((n) => !NOT_AUTOLINKED.has(n)).sort() : [];
  return names.flatMap((name) => {
    const dir = packageDir(root, name);
    return dir === undefined ? [] : [{ name, dir }];
  });
}

/** Comments and string contents blanked, so neither is read as code. */
export function rubyCode(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/#.*$/, "");
}

const COND_OPENER = /^\s*(?:if|unless|case|while|until)\b|=\s*(?:if|unless|case)\b/;
const OTHER_OPENER = /^\s*(?:begin|def|class|module)\b/;
const HEREDOC = /<<[-~]?(["']?)([A-Za-z_]\w*)\1/;

/**
 * The podspec lines that always apply: lines inside a `test_spec` block or a Ruby condition (`if`, `unless`, `case`,
 * `while`, `until`), lines carrying an `if`/`unless` modifier or a ternary, and heredoc bodies are left out. Block depth
 * is counted from `do`, those keywords and `end`, as an approximation; nothing is evaluated. Each line comes as code
 * (comments and string contents blanked), or with `"source"` as it is written, for reading the strings it holds.
 */
export function unconditionalLines(text: string, form: "code" | "source" = "code"): string[] {
  const lines = podspecLines(text);
  return unconditionalLineIndexes(text).map((i) => (form === "code" ? rubyCode(lines[i]!) : lines[i]!));
}

/** The podspec's lines, as `unconditionalLineIndexes` counts them. */
export function podspecLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** True when a line of code (`rubyCode`) carries an `if`/`unless` modifier. */
export function carriesModifier(code: string): boolean {
  return /\S\s+(?:if|unless)\s/.test(code.replace(COND_OPENER, ""));
}

/** The indexes in `podspecLines(text)` of the lines `unconditionalLines` keeps. */
export function unconditionalLineIndexes(text: string): number[] {
  const stack: boolean[] = []; // true: a frame whose lines may not apply
  const kept: number[] = [];
  let heredoc: string | undefined;
  for (const [at, raw] of podspecLines(text).entries()) {
    if (heredoc !== undefined) {
      if (raw.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const code = rubyCode(raw);
    heredoc = HEREDOC.exec(raw)?.[2];
    const opensCondition = COND_OPENER.test(code);
    const testSpec = /\.test_spec\b/.test(code);
    const modifier = carriesModifier(code);
    const ternary = /=(?!=)[^?]*\?\s[^:]*:/.test(code);
    if (!stack.some(Boolean) && !opensCondition && !testSpec && !modifier && !ternary) kept.push(at);
    const dos = (code.match(/\bdo\b/g) ?? []).length;
    if (opensCondition) stack.push(true);
    else if (OTHER_OPENER.test(code)) stack.push(false);
    for (let i = 0; i < dos; i++) stack.push(testSpec);
    for (let i = (code.match(/\bend\b/g) ?? []).length; i > 0 && stack.length > 0; i--) stack.pop();
  }
  return kept;
}

const SUBSPEC_OPENER = /\.subspec\s*\(?\s*(["'])([^"']+)\1[^\n]*?\bdo\b/;

/**
 * For each of `podspecLines(text)`, the top-level subspec block it is in (`s.subspec 'Name' do |ss|` … `end`), else
 * undefined: the subspec the scaffolder's reader gives its dependencies to (nested subspecs count as their outermost
 * one). Block depth is counted as in `unconditionalLineIndexes`.
 */
export function subspecOfLines(text: string): (string | undefined)[] {
  const stack: (string | undefined)[] = [];
  return podspecLines(text).map((raw) => {
    const code = rubyCode(raw);
    const current = stack.find((name) => name !== undefined);
    // Only a top-level subspec is named: one inside another counts as its outermost.
    const opened = current === undefined ? SUBSPEC_OPENER.exec(raw)?.[2] : undefined;
    if (COND_OPENER.test(code) || OTHER_OPENER.test(code)) stack.push(undefined);
    const dos = (code.match(/\bdo\b/g) ?? []).length;
    for (let i = 0; i < dos; i++) stack.push(i === 0 ? opened : undefined);
    for (let i = (code.match(/\bend\b/g) ?? []).length; i > 0 && stack.length > 0; i--) stack.pop();
    return current;
  });
}

/** `<spec>.dependency` or `<spec>.ios.dependency` at the start of a line, with an optional `(`. */
const DEPENDENCY = /^\s*[A-Za-z_]\w*\.(?:ios\.)?dependency\b\s*\(?\s*/;
const STRING = /^(["'])((?:(?!\1)[^\\]|\\.)*)\1/;

/**
 * The pod dependencies on `lines` (podspec lines as written, such as `unconditionalLines(text, "source")`):
 * `<spec>.dependency 'Name'` or `<spec>.ios.dependency 'Name'`, with the requirement strings that follow, one by one or
 * in one `[…]` list, each trimmed. Another platform's dependency, a name built with `#{…}`, and a line that does not
 * start with the call are left out; the requirements stop at the first value that is not a string.
 */
export function podDependencies(lines: readonly string[]): { name: string; requirements: string[] }[] {
  return lines.flatMap((line) => {
    const head = DEPENDENCY.exec(line);
    if (head === null) return [];
    let rest = line.slice(head[0].length);
    const take = (re: RegExp): RegExpExecArray | null => {
      const m = re.exec(rest);
      if (m !== null) rest = rest.slice(m[0].length);
      return m;
    };
    const name = take(STRING)?.[2];
    if (name === undefined || name === "" || name.includes("#{")) return [];
    const requirements: string[] = [];
    items: while (take(/^\s*,\s*/) !== null) {
      const list = take(/^\[\s*/) !== null;
      do {
        const item = take(STRING);
        if (item === null) break items;
        requirements.push(item[2]!.trim());
      } while (list && take(/^\s*,\s*/) !== null);
      if (list && take(/^\s*\]/) === null) break;
    }
    return [{ name, requirements }];
  });
}
