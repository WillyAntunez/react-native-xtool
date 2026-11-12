import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authStatus,
  devBuild,
  devBuildIpa,
  devEnv,
  devRun,
  type DevRunner,
  installedBundleId,
  listDevices,
  parseAuthStatus,
  parseDevices,
  parseIpaPath,
  xtoolBin,
  xtoolUnrunnableError,
} from "../src/tools/xtool.js";
import { explainingXtool } from "../src/tools/xtoolErrors.js";
import { capturingStdio } from "./support/stdio.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "xtool-test-"));
  dirs.push(d);
  return d;
};

describe("parseAuthStatus", () => {
  it("parses logged out", () => {
    expect(parseAuthStatus("Logged out")).toEqual({ loggedIn: false });
  });
  it("parses logged in", () => {
    const out =
      "Logged in.\n- Apple ID: dev@example.com\n- Team ID: ABCDE12345\n- Token expiry: 23/10/2027, 9:48 AM\n";
    expect(parseAuthStatus(out)).toEqual({
      loggedIn: true,
      appleId: "dev@example.com",
      teamId: "ABCDE12345",
    });
  });
});

describe("parseDevices", () => {
  it("parses a device line", () => {
    expect(parseDevices("Test iPhone [usb]: 00008030-000000000000000E\n")).toEqual([
      { name: "Test iPhone", transport: "usb", udid: "00008030-000000000000000E" },
    ]);
  });
  it("ignores empty output", () => {
    expect(parseDevices("")).toEqual([]);
  });
});

describe("installedBundleId", () => {
  it("prefixes team id", () => {
    expect(installedBundleId("ABCDE12345", "com.a.b")).toBe("XTL-ABCDE12345.com.a.b");
  });
});

describe("listDevices", () => {
  it("resolves [] when the binary hangs past the timeout", async () => {
    const fake = join(tmp(), "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(fake, 0o755);
    const t0 = Date.now();
    await expect(listDevices(fake, 200)).resolves.toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("resolves [] when a grandchild keeps stdout open after the timeout (AppImage runtime)", async () => {
    const fake = join(tmp(), "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\nsleep 60 &\nwait\n");
    chmodSync(fake, 0o755);
    const t0 = Date.now();
    await expect(listDevices(fake, 200)).resolves.toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("polls until a device appears when asked to wait", async () => {
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    // Empty on the first two calls, one device on the third.
    writeFileSync(
      fake,
      `#!/bin/sh\nn=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"\n[ $n -ge 3 ] && echo "Phone [usb]: 00001111-AAAA"\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    const devices = await listDevices(fake, 5000, { waitForDevice: true, pollMs: 20 });
    expect(devices).toEqual([{ name: "Phone", transport: "usb", udid: "00001111-AAAA" }]);
    expect(readFileSync(join(dir, "n"), "utf8").trim()).toBe("3");
  });
  it("keeps waiting for the requested transport while another device answers", async () => {
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    writeFileSync(
      fake,
      `#!/bin/sh\nn=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"\necho "Phone [network]: 00001111-AAAA"\n[ $n -ge 2 ] && echo "Phone [usb]: 00001111-AAAA"\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    const devices = await listDevices(fake, 5000, { waitForDevice: "usb", pollMs: 20 });
    expect(devices.map((d) => d.transport)).toEqual(["network", "usb"]);
  });
  it("gives up waiting at the deadline", async () => {
    const fake = join(tmp(), "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    const t0 = Date.now();
    await expect(listDevices(fake, 300, { waitForDevice: true, pollMs: 50 })).resolves.toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("asks xtool not to wait for a device", async () => {
    const fake = join(tmp(), "fake-xtool");
    writeFileSync(fake, '#!/bin/sh\necho "$@" > "$(dirname "$0")/args"\n');
    chmodSync(fake, 0o755);
    await listDevices(fake, 2000);
    expect(readFileSync(join(dirname(fake), "args"), "utf8").trim()).toBe("devices --no-wait");
  });
});

describe("xtoolBin", () => {
  it("returns an explicit executable xtoolPath", () => {
    const f = join(tmp(), "x");
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
    expect(xtoolBin({ xtoolPath: f })).toBe(f);
  });
  it("throws pointing to setup when missing", () => {
    expect(() => xtoolBin({ xtoolPath: "/nonexistent/xtool" })).toThrow(
      "xtool not found at /nonexistent/xtool. Run `rn-xtool setup` first.",
    );
  });
});

describe("authStatus", () => {
  const script = (body: string): string => {
    const f = join(tmp(), "fake-xtool");
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  it("treats 'Logged out' on stderr with a non-zero exit as logged out", async () => {
    await expect(authStatus(script("echo 'Logged out' >&2\nexit 1"))).resolves.toEqual({ loggedIn: false });
  });
  it("reports an unrunnable binary with the libfuse2 hint instead of logged out", async () => {
    const bin = script("echo 'fuse: failed to open /dev/fuse' >&2\nexit 1");
    await expect(authStatus(bin)).rejects.toThrow(/xtool could not run \(exit 1\): fuse: failed to open.*libfuse2/s);
  });
  it("names the FUSE package of each Ubuntu release", () => {
    expect(xtoolUnrunnableError(1, "fuse: failed to open /dev/fuse\n").message).toBe(
      "xtool could not run (exit 1): fuse: failed to open /dev/fuse. On Ubuntu this usually means FUSE 2 is missing: " +
        "sudo apt install libfuse2t64 on Ubuntu 24.04 and newer, sudo apt install libfuse2 on older releases",
    );
  });
  it("throws when the binary cannot be spawned", async () => {
    await expect(authStatus("/nonexistent/xtool")).rejects.toBeDefined();
  });
});

describe("devEnv", () => {
  it("exposes the generated Swift headers dir to the manifests xtool evaluates", () => {
    const env = devEnv("/app/ios-xtool");
    expect(env["RN_SPM_SWIFT_HEADERS_DIR"]).toBe(
      "/app/ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos",
    );
    expect(env.PATH).toContain(".local/share/swiftly/bin");
    expect(env.SDKROOT).toBeUndefined();
  });
});

describe("devBuild / devRun", () => {
  const SWIFT_HEADERS = "/app/ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos";
  const record = () => {
    const calls: { args: string[]; opts: Parameters<DevRunner>[2] }[] = [];
    const runner: DevRunner = async (_cmd, args, opts) => {
      calls.push({ args, opts });
    };
    return { calls, runner };
  };

  it("devBuild passes RN_SPM_SWIFT_HEADERS_DIR to xtool dev build", async () => {
    const { calls, runner } = record();
    await devBuild("/bin/xtool", "/app/ios-xtool", runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["dev", "build"]);
    expect(calls[0]!.opts?.cwd).toBe("/app/ios-xtool");
    expect(calls[0]!.opts?.env?.["RN_SPM_SWIFT_HEADERS_DIR"]).toBe(SWIFT_HEADERS);
  });

  it("devRun shows and keeps xtool's output by default, for the failure explanations", async () => {
    // `xtool dev run` prints an install error on stdout (`print("\nError: …")`), then exits 1.
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\nprintf '\\nError: limit\\n'\necho warn >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    const { result, stdout, stderr } = await capturingStdio(() => devRun(fake, dir));
    const e = (result as PromiseRejectedResult).reason as { stderr?: unknown; stdout?: unknown; message?: string };
    expect(e.stdout).toBe("\nError: limit");
    expect(e.stderr).toBe("warn");
    expect(stdout).toBe("\nError: limit\n");
    expect(stderr).toBe("warn\n");
    expect(e.message).toBe(`Command failed with exit code 1: nice -n 15 ${fake} dev run --configuration debug --usb`);
  });

  it("devBuild shows and keeps xtool's output by default, and explains a module cache a killed build left", async () => {
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    const pcm = join(dir, ".build", "out", "ModuleCache.noindex", "X", "React-1.pcm");
    writeFileSync(
      fake,
      `#!/bin/sh\necho 'Building for debugging...'\necho "fatal error: file '${pcm}' is not a valid module file: file too small" >&2\nexit 1\n`,
    );
    chmodSync(fake, 0o755);
    const { result, stdout, stderr } = await capturingStdio(() => devBuild(fake, dir));
    const e = (result as PromiseRejectedResult).reason as Error & { cause?: { exitCode?: number; stderr?: unknown } };
    expect(stdout).toBe("Building for debugging...\n");
    expect(stderr).toBe(`fatal error: file '${pcm}' is not a valid module file: file too small\n`);
    const command = `Command failed with exit code 1: nice -n 15 ${fake} dev build --configuration debug`;
    expect(e.message.startsWith(`${command}\nxtool dev build stopped on a precompiled module file in the app build's module cache`)).toBe(true);
    expect(e.message).toContain("Run `rm -rf ios-xtool/.build` in the project folder, then `rn-xtool build`");
    expect(e.cause?.exitCode).toBe(1);
    expect(e.cause?.stderr).toBe(`fatal error: file '${pcm}' is not a valid module file: file too small`);
  });

  it("devBuild passes any other failure through unchanged", async () => {
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\necho 'error: cannot find type' >&2\nexit 2\n");
    chmodSync(fake, 0o755);
    const { result } = await capturingStdio(() => devBuild(fake, dir));
    const e = (result as PromiseRejectedResult).reason as Error & { exitCode?: number; stderr?: unknown };
    expect(e.message).toBe(`Command failed with exit code 2: nice -n 15 ${fake} dev build --configuration debug`);
    expect(e.exitCode).toBe(2);
    expect(e.stderr).toBe("error: cannot find type");
    expect(e.cause).toBeUndefined();
    const failure = Object.assign(new Error("Command failed with exit code 1: xtool"), { stdout: "", stderr: "error: x" });
    await expect(
      devBuild("/bin/xtool", "/app/ios-xtool", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("devRun explains a module cache a killed build left, through install's explanations, keeping the failure", async () => {
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    const pcm = join(dir, ".build", "out", "ModuleCache.noindex", "X", "React-1.pcm");
    writeFileSync(fake, `#!/bin/sh\necho "fatal error: file '${pcm}' is not a valid module file: file too small" >&2\nexit 1\n`);
    chmodSync(fake, 0o755);
    const { result } = await capturingStdio(() => explainingXtool(() => devRun(fake, dir)));
    const e = (result as PromiseRejectedResult).reason as Error & { cause?: { exitCode?: number; stderr?: unknown } };
    const command = `Command failed with exit code 1: nice -n 15 ${fake} dev run --configuration debug --usb`;
    expect(e.message.startsWith(`${command}\nxtool dev build stopped on a precompiled module file in the app build's module cache`)).toBe(true);
    expect(e.message).toContain("Run `rm -rf ios-xtool/.build` in the project folder, then `rn-xtool build`");
    expect(e.cause?.exitCode).toBe(1);
    expect(e.cause?.stderr).toBe(`fatal error: file '${pcm}' is not a valid module file: file too small`);
  });

  it("devRun leaves any other failure to install's explanations as before", async () => {
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\nprintf '\\nError: The maximum App ID limit has been reached.\\n'\nexit 1\n");
    chmodSync(fake, 0o755);
    const { result } = await capturingStdio(() => explainingXtool(() => devRun(fake, dir)));
    const e = (result as PromiseRejectedResult).reason as Error & { cause?: { exitCode?: number; stdout?: unknown } };
    expect(e.message).toMatch(/^Apple refused to register another App ID/);
    expect(e.cause?.exitCode).toBe(1);
    expect(e.cause?.stdout).toBe("\nError: The maximum App ID limit has been reached.");
    const failure = Object.assign(new Error("Command failed with exit code 1: xtool"), { stdout: "", stderr: "error: x" });
    await expect(
      devRun("/bin/xtool", "/app/ios-xtool", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("devRun passes RN_SPM_SWIFT_HEADERS_DIR to xtool dev run", async () => {
    const { calls, runner } = record();
    await devRun("/bin/xtool", "/app/ios-xtool", runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["dev", "run"]);
    expect(calls[0]!.opts?.env?.["RN_SPM_SWIFT_HEADERS_DIR"]).toBe(SWIFT_HEADERS);
  });
});

describe("parseIpaPath", () => {
  it("takes the path from xtool's last `Wrote to` line, relative to the project dir", () => {
    expect(parseIpaPath("Building…\nWrote to xtool/App.ipa\n", "/app/ios-xtool")).toBe("/app/ios-xtool/xtool/App.ipa");
    expect(parseIpaPath("Wrote to /abs/App.ipa  \n", "/x")).toBe("/abs/App.ipa");
  });
  it("is undefined without that line", () => {
    expect(parseIpaPath("Build complete", "/x")).toBeUndefined();
  });
});

describe("devBuildIpa", () => {
  it("builds, signs and packages an ipa with the Swift headers env and returns its path", async () => {
    const calls: { args: string[]; opts: Parameters<DevRunner>[2] }[] = [];
    const path = await devBuildIpa("/bin/xtool", "/app/ios-xtool", async (_cmd, args, opts) => {
      calls.push({ args, opts });
      return "Wrote to xtool/App.ipa";
    });
    expect(path).toBe("/app/ios-xtool/xtool/App.ipa");
    expect(calls[0]!.args).toEqual(["dev", "build", "--configuration", "debug", "--sign", "--ipa"]);
    expect(calls[0]!.opts?.cwd).toBe("/app/ios-xtool");
    expect(calls[0]!.opts?.env?.["RN_SPM_SWIFT_HEADERS_DIR"]).toContain("GeneratedModuleMaps-iphoneos");
  });
  it("explains a module cache a killed build left, keeping the failure, and passes any other through", async () => {
    const dir = tmp();
    const fake = join(dir, "fake-xtool");
    const pcm = join(dir, ".build", "out", "ModuleCache.noindex", "X", "React-1.pcm");
    writeFileSync(fake, `#!/bin/sh\necho "fatal error: file '${pcm}' is not a valid module file: file too small" >&2\nexit 1\n`);
    chmodSync(fake, 0o755);
    const { result } = await capturingStdio(() => explainingXtool(() => devBuildIpa(fake, dir)));
    const e = (result as PromiseRejectedResult).reason as Error & { cause?: { exitCode?: number; stderr?: unknown } };
    const command = `Command failed with exit code 1: nice -n 15 ${fake} dev build --configuration debug --sign --ipa`;
    expect(e.message.startsWith(`${command}\nxtool dev build stopped on a precompiled module file in the app build's module cache`)).toBe(true);
    expect(e.message).toContain("Run `rm -rf ios-xtool/.build` in the project folder, then `rn-xtool build`");
    expect(e.cause?.exitCode).toBe(1);
    expect(e.cause?.stderr).toBe(`fatal error: file '${pcm}' is not a valid module file: file too small`);
    const failure = Object.assign(new Error("Command failed with exit code 1: xtool"), { stdout: "", stderr: "error: x" });
    await expect(
      devBuildIpa("/bin/xtool", "/app/ios-xtool", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
  it("fails clearly when xtool does not say where the ipa is", async () => {
    await expect(devBuildIpa("/bin/xtool", "/app", async () => "done")).rejects.toThrow("did not report the .ipa path");
  });
});
