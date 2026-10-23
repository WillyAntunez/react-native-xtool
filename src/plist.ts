import * as plist from "plist";

export type BuildVars = Record<string, string>;

export interface InfoPlistOptions {
  vars: BuildVars;
  metroPort: number;
}

const VAR_PATTERN = /\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]/g;
const LEFTOVER_PATTERN = /\$[({]([^)}\r\n]*)/g;
const BONJOUR_HTTP = "_http._tcp";

function substitute(text: string, vars: BuildVars): string {
  return text.replace(VAR_PATTERN, (match, name: string) =>
    Object.hasOwn(vars, name) ? (vars[name] as string) : match,
  );
}

function leftovers(text: string): string[] {
  return [...text.matchAll(LEFTOVER_PATTERN)].map((m) => m[1] as string);
}

function assertResolved(names: string[]): void {
  if (names.length > 0) {
    const unique = [...new Set(names)].sort();
    throw new Error(`Unresolved build variable(s): ${unique.join(", ")}`);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function resolveBuildVars(xml: string, vars: BuildVars): string {
  const escaped: BuildVars = {};
  for (const [k, v] of Object.entries(vars)) escaped[k] = escapeXml(v);
  const out = substitute(xml, escaped);
  assertResolved(leftovers(out));
  return out;
}

function resolveValue(
  value: plist.PlistValue,
  vars: BuildVars,
  problems: string[],
): plist.PlistValue {
  if (typeof value === "string") {
    const out = substitute(value, vars);
    problems.push(...leftovers(out));
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, vars, problems));
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  ) {
    const out: Record<string, plist.PlistValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveValue(v as plist.PlistValue, vars, problems);
    }
    return out;
  }
  return value;
}

export function transformInfoPlist(
  xml: string,
  opts: InfoPlistOptions,
): string {
  const problems: string[] = [];
  const info = resolveValue(
    plist.parse(xml) as plist.PlistValue,
    { ...opts.vars, RCT_METRO_PORT: String(opts.metroPort) },
    problems,
  ) as Record<string, plist.PlistValue>;
  assertResolved(problems);
  delete info.UILaunchStoryboardName;
  info.UILaunchScreen = {};
  info.RCTMetroPort = String(opts.metroPort);
  info.NSLocalNetworkUsageDescription =
    "Connects to the Metro development server on your local network.";
  const existing = Array.isArray(info.NSBonjourServices)
    ? info.NSBonjourServices
    : [];
  info.NSBonjourServices = existing.includes(BONJOUR_HTTP)
    ? existing
    : [...existing, BONJOUR_HTTP];
  return plist.build(info);
}
