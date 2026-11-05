import { basename } from "node:path";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { devClientLinkLines } from "../devClientLink.js";
import {
  identify,
  locateDevice,
  pairCandidates,
  retryWhileUnreachable,
  type Located,
  type LocateOptions,
  type PairCandidate,
} from "../device/discover.js";
import { message } from "../device/errors.js";
import { loadPairRecord, pairedUdids, type LoadedPairRecord, type PairRecordSources } from "../device/pairRecord.js";
import { readPairRecordFromUsbmux } from "../device/usbmux.js";
import {
  installOverWifi,
  UploadInterruptedError,
  type WifiInstallOptions,
  type WifiInstallResult,
} from "../device/wifiInstall.js";
import { detectLanRoute, isPrivateIpv4, looksLikeTunnel, type LanRoute } from "../net.js";
import { projectPaths } from "../paths.js";
import { writeEmptyTargetObjects } from "../pods/emptyTargets.js";
import { IOS_MIN } from "../versions.js";
import { readState, rememberDevice, writeState, type BuildState } from "../state.js";
import {
  authStatus,
  devBuildIpa,
  devRun,
  installedBundleId,
  listDevices,
  xtoolBin,
  type AuthStatus,
  type Device,
} from "../tools/xtool.js";
import { explainingXtool } from "../tools/xtoolErrors.js";

type InstallState = Pick<BuildState, "bundleIdentifier" | "metroPort" | "lanIp"> & Partial<BuildState>;

export interface InstallDeps {
  xtool?: {
    loadConfig?: (root: string) => Promise<ExpoXtoolConfig>;
    bin?: (config: ExpoXtoolConfig) => string;
    authStatus?: (bin: string) => Promise<AuthStatus>;
    listDevices?: (bin: string) => Promise<Device[]>;
    readState?: (iosXtoolDir: string) => Promise<InstallState | undefined>;
    writeState?: (iosXtoolDir: string, state: BuildState) => Promise<void>;
    devRun?: (bin: string, iosXtoolDir: string) => Promise<void>;
    devBuildIpa?: (bin: string, iosXtoolDir: string) => Promise<string>;
    /** Before xtool builds: the empty objects of the targets the state records (row 90). */
    writeEmptyTargets?: (iosXtoolDir: string, targets: readonly string[]) => Promise<unknown>;
  };
  wifi?: {
    /** This computer's default route (address + interface), unless `lanIp` is configured. */
    lanRoute?: () => Promise<LanRoute>;
    locate?: (o: LocateOptions) => Promise<Located>;
    loadPairRecord?: (udid: string, src: PairRecordSources) => Promise<LoadedPairRecord>;
    pairedUdids?: () => Promise<string[]>;
    installOverWifi?: (o: WifiInstallOptions) => Promise<WifiInstallResult>;
    rememberDevice?: (
      iosXtoolDir: string,
      device: {
        deviceIp: string;
        deviceUdid: string;
        installedUdid?: string;
        installedFingerprint?: string;
        installedBundleId?: string;
      },
    ) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  };
  /** The dev-client lines after `Installed …`: the Metro URL, the deep link and its QR code. */
  devClientLink?: (root: string, state: { lanIp: string; metroPort: number }) => Promise<string[]>;
  log?: (s: string) => void;
}

export interface InstallOptions {
  /** `--network [ip]`: install over Wi‑Fi; a string is the iPhone's IP. */
  network?: boolean | string;
  udid?: string;
  /** `--pair-record <file>`. */
  pairRecord?: string;
}

/** devClient: the app opens the dev launcher. autoReload: the build has the RNXtoolDevSupport helper (an app built by
 *  an older rn-xtool has none and still needs a Reload). */
export function firstRunChecklist(
  appleId: string | undefined,
  opts: { devClient?: boolean; autoReload?: boolean } = {},
): string {
  return [
    "First-run checklist:",
    "  - Enable Developer Mode: Settings → Privacy & Security → Developer Mode (the phone reboots).",
    `  - Trust the developer certificate: Settings → General → VPN & Device Management → Apple Development: ${appleId ?? "<your Apple ID>"} → Trust.`,
    "  - Allow Local Network access when iOS asks (needed to reach Metro).",
    opts.devClient
      ? "  - On the first launch the dev launcher asks for Local Network access: tap Allow, then open the link or QR code above, or enter the Metro URL above in the launcher."
      : opts.autoReload
        ? '  - On the first launch iOS asks for Local Network access, and the red screen "No script URL provided" may show behind it: tap Allow, and the app reloads by itself.'
        : '  - On the first launch iOS asks for Local Network access and "No script URL provided" shows behind it: tap Allow, then Reload.',
    "  - With a free Apple ID the signature expires in 7 days; reinstall the app with `rn-xtool install`.",
  ].join("\n");
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Logs upload progress every 10% and installd's status whenever it changes. */
export function progressLoggers(log: (s: string) => void): Pick<WifiInstallOptions, "onUpload" | "onInstall"> {
  let lastTenth = -1;
  let lastStatus: string | undefined;
  return {
    onUpload: (sent, total) => {
      const tenth = total === 0 ? 10 : Math.floor((sent / total) * 10);
      if (tenth !== lastTenth) {
        lastTenth = tenth;
        log(`  upload ${tenth * 10}% of ${mb(total)}`);
      }
    },
    onInstall: (percent, status) => {
      if (status && status !== lastStatus) {
        lastStatus = status;
        log(`  installing: ${status}${percent !== undefined ? ` (${percent}%)` : ""}`);
      }
    },
  };
}

/**
 * Why the /24 scan must not run from this route (it would probe a VPN's or a public network's
 * hosts with our pair records), or undefined when it may.
 */
export function scanRefusal(route: LanRoute): string | undefined {
  if (!route.ip) return "this computer's LAN address is unknown";
  if (!isPrivateIpv4(route.ip)) return `this computer's address ${route.ip} is not on a private LAN`;
  if (looksLikeTunnel(route.dev)) return `this computer's route goes through ${route.dev} (a VPN or tunnel)`;
  return undefined;
}

/**
 * How a dev-client user opens the app on Metro: the URL, the deep link and its QR code; nothing without
 * expo-dev-client. A state written before bare support has neither `kind` nor `hasDevClient`: it may be an Expo
 * build with the dev client, so print the URL alone, as before.
 */
async function logDevLauncherLink(
  root: string,
  state: InstallState,
  deps: InstallDeps,
  log: (s: string) => void,
): Promise<void> {
  if (state.hasDevClient === true) {
    for (const line of await (deps.devClientLink ?? devClientLinkLines)(root, state)) log(line);
  } else if (state.kind === undefined && state.hasDevClient === undefined) {
    log(`Metro URL for the dev launcher: http://${state.lanIp}:${state.metroPort}`);
  }
}

async function authenticated(
  x: NonNullable<InstallDeps["xtool"]>,
  root: string,
): Promise<{ config: ExpoXtoolConfig; bin: string; auth: AuthStatus & { teamId: string } }> {
  const config = await (x.loadConfig ?? loadConfig)(root);
  const bin = (x.bin ?? xtoolBin)(config);
  const auth = await (x.authStatus ?? authStatus)(bin);
  if (!auth.loggedIn) {
    throw new Error(`Not logged in to Apple Developer Services. Run: rn-xtool auth login`);
  }
  if (!auth.teamId) {
    throw new Error(
      `Could not determine the Apple Team ID from \`xtool auth status\`; run \`rn-xtool auth login\` again.`,
    );
  }
  return { config, bin, auth: auth as AuthStatus & { teamId: string } };
}

/**
 * Row 90: xtool links the empty objects of the targets without sources from `.build`, which may be gone since the
 * build (deleted by hand, or a clean): `install` writes them again before xtool builds, as generate does.
 */
async function emptyObjects(x: NonNullable<InstallDeps["xtool"]>, iosXtool: string, state: InstallState): Promise<void> {
  const targets = state.emptyTargets ?? [];
  if (targets.length === 0) return;
  await (x.writeEmptyTargets ?? ((dir, t) => writeEmptyTargetObjects(dir, t, IOS_MIN)))(iosXtool, targets);
}

export async function install(root: string, deps: InstallDeps = {}, opts: InstallOptions = {}): Promise<void> {
  if (opts.network !== undefined && opts.network !== false) return installNetwork(root, deps, opts);
  const x = deps.xtool ?? {};
  const log = deps.log ?? ((s: string) => console.log(s));
  const { bin, auth } = await authenticated(x, root);
  const devices = (await (x.listDevices ?? ((b) => listDevices(b, 30000, { waitForDevice: "usb" })))(bin)).filter(
    (d) => d.transport === "usb",
  );
  if (devices.length === 0) {
    throw new Error(
      "No iPhone found over USB. Connect it, tap Trust on the phone, and enable Developer Mode (Settings → Privacy & Security). Or install over Wi‑Fi: `rn-xtool install --network`.",
    );
  }
  const iosXtool = projectPaths(root).iosXtool;
  const state = await (x.readState ?? readState)(iosXtool).catch(() => undefined);
  if (!state) throw new Error("No build found. Run `rn-xtool build` first.");
  await emptyObjects(x, iosXtool, state);
  await explainingXtool(() => (x.devRun ?? devRun)(bin, iosXtool));
  const id = installedBundleId(auth.teamId, state.bundleIdentifier);
  // Which iPhone got this build: `run` must not skip the install for a different one. The id is the one xtool signs
  // with for an Apple ID login (`start` announces Metro under it).
  const installed: Partial<BuildState> = { installedUdid: devices[0]!.udid };
  if (state.depsFingerprint !== undefined) installed.installedFingerprint = state.depsFingerprint;
  installed.installedBundleId = id;
  await (x.writeState ?? writeState)(iosXtool, { ...(state as BuildState), ...installed });
  log(`Installed ${id} on ${devices[0]!.name}`);
  await logDevLauncherLink(root, state, deps, log);
  log(firstRunChecklist(auth.appleId, { devClient: state.hasDevClient === true, autoReload: state.devSupport === true }));
}

async function installNetwork(root: string, deps: InstallDeps, opts: InstallOptions): Promise<void> {
  const x = deps.xtool ?? {};
  const w = deps.wifi ?? {};
  const log = deps.log ?? ((s: string) => console.log(s));
  const { config, bin, auth } = await authenticated(x, root);
  const iosXtool = projectPaths(root).iosXtool;
  const state = await (x.readState ?? readState)(iosXtool).catch(() => undefined);
  if (!state) throw new Error("No build found. Run `rn-xtool build` first.");

  await emptyObjects(x, iosXtool, state);
  const ipa = await explainingXtool(() => (x.devBuildIpa ?? devBuildIpa)(bin, iosXtool));
  const bundleId = installedBundleId(auth.teamId, state.bundleIdentifier);
  const route: LanRoute = config.lanIp
    ? { ip: config.lanIp }
    : await (w.lanRoute ?? (() => detectLanRoute()))().catch((): LanRoute => ({}));
  const refusal = scanRefusal(route);
  const refusalMessage = refusal
    ? `Not scanning the network for the iPhone: ${refusal}. Pass its IP: \`rn-xtool install --network <ip>\` ` +
      '(on the iPhone: Settings → Wi‑Fi → ⓘ), or set "lanIp" in rn-xtool.config.json to your Wi‑Fi address.'
    : undefined;
  const sources: PairRecordSources = {
    override: opts.pairRecord,
    fromUsbmux: (udid) => readPairRecordFromUsbmux(udid),
  };
  const load = w.loadPairRecord ?? loadPairRecord;
  const doInstall = w.installOverWifi ?? installOverWifi;
  const explicitIp = typeof opts.network === "string" ? opts.network : undefined;
  // Over Wi‑Fi the UDID is only readable inside a session, so identifying a device means trying
  // our pair records on it: the given/remembered iPhone's first, then every other one we hold.
  let candidates: Promise<PairCandidate[]> | undefined;
  const pairs = (): Promise<PairCandidate[]> =>
    (candidates ??= opts.pairRecord
      ? load("", sources).then(({ record }) => [{ record }])
      : (w.pairedUdids ?? (() => pairedUdids()))().then((all) =>
          pairCandidates([opts.udid, state.deviceUdid, ...all], (u) => load(u, sources)),
        ));

  const attempt = async (): Promise<{ where: Located; result: WifiInstallResult }> => {
    const where = await (w.locate ?? locateDevice)({
      explicitIp,
      lastIp: state.deviceIp,
      udid: opts.udid,
      preferredUdid: explicitIp ? undefined : state.deviceUdid,
      lanIp: route.ip ?? state.lanIp,
      ...(refusalMessage && { scanRefusal: refusalMessage }),
      paired: (udid) => load(udid, sources).then(() => true, () => false),
      identify: (ip) => identify(ip, { candidates: pairs }),
      log,
    });
    const { record } = await load(where.udid, sources);
    const run = (): Promise<WifiInstallResult> =>
      doInstall({ ip: where.ip, udid: where.udid, pairRecord: record, ipaPath: ipa, bundleId, ...progressLoggers(log) });
    log(`Installing ${basename(ipa)} on iPhone ${where.udid} at ${where.ip} over Wi‑Fi…`);
    try {
      return { where, result: await run() };
    } catch (e) {
      if (!(e instanceof UploadInterruptedError)) throw e;
      log(`${e.message}; retrying once…`);
      return { where, result: await run() };
    }
  };

  const { where, result } = await retryWhileUnreachable(attempt, { log, sleep: w.sleep });
  const installed = {
    deviceIp: where.ip,
    deviceUdid: where.udid,
    installedUdid: where.udid,
    ...(state.depsFingerprint !== undefined && { installedFingerprint: state.depsFingerprint }),
    // The id the iPhone reports for the uploaded app: the real signed one, whatever the login kind.
    ...(typeof result.app.CFBundleIdentifier === "string" && { installedBundleId: result.app.CFBundleIdentifier }),
  };
  await (w.rememberDevice ?? rememberDevice)(iosXtool, installed).catch((e: unknown) =>
    log(`⚠ Could not save the iPhone's address in the build state: ${message(e)}`),
  );
  const version = [result.app.CFBundleShortVersionString, result.app.CFBundleVersion].filter(Boolean).join(" ");
  log(
    `Installed ${bundleId}${version ? ` ${version}` : ""} on iPhone ${where.udid} over Wi‑Fi (${where.ip}) — ` +
      `upload ${secs(result.uploadMs)}, install ${secs(result.installMs)}`,
  );
  await logDevLauncherLink(root, state, deps, log);
  log(firstRunChecklist(auth.appleId, { devClient: state.hasDevClient === true, autoReload: state.devSupport === true }));
}
