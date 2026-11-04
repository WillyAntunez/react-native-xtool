import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { announceDevServer, bonjourOffSwitch, expoAnnouncesBonjour, lanAnnouncementFailure, loadAdvertiser } from "../src/devServerAnnounce.js";
import { needsTarball, packageFromTarball } from "./support/tarballs.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A temp project whose `dnssd-advertise` is `body` (none when undefined). */
const project = (body?: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "announce-"));
  tmps.push(root);
  if (body !== undefined) {
    const at = path.join(root, "node_modules", "dnssd-advertise");
    mkdirSync(at, { recursive: true });
    writeFileSync(path.join(at, "package.json"), JSON.stringify({ name: "dnssd-advertise", version: "1.1.6", main: "index.js" }));
    writeFileSync(path.join(at, "index.js"), body);
  }
  return root;
};

const input = (root: string) => ({
  root,
  name: "app",
  slug: "app",
  port: 8083,
  iosBundleIdentifier: "XTL-TEAMID0000.com.example.app",
});

describe("announceDevServer", () => {
  it("announces like Expo CLI, with the installed id", async () => {
    const root = project(
      "exports.calls = []; exports.stop = async () => {}; exports.advertise = (o) => { exports.calls.push(o); return exports.stop; };",
    );
    const stop = await announceDevServer(input(root));
    // The stub module itself, as the project loads it: it kept the options it was given.
    const lib = createRequire(path.join(root, "package.json"))("dnssd-advertise") as { calls: object[]; stop: unknown };
    expect(lib.calls).toEqual([
      {
        name: "app",
        type: "expo",
        protocol: "tcp",
        hostname: "app",
        port: 8083,
        stack: "IPv4",
        txt: { name: "app", slug: "app", iosBundleIdentifier: "XTL-TEAMID0000.com.example.app" },
      },
    ]);
    expect(stop).toBe(lib.stop);
  });

  it("passes onError only when given", async () => {
    const root = project("exports.calls = []; exports.advertise = (o) => { exports.calls.push(o); return async () => {}; };");
    await announceDevServer(input(root));
    const onError = (_e: unknown) => {};
    await announceDevServer({ ...input(root), onError });
    const lib = createRequire(path.join(root, "package.json"))("dnssd-advertise") as { calls: object[] };
    expect(lib.calls[0]).not.toHaveProperty("onError");
    expect(lib.calls[1]).toHaveProperty("onError", onError);
  });

  it("fails when the library is missing, throws or rejects", async () => {
    await expect(announceDevServer(input(project()))).rejects.toThrow();
    await expect(announceDevServer(input(project("")))).rejects.toThrow();
    await expect(
      announceDevServer(input(project("exports.advertise = () => { throw new Error('EADDRINUSE'); };"))),
    ).rejects.toThrow("EADDRINUSE");
    expect(loadAdvertiser(project(""))).toBeUndefined();
  });

  it("announces nothing with another API than the 1.x one Expo uses", async () => {
    // Another major or a future release: no advertise(), or one that does not return the stop function at once.
    await expect(announceDevServer(input(project("exports.default = { advertise: () => () => {} };")))).rejects.toThrow(
      "dnssd-advertise has no advertise() function",
    );
    const stub = (returned: string) =>
      project(`exports.stopped = 0; exports.advertise = () => ${returned};`);
    const lib = (root: string) => createRequire(path.join(root, "package.json"))("dnssd-advertise") as { stopped: number };
    const NOT_1X = "dnssd-advertise's advertise() did not return a stop function";
    const object = stub("({ stop: async () => {} })");
    await expect(announceDevServer(input(object))).rejects.toThrow(NOT_1X);
    // A promise of the stop: whatever it started is stopped, and a rejection is not left unhandled.
    const later = stub("Promise.resolve(async () => { exports.stopped++; })");
    await expect(announceDevServer(input(later))).rejects.toThrow(NOT_1X);
    await new Promise((r) => setTimeout(r, 0));
    expect(lib(later).stopped).toBe(1);
    const rejected = stub("Promise.reject(new Error('EACCES'))");
    await expect(announceDevServer(input(rejected))).rejects.toThrow(NOT_1X);
  });

  const dnssd = needsTarball("dnssd-advertise@1.1.6");
  it.skipIf(dnssd !== "")(`the real dnssd-advertise exports advertise${dnssd}`, () => {
    expect(typeof loadAdvertiser(path.resolve(packageFromTarball("dnssd-advertise@1.1.6")!, "..", ".."))).toBe("function");
  });
});

describe("expoAnnouncesBonjour", () => {
  it("reads the switches as Expo CLI does", () => {
    const on: NodeJS.ProcessEnv[] = [
      {},
      { CI: "false" },
      { CI: "0" },
      { EXPO_UNSTABLE_BONJOUR: "1" },
      { EXPO_UNSTABLE_BONJOUR: "TRUE" },
      { EXPO_UNSTABLE_HEADLESS: "1", EXPO_UNSTABLE_BONJOUR: "true" },
      { SHELL: "/bin/jsh" },
    ];
    const off: NodeJS.ProcessEnv[] = [
      { CI: "true" },
      { CI: "1" },
      { CI: "True", EXPO_UNSTABLE_BONJOUR: "1" },
      { EXPO_UNSTABLE_BONJOUR: "0" },
      { EXPO_UNSTABLE_BONJOUR: "false" },
      { EXPO_UNSTABLE_BONJOUR: "FALSE" },
      { EXPO_UNSTABLE_HEADLESS: "1" },
      { EXPO_FORCE_WEBCONTAINER_ENV: "true" },
      // Values Expo CLI's getenv cannot read make it throw.
      { CI: "yes" },
      { CI: "" },
      { EXPO_UNSTABLE_BONJOUR: "off" },
      { EXPO_UNSTABLE_HEADLESS: "no", EXPO_UNSTABLE_BONJOUR: "1" },
    ];
    const plain = {} as NodeJS.ProcessVersions;
    for (const env of on) expect(expoAnnouncesBonjour(env, plain), JSON.stringify(env)).toBe(true);
    for (const env of off) expect(expoAnnouncesBonjour(env, plain), JSON.stringify(env)).toBe(false);
    const webcontainer = { webcontainer: "1" } as unknown as NodeJS.ProcessVersions;
    expect(expoAnnouncesBonjour({ SHELL: "/bin/jsh" }, webcontainer)).toBe(false);
  });

  it("names the variable that turned the announcement off", () => {
    const plain = {} as NodeJS.ProcessVersions;
    const cases: [NodeJS.ProcessEnv, string | undefined][] = [
      [{}, undefined],
      [{ EXPO_UNSTABLE_HEADLESS: "1", EXPO_UNSTABLE_BONJOUR: "true" }, undefined],
      [{ CI: "1" }, "CI=1"],
      [{ CI: "True", EXPO_UNSTABLE_BONJOUR: "0" }, "CI=True"],
      [{ EXPO_UNSTABLE_BONJOUR: "false" }, "EXPO_UNSTABLE_BONJOUR=false"],
      [{ EXPO_UNSTABLE_BONJOUR: "0", EXPO_UNSTABLE_HEADLESS: "1" }, "EXPO_UNSTABLE_BONJOUR=0"],
      [{ EXPO_UNSTABLE_HEADLESS: "1" }, "EXPO_UNSTABLE_HEADLESS=1"],
      [{ EXPO_FORCE_WEBCONTAINER_ENV: "true" }, "EXPO_FORCE_WEBCONTAINER_ENV=true"],
      // A value Expo CLI cannot read is named too.
      [{ CI: "yes" }, "CI=yes"],
      [{ EXPO_UNSTABLE_BONJOUR: "off" }, "EXPO_UNSTABLE_BONJOUR=off"],
      [{ EXPO_UNSTABLE_HEADLESS: "no", EXPO_UNSTABLE_BONJOUR: "1" }, "EXPO_UNSTABLE_HEADLESS=no"],
      [{ EXPO_FORCE_WEBCONTAINER_ENV: "", EXPO_UNSTABLE_BONJOUR: "1" }, "EXPO_FORCE_WEBCONTAINER_ENV="],
    ];
    for (const [env, named] of cases) expect(bonjourOffSwitch(env, plain), JSON.stringify(env)).toBe(named);
    const webcontainer = { webcontainer: "1" } as unknown as NodeJS.ProcessVersions;
    expect(bonjourOffSwitch({ SHELL: "/bin/jsh" }, webcontainer)).toBe("SHELL=/bin/jsh");
  });
});

describe("lanAnnouncementFailure", () => {
  const nic = (address: string, o: { family?: "IPv4" | "IPv6"; internal?: boolean } = {}) => ({
    address,
    netmask: "255.255.255.0",
    family: o.family ?? "IPv4",
    mac: "00:00:00:00:00:00",
    internal: o.internal ?? false,
    cidr: null,
  });
  // The LAN on enp4s0, a Docker bridge and a veth, loopback, and an IPv6-only tunnel.
  const interfaces = {
    lo: [nic("127.0.0.1", { internal: true })],
    enp4s0: [nic("192.168.1.5"), nic("fe80::1", { family: "IPv6" as const })],
    docker0: [nic("172.17.0.1")],
    veth23: [nic("169.254.10.1")],
    tun0: [nic("fd00::2", { family: "IPv6" as const })],
  };
  const setup = (name: string) => new Error(`mDNS interface "${name}" failed initial setup after 2 attempts`);

  it("ignores errors on interfaces other than the LAN's", () => {
    const failed = lanAnnouncementFailure("192.168.1.5", interfaces);
    expect(failed(setup("veth23"))).toBe(false);
    expect(failed(new Error('mDNS unavailable on interface "docker0" after 5 setup attempts'))).toBe(false);
    expect(failed(setup("tun0"))).toBe(false);
    expect(failed(setup("lo"))).toBe(false);
  });

  it("fails when the LAN interface reports an error, by name or by address", () => {
    expect(lanAnnouncementFailure("192.168.1.5", interfaces)(setup("enp4s0"))).toBe(true);
    const byAddress = Object.assign(new Error("bind EADDRNOTAVAIL 192.168.1.5"), { address: "192.168.1.5" });
    expect(lanAnnouncementFailure("192.168.1.5", interfaces)(byAddress)).toBe(true);
    const other = Object.assign(new Error("bind EADDRNOTAVAIL 172.17.0.1"), { address: "172.17.0.1" });
    expect(lanAnnouncementFailure("192.168.1.5", interfaces)(other)).toBe(false);
  });

  it("ignores errors that name no interface", () => {
    const failed = lanAnnouncementFailure("192.168.1.5", interfaces);
    // Node's send errors carry the multicast destination as their address, not an interface.
    const send = Object.assign(new Error("send EHOSTUNREACH 224.0.0.251:5353"), { address: "224.0.0.251" });
    for (let n = 0; n < 5; n++) {
      expect(failed(send)).toBe(false);
      expect(failed("socket closed")).toBe(false);
      expect(failed(setup("docker0"))).toBe(false);
    }
    expect(failed(setup("enp4s0"))).toBe(true);
    expect(lanAnnouncementFailure("192.168.1.99", interfaces)(setup("enp4s0"))).toBe(false);
  });
});
