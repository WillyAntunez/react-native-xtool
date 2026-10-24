import { describe, expect, it } from "vitest";
import { checkUdid, isValidUdid, normalizeUdid, sameUdid } from "../../src/device/udid.js";

describe("UDIDs", () => {
  it("accepts both UDID formats only", () => {
    expect(isValidUdid("00008030-00000000DEADBEEF")).toBe(true);
    expect(isValidUdid("a".repeat(40))).toBe(true);
    for (const bad of ["", "../x", "00008030-00000000DEADBEEF/..", "00008030-00000000DEADBEEZ"]) {
      expect(isValidUdid(bad)).toBe(false);
    }
  });
  it("restores the dash usbmuxd may drop and refuses junk", () => {
    expect(normalizeUdid("0000803000000000DEADBEEF")).toBe("00008030-00000000DEADBEEF");
    expect(normalizeUdid("x/y")).toBeUndefined();
  });
  it("names the source of a bad UDID without echoing much of it", () => {
    expect(() => checkUdid("../".repeat(50), "lockdownd")).toThrow("lockdownd gave an invalid UDID");
  });
  it("compares ignoring dash and case", () => {
    expect(sameUdid("00008030-00000000DEADBEEF", "0000803000000000deadbeef")).toBe(true);
  });
});
