/**
 * `rn-xtool doctor --report`: one paste-ready block for a GitHub issue. The doctor probes are wrapped to record the
 * private values they return (Apple ID, Team ID, UDIDs, device names, IPs), and the rendered block is redacted: those
 * values first, then patterns for what no probe returned (bundle prefixes, e-mails, UDIDs, IPs, tokens, home folders).
 * It makes no network request: the artifacts line reads the cache or the local folder only, and the Wi‑Fi probe (a
 * lockdown session over USB, a connection to the iPhone's last IP) does not run.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, type ExpoXtoolConfig } from "../config.js";
import { projectPaths } from "../paths.js";
import { podspecReportLines, readPodspecReads } from "../pipeline/podspecReads.js";
import { MissingBundleIdentifierError } from "../project/index.js";
import { packageRoot } from "../tools/exec.js";
import { doctorWithProbes, realProbes, renderReport, type DoctorProbes, type DoctorReport } from "./doctor.js";

export interface SeenValues {
  appleIds: string[];
  teamIds: string[];
  udids: string[];
  deviceNames: string[];
  ips: string[];
  bundleIds: string[];
}

/** No recorded value: `redact` by pattern only (an error printed before any probe ran). */
export const NOTHING_SEEN: Readonly<SeenValues> = Object.freeze({
  appleIds: [],
  teamIds: [],
  udids: [],
  deviceNames: [],
  ips: [],
  bundleIds: [],
});

const push = (list: string[], value: string | undefined): void => {
  if (value !== undefined && value.trim() !== "") list.push(value);
};

/** `p`, recording into `seen` each private value its probes return; results and rejections pass through unchanged. */
export function recordingProbes(p: DoctorProbes, seen: SeenValues): DoctorProbes {
  return {
    ...p,
    authStatus: async () => {
      const a = await p.authStatus();
      push(seen.appleIds, a.appleId);
      push(seen.teamIds, a.teamId);
      return a;
    },
    devices: async () => {
      const devices = await p.devices();
      for (const d of devices) {
        push(seen.udids, d.udid);
        push(seen.deviceNames, d.name);
      }
      return devices;
    },
    wifi: async (root) => {
      const w = await p.wifi(root);
      push(seen.udids, w.usb?.udid);
      push(seen.ips, w.lastIp);
      return w;
    },
    lanRoute: async () => {
      const route = await p.lanRoute();
      push(seen.ips, route.ip);
      return route;
    },
    configLanIp: () => {
      const ip = p.configLanIp();
      push(seen.ips, ip);
      return ip;
    },
    buildState: async (root) => {
      const state = await p.buildState(root);
      push(seen.ips, state?.lanIp);
      return state;
    },
    project: async (root) => {
      try {
        const info = await p.project(root);
        push(seen.bundleIds, info.bundleIdentifier);
        return info;
      } catch (e) {
        // The id build would write: the slug is in it.
        if (e instanceof MissingBundleIdentifierError) push(seen.bundleIds, e.suggestion);
        throw e;
      }
    },
  };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One IPv4 octet, 0 to 255. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`(?<!\\d)(?:${OCTET}\\.){3}${OCTET}(?!\\d)`, "g");
const H16 = "[0-9a-f]{1,4}";
/** The full form (eight groups), or a compressed one with `::`; an optional IPv4 tail and zone. */
const IPV6 = new RegExp(
  `(?<!\\w)(?:(?:${H16}:){7}${H16}|(?:${H16}(?::${H16}){0,6})?::(?:${H16}(?::${H16}){0,6})?)` +
    `(?::${OCTET}(?:\\.${OCTET}){3})?(?:%[\\w.-]+)?(?![\\w:]|\\.\\d)`,
  "gi",
);

/** Runs of base64url characters (no `/`, so paths are kept); a token when 32+ long with upper and lower case. */
const BASE64_RUN = /(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_=-])/g;

/** A user folder's name: up to the next `/` or the end of the path. */
const USER_NAME = "[^/\\s,;:'\")\\]]+";
/**
 * A Windows user folder's name, which may have spaces: it cannot end in one, and ends at a `/`, the end of the line or
 * a delimiter; else just its first word.
 */
const WINDOWS_USER_NAME = `(?:[^/\\s](?:[^/\\n]*?[^/\\s])?(?=/|$|[,:;)'"\\]])|${USER_NAME})`;
/** Folders that hold users' folders: the pattern, the name's pattern and what the pair becomes. */
const USER_ROOTS: [string, string, string][] = [
  // Fedora Silverblue and other image-based systems keep homes under /var/home.
  ["/var/home", USER_NAME, "~"],
  ["/home", USER_NAME, "~"],
  ["/mnt/[a-z]/Users", WINDOWS_USER_NAME, "~"],
  // External drives: the user's folder is not the home folder, so only the name goes.
  ["/run/media", USER_NAME, "/run/media/<user>"],
  ["(?<!/run)/media", USER_NAME, "/media/<user>"],
];
const TRANSPORT = "(?:USB|usb|Usb|Network|network|NETWORK)";
/** Device names shorter than this are not replaced everywhere (`ip` would hit every `<ip>`). */
const MIN_DEVICE_NAME = 3;

/**
 * `text` with every private value replaced:
 * 1. a bundle id with the `XTL-<team>.` prefix → `<bundle id>` (before the Team ID itself is replaced);
 * 2. the values the probes returned, longest first: `<apple-id>`, `<team-id>`, `<udid>`, `<device>` (3 characters or
 *    more), `<ip>`, `<bundle id>`; then the same kinds by context when no probe returned them: a bundle id the text
 *    names as one (bundle identifier, bundleIdentifier, PRODUCT_BUNDLE_IDENTIFIER; ids often carry a person's name,
 *    Expo suggests `com.<username>.<slug>`), `Team ID <id>`, `Apple ID <id>`, and the device name on doctor's device
 *    line and in `xtool devices` output;
 * 3. e-mail addresses → `<email>`, MAC addresses → `<mac>` (also inside `enx…`/`wlx…`/`wwx…` interface names);
 * 4. UDIDs (8-16 and 40 hex) → `<udid>`;
 * 5. IPv6 and IPv4 addresses → `<ip>`;
 * 6. tokens (GitHub tokens, JWTs, Bearer values, token=/password=/secret= values, long mixed-case base64 runs) → `<token>`;
 * 7. the home folder, then any other user's folder (beside it, under /home or /var/home, or a WSL Windows home) → `~`;
 *    the user's folder on an external drive (`/media/<user>`, `/run/media/<user>`).
 */
export function redact(text: string, ctx: { home: string; seen: SeenValues }): string {
  let out = text.replace(/\bXTL-[A-Z0-9]{10}\.[A-Za-z0-9.-]*[A-Za-z0-9-]/gi, "<bundle id>");

  const values: [string, string][] = [
    ...ctx.seen.appleIds.map((v): [string, string] => [v, "<apple-id>"]),
    ...ctx.seen.teamIds.map((v): [string, string] => [v, "<team-id>"]),
    ...ctx.seen.udids.map((v): [string, string] => [v, "<udid>"]),
    ...ctx.seen.deviceNames.map((v): [string, string] => [v, "<device>"]),
    ...ctx.seen.ips.map((v): [string, string] => [v, "<ip>"]),
    ...ctx.seen.bundleIds.map((v): [string, string] => [v, "<bundle id>"]),
  ]
    .map(([v, placeholder]): [string, string] => [v.trim(), placeholder])
    .filter(([v, placeholder]) => v !== "" && (placeholder !== "<device>" || v.length >= MIN_DEVICE_NAME))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [value, placeholder] of values) {
    // An IP is not replaced inside a longer one (10.0.0.1 in 10.0.0.12): the pattern below takes that one whole.
    const re = placeholder === "<ip>" ? `(?<![\\d.])${escapeRegExp(value)}(?!\\d)` : escapeRegExp(value);
    out = out.replace(new RegExp(re, "gi"), placeholder);
  }
  out = out.replace(
    /\b(bundle identifier |bundleIdentifier["']?\s*[:=]\s*["']?|PRODUCT_BUNDLE_IDENTIFIER\s*=\s*["']?)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    "$1<bundle id>",
  );
  out = out
    .replace(/\b(Team ID:?\s+)[A-Z0-9]{10}\b/g, "$1<team-id>")
    // An Apple ID is an e-mail address or a phone number: a word without `@` or a digit ("not logged in") stays.
    .replace(/\b(Apple ID:?\s+)(?!<)(?=[^\s,;]*[@\d])[^\s,;]+/g, "$1<apple-id>")
    .replace(new RegExp(`(\\bdevice — )(?!<device> )(.+)( \\(${TRANSPORT}\\))$`, "gm"), "$1<device>$3")
    .replace(new RegExp(`^(?!<device> )(.+?) (\\[${TRANSPORT}\\]:)`, "gm"), "<device> $2");

  // Not SwiftPM's versioned manifest name (Package@swift-6.5.swift).
  out = out.replace(/[A-Za-z0-9._%+-]+@(?!swift-\d)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");

  // systemd names USB network adapters after their MAC (73-usb-net-by-mac.link): the prefix stays.
  out = out
    .replace(/\b((?:en|wl|ww)x)[0-9a-f]{12}\b/gi, "$1<mac>")
    .replace(/(?<![\w:-])[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}(?![\w:-])/gi, "<mac>");

  out = out
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{16}\b/gi, "<udid>")
    .replace(/\b[0-9a-f]{40}\b/gi, "<udid>");

  out = out.replace(IPV6, (m) => (m === "::" ? m : "<ip>")).replace(IPV4, "<ip>");

  out = out
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<token>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<token>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<token>")
    .replace(/\b([\w-]*(?:token|password|passwd|secret))=(?!<token>)[^\s&"',;]+/gi, "$1=<token>")
    .replace(BASE64_RUN, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) ? "<token>" : m));

  const home = ctx.home.replace(/\/+$/, "");
  const roots = [...USER_ROOTS];
  if (home !== "") {
    // Only the folder itself: a longer name beside it is another user's folder, and a longer path ending in it
    // (`/var/home/me` for `/home/me`) is another folder; both are replaced below.
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(home)}(?![\\w.-])`, "g"), "~");
    const beside = path.posix.dirname(home);
    if (beside !== "/") roots.unshift([escapeRegExp(beside), USER_NAME, "~"]);
  }
  for (const [root, name, replacement] of roots) {
    // A root starts a path: `/home` is not the end of `/var/home`.
    out = out.replace(new RegExp(`(?<![\\w.-])${root}/(?!<user>)${name}`, "gm"), replacement);
  }
  return out;
}

export interface ReportEnv {
  rnXtoolVersion: string;
  os: string;
  arch: string;
  home: string;
}

/** The PRETTY_NAME of /etc/os-release, else "Linux". */
function osName(): string {
  try {
    const m = /^PRETTY_NAME=(["']?)(.*)\1\s*$/m.exec(readFileSync("/etc/os-release", "utf8"));
    if (m?.[2]) return m[2];
  } catch {
    // No os-release: plain "Linux".
  }
  return "Linux";
}

export function realReportEnv(): ReportEnv {
  let version = "unknown";
  try {
    version = (JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version: string }).version;
  } catch {
    // Keep "unknown": the report still prints.
  }
  return { rnXtoolVersion: version, os: `${osName()}, Linux ${os.release()}`, arch: process.arch, home: os.homedir() };
}

export const REVIEW_LINE =
  "Read the report before you post it: rn-xtool replaced your home folder, Apple ID, Team ID, bundle identifiers, " +
  "device names and UDIDs, IP and MAC addresses and tokens with placeholders. Remove anything else you consider private.";

function projectLine(r: DoctorReport, inProject: boolean): string {
  if (!inProject) return "none (run it in the project folder)";
  const c = r.capabilities;
  const parts = [
    c?.kind,
    c?.sdk === undefined ? undefined : `Expo SDK ${c.sdk}`,
    c?.expoVersion === undefined ? undefined : `expo ${c.expoVersion}`,
    c?.rnVersion === undefined ? undefined : `react-native ${c.rnVersion}`,
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : "unknown (see the project line)";
}

/**
 * The block, fenced as text, before redaction. `podspecLines` are the last `rn-spm`'s reader and `ENV` names
 * (`podspecReportLines`): the report is the only place outside the reads file that names them (R2, R4).
 */
export function renderIssueReport(
  r: DoctorReport,
  env: ReportEnv,
  opts: { projectOnly: boolean; nodeVersion: string; inProject: boolean; podspecLines: string[] },
): string {
  const detail = (name: string): string => r.checks.find((c) => c.name === name)?.detail ?? "not checked";
  const tool = (name: string): string => (opts.projectOnly ? "not checked (--project)" : detail(name));
  return [
    "```text",
    "rn-xtool doctor --report",
    `rn-xtool: ${env.rnXtoolVersion}`,
    `node: ${opts.nodeVersion}`,
    `swift: ${tool("swift")}`,
    `xtool: ${tool("xtool")}`,
    // doctor --project checks Ruby too.
    `ruby: ${detail("ruby")}`,
    ...opts.podspecLines,
    `os: ${env.os}, ${env.arch}`,
    `project: ${projectLine(r, opts.inProject)}`,
    renderReport(r.checks),
    "```",
  ].join("\n");
}

/**
 * The real probes, offline, with the config loaded as `doctor` loads it (none under `--project`). A config that cannot
 * be read gives the defaults here: the project line reports it, since the project readers load it again.
 */
export async function reportProbes(dir: string, projectOnly: boolean): Promise<DoctorProbes> {
  let config: ExpoXtoolConfig = DEFAULT_CONFIG;
  if (!projectOnly) config = await loadConfig(dir).catch((): ExpoXtoolConfig => DEFAULT_CONFIG);
  return realProbes(config, { offline: true });
}

/**
 * `fn`, with whatever it prints dropped: the console and the process's stdout and stderr. An `app.config.js` that Expo
 * evaluates in this process may print, and nothing may reach the terminal outside the redacted block.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = methods.map((m) => console[m]);
  const { stdout, stderr } = process;
  const writes = [stdout.write, stderr.write];
  const drop = ((_chunk: unknown, ...rest: unknown[]): boolean => {
    const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  for (const m of methods) console[m] = () => {};
  stdout.write = drop;
  stderr.write = drop;
  try {
    return await fn();
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]!));
    stdout.write = writes[0]!;
    stderr.write = writes[1]!;
  }
}

/** The redacted report, then the line asking the user to review it. */
export async function doctorReport(
  root: string | undefined,
  opts: { projectOnly?: boolean; probes?: DoctorProbes; env?: ReportEnv } = {},
): Promise<string> {
  const projectOnly = opts.projectOnly === true;
  const seen: SeenValues = { appleIds: [], teamIds: [], udids: [], deviceNames: [], ips: [], bundleIds: [] };
  let home = opts.env?.home ?? os.homedir();
  try {
    return await quietly(async () => {
      const probes = opts.probes ?? (await reportProbes(root ?? process.cwd(), projectOnly));
      const env = opts.env ?? realReportEnv();
      home = env.home;
      const r = await doctorWithProbes(recordingProbes(probes, seen), root, {
        projectOnly,
        withCapabilities: true,
        noLiveProbes: true,
      });
      const inProject = root !== undefined || projectOnly;
      // Without a project there is no reads file.
      const project = inProject ? projectPaths(root ?? process.cwd()) : undefined;
      const reads = project !== undefined ? readPodspecReads(project.podspecReads) : [];
      const text = renderIssueReport(r, env, {
        projectOnly,
        nodeVersion: probes.nodeVersion(),
        inProject,
        podspecLines: podspecReportLines(reads, project?.root ?? ""),
      });
      return `${redact(text, { home, seen })}\n${REVIEW_LINE}`;
    });
  } catch (e) {
    // Whatever failed, its message is redacted with what the probes returned so far.
    throw new Error(redact(e instanceof Error ? e.message : String(e), { home, seen }));
  }
}
