import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every .ts file under `dir`. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

/** GitHub's heading anchor: lowercase, only letters, digits, spaces, `-` and `_` kept, spaces turned into `-`. */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** The anchors of a markdown file's headings, code blocks left out. */
function headingAnchors(file: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) anchors.add(githubSlug(m[1]!));
  }
  return anchors;
}

/** `[docs file, anchor, where]` for every docs link in src: `troubleshootingUrl("<a>")` calls and full blob URLs. */
function srcDocsLinks(): [string, string, string][] {
  return tsFiles(path.join(repo, "src")).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const where = path.relative(repo, file);
    return [
      ...[...text.matchAll(/troubleshootingUrl\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(
        (m): [string, string, string] => ["troubleshooting.md", m[1]!, where],
      ),
      ...[...text.matchAll(/blob\/main\/docs\/([\w./-]+\.md)#([\w-]+)/g)].map(
        (m): [string, string, string] => [m[1]!, m[2]!, where],
      ),
    ];
  });
}

describe("docs links", () => {
  it("turns headings into GitHub's anchors", () => {
    expect(githubSlug("doctor --project")).toBe("doctor---project");
    expect(githubSlug("First-run checklist (on the iPhone)")).toBe("first-run-checklist-on-the-iphone");
    expect(githubSlug("pnpm and Yarn PnP")).toBe("pnpm-and-yarn-pnp");
    expect(githubSlug("App ID limit")).toBe("app-id-limit");
  });

  it("finds the troubleshooting links src uses", () => {
    const anchors = srcDocsLinks().map(([file, anchor]) => `${file}#${anchor}`);
    expect(anchors).toEqual(
      expect.arrayContaining([
        "troubleshooting.md#app-id-limit",
        "troubleshooting.md#libraries-with-prebuilt-binaries",
        "troubleshooting.md#libraries-that-build-vendored-c-sources",
        "troubleshooting.md#pnpm-and-yarn-pnp",
        "troubleshooting.md#packages-hoisted-to-a-parent-folder",
      ]),
    );
  });

  it("every troubleshooting link in src has a heading", () => {
    const missing = srcDocsLinks().filter(
      ([file, anchor]) => !headingAnchors(path.join(repo, "docs", file)).has(anchor),
    );
    expect(missing.map(([file, anchor, where]) => `${where}: docs/${file}#${anchor}`)).toEqual([]);
  });
});
