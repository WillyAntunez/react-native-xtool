/**
 * The drift watch's targets: one fresh project per supported line (per create-expo-app template for an Expo SDK), with
 * the newest version npm publishes on that line. The daily workflow creates each one and runs the checks in check.ts.
 */
import { bareLines, compareVersions, lineId, releaseLine, SUPPORTED_LINES } from "../versions.js";

export interface WatchTarget {
  /** "expo-58/default", "bare-0.88" */
  id: string;
  /** `id` with "/" → "-": usable in file and artifact names. */
  slug: string;
  /** The line's id ("expo-58"): targets of one line share its issue. */
  line: string;
  /** The line's issue title: "Drift: Expo SDK 58", "Drift: React Native 0.88 (bare)". */
  title: string;
  kind: "expo" | "bare";
  sdk?: number;
  template?: string;
  minor?: string;
  /** The react-native version a bare project is created with. */
  version?: string;
  /** The @react-native-community/cli version a bare project is created with. */
  cli?: string;
  /** The create-expo version an Expo project is created with. */
  createExpo?: string;
}

/** The newest stable release of `minor` ("0.88") among `versions`; prereleases and other minors do not count. */
export function newestOfMinor(versions: readonly string[], minor: string): string | undefined {
  return versions
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && releaseLine(v) === minor)
    .reduce<string | undefined>((hi, v) => (hi === undefined || compareVersions(v, hi) > 0 ? v : hi), undefined);
}

/**
 * One target per Expo template and per bare line, in table order. A bare line takes the newest release `rnVersions`
 * (`npm view react-native versions`) has of its minor, else its last verified version.
 */
export function watchTargets(rnVersions: readonly string[]): WatchTarget[] {
  const targets: WatchTarget[] = [];
  for (const line of SUPPORTED_LINES) {
    if (line.kind !== "expo") continue;
    for (const template of line.templates) {
      const id = `${lineId(line)}/${template}`;
      targets.push({
        id,
        slug: id.replace(/\//g, "-"),
        line: lineId(line),
        title: `Drift: Expo SDK ${line.sdk}`,
        kind: "expo",
        sdk: line.sdk,
        template,
        createExpo: line.createExpo,
      });
    }
  }
  for (const line of bareLines()) {
    const id = lineId(line);
    targets.push({
      id,
      slug: id,
      line: id,
      title: `Drift: React Native ${line.minor} (bare)`,
      kind: "bare",
      minor: line.minor,
      version: newestOfMinor(rnVersions, line.minor) ?? line.verified.at(-1),
      cli: line.cli,
    });
  }
  return targets;
}

/** The Expo SDKs the weekly exploration looks at (older than every Expo row), from the blank-typescript template. */
export const EXPLORE_EXPO_SDKS: readonly number[] = [54, 55, 56];
/** The bare React Native minors the weekly exploration looks at (older than every bare row), at their newest patch. */
export const EXPLORE_RN_MINORS: readonly string[] = ["0.81", "0.82", "0.83", "0.84", "0.85"];
/**
 * The @react-native-community/cli each explored minor is created with, from package/template/package.json of
 * @react-native-community/template at the minor's newest patch (0.81.6, 0.82.1, 0.83.10, 0.84.1, 0.85.3), the same
 * source as the bare rows' `cli`. Pinned, never `@latest`: a CLI that drops an old minor would hide the evidence.
 */
export const EXPLORE_RN_CLI: Readonly<Record<string, string>> = {
  "0.81": "20.0.0",
  "0.82": "20.0.0",
  "0.83": "20.0.0",
  "0.84": "20.1.0",
  "0.85": "20.1.0",
};
/** The create-expo the explored SDKs are created with: the Expo rows' pin. */
export const EXPLORE_CREATE_EXPO = "5.1.5";

/**
 * The weekly exploration's targets: each explored SDK's blank-typescript template, then each explored minor at the
 * newest release `rnVersions` lists (none listed: no version, and the target cannot be created).
 */
export function exploreTargets(rnVersions: readonly string[]): WatchTarget[] {
  const template = "blank-typescript";
  const expo = EXPLORE_EXPO_SDKS.map((sdk): WatchTarget => {
    const id = `expo-${sdk}/${template}`;
    return {
      id,
      slug: id.replace(/\//g, "-"),
      line: `expo-${sdk}`,
      title: `Explore: Expo SDK ${sdk}`,
      kind: "expo",
      sdk,
      template,
      createExpo: EXPLORE_CREATE_EXPO,
    };
  });
  const bare = EXPLORE_RN_MINORS.map((minor): WatchTarget => {
    const version = newestOfMinor(rnVersions, minor);
    return {
      id: `bare-${minor}`,
      slug: `bare-${minor}`,
      line: `bare-${minor}`,
      title: `Explore: React Native ${minor} (bare)`,
      kind: "bare",
      minor,
      ...(version !== undefined && { version }),
      cli: EXPLORE_RN_CLI[minor]!,
    };
  });
  return [...expo, ...bare];
}

/**
 * The command that creates the target's project in `dir`, as the clean-machine e2e harness does: create-expo with the
 * SDK's template, or the React Native CLI without pods. Both are pinned per line, never `@latest`: a tooling release
 * (a new prompt, a dropped minor) must not read as drift.
 */
export function createCommand(t: WatchTarget, dir: string): [string, string[]] {
  if (t.kind === "expo") {
    if (t.createExpo === undefined) throw new Error(`${t.id} has no create-expo version to create it with`);
    return ["npx", ["--yes", `create-expo@${t.createExpo}`, dir, "--template", `${t.template}@sdk-${t.sdk}`]];
  }
  if (t.cli === undefined) throw new Error(`${t.id} has no @react-native-community/cli version to create it with`);
  if (t.version === undefined) throw new Error(`${t.id} has no react-native version to create it with`);
  return [
    "npx",
    [
      "--yes",
      `@react-native-community/cli@${t.cli}`,
      "init",
      "DriftApp",
      "--directory",
      dir,
      "--version",
      t.version,
      "--install-pods",
      "false",
      "--skip-git-init",
    ],
  ];
}
