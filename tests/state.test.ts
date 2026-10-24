import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState, rememberDevice, writeState } from "../src/state.js";

const state = {
  version: 1 as const,
  metroPort: 8082,
  lanIp: "192.168.1.5",
  bundleIdentifier: "com.example.app",
  builtAt: "2026-10-23T00:00:00.000Z",
};

describe("state", () => {
  it("round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    await writeState(dir, state);
    expect(await readState(dir)).toEqual(state);
  });
  it("round-trips the deps fingerprint; states without it still load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    await writeState(dir, { ...state, depsFingerprint: "abc" });
    expect((await readState(dir))?.depsFingerprint).toBe("abc");
    const old = mkdtempSync(join(tmpdir(), "state-"));
    await writeState(old, state);
    expect((await readState(old))?.depsFingerprint).toBeUndefined();
  });
  it("returns undefined when missing", async () => {
    expect(await readState(mkdtempSync(join(tmpdir(), "state-")))).toBeUndefined();
  });
  it("throws on malformed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    writeFileSync(join(dir, ".expo-xtool-state.json"), "{nope");
    await expect(readState(dir)).rejects.toThrow(".expo-xtool-state.json");
  });
  it("throws on wrong version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    writeFileSync(join(dir, ".expo-xtool-state.json"), JSON.stringify({ ...state, version: 2 }));
    await expect(readState(dir)).rejects.toThrow("version");
  });
  it("remembers the Wi‑Fi device without touching the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    await writeState(dir, state);
    await rememberDevice(dir, { deviceIp: "192.168.1.10", deviceUdid: "U" });
    expect(await readState(dir)).toEqual({ ...state, deviceIp: "192.168.1.10", deviceUdid: "U" });
  });
  it("does nothing to remember without a build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    await rememberDevice(dir, { deviceIp: "192.168.1.10", deviceUdid: "U" });
    expect(await readState(dir)).toBeUndefined();
  });
});
