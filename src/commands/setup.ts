import { execa } from "execa";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { cacheDir } from "../paths.js";
import { downloadFile } from "../tools/download.js";
import { run, toolEnv } from "../tools/exec.js";
import { authStatus, defaultXtoolPath } from "../tools/xtool.js";
import { SWIFT_VERSION, XTOOL_VERSION } from "../versions.js";

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
  log: (line: string) => void;
}

const MIN_FREE_BYTES = 10 * 1024 ** 3;

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

export const sdkBundle = (): string => path.join(homedir(), ".swiftpm", "swift-sdks", "darwin.artifactbundle");

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

/** True when `version` (e.g. "6.4.1") is at least the pinned SWIFT_VERSION. */
export function swiftMeetsMin(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [reqMajor = 0, reqMinor = 0] = SWIFT_VERSION.split(".").map(Number);
  return major > reqMajor || (major === reqMajor && minor >= reqMinor);
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

async function installSwift(): Promise<void> {
  const dir = path.join(cacheDir(), "swiftly");
  await mkdir(dir, { recursive: true });
  const tarball = path.join(dir, "swiftly.tar.gz");
  await downloadFile(swiftlyDownloadUrl(), tarball, { minBytes: 100 * 1024 });
  await run("tar", ["-xzf", tarball], { cwd: dir });
  if (!existsSync(path.join(homedir(), ".local", "share", "swiftly", "bin", "swiftly"))) {
    await run("./swiftly", ["init", "--assume-yes", "--skip-install"], { cwd: dir });
  }
  await run("swiftly", ["install", SWIFT_VERSION, "--use", "--assume-yes"], { cwd: dir });
}

export async function freeBytesForSdk(): Promise<number> {
  const swiftpm = path.join(homedir(), ".swiftpm");
  const fs = await statfs(existsSync(swiftpm) ? swiftpm : homedir());
  return fs.bavail * fs.bsize;
}

/** Validates the Xcode.xip and free disk space before any heavy step runs. */
export async function preflightSdk(
  xip: string | undefined,
  probes: { exists: (p: string) => boolean; freeBytes: () => Promise<number> } = {
    exists: existsSync,
    freeBytes: freeBytesForSdk,
  },
): Promise<void> {
  if (!xip) {
    throw new Error("Darwin SDK is missing: pass --xcode-xip <path to Xcode.xip> to install it");
  }
  if (!probes.exists(xip)) throw new Error(`Xcode xip not found: ${xip}`);
  if ((await probes.freeBytes()) < MIN_FREE_BYTES) {
    throw new Error("Need at least 10 GB free in your home filesystem (~/.swiftpm) to install the Darwin SDK");
  }
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
  const actions = planSetup(state);
  if (actions.length === 0) {
    log("✔ Nothing to do: toolchain already set up");
    return;
  }
  if (actions.includes("install-sdk")) await preflightSdk(opts.xcodeXip, deps.preflightProbes);
  for (const action of actions) {
    switch (action) {
      case "install-swift":
        await step(`Swift ${SWIFT_VERSION} via swiftly`, log, installSwift);
        break;
      case "download-xtool":
        await step(`xtool ${XTOOL_VERSION}`, log, () =>
          downloadFile(xtoolDownloadUrl(), bin, { mode: 0o755 }),
        );
        break;
      case "install-sdk":
        await step("Darwin SDK", log, () => installSdk(bin, opts.xcodeXip!, log));
        break;
      case "login-hint":
        log(`Run: ${bin} auth login`);
        break;
    }
  }
}
