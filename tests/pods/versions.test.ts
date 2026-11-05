import { describe, expect, it } from "vitest";
import {
  RequirementError,
  comparePodVersions,
  isPrerelease,
  newestSatisfying,
  parseRequirements,
  satisfiesAll,
} from "../../src/pods/versions.js";

const sat = (version: string, ...items: string[]): boolean => satisfiesAll(version, parseRequirements(items));

describe("CocoaPods versions", () => {
  it.each([
    ["1.0.0-beta6", "1.0.0-beta7", -1],
    ["1.0.0-beta7", "1.0.0", -1],
    ["1.0.0", "1.0.0-beta7", 1],
    ["13.0", "13.0.0", 0],
    ["2.30910.0", "3.30910.0", -1],
    ["9.0.0", "8.10.0", 1],
    ["8.10.0", "8.9.0", 1],
    [" 4.2.1", "4.2.1", 0],
  ])("orders versions as Gem::Version does (%s vs %s)", (a, b, want) => {
    expect(comparePodVersions(a, b)).toBe(want);
  });

  it("tells a prerelease by its letter segment", () => {
    expect(isPrerelease("1.0.0-beta7")).toBe(true);
    expect(isPrerelease("1.0.0")).toBe(false);
    expect(isPrerelease("3.30910.0")).toBe(false);
  });

  it("reads string and array requirements, trimmed", () => {
    expect(parseRequirements(["~> 13.0"])).toEqual([{ op: "~>", version: "13.0" }]);
    expect(parseRequirements([">= 3.3.2", " < 4.0"])).toEqual([
      { op: ">=", version: "3.3.2" },
      { op: "<", version: "4.0" },
    ]);
    expect(parseRequirements([" 1.0.0-beta7"])).toEqual([{ op: "=", version: "1.0.0-beta7" }]);
    expect(parseRequirements([])).toEqual([]);
    expect(parseRequirements([">= 1, < 2"])).toEqual([
      { op: ">=", version: "1" },
      { op: "<", version: "2" },
    ]);
    expect(parseRequirements(["!= 1.2", "<= 3", "> 0.1", "= 2.0"]).map((r) => r.op)).toEqual(["!=", "<=", ">", "="]);
  });

  it("applies every operator", () => {
    expect(sat("4.2.1", ">= 4.2.1", " < 5.0")).toBe(true);
    expect(sat("5.0.0", ">= 4.2.1", " < 5.0")).toBe(false);
    expect(sat("1.2", "!= 1.2.0")).toBe(false);
    expect(sat("1.3", "!= 1.2.0")).toBe(true);
    expect(sat("2", "> 1.9")).toBe(true);
    expect(sat("3.0.1", "<= 3")).toBe(false);
    expect(sat("8.0.0", "8.0.0")).toBe(true);
    expect(sat("8.0.1", "= 8.0.0")).toBe(false);
    expect(sat("8.0.1")).toBe(true);
  });

  it("applies ~> with one, two and three segments", () => {
    // ~> 13.0.0: >= 13.0.0, < 13.1
    expect(sat("13.0.0", "~> 13.0.0")).toBe(true);
    expect(sat("13.0.9", "~> 13.0.0")).toBe(true);
    expect(sat("13.1.0", "~> 13.0.0")).toBe(false);
    expect(sat("12.9.9", "~> 13.0.0")).toBe(false);
    // ~> 13.0: >= 13.0, < 14
    expect(sat("13.4.0", "~> 13.0")).toBe(true);
    expect(sat("14.0.0", "~> 13.0")).toBe(false);
    // ~> 13: >= 13, < 14
    expect(sat("13.9", "~> 13")).toBe(true);
    expect(sat("14", "~> 13")).toBe(false);
    // the prerelease segments are dropped from the upper bound: ~> 1.0.0-beta14 is >= 1.0.0-beta14, < 1.1
    expect(sat("1.0.0-beta15", "~> 1.0.0-beta14")).toBe(true);
    expect(sat("1.0.5", "~> 1.0.0-beta14")).toBe(true);
    expect(sat("1.1.0", "~> 1.0.0-beta14")).toBe(false);
    expect(sat("1.0.0-beta13", "~> 1.0.0-beta14")).toBe(false);
  });

  it("picks a prerelease only when a requirement names one", () => {
    const versions = ["0.9.0", "1.0.0-beta6", "1.0.0-beta7"];
    expect(newestSatisfying(versions, parseRequirements([">= 0.1"]))).toBe("0.9.0");
    expect(newestSatisfying(versions, parseRequirements(["= 1.0.0-beta7"]))).toBe("1.0.0-beta7");
    expect(newestSatisfying(versions, parseRequirements([" 1.0.0-beta7"]))).toBe("1.0.0-beta7");
    expect(newestSatisfying(versions, parseRequirements([]))).toBe("0.9.0");
    expect(newestSatisfying(versions, parseRequirements([">= 2"]))).toBeUndefined();
  });

  it("takes the newest satisfying version in any listed order", () => {
    expect(newestSatisfying(["13.0.1", "12.0.0", "13.0.0", "14.0.0"], parseRequirements(["~> 13.0.0"]))).toBe("13.0.1");
  });

  it.each(["#{v}", "=> 1", "~>", ">= ", "1.0 || 2.0"])("throws RequirementError for an unreadable requirement (%s)", (item) => {
    expect(() => parseRequirements([item])).toThrow(RequirementError);
    expect(() => parseRequirements([item])).toThrow(`"${item.trim()}"`);
  });
});
