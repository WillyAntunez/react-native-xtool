import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkSetupSpace,
  GB,
  loggedIn,
  packagesFromPostInstall,
  pendingSwiftPackages,
  planSetup,
  preflightSdk,
  sdkBundle,
  setup as realSetup,
  type SetupDeps,
  setupSpaceNeeds,
  swiftlyDownloadUrl,
  swiftPostInstallMessage,
  xtoolDownloadUrl,
} from "../src/commands/setup.js";

const all = { hasSwift: true, hasXtool: true, hasSdk: true, loggedIn: true };
const withRuby = () => ({ reader: "ruby", ruby: "3.3.8", forced: false, warning: null }) as const;
const RUBY_LINE = "✔ ruby 3.3.8";
const noPending = async () => undefined;

// No test reaches the network: a download that slips through fails here instead.
const blockedFetch = vi.fn(async () => {
  throw new Error("no network in tests");
});
beforeEach(() => {
  blockedFetch.mockClear();
  vi.stubGlobal("fetch", blockedFetch);
});

const tmps: string[] = [];
afterEach(() => {
  expect(blockedFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rn-xtool-setup-"));
  tmps.push(d);
  return d;
};
/** A temporary HOME (and XDG cache inside it), so nothing touches the real ~/.swiftpm or caches. */
const tmpHome = () => {
  const home = tmp();
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CACHE_HOME", join(home, ".cache"));
  vi.stubEnv("XDG_CONFIG_HOME", undefined); // the SDK goes to ~/.swiftpm unless a test sets it
  return home;
};
const underTmp = (p: string | undefined) => p !== undefined && tmps.some((d) => p === d || p.startsWith(d + sep));

const noInstaller = (name: string) => async () => {
  throw new Error(`no real installer in tests: ${name}`);
};
/**
 * Every setup() in this file goes through here: the real installers are replaced by ones that throw (a test's own
 * fakes win), the disk is roomy unless the test probes it, Ruby 3.3.8 reads podspecs unless the test says otherwise,
 * and HOME is temporary unless the test set one up.
 */
const setup = (opts: Parameters<typeof realSetup>[0], deps: Partial<SetupDeps> = {}) => {
  if (!underTmp(process.env.HOME)) tmpHome();
  return realSetup(opts, {
    spaceProbes: { filesystemOf: async () => ({ dev: 1, freeBytes: 100 * GB }) },
    podspecReader: withRuby,
    ...deps,
    actions: {
      installSwift: noInstaller("installSwift"),
      downloadXtool: noInstaller("downloadXtool"),
      installSdk: noInstaller("installSdk"),
      ...deps.actions,
    },
  });
};

describe("planSetup", () => {
  it("returns nothing when everything is present", () => {
    expect(planSetup(all)).toEqual([]);
  });
  it("plans only the missing SDK", () => {
    expect(planSetup({ ...all, hasSdk: false })).toEqual(["install-sdk"]);
  });
  it("plans everything in order", () => {
    expect(planSetup({ hasSwift: false, hasXtool: false, hasSdk: false, loggedIn: false })).toEqual([
      "install-swift",
      "download-xtool",
      "install-sdk",
      "login-hint",
    ]);
  });
});

describe("download urls", () => {
  it("builds xtool url without a v prefix", () => {
    expect(xtoolDownloadUrl("x86_64")).toBe(
      "https://github.com/xtool-org/xtool/releases/download/1.24.0/xtool-x86_64.AppImage",
    );
  });
  it("builds swiftly url", () => {
    expect(swiftlyDownloadUrl("aarch64")).toBe(
      "https://download.swift.org/swiftly/linux/swiftly-aarch64.tar.gz",
    );
  });
});

describe("setup", () => {
  it("does nothing when the probe reports a complete state", async () => {
    const log = vi.fn();
    await setup({}, { checkSwiftPackages: noPending, probe: async () => all, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Nothing to do"));
  });

  it("says whether Ruby is there and installs nothing", async () => {
    const lines = async (deps: Partial<SetupDeps>): Promise<string[]> => {
      const log = vi.fn();
      await setup({}, { checkSwiftPackages: noPending, probe: async () => all, ...deps, log });
      return log.mock.calls.map((c) => c[0] as string);
    };
    const noRuby = () => ({ reader: "reduced", why: "Ruby was not found", forced: false, warning: null }) as const;
    expect(await lines({ podspecReader: noRuby })).toEqual([
      "⚠ Ruby was not found: rn-xtool reads podspecs with its reduced reader; install Ruby with: sudo apt install ruby",
      "✔ Nothing to do: toolchain already set up",
    ]);
    expect(await lines({ podspecReader: withRuby })).toEqual(["✔ ruby 3.3.8", "✔ Nothing to do: toolchain already set up"]);
    // With an action to run, the line comes before it; the throwing installers prove nothing is installed for Ruby.
    expect(await lines({ podspecReader: noRuby, probe: async () => ({ ...all, loggedIn: false }) })).toEqual([
      "⚠ Ruby was not found: rn-xtool reads podspecs with its reduced reader; install Ruby with: sudo apt install ruby",
      "Run: rn-xtool auth login",
    ]);
  });
});

describe("preflightSdk", () => {
  const ok = { exists: () => true };
  it("requires an xip", async () => {
    await expect(preflightSdk(undefined, ok)).rejects.toThrow("--xcode-xip");
  });
  it("rejects a missing file", async () => {
    await expect(preflightSdk("/x.xip", { exists: () => false })).rejects.toThrow("not found");
  });
  it("passes with an existing xip", async () => {
    await expect(preflightSdk("/x.xip", ok)).resolves.toBeUndefined();
  });
  it("setup fails before running any action when the xip is missing", async () => {
    const log = vi.fn();
    await expect(
      setup({}, { checkSwiftPackages: noPending, probe: async () => ({ ...all, hasSwift: false, hasSdk: false }), log }),
    ).rejects.toThrow("--xcode-xip");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("setup space check", () => {
  const actions = ["install-swift", "download-xtool", "install-sdk", "login-hint"] as const;

  it("lists the space each pending action needs", () => {
    vi.stubEnv("HOME", "/home/me");
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    const bin = "/home/me/.cache/rn-xtool/xtool-1.24.0.AppImage";
    expect(setupSpaceNeeds([...actions], bin)).toEqual([
      { label: "Swift toolchain", dir: "/home/me/.local/share/swiftly", bytes: 5 * GB },
      { label: "xtool", dir: "/home/me/.cache/rn-xtool", bytes: 0.2 * GB },
      { label: "Darwin SDK", dir: "/home/me/.swiftpm/swift-sdks", bytes: 15 * GB },
      { label: "first build", dir: "/home/me/Library/Caches/ReactNative", bytes: 4 * GB },
    ]);
    expect(setupSpaceNeeds(["download-xtool", "login-hint"], bin)).toEqual([
      { label: "xtool", dir: "/home/me/.cache/rn-xtool", bytes: 0.2 * GB },
    ]);
    expect(setupSpaceNeeds(["login-hint"], bin)).toEqual([]);
  });

  it("puts the Darwin SDK where xtool does when XDG_CONFIG_HOME is set", () => {
    vi.stubEnv("HOME", "/home/me");
    vi.stubEnv("XDG_CONFIG_HOME", "/home/me/cfg");
    const sdk = { label: "Darwin SDK", dir: "/home/me/cfg/swiftpm/swift-sdks", bytes: 15 * GB };
    expect(setupSpaceNeeds(["install-sdk"], "/x/xtool")).toContainEqual(sdk);
    expect(sdkBundle()).toBe("/home/me/cfg/swiftpm/swift-sdks/darwin.artifactbundle");
    // xtool refuses a relative one with its own error; rn-xtool keeps the default.
    vi.stubEnv("XDG_CONFIG_HOME", "cfg");
    expect(sdkBundle()).toBe("/home/me/.swiftpm/swift-sdks/darwin.artifactbundle");
  });

  it("sums the needs per filesystem", async () => {
    const home = tmpHome();
    const needs = setupSpaceNeeds([...actions], join(home, ".cache", "rn-xtool", "xtool-1.24.0.AppImage"));
    const oneFs = { filesystemOf: async () => ({ dev: 1, freeBytes: 8.2 * GB }) };
    await expect(checkSetupSpace(needs, oneFs)).rejects.toThrow(
      "Not enough free disk space for setup: the filesystem of ~ has 8.2 GB free, and setup needs about 25 GB there (Swift toolchain 5 GB, xtool 0.2 GB, Darwin SDK 15 GB, first build 4 GB). Free some space, then run `rn-xtool setup` again.",
    );

    const elsewhere = tmp();
    const split = setupSpaceNeeds([...actions], join(elsewhere, "xtool.AppImage"));
    const twoFs = {
      filesystemOf: async (dir: string) =>
        dir === elsewhere ? { dev: 2, freeBytes: 0.1 * GB } : { dev: 1, freeBytes: 100 * GB },
    };
    await expect(checkSetupSpace(split, twoFs)).rejects.toThrow(
      `Not enough free disk space for setup: the filesystem of ${elsewhere} has 0.1 GB free, and setup needs about 1 GB there (xtool 0.2 GB). Free some space, then run \`rn-xtool setup\` again.`,
    );
    await expect(checkSetupSpace(needs, { filesystemOf: async () => ({ dev: 1, freeBytes: 30 * GB }) })).resolves.toBeUndefined();
    await expect(checkSetupSpace([], { filesystemOf: async () => { throw new Error("not called"); } })).resolves.toBeUndefined();
  });

  const nothing = { hasSwift: false, hasXtool: false, hasSdk: false, loggedIn: false };
  const spies = () => ({ installSwift: vi.fn(async () => {}), downloadXtool: vi.fn(async () => {}), installSdk: vi.fn(async () => {}) });

  it("setup stops before any download when space is short", async () => {
    const home = tmpHome();
    const xip = join(home, "Xcode.xip");
    writeFileSync(xip, "");
    const actionSpies = spies();
    const spaceProbes = { filesystemOf: vi.fn(async () => ({ dev: 1, freeBytes: 8 * GB })) };
    await expect(
      setup({ xcodeXip: xip }, { checkSwiftPackages: noPending, probe: async () => nothing, spaceProbes, actions: actionSpies, log: vi.fn() }),
    ).rejects.toThrow("Not enough free disk space for setup: the filesystem of ~ has 8.0 GB free");
    for (const spy of Object.values(actionSpies)) expect(spy).not.toHaveBeenCalled();
  });

  it("removes a leftover SDK staging folder before measuring", async () => {
    const home = tmpHome();
    const staging = join(home, ".swiftpm", "swift-sdks", "darwin.artifactbundle.tmp");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "x"), "");
    const xip = join(home, "Xcode.xip");
    writeFileSync(xip, "");
    const order: string[] = [];
    const log = vi.fn((l: string) => void order.push(l));
    const spaceProbes = {
      filesystemOf: vi.fn(async () => {
        order.push(existsSync(staging) ? "measured with the staging folder" : "measured");
        return { dev: 1, freeBytes: 100 * GB };
      }),
    };
    await setup(
      { xcodeXip: xip },
      { checkSwiftPackages: noPending, probe: async () => ({ ...all, hasSdk: false }), spaceProbes, actions: spies(), log },
    );
    expect(order.slice(0, 2)).toEqual([
      "ℹ Removing ~/.swiftpm/swift-sdks/darwin.artifactbundle.tmp, left by an interrupted Darwin SDK install.",
      "measured",
    ]);
    expect(existsSync(staging)).toBe(false);
  });

  it("removes a leftover SDK staging folder when the SDK is already installed", async () => {
    const removing = "ℹ Removing ~/.swiftpm/swift-sdks/darwin.artifactbundle.tmp, left by an interrupted Darwin SDK install.";
    for (const state of [all, { ...all, hasXtool: false }]) {
      const home = tmpHome();
      const staging = join(home, ".swiftpm", "swift-sdks", "darwin.artifactbundle.tmp");
      mkdirSync(staging, { recursive: true });
      const order: string[] = [];
      const log = vi.fn((l: string) => void order.push(l));
      const spaceProbes = {
        filesystemOf: vi.fn(async () => {
          order.push(existsSync(staging) ? "measured with the staging folder" : "measured");
          return { dev: 1, freeBytes: 100 * GB };
        }),
      };
      await setup({}, { checkSwiftPackages: noPending, probe: async () => state, spaceProbes, actions: spies(), log });
      expect(order).toEqual(
        state === all
          ? [removing, RUBY_LINE, "✔ Nothing to do: toolchain already set up"]
          : [removing, "measured", RUBY_LINE, "✔ xtool 1.24.0"],
      );
      expect(existsSync(staging)).toBe(false);
    }
  });

  it("removes the staging folder under XDG_CONFIG_HOME when that is set", async () => {
    const home = tmpHome();
    vi.stubEnv("XDG_CONFIG_HOME", join(home, "cfg"));
    const staging = join(home, "cfg", "swiftpm", "swift-sdks", "darwin.artifactbundle.tmp");
    mkdirSync(staging, { recursive: true });
    const xip = join(home, "Xcode.xip");
    writeFileSync(xip, "");
    const log = vi.fn();
    await setup({ xcodeXip: xip }, { checkSwiftPackages: noPending, probe: async () => ({ ...all, hasSdk: false }), actions: spies(), log });
    expect(log).toHaveBeenCalledWith(
      "ℹ Removing ~/cfg/swiftpm/swift-sdks/darwin.artifactbundle.tmp, left by an interrupted Darwin SDK install.",
    );
    expect(existsSync(staging)).toBe(false);
  });

  it("a run that only hints at login checks no space", async () => {
    tmpHome();
    const spaceProbes = { filesystemOf: vi.fn(async () => ({ dev: 1, freeBytes: 0 })) };
    const log = vi.fn();
    await setup({}, { checkSwiftPackages: noPending, probe: async () => ({ ...all, loggedIn: false }), spaceProbes, log });
    expect(spaceProbes.filesystemOf).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Run: rn-xtool auth login");
  });
});

describe("setup on a second run", () => {
  /**
   * Action fakes that create what they install, on a temporary HOME and cache with the real probes. With
   * `configHome`, XDG_CONFIG_HOME is set and the SDK goes where xtool puts it then.
   */
  const machine = (authOutput: string, configHome = false) => {
    const base = tmp();
    const home = join(base, "home");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CACHE_HOME", join(base, "cache"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome ? join(base, "config") : undefined);
    // An empty PATH: no host Swift (/usr/bin/swift, a swiftly toolchain) is found; the fakes need none.
    const emptyBin = join(base, "bin");
    mkdirSync(emptyBin);
    vi.stubEnv("PATH", emptyBin);
    const swiftpm = configHome ? join(base, "config", "swiftpm") : join(home, ".swiftpm");
    const script = (file: string, body: string) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
    };
    const actions = {
      installSwift: vi.fn(async () =>
        script(join(home, ".local", "share", "swiftly", "bin", "swift"), "echo 'Swift version 6.4.1 (swift-6.4.1-RELEASE)'"),
      ),
      downloadXtool: vi.fn(async (bin: string) =>
        script(bin, `if [ "$1 $2" = "auth status" ]; then printf '%s\\n' ${authOutput}; fi`),
      ),
      installSdk: vi.fn(async () => void mkdirSync(join(swiftpm, "swift-sdks", "darwin.artifactbundle"), { recursive: true })),
    };
    const xip = join(base, "Xcode.xip");
    writeFileSync(xip, "");
    const spaceProbes = { filesystemOf: vi.fn(async () => ({ dev: 1, freeBytes: 100 * GB })) };
    const run = async () => {
      const log = vi.fn();
      await setup({ xcodeXip: xip }, { spaceProbes, actions, log });
      return log.mock.calls.map((c) => c[0] as string);
    };
    return { actions, spaceProbes, run };
  };
  const calls = (m: ReturnType<typeof machine>) =>
    [...Object.values(m.actions), m.spaceProbes.filesystemOf].map((f) => f.mock.calls.length);

  it("a second run downloads nothing", async () => {
    const m = machine("'Logged in.' '- Apple ID: me@example.com' '- Team ID: TEAMID0000'");
    await m.run();
    expect(calls(m)).toEqual([1, 1, 1, 4]);
    expect(await m.run()).toEqual([RUBY_LINE, "✔ Nothing to do: toolchain already set up"]);
    expect(calls(m)).toEqual([1, 1, 1, 4]);

    const out = machine("'Logged out.'");
    expect(await out.run()).toContain("Run: rn-xtool auth login");
    expect(calls(out)).toEqual([1, 1, 1, 4]);
    expect(await out.run()).toEqual([RUBY_LINE, "Run: rn-xtool auth login"]);
    expect(calls(out)).toEqual([1, 1, 1, 4]);
  });

  it("a second run downloads nothing with XDG_CONFIG_HOME set", async () => {
    const m = machine("'Logged in.'", true);
    await m.run();
    expect(await m.run()).toEqual([RUBY_LINE, "✔ Nothing to do: toolchain already set up"]);
    expect(calls(m)).toEqual([1, 1, 1, 4]);
  });
});

describe("setup config handling", () => {
  it("probes and hints with the configured xtoolPath and skips the download", async () => {
    const probe = vi.fn(async () => ({ ...all, loggedIn: false }));
    const log = vi.fn();
    await setup({ xtoolPath: "/opt/xtool" }, { checkSwiftPackages: noPending, probe, log });
    expect(probe).toHaveBeenCalledWith("/opt/xtool");
    expect(log).toHaveBeenCalledWith("Run: rn-xtool auth login");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("xtool 1.24.0"));
  });
  it("fails when the configured xtoolPath is not executable", async () => {
    const probe = async () => ({ ...all, hasXtool: false });
    await expect(setup({ xtoolPath: "/opt/xtool" }, { checkSwiftPackages: noPending, probe, log: vi.fn() })).rejects.toThrow("/opt/xtool");
  });
  it("uses the xip passed in opts for the preflight", async () => {
    const preflightProbes = { exists: () => false };
    await expect(
      setup({ xcodeXip: "/cfg.xip" }, { checkSwiftPackages: noPending, probe: async () => ({ ...all, hasSdk: false }), preflightProbes, log: vi.fn() }),
    ).rejects.toThrow("Xcode xip not found: /cfg.xip");
  });
});

describe("login probe", () => {
  it("propagates an unrunnable xtool instead of reporting logged out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtool-setup-"));
    const bin = join(dir, "xtool");
    writeFileSync(bin, "#!/bin/sh\necho 'fuse: failed to open' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    try {
      await expect(loggedIn(bin)).rejects.toThrow("libfuse2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swiftPostInstallMessage", () => {
  it("returns nothing when swiftly wrote no post-install script", () => {
    expect(swiftPostInstallMessage(undefined)).toBeUndefined();
    expect(swiftPostInstallMessage("")).toBeUndefined();
    expect(swiftPostInstallMessage("#!/bin/sh\n\n# nothing\n")).toBeUndefined();
  });
  it("tells the user to run the script as root and re-run setup", () => {
    const script = "#!/bin/sh\napt-get -y install binutils libcurl4-openssl-dev\n";
    const msg = swiftPostInstallMessage(script)!;
    expect(msg).toContain("system packages");
    expect(msg).toContain("  sudo apt-get update && sudo apt-get -y install binutils libcurl4-openssl-dev");
    expect(msg).toContain("rn-xtool setup");
  });
});

describe("swiftPostInstallMessage for other package managers", () => {
  it("does not prefix non-apt lines with apt-get update", () => {
    const msg = swiftPostInstallMessage("#!/bin/sh\nyum install foo\n")!;
    expect(msg).toContain("  sudo yum install foo");
    expect(msg).not.toContain("apt-get update");
  });
});

describe("pending Swift system packages", () => {
  const script = "#!/bin/sh\napt-get -y install binutils libcurl4-openssl-dev\n";
  it("lists the packages named by the apt line", () => {
    expect(packagesFromPostInstall(script)).toEqual(["binutils", "libcurl4-openssl-dev"]);
    expect(packagesFromPostInstall("yum install foo")).toEqual(["foo"]);
    expect(packagesFromPostInstall("")).toEqual([]);
  });
  it("reports only the packages still missing", async () => {
    const isInstalled = async (pkg: string) => pkg === "binutils";
    await expect(pendingSwiftPackages(script, isInstalled)).resolves.toEqual(["libcurl4-openssl-dev"]);
  });
  it("setup repeats the instruction while packages are missing, even when the toolchain probe is complete", async () => {
    const log = vi.fn();
    await expect(
      setup({}, { probe: async () => all, log, checkSwiftPackages: async () => "Swift needs packages: run X" }),
    ).rejects.toThrow("Swift needs packages");
  });
  it("setup proceeds when nothing is pending", async () => {
    const log = vi.fn();
    await setup({}, { probe: async () => all, log, checkSwiftPackages: async () => undefined });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Nothing to do"));
  });
});
