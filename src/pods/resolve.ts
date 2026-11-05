/**
 * Resolves the binary CocoaPods pods the libraries rn-xtool scaffolds depend on (spec goal 1.5): greedy, newest
 * satisfying version first, without backtracking, as `pod install` would pick on a fresh project. A locked version
 * that still satisfies is kept without a request; any other pod reads the version index again, once per resolution.
 * Dependencies are walked through binary pods only: a pod with a table entry is a SwiftPM package and brings its own
 * dependencies.
 */
import type { PodEntry } from "../config.js";
import { troubleshootingUrl } from "../docs.js";
import type { PodTable } from "../project/podTable.js";
import { podSpec, podVersions, type CdnOptions } from "./cdn.js";
import { PODS_LINK, PodsError } from "./format.js";
import { PodSpecError, podRoute, selectedLayers, type PodSpec, type SpecLayer } from "./spec.js";
import { RequirementError, newestSatisfying, parseRequirements, satisfiesAll, type Requirement } from "./versions.js";

/** One per unconditional `s.dependency` the early checks classify `unmapped`. */
export interface PodRoot {
  library: string;
  libraryVersion: string;
  dependency: string;
  requirements: string[];
}

export interface ResolvedBinaryPod {
  pod: string;
  version: string;
  subspecs: string[];
  spec: PodSpec;
  layers: SpecLayer[];
  headersOnly: boolean;
  /** The libraries that reach it, sorted. */
  neededBy: string[];
  /** The root pods (those a library names) that reach it, sorted. */
  roots: string[];
  /** The first path from a library to it, without it: ["GoogleMLKit 8.0.0", "MLKitVision 9.0.0"] for MLImage. */
  chain: string[];
}

export interface SourceDependency {
  pod: string;
  subspecs: string[];
  entry: PodEntry;
  /** from: "MLKitCommon" */
  requiredBy: { from: string; requirements: string[] }[];
}

export interface Resolution {
  /** Sorted by pod. */
  binary: ResolvedBinaryPod[];
  /** Sorted by pod. */
  sources: SourceDependency[];
  /** One product of the generated package each. */
  roots: { pod: string; libraries: string[] }[];
  /** Locked versions that moved. */
  changed: { pod: string; from: string; to: string; requirement: string; by: string }[];
  /**
   * Source pods without a table entry that only libraries in `knownLimits.allow` reach: left out, with block 2's
   * refusal as `reason`, and their dependencies not walked. Sorted by pod.
   */
  dropped?: DroppedPod[];
}

export interface DroppedPod {
  pod: string;
  version: string;
  /** The libraries that reach it, sorted. */
  libraries: string[];
  reason: string;
}

/** Block 2's refusal of a source pod without a table entry, with the pod and the libraries that reach it. */
export class SourcePodError extends PodsError {
  constructor(
    message: string,
    readonly pod: string,
    readonly libraries: string[],
  ) {
    super(message);
    this.name = "SourcePodError";
  }
}

const MAX_ROUNDS = 20;

/** Who imposed a requirement: a library (on a root pod) or a binary pod at its chosen version. */
type Imposer = { library: string; libraryVersion: string } | { pod: string; version: string };

interface Need {
  requirements: string[];
  by: Imposer;
}

/** What one round reads from the roots and the current choices. */
interface Graph {
  /** Pods in the order they were reached. */
  order: string[];
  needs: Map<string, Need[]>;
  /** "" stands for the root pod named itself. */
  subspecs: Map<string, Set<string>>;
  libraries: Map<string, Set<string>>;
  rootsOf: Map<string, Set<string>>;
  chains: Map<string, string[]>;
  /** The first library that reaches each pod, with its version. */
  firstLibrary: Map<string, { library: string; libraryVersion: string }>;
}

const podOf = (dependency: string): string => dependency.split("/")[0]!;
const subOf = (dependency: string): string => dependency.split("/").slice(1).join("/");
const sorted = (set: Iterable<string>): string[] => [...set].sort();

export async function resolveBinaryPods(
  roots: readonly PodRoot[],
  ctx: {
    table: PodTable;
    locked: Record<string, string>;
    cdn: CdnOptions;
    /** Whether `knownLimits.allow` names the library: a source pod only such libraries reach is dropped, not refused. */
    allowed?: (library: string) => boolean;
    /** Called at the start of each round (a test seam: the cycle check ends long before the round limit). */
    onRound?: (round: number) => void;
  },
): Promise<Resolution> {
  const specs = new Map<string, PodSpec>();
  const versions = new Map<string, string[]>();
  const refreshed = new Set<string>();
  let graph = emptyGraph();
  const cdn: CdnOptions = {
    ...ctx.cdn,
    neededBy: (pod) => graph.firstLibrary.get(pod)?.library ?? ctx.cdn.neededBy(pod),
  };
  const specOf = async (pod: string, version: string): Promise<PodSpec> => {
    const key = `${pod}@${version}`;
    let spec = specs.get(key);
    if (spec === undefined) {
      spec = await podSpec(pod, version, cdn);
      specs.set(key, spec);
    }
    return spec;
  };

  /** Whom a requirement came from, for the texts: `GoogleMLKit 8.0.0, needed by <lib>` or `<lib> <version>`. */
  const describe = (by: Imposer): string =>
    "library" in by
      ? `${by.library} ${by.libraryVersion}`
      : `${by.pod} ${by.version}, needed by ${sorted(graph.libraries.get(by.pod) ?? []).join(", ")}`;

  const requirementsOf = (pod: string): Requirement[] =>
    (graph.needs.get(pod) ?? []).flatMap((need) => {
      try {
        return parseRequirements(need.requirements);
      } catch (err) {
        if (!(err instanceof RequirementError)) throw err;
        throw new PodsError(`rn-xtool cannot read the requirement ${err.message} on ${pod} (${describe(need.by)}). See ${PODS_LINK}`);
      }
    });

  let choices = new Map<string, string>();
  const seen = new Set<string>();
  let lastFailures: Error[] = [];
  let dropped = new Map<string, DroppedPod>();
  for (let round = 0; ; round++) {
    ctx.onRound?.(round);
    graph = await collect(roots, choices, ctx.table, specOf);
    const next = new Map<string, string>();
    dropped = new Map();
    // A round reads its requirements from the previous round's choices, so a failure may come from a choice this
    // round moves: failures are collected, and the first is thrown only in a round where no choice moved.
    const failures: Error[] = [];
    for (const pod of graph.order) {
      if (ctx.table.pods[pod] !== undefined) continue;
      try {
        const reqs = requirementsOf(pod);
        const locked = ctx.locked[pod];
        let version = locked !== undefined && satisfiesAll(locked, reqs) ? locked : undefined;
        if (version === undefined) {
          // A pod the lock does not record, or whose locked version no longer satisfies, is resolved from a fresh
          // index (once per resolution), so the version the lock records does not depend on how old this machine's
          // cache is (row 71).
          const fresh = !refreshed.has(pod);
          if (fresh) refreshed.add(pod);
          const listed = (fresh ? undefined : versions.get(pod)) ?? (await podVersions(pod, { ...cdn, refresh: fresh }));
          versions.set(pod, listed);
          version = newestSatisfying(listed, reqs);
          if (version === undefined) throw new PodsError(conflictText(pod, graph.needs.get(pod) ?? [], describe));
        }
        const refusal = await checkRoute(pod, version, graph, specOf);
        if (refusal !== undefined) {
          const libraries = sorted(graph.libraries.get(pod) ?? []);
          if (ctx.allowed === undefined || libraries.length === 0 || !libraries.every(ctx.allowed)) {
            throw new SourcePodError(refusal, pod, libraries);
          }
          // Not a choice: the next round does not walk its dependencies.
          dropped.set(pod, { pod, version, libraries, reason: refusal });
          continue;
        }
        next.set(pod, version);
      } catch (err) {
        if (!(err instanceof PodsError || err instanceof PodSpecError)) throw err;
        failures.push(err);
      }
    }
    const settled = sameChoices(choices, next);
    if (settled && failures.length === 0) break;
    if (settled) throw failures[0]!;
    if (failures.length > 0) lastFailures = failures;
    // Choices that come back to an earlier round go round in a cycle: a real conflict, named by its failure (row 8).
    const key = choiceKey(next);
    if ((seen.has(key) || round + 1 >= MAX_ROUNDS) && lastFailures.length > 0) throw (failures.length > 0 ? failures : lastFailures)[0]!;
    seen.add(key);
    if (round + 1 >= MAX_ROUNDS) {
      const moving = sorted(new Set([...next.keys(), ...choices.keys()].filter((p) => choices.get(p) !== next.get(p))));
      throw new PodsError(`Resolving the CocoaPods pods did not settle after ${MAX_ROUNDS} rounds (${moving.join(", ")}). See ${PODS_LINK}`);
    }
    choices = next;
  }

  const binary: ResolvedBinaryPod[] = [];
  const sources: SourceDependency[] = [];
  const changed: Resolution["changed"] = [];
  for (const pod of sorted(graph.order)) {
    const entry = ctx.table.pods[pod];
    if (entry !== undefined) {
      const requiredBy: SourceDependency["requiredBy"] = [];
      for (const need of graph.needs.get(pod) ?? []) {
        const from = "library" in need.by ? need.by.library : need.by.pod;
        if (!requiredBy.some((r) => r.from === from && r.requirements.join("\0") === need.requirements.join("\0"))) {
          requiredBy.push({ from, requirements: need.requirements });
        }
      }
      requiredBy.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
      const subspecs = sorted([...(graph.subspecs.get(pod) ?? [])].filter((s) => s !== ""));
      sources.push({ pod, subspecs, entry, requiredBy });
      continue;
    }
    if (dropped.has(pod)) continue;
    const version = choices.get(pod)!;
    const spec = await specOf(pod, version);
    const { layers, used } = selectedLayers(spec, subspecNames(spec, graph.subspecs.get(pod)));
    const route = podRoute(spec, layers);
    binary.push({
      pod,
      version,
      subspecs: used,
      spec,
      layers,
      headersOnly: route.kind === "binary" && route.headersOnly,
      neededBy: sorted(graph.libraries.get(pod) ?? []),
      roots: sorted(graph.rootsOf.get(pod) ?? []),
      chain: graph.chains.get(pod) ?? [],
    });
    const locked = ctx.locked[pod];
    if (locked !== undefined && locked !== version) {
      const need = (graph.needs.get(pod) ?? []).find((n) => !satisfiesAll(locked, parseRequirements(n.requirements)));
      if (need !== undefined) {
        changed.push({ pod, from: locked, to: version, requirement: need.requirements.join(", "), by: describe(need.by) });
      }
    }
  }
  const rootPods = new Map<string, Set<string>>();
  for (const root of roots) {
    const pod = podOf(root.dependency);
    if (ctx.table.pods[pod] !== undefined || dropped.has(pod)) continue;
    rootPods.set(pod, (rootPods.get(pod) ?? new Set()).add(root.library));
  }
  return {
    binary,
    sources,
    roots: sorted(rootPods.keys()).map((pod) => ({ pod, libraries: sorted(rootPods.get(pod)!) })),
    changed,
    ...(dropped.size > 0 ? { dropped: sorted(dropped.keys()).map((pod) => dropped.get(pod)!) } : {}),
  };
}

function emptyGraph(): Graph {
  return {
    order: [],
    needs: new Map(),
    subspecs: new Map(),
    libraries: new Map(),
    rootsOf: new Map(),
    chains: new Map(),
    firstLibrary: new Map(),
  };
}

/** The names `selectedLayers` takes: the root pod for "". */
function subspecNames(spec: PodSpec, subs: Set<string> | undefined): string[] {
  return [...(subs ?? [""])].map((s) => (s === "" ? spec.name : s));
}

function sameChoices(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([pod, version]) => b.get(pod) === version);
}

/**
 * The pods the roots reach through the binary pods chosen so far, with their requirements, subspecs, libraries, roots
 * and first chains. Pods with a table entry are recorded and not walked.
 */
async function collect(
  roots: readonly PodRoot[],
  choices: Map<string, string>,
  table: PodTable,
  specOf: (pod: string, version: string) => Promise<PodSpec>,
): Promise<Graph> {
  const g = emptyGraph();
  let grew = false;
  const addTo = (map: Map<string, Set<string>>, pod: string, items: Iterable<string>): void => {
    const set = map.get(pod) ?? new Set<string>();
    map.set(pod, set);
    for (const item of items) {
      if (set.has(item)) continue;
      set.add(item);
      grew = true;
    }
  };
  const reach = (
    dependency: string,
    requirements: string[],
    by: Imposer,
    from: { libraries: Iterable<string>; roots: Iterable<string>; chain: string[]; first: { library: string; libraryVersion: string } },
  ): void => {
    const pod = podOf(dependency);
    if (!g.needs.has(pod)) {
      g.order.push(pod);
      g.needs.set(pod, []);
      g.chains.set(pod, from.chain);
      g.firstLibrary.set(pod, from.first);
      grew = true;
    }
    const needs = g.needs.get(pod)!;
    const same = (n: Need): boolean =>
      n.requirements.join("\0") === requirements.join("\0") &&
      ("library" in n.by && "library" in by
        ? n.by.library === by.library
        : "pod" in n.by && "pod" in by && n.by.pod === by.pod);
    if (!needs.some(same)) {
      needs.push({ requirements, by });
      grew = true;
    }
    addTo(g.subspecs, pod, [subOf(dependency)]);
    addTo(g.libraries, pod, from.libraries);
    addTo(g.rootsOf, pod, from.roots);
  };
  for (const root of roots) {
    const pod = podOf(root.dependency);
    const first = { library: root.library, libraryVersion: root.libraryVersion };
    reach(root.dependency, root.requirements, first, { libraries: [root.library], roots: [pod], chain: [], first });
  }
  do {
    grew = false;
    for (const pod of [...g.order]) {
      const version = choices.get(pod);
      if (version === undefined || table.pods[pod] !== undefined) continue;
      const spec = await specOf(pod, version);
      const { layers } = selectedLayers(spec, subspecNames(spec, g.subspecs.get(pod)));
      const from = {
        libraries: [...g.libraries.get(pod)!],
        roots: [...g.rootsOf.get(pod)!],
        chain: [...g.chains.get(pod)!, `${pod} ${version}`],
        first: g.firstLibrary.get(pod)!,
      };
      for (const layer of layers) {
        for (const [dependency, requirements] of Object.entries(layer.dependencies)) {
          if (podOf(dependency) === pod) continue;
          reach(dependency, requirements, { pod, version }, from);
        }
      }
    }
  } while (grew);
  return g;
}

/**
 * Block 2's refusal for a pod without a table entry whose spec is a source pod (the caller stops or drops it); stops on
 * one in another shape rn-xtool does not cover.
 */
async function checkRoute(
  pod: string,
  version: string,
  g: Graph,
  specOf: (pod: string, version: string) => Promise<PodSpec>,
): Promise<string | undefined> {
  const spec = await specOf(pod, version);
  const route = podRoute(spec, selectedLayers(spec, subspecNames(spec, g.subspecs.get(pod))).layers);
  const first = g.firstLibrary.get(pod)!;
  if (route.kind === "source") {
    const chain = g.chains.get(pod) ?? [];
    const snippet = `{ "pods": { "${pod}": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }`;
    const through =
      chain.length === 0
        ? `the CocoaPods pod ${pod}`
        : `the CocoaPods pod ${podOf(chain[0]!.split(" ")[0]!)}, and through it (${chain.join(" → ")}) on the CocoaPods pod ${pod}`;
    return (
      `${first.library} ${first.libraryVersion}: its podspec depends on ${through}, which has no SwiftPM package rn-xtool knows. ` +
      `Add one under "pods" in rn-xtool.config.json: ${snippet}, or leave the library out with "exclude". ` +
      `See ${troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")}`
    );
  }
  if (route.kind === "other") {
    const why = route.noIos === true ? ", so an iPhone app cannot use it." : "; rn-xtool links static CocoaPods binaries only.";
    throw new PodsError(
      `${pod} ${version} (needed by ${first.library}) ${route.what}${why} Leave the library out with "exclude" in rn-xtool.config.json. See ${PODS_LINK}`,
    );
  }
  return undefined;
}

/** One round's choices as a string, pods sorted. */
const choiceKey = (choices: ReadonlyMap<string, string>): string =>
  sorted([...choices].map(([pod, version]) => `${pod}@${version}`)).join(" ");

function conflictText(pod: string, needs: readonly Need[], describe: (by: Imposer) => string): string {
  const named = needs.filter((n) => n.requirements.length > 0);
  const list = (named.length > 0 ? named : needs)
    .map((n) => `${n.requirements.length > 0 ? `"${n.requirements.join(", ")}"` : "any version"} (${describe(n.by)})`)
    .join(", ");
  return `No version of ${pod} satisfies every requirement: ${list}. rn-xtool resolves CocoaPods versions without backtracking; leave one of the libraries out with "exclude" in rn-xtool.config.json. See ${PODS_LINK}`;
}
