/**
 * Block 2's pin check, on the requirements binary pods put on their source pods (spec goal 3.3): a table pin outside a
 * requirement gets the `⚠` line, or the `ℹ` line of an entry that marks the override as checked (`outsideRequirement`).
 */
import { pinLine, pinSource, podRequirementSatisfied, type PodTable } from "../project/podTable.js";
import type { Resolution } from "./resolve.js";

/** "a", "a and b", "a, b and c" */
const andList = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * One line per source pod and requirement its pin misses, naming the binary pods (or libraries) that impose it:
 * `MLKitCommon's and MLKitVision's`. `podsFile` names the config file a config pin comes from.
 */
export function binaryPinLines(resolution: Resolution, table: PodTable, podsFile?: string): string[] {
  const lines: string[] = [];
  for (const source of resolution.sources) {
    const entry = table.pods[source.pod] ?? source.entry;
    const byRequirement = new Map<string, string[]>();
    for (const { from, requirements } of source.requiredBy) {
      if (podRequirementSatisfied(entry.exact, requirements)) continue;
      const key = requirements.join(", ");
      const froms = byRequirement.get(key) ?? [];
      if (!froms.includes(from)) froms.push(from);
      byRequirement.set(key, froms);
    }
    for (const [requirement, froms] of byRequirement) {
      lines.push(pinLine(source.pod, entry, pinSource(table, source.pod, podsFile), andList(froms.sort().map((f) => `${f}'s`)), requirement));
    }
  }
  return lines;
}
