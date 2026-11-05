/**
 * CocoaPods JSON specs, as the CocoaPods CDN serves them: the attributes that decide how rn-xtool builds a pod, per
 * layer (the root and each subspec), with `ios`-scoped attributes merged in. Keys rn-xtool does not use are ignored.
 */
import { PODS_LINK } from "./format.js";

export interface PodSource {
  http?: string;
  git?: string;
  tag?: string;
  type?: string;
  flatten?: boolean;
  sha256?: string;
  sha1?: string;
  /** A source key rn-xtool cannot download from (`svn`, `hg`, `path`, …). */
  other?: string;
}

export interface SpecLayer {
  /** "GoogleMLKit/MLKitCore" → []; items trimmed. */
  dependencies: Record<string, string[]>;
  vendoredFrameworks: string[];
  vendoredLibraries: string[];
  sourceFiles: string[];
  preservePaths: string[];
  moduleMap?: string;
  resourceBundles: Record<string, string[]>;
  resources: string[];
  frameworks: string[];
  weakFrameworks: string[];
  libraries: string[];
}

export interface PodSpecNode {
  name: string;
  layer: SpecLayer;
  subspecs: PodSpecNode[];
  defaultSubspecs?: string[];
}

export interface PodSpec extends PodSpecNode {
  version: string;
  source: PodSource;
  license: { type?: string; text?: string };
  homepage?: string;
  authors: string[];
  moduleName?: string;
  iosMin?: string;
  /** False when `platforms` lists other platforms and not iOS; true without `platforms` (every platform). */
  supportsIos: boolean;
  /** The platforms the spec lists, for the text of a pod without iOS. */
  platforms?: string[];
}

export class PodSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodSpecError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The attributes read as a list (a string is a list of one). */
const LIST_KEYS = {
  vendored_frameworks: "vendoredFrameworks",
  vendored_libraries: "vendoredLibraries",
  source_files: "sourceFiles",
  preserve_paths: "preservePaths",
  resources: "resources",
  frameworks: "frameworks",
  weak_frameworks: "weakFrameworks",
  libraries: "libraries",
} as const;

/** The list attributes that hold paths in the pod's folder (row 82: none may leave it). */
const PATH_KEYS = new Set(["vendored_frameworks", "vendored_libraries", "source_files", "preserve_paths", "resources"]);

/** Whether a spec or Info.plist path leaves the folder it is relative to: absolute, or with a `..` segment. */
export function leavesFolder(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || p.split(/[\\/]/).includes("..");
}

/** Source keys rn-xtool reads, or that only qualify a git or http source. */
const SOURCE_KEYS = new Set(["http", "git", "tag", "type", "flatten", "sha256", "sha1", "branch", "commit", "submodules", "headers"]);

class Reader {
  constructor(private readonly where: { pod: string; version: string }) {}

  fail(key: string, value: unknown): never {
    const shown = (JSON.stringify(value) ?? String(value)).slice(0, 80);
    throw new PodSpecError(
      `The spec of ${this.where.pod} ${this.where.version} has a "${key}" value rn-xtool cannot read (${shown}). See ${PODS_LINK}`,
    );
  }

  /** Row 82: a path that is absolute or goes up stops, naming the pod and the key. */
  inside(key: string, paths: readonly string[], value: unknown): void {
    if (!paths.some(leavesFolder)) return;
    const shown = (JSON.stringify(value) ?? String(value)).slice(0, 80);
    throw new PodSpecError(
      `The spec of ${this.where.pod} ${this.where.version} has a "${key}" path that leaves the pod's folder (${shown}). See ${PODS_LINK}`,
    );
  }

  list(key: string, value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
    return this.fail(key, value);
  }

  string(key: string, value: unknown): string {
    return typeof value === "string" ? value : this.fail(key, value);
  }

  /** `{ "<pod>": "<requirement>" | ["<requirement>", …] }`, items trimmed. */
  dependencies(key: string, value: unknown): Record<string, string[]> {
    if (!isRecord(value)) return this.fail(key, value);
    const out: Record<string, string[]> = {};
    for (const [pod, reqs] of Object.entries(value)) {
      const items = typeof reqs === "string" ? [reqs] : Array.isArray(reqs) && reqs.every((r) => typeof r === "string") ? reqs : undefined;
      if (items === undefined) return this.fail(key, value);
      out[pod] = (items as string[]).map((r) => r.trim());
    }
    return out;
  }

  /** The layer's attributes from `obj`, with `prefix` naming where they sit (`ios.`). */
  layerInto(layer: SpecLayer, obj: Record<string, unknown>, prefix: string): void {
    for (const [key, field] of Object.entries(LIST_KEYS)) {
      if (obj[key] === undefined) continue;
      const items = this.list(`${prefix}${key}`, obj[key]);
      if (PATH_KEYS.has(key)) this.inside(`${prefix}${key}`, items, obj[key]);
      layer[field].push(...items);
    }
    if (obj.dependencies !== undefined) {
      for (const [pod, reqs] of Object.entries(this.dependencies(`${prefix}dependencies`, obj.dependencies))) {
        layer.dependencies[pod] = [...(layer.dependencies[pod] ?? []), ...reqs];
      }
    }
    if (obj.resource_bundles !== undefined) {
      const bundles = obj.resource_bundles;
      if (!isRecord(bundles)) this.fail(`${prefix}resource_bundles`, bundles);
      for (const [name, globs] of Object.entries(bundles as Record<string, unknown>)) {
        const list = typeof globs === "string" ? [globs] : Array.isArray(globs) && globs.every((g) => typeof g === "string") ? globs : undefined;
        if (list === undefined) this.fail(`${prefix}resource_bundles`, bundles);
        this.inside(`${prefix}resource_bundles`, list as string[], bundles);
        layer.resourceBundles[name] = [...(layer.resourceBundles[name] ?? []), ...(list as string[])];
      }
    }
    if (obj.module_map !== undefined && obj.module_map !== false) {
      layer.moduleMap = this.string(`${prefix}module_map`, obj.module_map);
      this.inside(`${prefix}module_map`, [layer.moduleMap], obj.module_map);
    }
  }

  layer(obj: Record<string, unknown>): SpecLayer {
    const layer: SpecLayer = {
      dependencies: {},
      vendoredFrameworks: [],
      vendoredLibraries: [],
      sourceFiles: [],
      preservePaths: [],
      resourceBundles: {},
      resources: [],
      frameworks: [],
      weakFrameworks: [],
      libraries: [],
    };
    this.layerInto(layer, obj, "");
    if (obj.ios !== undefined) {
      if (!isRecord(obj.ios)) this.fail("ios", obj.ios);
      this.layerInto(layer, obj.ios as Record<string, unknown>, "ios.");
    }
    return layer;
  }

  node(obj: Record<string, unknown>, name: string): PodSpecNode {
    const node: PodSpecNode = { name, layer: this.layer(obj), subspecs: [] };
    // `default_subspecs`, or the older singular `default_subspec`; "none" (`:none`) selects no subspec.
    const key = obj.default_subspecs !== undefined ? "default_subspecs" : "default_subspec";
    if (obj[key] !== undefined) {
      const defaults = this.list(key, obj[key]);
      node.defaultSubspecs = defaults.length === 1 && defaults[0] === "none" ? [] : defaults;
    }
    if (obj.subspecs !== undefined) {
      if (!Array.isArray(obj.subspecs)) this.fail("subspecs", obj.subspecs);
      for (const sub of obj.subspecs as unknown[]) {
        if (!isRecord(sub) || typeof sub.name !== "string" || sub.name === "" || sub.name.includes("/")) {
          this.fail("subspecs", sub);
        }
        const s = sub as Record<string, unknown> & { name: string };
        node.subspecs.push(this.node(s, s.name));
      }
    }
    return node;
  }

  source(value: unknown): PodSource {
    if (!isRecord(value)) return this.fail("source", value);
    const source: PodSource = {};
    for (const key of ["http", "git", "tag", "type", "sha256", "sha1"] as const) {
      if (value[key] !== undefined) source[key] = this.string(`source.${key}`, value[key]);
    }
    if (value.flatten !== undefined) {
      if (typeof value.flatten !== "boolean") this.fail("source.flatten", value.flatten);
      source.flatten = value.flatten as boolean;
    }
    const other = Object.keys(value).find((k) => !SOURCE_KEYS.has(k));
    if (other !== undefined) source.other = other;
    return source;
  }

  license(value: unknown): { type?: string; text?: string } {
    if (value === undefined) return {};
    if (typeof value === "string") return { type: value };
    if (!isRecord(value)) return this.fail("license", value);
    const license: { type?: string; text?: string } = {};
    if (value.type !== undefined) license.type = this.string("license.type", value.type);
    if (value.text !== undefined) license.text = this.string("license.text", value.text);
    return license;
  }

  authors(value: unknown): string[] {
    if (value === undefined) return [];
    if (isRecord(value)) return Object.keys(value);
    return this.list("authors", value);
  }

  iosMin(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return this.fail("platforms", value);
    const ios = value.ios;
    if (ios === undefined || ios === null) return undefined;
    return this.string("platforms.ios", ios);
  }
}

/**
 * Every attribute may be a string or a list (normalised to a list); `ios: {…}` is merged into its layer; osx, tvos,
 * watchos and visionos are ignored; keys rn-xtool does not use are ignored. `authors` is a string, a list or an object
 * (its keys).
 */
export function parsePodSpec(json: unknown, where: { pod: string; version: string }): PodSpec {
  const r = new Reader(where);
  if (!isRecord(json)) return r.fail("spec", json);
  const name = json.name === undefined ? where.pod : r.string("name", json.name);
  const spec: PodSpec = {
    ...r.node(json, name),
    version: json.version === undefined ? where.version : r.string("version", json.version),
    source: json.source === undefined ? {} : r.source(json.source),
    license: r.license(json.license),
    authors: r.authors(json.authors),
    supportsIos: true,
  };
  if (isRecord(json.platforms)) {
    spec.platforms = Object.keys(json.platforms);
    spec.supportsIos = "ios" in json.platforms;
  }
  if (json.homepage !== undefined) spec.homepage = r.string("homepage", json.homepage);
  if (json.module_name !== undefined) spec.moduleName = r.string("module_name", json.module_name);
  const iosMin = r.iosMin(json.platforms);
  if (iosMin !== undefined) spec.iosMin = iosMin;
  return spec;
}

/** The subspecs a node selects when it is named itself: its default_subspecs, or every subspec. */
function defaultsOf(node: PodSpecNode): string[] {
  return node.defaultSubspecs ?? node.subspecs.map((s) => s.name);
}

/**
 * The root layer, then each named subspec ("TextRecognition", "A/B") with its parents. Naming the root selects
 * default_subspecs, or every subspec when there is none (CocoaPods). Dependencies on "<Pod>/<sub>" of the same pod are
 * followed; `used` lists the subspec paths taken, sorted.
 */
export function selectedLayers(spec: PodSpec, subspecs: readonly string[]): { layers: SpecLayer[]; used: string[] } {
  const layers: SpecLayer[] = [spec.layer];
  const used = new Set<string>();
  const relative = (name: string): string =>
    name === spec.name ? "" : name.startsWith(`${spec.name}/`) ? name.slice(spec.name.length + 1) : name;
  const todo = subspecs.length === 0 ? [""] : subspecs.map(relative);
  const seen = new Set<string>();
  while (todo.length > 0) {
    const sub = todo.shift()!;
    if (seen.has(sub)) continue;
    seen.add(sub);
    let node: PodSpecNode = spec;
    const parts = sub === "" ? [] : sub.split("/");
    for (let i = 0; i < parts.length; i++) {
      const next = node.subspecs.find((s) => s.name === parts[i]);
      if (next === undefined) {
        throw new PodSpecError(`The spec of ${spec.name} ${spec.version} has no subspec "${sub}". See ${PODS_LINK}`);
      }
      node = next;
      const at = parts.slice(0, i + 1).join("/");
      if (used.has(at)) continue;
      used.add(at);
      layers.push(node.layer);
      for (const dep of Object.keys(node.layer.dependencies)) {
        if (dep === spec.name || dep.startsWith(`${spec.name}/`)) todo.push(relative(dep));
      }
    }
    // A node named itself selects its default subspecs, or all of them.
    if (node.subspecs.length > 0) todo.push(...defaultsOf(node).map((d) => (sub === "" ? d : `${sub}/${d}`)));
  }
  return { layers, used: [...used].sort() };
}

export type PodRoute =
  | { kind: "binary"; headersOnly: boolean }
  | { kind: "source" }
  /** `noIos`: the spec's platforms lack iOS, a stop of its own. */
  | { kind: "other"; what: string; noIos?: true };

/** `a{b,c}d` → [abd, acd], nested braces included; a pattern without braces is itself. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      const parts: string[] = [];
      let start = open + 1;
      for (const at of commas) {
        parts.push(pattern.slice(start, at));
        start = at + 1;
      }
      parts.push(pattern.slice(start, i));
      const rest = pattern.slice(i + 1);
      return parts.flatMap((p) => expandBraces(`${pattern.slice(0, open)}${p}${rest}`));
    } else if (c === "," && depth === 1) commas.push(i);
  }
  return [pattern];
}

const COMPILED = /\.(m|mm|c|cc|cpp|cxx|swift|s|S)$/;

/** Whether a source_files pattern can match a file the compiler builds: a source extension, or a wildcard ending. */
function compilesSources(pattern: string): boolean {
  return expandBraces(pattern).some((p) => {
    const last = p.slice(p.lastIndexOf("/") + 1);
    if (COMPILED.test(last)) return true;
    const ext = last.lastIndexOf(".") === -1 ? last : last.slice(last.lastIndexOf(".") + 1);
    return /[*?[\]]/.test(ext);
  });
}

/** The URL's path, without the query or fragment. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.replace(/[?#].*$/, "");
  }
}

/** The kind of download a URL path names, for the text: `tar.bz2`, `dmg`, or `unknown` without an extension. */
function urlExtension(file: string): string {
  const m = /\.(tar\.[A-Za-z0-9]+|[A-Za-z0-9]+)$/.exec(file.slice(file.lastIndexOf("/") + 1));
  return m === null ? "unknown" : m[1]!;
}

/**
 * http source (type absent, "tgz" or "zip"; a URL ending in .tar.gz, .tgz or .zip): vendored_libraries → other; else
 * a non-header source_files entry (.m .mm .c .cc .cpp .swift) → other; else vendored_frameworks → binary; else binary,
 * headersOnly. A git source → source. Anything else → other.
 */
export function podRoute(spec: PodSpec, layers: readonly SpecLayer[]): PodRoute {
  const { source } = spec;
  if (!spec.supportsIos) {
    return { kind: "other", what: `does not support iOS (its platforms: ${(spec.platforms ?? []).join(", ")})`, noIos: true };
  }
  if (source.http !== undefined) {
    const file = urlPath(source.http);
    const archive = source.type === undefined ? /\.(tar\.gz|tgz|zip)$/.test(file) : ["tgz", "zip"].includes(source.type);
    if (!archive) return { kind: "other", what: `is a ${source.type ?? urlExtension(file)} download (${source.http})` };
    // Vendored libraries and compiled sources come first: a framework beside them would leave them out of the link.
    const library = layers.flatMap((l) => l.vendoredLibraries)[0];
    if (library !== undefined) return { kind: "other", what: `ships vendored libraries (${library})` };
    const compiled = layers.flatMap((l) => l.sourceFiles).find(compilesSources);
    if (compiled !== undefined) return { kind: "other", what: `compiles sources (${compiled})` };
    return { kind: "binary", headersOnly: !layers.some((l) => l.vendoredFrameworks.length > 0) };
  }
  if (source.git !== undefined) return { kind: "source" };
  return { kind: "other", what: `comes from a ${source.other ?? "missing"} source, which rn-xtool cannot download` };
}
