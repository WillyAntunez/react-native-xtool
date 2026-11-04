import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as plist from "plist";
import { afterEach, describe, expect, it } from "vitest";
import {
  devClientDeepLink,
  devClientLinkLines,
  devClientScheme,
  loadQrEncoder,
  renderQr,
  type QrEncoder,
} from "../src/devClientLink.js";
import { requireFromProject } from "../src/project/requireFromProject.js";
import { needsTarball, packageFromTarball } from "./support/tarballs.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "devclientlink-"));
  tmps.push(d);
  return d;
};
/** A package at `<dir>/node_modules/<name>` whose index.js is `body`. */
const stub = (dir: string, name: string, body: string) => {
  const at = path.join(dir, "node_modules", name);
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  writeFileSync(path.join(at, "index.js"), body);
  return at;
};

const withSchemes = (...schemes: string[][]) =>
  plist.build({ CFBundleURLTypes: schemes.map((s) => ({ CFBundleURLSchemes: s })) });

const URL_ = "http://192.168.1.20:8082";
const LINK = "exp+app://expo-development-client/?url=http%3A%2F%2F192.168.1.20%3A8082";
const LINE_1 = `Metro URL for the dev launcher: ${URL_}`;
const OPEN_LINE = `Open this link on the iPhone to open the app on that Metro server: ${LINK}`;
const NO_SCHEME_LINE = `ℹ ios-xtool/Info.plist has no URL scheme, so there is no link to open the dev client: enter ${URL_} in the dev launcher.`;
const state = { lanIp: "192.168.1.20", metroPort: 8082 };
const fake21: QrEncoder = () => new Uint8Array(21 * 21);
const io = (over: object = {}) => ({
  readInfoPlist: async () => withSchemes(["exp+app"]),
  qrEncoder: () => fake21,
  isTTY: true,
  columns: 80,
  ...over,
});

describe("devClientScheme", () => {
  it("picks the dev-client scheme like Expo CLI", () => {
    expect(devClientScheme(withSchemes(["myapp", "exp+my-app"]))).toBe("exp+my-app");
    expect(devClientScheme(withSchemes(["a"], ["longer"]))).toBe("longer");
    expect(devClientScheme(plist.build({ CFBundleName: "App" }))).toBeUndefined();
    expect(devClientScheme("<plist><dict><key>")).toBeUndefined();
  });
});

describe("devClientDeepLink", () => {
  it("builds the legacy deep link", () => {
    expect(devClientDeepLink("exp+app", URL_)).toBe(LINK);
  });
});

describe("renderQr", () => {
  it("renders half blocks with a border", () => {
    expect(renderQr(new Uint8Array([1, 0, 0, 1]))).toEqual(["██████", "██▄▀██", "██████"]);
  });
});

describe("requireFromProject", () => {
  it("loads packages from the project", () => {
    const root = tmp();
    stub(root, "toqr", "exports.where = 'root';");
    expect(requireFromProject(root, "toqr")).toEqual({ where: "root" });

    const nested = tmp();
    const expo = stub(nested, "expo", "");
    const cli = stub(expo, "@expo/cli", "");
    stub(cli, "toqr", "exports.where = 'cli';");
    expect(requireFromProject(nested, "toqr")).toEqual({ where: "cli" });

    // npm nests the copy @expo/cli uses when another version sits at the root: Expo's own copy wins.
    const both = tmp();
    const bothCli = stub(stub(both, "expo", ""), "@expo/cli", "");
    stub(both, "dnssd-advertise", "exports.version = '2.0.0';");
    stub(bothCli, "dnssd-advertise", "exports.version = '1.1.6';");
    expect(requireFromProject(both, "dnssd-advertise")).toEqual({ version: "1.1.6" });
    // Hoisted (the usual npm layout): @expo/cli finds the root copy.
    const hoisted = tmp();
    stub(stub(hoisted, "expo", ""), "@expo/cli", "");
    stub(hoisted, "dnssd-advertise", "exports.version = '1.1.6';");
    expect(requireFromProject(hoisted, "dnssd-advertise")).toEqual({ version: "1.1.6" });

    expect(requireFromProject(tmp(), "toqr")).toBeUndefined();

    const broken = tmp();
    stub(broken, "toqr", "throw new Error('broken');");
    expect(requireFromProject(broken, "toqr")).toBeUndefined();

    const empty = tmp();
    stub(empty, "toqr", "");
    expect(loadQrEncoder(empty)).toBeUndefined();
  });

  const toqr = needsTarball("toqr@0.1.1");
  it.skipIf(toqr !== "")(`the real toqr draws a QR code${toqr}`, () => {
    const encode = loadQrEncoder(path.resolve(packageFromTarball("toqr@0.1.1")!, "..", ".."));
    expect(typeof encode).toBe("function");
    const qr = encode!(LINK);
    const n = Math.sqrt(qr.length);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(21);
    expect(n % 4).toBe(1);
    const at = (r: number, c: number) => qr[r * n + c];
    for (let c = 0; c <= 6; c++) expect(at(0, c), `row 0 col ${c}`).toBe(1);
    for (let c = 1; c <= 5; c++) expect(at(1, c), `row 1 col ${c}`).toBe(0);
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) expect(at(r, c), `row ${r} col ${c}`).toBe(1);
  });
});

describe("devClientLinkLines", () => {
  it("prints the QR code and the link in a terminal", async () => {
    const lines = await devClientLinkLines("/p", state, io());
    expect(lines[0]).toBe(LINE_1);
    expect(lines[1]).toBe("Scan this QR code with the iPhone camera to open the app on that Metro server:");
    expect(lines.slice(2, 15)).toEqual(renderQr(new Uint8Array(21 * 21)));
    expect(lines.slice(2, 15)).toHaveLength(13);
    expect(lines[15]).toBe(`Or open this link on the iPhone: ${LINK}`);
    expect(lines).toHaveLength(16);
  });

  it("prints the link as text without a TTY", async () => {
    expect(await devClientLinkLines("/p", state, io({ isTTY: false }))).toEqual([LINE_1, OPEN_LINE]);
  });

  it("drops the QR code in a narrow terminal", async () => {
    expect(await devClientLinkLines("/p", state, io({ columns: 20 }))).toEqual([LINE_1, OPEN_LINE]);
    // Exactly the QR code's width (21 modules and the border) still fits.
    expect(await devClientLinkLines("/p", state, io({ columns: 25 }))).toHaveLength(16);
  });

  it("prints the link when the encoder fails", async () => {
    const throwing: QrEncoder = () => {
      throw new Error("too long");
    };
    expect(await devClientLinkLines("/p", state, io({ qrEncoder: () => throwing }))).toEqual([LINE_1, OPEN_LINE]);
    expect(await devClientLinkLines("/p", state, io({ qrEncoder: () => undefined }))).toEqual([LINE_1, OPEN_LINE]);
  });

  it("without a URL scheme, says what to enter in the launcher", async () => {
    for (const readInfoPlist of [async () => plist.build({ CFBundleName: "App" }), async () => undefined]) {
      expect(await devClientLinkLines("/p", state, io({ readInfoPlist }))).toEqual([LINE_1, NO_SCHEME_LINE]);
    }
  });

  it("reads ios-xtool/Info.plist from the project by default", async () => {
    const root = tmp();
    mkdirSync(path.join(root, "ios-xtool"));
    writeFileSync(path.join(root, "ios-xtool", "Info.plist"), withSchemes(["exp+app"]));
    expect(await devClientLinkLines(root, state, { isTTY: false })).toEqual([LINE_1, OPEN_LINE]);
    expect(await devClientLinkLines(tmp(), state, { isTTY: false })).toEqual([LINE_1, NO_SCHEME_LINE]);
  });
});
