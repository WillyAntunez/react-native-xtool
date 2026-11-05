/**
 * CocoaPods versions and requirements, strictly: the binary-pod resolver picks versions with these. Block 2's lenient
 * `podRequirementSatisfied` (src/project/podTable.ts) stays for the pin warnings.
 */

/** A requirement rn-xtool cannot read; the message is the requirement, quoted. */
export class RequirementError extends Error {
  constructor(requirement: string) {
    super(`"${requirement}"`);
    this.name = "RequirementError";
  }
}

type Segment = number | string;

/** The trimmed text without its `+build` metadata, which neither orders nor marks a prerelease. */
const withoutMetadata = (version: string): string => version.trim().replace(/\+.*$/, "");

/**
 * The segments /[0-9]+|[A-Za-z]+/ of the trimmed text without metadata, a dash read as `.pre.` (Gem::Version):
 * `1.0.0-beta7` → [1, 0, 0, "pre", "beta", 7], `1.0.0-1` → [1, 0, 0, "pre", 1]. This is RubyGems' order, not
 * CocoaPods': `Pod::Version` puts `1.0.0-1` above `1.0.0`. Only a requirement that names a prerelease meets the
 * difference (an accepted ruling).
 */
function versionSegments(version: string): Segment[] {
  return [...withoutMetadata(version).replaceAll("-", ".pre.").matchAll(/[0-9]+|[A-Za-z]+/g)].map(([s]) =>
    /^[0-9]/.test(s) ? Number(s) : s,
  );
}

function compareSegmentLists(a: readonly Segment[], b: readonly Segment[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    // A letter segment sorts before any number.
    if (typeof x === "string" && typeof y === "number") return -1;
    if (typeof x === "number" && typeof y === "string") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Gem::Version order over the segments of the version: a letter segment sorts before any number, so 1.0.0-beta7 <
 * 1.0.0-1 < 1.0.0; a missing segment counts as 0; `+build` metadata is left out.
 */
export function comparePodVersions(a: string, b: string): number {
  return compareSegmentLists(versionSegments(a), versionSegments(b));
}

/** CocoaPods' `prerelease?`: a letter or a dash in the version without its metadata (`1.0.0-beta7`, `1.0.0-1`). */
export function isPrerelease(version: string): boolean {
  return /[A-Za-z-]/.test(withoutMetadata(version));
}

export interface Requirement {
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "~>";
  version: string;
}

/** Each separator is required, so a run of characters splits one way only (linear time). */
const REQUIREMENT = /^(=|!=|>=|<=|>|<|~>)?\s*([0-9][0-9A-Za-z]*(?:[.+-][0-9A-Za-z]+)*)$/;

/**
 * Items trimmed and split at commas; a bare version is "="; [] means any version. Throws RequirementError for an item
 * it cannot read (an interpolation, an unknown operator).
 */
export function parseRequirements(items: readonly string[]): Requirement[] {
  return items
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const m = REQUIREMENT.exec(item);
      if (m === null) throw new RequirementError(item);
      return { op: (m[1] ?? "=") as Requirement["op"], version: m[2]! };
    });
}

/** Gem::Version#release: the segments before the first letter segment. */
function releaseSegments(version: string): number[] {
  const segments = versionSegments(version);
  const firstLetter = segments.findIndex((s) => typeof s === "string");
  return (firstLetter === -1 ? segments : segments.slice(0, firstLetter)) as number[];
}

/** The upper bound of `~> version`, as Gem::Version#bump: prerelease segments dropped, the last but one raised. */
function pessimisticUpper(version: string): Segment[] {
  const release = releaseSegments(version);
  const upper = release.length > 1 ? release.slice(0, -1) : [...release];
  upper[upper.length - 1]! += 1;
  return upper;
}

function satisfies(version: string, req: Requirement): boolean {
  const c = comparePodVersions(version, req.version);
  switch (req.op) {
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case "~>":
      // RubyGems: version >= r && version.release < r.bump.
      return c >= 0 && compareSegmentLists(releaseSegments(version), pessimisticUpper(req.version)) < 0;
  }
}

/**
 * `~> a.b.c` is >= a.b.c and < a.(b+1); `~> a.b` is >= a.b and < (a+1); `~> a` is >= a and < (a+1); prerelease
 * segments are dropped from the upper bound, as Gem::Version#bump drops them.
 */
export function satisfiesAll(version: string, reqs: readonly Requirement[]): boolean {
  return reqs.every((req) => satisfies(version, req));
}

/** The newest of `versions` that satisfies `reqs`; prereleases only when a requirement names one (CocoaPods). */
export function newestSatisfying(versions: readonly string[], reqs: readonly Requirement[]): string | undefined {
  const prereleases = reqs.some((req) => isPrerelease(req.version));
  let best: string | undefined;
  for (const version of versions) {
    if (!prereleases && isPrerelease(version)) continue;
    if (!satisfiesAll(version, reqs)) continue;
    if (best === undefined || comparePodVersions(version, best) > 0) best = version;
  }
  return best;
}
