import { networkInterfaces } from "node:os";
import { requireFromProject } from "./project/requireFromProject.js";

export interface AnnounceInput {
  root: string;
  name: string;
  slug: string;
  port: number;
  iosBundleIdentifier: string;
  /** dnssd-advertise's report of an error, one per network interface it cannot use; see lanAnnouncementFailure. */
  onError?: (e: unknown) => void;
}

type Advertise = (o: object) => () => Promise<void>;

/** dnssd-advertise's advertise() through requireFromProject; undefined when missing or not a function. */
export function loadAdvertiser(root: string): Advertise | undefined {
  const advertise = (requireFromProject(root, "dnssd-advertise") as { advertise?: unknown } | undefined)?.advertise;
  return typeof advertise === "function" ? (advertise as Advertise) : undefined;
}

/** Announces _expo._tcp as Expo CLI does: { name, type: "expo", protocol: "tcp", hostname: slug, port, stack: "IPv4",
 *  txt: { name, slug, iosBundleIdentifier } }, plus onError when given (Expo CLI passes none). Resolves to the stop
 *  function; rejects when the library is missing, advertise() throws, or the library is not the 1.x API Expo CLI uses
 *  (an advertise() that returns its stop function at once): then nothing stays announced. */
export async function announceDevServer(i: AnnounceInput): Promise<() => Promise<void>> {
  const lib = requireFromProject(i.root, "dnssd-advertise") as { advertise?: unknown } | null | undefined;
  if (lib === undefined) throw new Error("dnssd-advertise is not installed in the project");
  const advertise = lib?.advertise;
  if (typeof advertise !== "function") throw new Error("dnssd-advertise has no advertise() function");
  const stop: unknown = (advertise as (o: object) => unknown)({
    name: i.name,
    type: "expo",
    protocol: "tcp",
    hostname: i.slug,
    port: i.port,
    stack: "IPv4",
    txt: { name: i.name, slug: i.slug, iosBundleIdentifier: i.iosBundleIdentifier },
    ...(i.onError !== undefined ? { onError: i.onError } : {}),
  });
  if (typeof stop === "function") return stop as () => Promise<void>;
  // Another API: whatever it may have started is stopped, so it cannot run next to Expo's announcement.
  if (typeof (stop as { then?: unknown } | null)?.then === "function") {
    Promise.resolve(stop)
      .then((s: unknown) => (typeof s === "function" ? (s as () => unknown)() : undefined))
      .catch(() => {});
  }
  throw new Error("dnssd-advertise's advertise() did not return a stop function");
}

/** getenv 2.0's boolish, as Expo CLI reads its switches: "true"/"false" in any case, "1" or "0", the fallback when
 *  unset; any other value (an empty one too) throws. */
function boolish(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name] ?? String(fallback);
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "false") return lower === "true";
  if (value === "1" || value === "0") return value === "1";
  throw new Error(`${name}=${value} is not a boolean`);
}

/**
 * Whether Expo CLI would announce Metro over Bonjour in `env`, so a user who turned it off (CI, or
 * EXPO_UNSTABLE_BONJOUR=0) gets no announcement from rn-xtool either. Expo CLI's rule (57.0.32 and 58.1.17,
 * start/server/Bonjour.js and utils/env.js): `!CI && EXPO_UNSTABLE_BONJOUR`, the latter defaulting to
 * `!EXPO_UNSTABLE_HEADLESS`, which defaults to the webcontainer check. A value Expo CLI cannot read makes it throw:
 * no announcement then either.
 */
export function expoAnnouncesBonjour(
  env: NodeJS.ProcessEnv,
  versions: NodeJS.ProcessVersions = process.versions,
): boolean {
  return bonjourOffSwitch(env, versions) === undefined;
}

/**
 * The setting that turns the announcement off in `env` by expoAnnouncesBonjour's rule, as `NAME=value`: CI, else the
 * first one set of EXPO_UNSTABLE_BONJOUR, EXPO_UNSTABLE_HEADLESS and EXPO_FORCE_WEBCONTAINER_ENV (SHELL in a real
 * webcontainer), or the one whose value Expo CLI cannot read. Undefined when the announcement is on.
 */
export function bonjourOffSwitch(
  env: NodeJS.ProcessEnv,
  versions: NodeJS.ProcessVersions = process.versions,
): string | undefined {
  const named = (name: string): string => `${name}=${env[name] ?? ""}`;
  let reading = "CI";
  try {
    if (boolish(env, reading, false)) return named(reading);
    reading = "EXPO_FORCE_WEBCONTAINER_ENV";
    const forced = boolish(env, reading, false);
    const webcontainer = forced || (env.SHELL === "/bin/jsh" && Boolean((versions as { webcontainer?: string }).webcontainer));
    reading = "EXPO_UNSTABLE_HEADLESS";
    const headless = boolish(env, reading, webcontainer);
    reading = "EXPO_UNSTABLE_BONJOUR";
    if (boolish(env, reading, !headless)) return undefined;
    if (env.EXPO_UNSTABLE_BONJOUR !== undefined) return named("EXPO_UNSTABLE_BONJOUR");
    if (env.EXPO_UNSTABLE_HEADLESS !== undefined) return named("EXPO_UNSTABLE_HEADLESS");
    return named(forced ? "EXPO_FORCE_WEBCONTAINER_ENV" : "SHELL");
  } catch {
    return named(reading);
  }
}

export type NetworkInterfaces = ReturnType<typeof networkInterfaces>;

/** The interface an onError report is about: named in its message, or owning its `address`. */
function interfaceOf(e: unknown, addresses: Map<string, string[]>): string | undefined {
  const named = /interface "([^"]+)"/.exec(e instanceof Error ? e.message : String(e))?.[1];
  if (named !== undefined) return named;
  const address = e !== null && typeof e === "object" ? (e as { address?: unknown }).address : undefined;
  if (typeof address !== "string") return undefined;
  for (const [name, list] of addresses) if (list.includes(address)) return name;
  return undefined;
}

/**
 * Reads dnssd-advertise's onError reports. It announces on every interface with a non-internal address and reports
 * each one it cannot use (a Docker bridge or veth, a VPN) while the others keep announcing; some reports name no
 * interface (a send error carries the multicast address). Returns a function that says whether a report is about the
 * interface that carries `lanIp` (named in its message, or by one of its addresses): only then can the iPhone on the
 * LAN no longer see the announcement.
 */
export function lanAnnouncementFailure(
  lanIp: string,
  interfaces: NetworkInterfaces = networkInterfaces(),
): (e: unknown) => boolean {
  const candidates = new Map<string, string[]>();
  for (const [name, infos] of Object.entries(interfaces)) {
    const v4 = (infos ?? []).filter((n) => n.family === "IPv4" && !n.internal).map((n) => n.address);
    if (v4.length > 0) candidates.set(name, v4);
  }
  const lan = [...candidates].find(([, list]) => list.includes(lanIp))?.[0];
  return (e) => lan !== undefined && interfaceOf(e, candidates) === lan;
}
