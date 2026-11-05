import { execa } from "execa";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { cacheDir } from "../paths.js";
import { downloadFile } from "../tools/download.js";
import { run, toolEnv } from "../tools/exec.js";
import { authStatus, defaultXtoolPath } from "../tools/xtool.js";
import { SWIFT_VERSION, XTOOL_SHA256, XTOOL_VERSION } from "../versions.js";

export type SetupAction = "install-swift" | "download-xtool" | "install-sdk" | "login-hint";
export interface SetupState {
  hasSwift: boolean;
  hasXtool: boolean;
  hasSdk: boolean;
  loggedIn: boolean;
}
export interface SetupDeps {
  probe: (xtoolBin: string) => Promise<SetupState>;
  preflightProbes: Parameters<typeof preflightSdk>[1];
  spaceProbes: SpaceProbes;
  actions: Partial<{
    installSwift: () => Promise<void>;
    downloadXtool: (bin: string) => Promise<void>;
    installSdk: (bin: string, xip: string) => Promise<void>;
  }>;
  log: (line: string) => void;
  /** Message to fail with while Swift's system packages from a previous run are still missing. */
  checkSwiftPackages: () => Promise<string | undefined>;
}

export const GB = 1024 ** 3;
/** Measured on the dev host (plan facts 7); corrected from Task 10 Step 6 (ruling Q5). */
export const SETUP_SPACE = { swift: 5 * GB, xtool: 0.2 * GB, sdk: 15 * GB, firstBuild: 4 * GB } as const;

export interface SpaceNeed {
  label: string;
  dir: string;
  bytes: number;
}

/** install-swift: "Swift toolchain" in ~/.local/share/swiftly; download-xtool: "xtool" in dirname(bin);
 *  install-sdk: "Darwin SDK" in swiftSdksDir(); with install-swift or install-sdk, also "first build"
 *  in ~/Library/Caches/ReactNative (React Native artifacts, then the app's .build). login-hint: nothing. */
export function setupSpaceNeeds(actions: SetupAction[], bin: string): SpaceNeed[] {
  const home = homedir();
  const needs: SpaceNeed[] = [];
  if (actions.includes("install-swift")) {
    needs.push({ label: "Swift toolchain", dir: path.join(home, ".local", "share", "swiftly"), bytes: SETUP_SPACE.swift });
  }
  if (actions.includes("download-xtool")) needs.push({ label: "xtool", dir: path.dirname(bin), bytes: SETUP_SPACE.xtool });
  if (actions.includes("install-sdk")) {
    needs.push({ label: "Darwin SDK", dir: swiftSdksDir(), bytes: SETUP_SPACE.sdk });
  }
  if (actions.includes("install-swift") || actions.includes("install-sdk")) {
    needs.push({
      label: "first build",
      dir: path.join(home, "Library", "Caches", "ReactNative"),
      bytes: SETUP_SPACE.firstBuild,
    });
  }
  return needs;
}

export interface SpaceProbes {
  /** Free bytes and device id of the filesystem holding `dir`, through its nearest existing ancestor. */
  filesystemOf: (dir: string) => Promise<{ dev: number; freeBytes: number }>;
}

/** `dir`, or its nearest ancestor that exists. */
function nearestExisting(dir: string): string {
  let at = path.resolve(dir);
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

export async function filesystemOf(dir: string): Promise<{ dev: number; freeBytes: number }> {
  const at = nearestExisting(dir);
  const [{ dev }, fs] = await Promise.all([stat(at), statfs(at)]);
  return { dev, freeBytes: fs.bavail * fs.bsize };
}

/** `p` with the home folder shown as `~`. */
export function tilde(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Sums the needs per filesystem; throws the message below for the first one short. No-op for []. */
export async function checkSetupSpace(needs: SpaceNeed[], probes: SpaceProbes = { filesystemOf }): Promise<void> {
  const byFilesystem = new Map<number, { freeBytes: number; needs: SpaceNeed[] }>();
  for (const need of needs) {
    const { dev, freeBytes } = await probes.filesystemOf(need.dir);
    const entry = byFilesystem.get(dev) ?? { freeBytes, needs: [] };
    entry.needs.push(need);
    byFilesystem.set(dev, entry);
  }
  for (const { freeBytes, needs: there } of byFilesystem.values()) {
    const sum = there.reduce((total, n) => total + n.bytes, 0);
    if (freeBytes >= sum) continue;
    const where = tilde(nearestExisting(there[0]!.dir));
    const parts = there.map((n) => `${n.label} ${+(n.bytes / GB).toFixed(1)} GB`).join(", ");
    throw new Error(
      `Not enough free disk space for setup: the filesystem of ${where} has ${(freeBytes / GB).toFixed(1)} GB free, and setup needs about ${Math.ceil(sum / GB)} GB there (${parts}). Free some space, then run \`rn-xtool setup\` again.`,
    );
  }
}

export function planSetup(state: SetupState): SetupAction[] {
  const actions: SetupAction[] = [];
  if (!state.hasSwift) actions.push("install-swift");
  if (!state.hasXtool) actions.push("download-xtool");
  if (!state.hasSdk) actions.push("install-sdk");
  if (!state.loggedIn) actions.push("login-hint");
  return actions;
}

const linuxArch = (): string => (process.arch === "arm64" ? "aarch64" : "x86_64");

export function xtoolDownloadUrl(arch: string = linuxArch()): string {
  return `https://github.com/xtool-org/xtool/releases/download/${XTOOL_VERSION}/xtool-${arch}.AppImage`;
}

export function swiftlyDownloadUrl(arch: string = linuxArch()): string {
  return `https://download.swift.org/swiftly/linux/swiftly-${arch}.tar.gz`;
}

/**
 * Where xtool installs the Darwin SDK: `$XDG_CONFIG_HOME/swiftpm/swift-sdks` when that is set, else
 * `~/.swiftpm/swift-sdks` (xtool 1.24.0, `DarwinSDK.swiftPMDirectory`). xtool refuses a relative XDG_CONFIG_HOME with its
 * own error, so that case keeps the default here.
 */
export function swiftSdksDir(): string {
  const config = process.env.XDG_CONFIG_HOME;
  const swiftpm =
    config !== undefined && path.isAbsolute(config) ? path.join(config, "swiftpm") : path.join(homedir(), ".swiftpm");
  return path.join(swiftpm, "swift-sdks");
}

export const sdkBundle = (): string => path.join(swiftSdksDir(), "darwin.artifactbundle");

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function swiftVersionText(timeoutMs?: number): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execa("swift", ["--version"], {
      env: toolEnv(),
      extendEnv: false,
      timeout: timeoutMs,
    });
    return /Swift version (\d+\.\d+(?:\.\d+)?)/.exec(`${stdout}\n${stderr}`)?.[1];
  } catch (e) {
    if ((e as { timedOut?: boolean }).timedOut) throw new Error("timed out");
    return undefined;
  }
}

/** True when `version` (e.g. "6.4.1") is at least `min` (e.g. "6.5"), compared on major.minor. */
export function swiftAtLeast(version: string, min: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [reqMajor = 0, reqMinor = 0] = min.split(".").map(Number);
  return major > reqMajor || (major === reqMajor && minor >= reqMinor);
}

/** True when `version` (e.g. "6.4.1") is at least the pinned SWIFT_VERSION. */
export function swiftMeetsMin(version: string): boolean {
  return swiftAtLeast(version, SWIFT_VERSION);
}

async function swiftOk(): Promise<boolean> {
  const v = await swiftVersionText();
  return v !== undefined && swiftMeetsMin(v);
}

export async function loggedIn(bin: string): Promise<boolean> {
  if (!isExecutable(bin)) return false;
  return (await authStatus(bin)).loggedIn;
}

export async function probeSetupState(bin: string): Promise<SetupState> {
  return {
    hasSwift: await swiftOk(),
    hasXtool: isExecutable(bin),
    hasSdk: existsSync(sdkBundle()),
    loggedIn: await loggedIn(bin),
  };
}

/**
 * swiftly writes the system packages a toolchain needs (an `apt-get install ...` line on Ubuntu) to the
 * `--post-install-file`; without that flag it prints them and exits non-zero. Turns that script into an
 * instruction, or undefined when there is nothing to run.
 */
export function swiftPostInstallMessage(script: string | undefined): string | undefined {
  const commands = (script ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (commands.length === 0) return undefined;
  return [
    `Swift ${SWIFT_VERSION} is installed, but it needs system packages that only an administrator can install. Run:`,
    ...commands.map((c) => (/^apt-get\s/.test(c) ? `  sudo apt-get update && sudo ${c}` : `  sudo ${c}`)),
    "then run `rn-xtool setup` again.",
  ].join("\n");
}

/** Package names from swiftly's post-install script (`apt-get -y install a b`, `yum install a`, …). */
export function packagesFromPostInstall(script: string): string[] {
  const packages: string[] = [];
  for (const line of script.split("\n")) {
    const m = /\binstall\b(.*)$/.exec(line.trim());
    if (!m || line.trim().startsWith("#")) continue;
    packages.push(...m[1]!.split(/\s+/).filter((t) => t !== "" && !t.startsWith("-")));
  }
  return packages;
}

export async function pendingSwiftPackages(
  script: string,
  isInstalled: (pkg: string) => Promise<boolean>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const pkg of packagesFromPostInstall(script)) if (!(await isInstalled(pkg))) missing.push(pkg);
  return missing;
}

const postInstallFile = (): string => path.join(cacheDir(), "swiftly", "post-install.sh");

async function dpkgInstalled(pkg: string): Promise<boolean> {
  const r = await execa("dpkg-query", ["-W", "-f=${Status}", pkg], { reject: false });
  if (r.exitCode === undefined) throw new Error("dpkg-query is not available");
  return r.exitCode === 0 && /\binstalled\b/.test(r.stdout) && !/not-installed/.test(r.stdout);
}

/**
 * A previous `setup` left swiftly's post-install script behind because its packages were missing.
 * `swift --version` works without them, so the toolchain probe would otherwise skip the step and the
 * failure would only surface later as linker errors. Re-checks them with dpkg until they are installed.
 */
export async function checkPendingSwiftPackages(): Promise<string | undefined> {
  const file = postInstallFile();
  if (!existsSync(file)) return undefined;
  const script = await readFile(file, "utf8");
  let missing: string[];
  try {
    missing = await pendingSwiftPackages(script, dpkgInstalled);
  } catch {
    // No dpkg: nothing to verify against, show the instruction one last time.
    await rm(file, { force: true });
    return swiftPostInstallMessage(script);
  }
  if (missing.length === 0) {
    await rm(file, { force: true });
    return undefined;
  }
  return swiftPostInstallMessage(script);
}

async function installSwift(): Promise<void> {
  const dir = path.join(cacheDir(), "swiftly");
  await mkdir(dir, { recursive: true });
  const tarball = path.join(dir, "swiftly.tar.gz");
  await downloadFile(swiftlyDownloadUrl(), tarball, { minBytes: 100 * 1024 });
  await run("tar", ["-xzf", tarball], { cwd: dir });
  if (!existsSync(path.join(homedir(), ".local", "share", "swiftly", "bin", "swiftly"))) {
    await run("./swiftly", ["init", "--assume-yes", "--skip-install"], { cwd: dir });
  }
  const postInstall = postInstallFile();
  await rm(postInstall, { force: true });
  await run("swiftly", ["install", SWIFT_VERSION, "--use", "--assume-yes", "--post-install-file", postInstall], {
    cwd: dir,
  });
  const message = swiftPostInstallMessage(existsSync(postInstall) ? await readFile(postInstall, "utf8") : undefined);
  if (message) throw new Error(message);
}

/** Validates the Xcode.xip before any heavy step runs; checkSetupSpace checks the disk space. */
export async function preflightSdk(
  xip: string | undefined,
  probes: { exists: (p: string) => boolean } = { exists: existsSync },
): Promise<void> {
  if (!xip) {
    throw new Error("Darwin SDK is missing: pass --xcode-xip <path to Xcode.xip> to install it");
  }
  if (!probes.exists(xip)) throw new Error(`Xcode xip not found: ${xip}`);
}

async function installSdk(bin: string, xip: string, log: (l: string) => void): Promise<void> {
  log(`Installing Darwin SDK from ${xip} (this takes several minutes and ~7 GB)`);
  await run(bin, ["sdk", "install", xip]);
}

async function step(name: string, log: (l: string) => void, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    log(`✔ ${name}`);
  } catch (err) {
    log(`✖ ${name}`);
    throw err;
  }
}

export async function setup(
  opts: { xcodeXip?: string; xtoolPath?: string },
  deps: Partial<SetupDeps> = {},
): Promise<void> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const bin = opts.xtoolPath ?? defaultXtoolPath();
  const state = await (deps.probe ?? probeSetupState)(bin);
  if (opts.xtoolPath && !state.hasXtool) {
    throw new Error(`xtoolPath is set to ${bin} but it does not exist or is not executable`);
  }
  const pending = await (deps.checkSwiftPackages ?? checkPendingSwiftPackages)();
  if (pending) throw new Error(pending);
  const actions = planSetup(state);
  // `xtool sdk install` removes it too, but only after the space check would have counted it as used space; with the
  // SDK installed, nothing else ever removes it.
  const removeSdkStaging = async (): Promise<void> => {
    const staging = `${sdkBundle()}.tmp`;
    if (!existsSync(staging)) return;
    log(`ℹ Removing ${tilde(staging)}, left by an interrupted Darwin SDK install.`);
    await rm(staging, { recursive: true, force: true });
  };
  if (actions.length === 0) {
    await removeSdkStaging();
    log("✔ Nothing to do: toolchain already set up");
    return;
  }
  if (actions.includes("install-sdk")) await preflightSdk(opts.xcodeXip, deps.preflightProbes);
  await removeSdkStaging();
  await checkSetupSpace(setupSpaceNeeds(actions, bin), deps.spaceProbes);
  const act = {
    installSwift,
    downloadXtool: (to: string) => {
      const sha256 = XTOOL_SHA256[linuxArch()];
      if (!sha256) log(`⚠ no pinned checksum for xtool on ${linuxArch()}; the download is not verified`);
      return downloadFile(xtoolDownloadUrl(), to, { mode: 0o755, sha256 });
    },
    installSdk: (to: string, xip: string) => installSdk(to, xip, log),
    ...deps.actions,
  };
  for (const action of actions) {
    switch (action) {
      case "install-swift":
        await step(`Swift ${SWIFT_VERSION} via swiftly`, log, act.installSwift);
        break;
      case "download-xtool":
        await step(`xtool ${XTOOL_VERSION}`, log, () => act.downloadXtool(bin));
        break;
      case "install-sdk":
        await step("Darwin SDK", log, () => act.installSdk(bin, opts.xcodeXip!));
        break;
      case "login-hint":
        log("Run: rn-xtool auth login");
        break;
    }
  }
}
