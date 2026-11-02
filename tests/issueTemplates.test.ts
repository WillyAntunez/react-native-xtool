import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REVIEW_LINE } from "../src/commands/report.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "ISSUE_TEMPLATE");

interface Field {
  type: string;
  id?: string;
  attributes: {
    label?: string;
    description?: string;
    value?: string;
    options?: { label: string; required?: boolean }[];
  };
  validations?: { required?: boolean };
}
interface Template {
  name: string;
  description: string;
  labels?: string[];
  body: Field[];
}

const load = (file: string): Template => parse(readFileSync(path.join(dir, file), "utf8")) as Template;
const requiredIds = (t: Template): string[] =>
  t.body
    .filter((f) => f.validations?.required === true || f.attributes.options?.some((o) => o.required === true))
    .map((f) => f.id as string);

describe("issue templates", () => {
  it("every template parses and has a name, a description and a body", () => {
    for (const file of ["bug.yml", "library.yml"]) {
      const t = load(file);
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.body.length).toBeGreaterThan(0);
    }
    expect(load("bug.yml").labels).toEqual(["bug"]);
    expect(load("library.yml").labels).toEqual(["library"]);
  });

  it("the bug template requires the report, the command and both results", () => {
    expect(requiredIds(load("bug.yml"))).toEqual(["report", "command", "expected", "actual", "reviewed"]);
  });

  it("the library template requires the library, its version and the report", () => {
    expect(requiredIds(load("library.yml"))).toEqual(["library", "version", "report", "actual", "reviewed"]);
  });

  it("both tell the user to review the report", () => {
    for (const file of ["bug.yml", "library.yml"]) {
      const md = load(file).body.find((f) => f.type === "markdown")?.attributes.value ?? "";
      expect(md).toContain("rn-xtool doctor --report");
      expect(md).toContain("Read it before you post");
    }
  });

  it("both name everything the report replaces, as its closing line does", () => {
    const replaced = /replaced (your home folder, .*) with placeholders/.exec(REVIEW_LINE)?.[1];
    expect(replaced).toContain("bundle identifiers");
    for (const file of ["bug.yml", "library.yml"]) {
      const md = load(file).body.find((f) => f.type === "markdown")?.attributes.value ?? "";
      expect(md).toContain(`rn-xtool replaces ${replaced} with placeholders.`);
    }
  });

  it("both ask to remove anything private from the output", () => {
    for (const file of ["bug.yml", "library.yml"]) {
      const actual = load(file).body.find((f) => f.id === "actual");
      expect(actual?.attributes.description).toContain("Remove anything private.");
    }
  });

  it("blank issues are off", () => {
    const config = parse(readFileSync(path.join(dir, "config.yml"), "utf8")) as { blank_issues_enabled: boolean };
    expect(config.blank_issues_enabled).toBe(false);
  });
});
