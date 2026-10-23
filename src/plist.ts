import * as plist from "plist";

export type BuildVars = Record<string, string>;

export interface InfoPlistOptions {
  vars: BuildVars;
  metroPort: number;
}

const VAR_PATTERN = /\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]/g;
const BONJOUR_HTTP = "_http._tcp";

export function resolveBuildVars(xml: string, vars: BuildVars): string {
  const unresolved = new Set<string>();
  const out = xml.replace(VAR_PATTERN, (match, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name] as string;
    unresolved.add(name);
    return match;
  });
  if (unresolved.size > 0) {
    throw new Error(
      `Unresolved build variable(s): ${[...unresolved].sort().join(", ")}`,
    );
  }
  return out;
}

export function transformInfoPlist(
  xml: string,
  opts: InfoPlistOptions,
): string {
  const info = plist.parse(
    resolveBuildVars(xml, {
      ...opts.vars,
      RCT_METRO_PORT: String(opts.metroPort),
    }),
  ) as Record<string, plist.PlistValue>;
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
