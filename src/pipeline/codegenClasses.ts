/**
 * The classes React Native's codegen looks up by name at app start must be in the app. The generated
 * `RCTThirdPartyComponentsProvider.mm` builds a dictionary literal of `NSClassFromString(@"<Class>")` for every
 * third-party Fabric component: one class missing from the binary is a nil value, and the app stops at start with
 * NSInvalidArgumentException in `+[RCTThirdPartyComponentsProvider thirdPartyFabricComponents]`. `RCTModuleProviders.mm`
 * does the same for TurboModule providers, and React Native logs "Module provider <Class> cannot be found in the
 * runtime" and goes on without the module. A library whose scaffolded Package.swift left out its Objective-C sources
 * (react-native-screens 4.24.0 before fix 28) builds and links without them, so this is checked on the packed app:
 * `build` runs it after xtool-build, and `install` on the app xtool builds before it installs. Nothing is repaired: a
 * missing class removes the packed app and its .ipa and stops with the list.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { troubleshootingUrl } from "../docs.js";
import { projectPaths } from "../paths.js";
import { appBinary, removePackedApp } from "../pods/postPack.js";
import type { NmRunner } from "./symbols.js";

export const CODEGEN_CLASSES_LINK = troubleshootingUrl("rctthirdpartycomponentsprovider-thirdpartyfabriccomponents");

/** One class the generated providers name. */
export interface CodegenClass {
  kind: "component" | "module";
  /** The component (`RNSScreen`) or module (`RNCWebViewModule`) name. */
  name: string;
  /** The Objective-C class name `NSClassFromString` looks up (`RNSScreenView`). */
  className: string;
  /** The npm package codegen took it from, when known. */
  library?: string;
}

const COMPONENTS_FILE = "RCTThirdPartyComponentsProvider.mm";
const MODULES_FILE = "RCTModuleProviders.mm";
/** `@"Name": NSClassFromString(@"Class"), // library` (also `[Class class]`). */
const COMPONENT_RE = /@"([^"]+)"\s*:\s*(?:NSClassFromString\(\s*@"([^"]+)"\s*\)|\[\s*([A-Za-z_]\w*)\s+class\s*\])\s*,?[ \t]*(?:\/\/[ \t]*(\S+))?/g;
/** `@"Module": @"ProviderClass", // library` */
const MODULE_RE = /@"([^"]+)"\s*:\s*@"([^"]+)"\s*,?[ \t]*(?:\/\/[ \t]*(\S+))?/g;

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The classes `ios/build/generated/ios/ReactCodegen`'s providers name; none when codegen wrote no providers. */
export function codegenClasses(generatedIos: string): CodegenClass[] {
  const dir = path.join(generatedIos, "ReactCodegen");
  const out: CodegenClass[] = [];
  const components = readText(path.join(dir, COMPONENTS_FILE));
  if (components !== undefined) {
    for (const m of components.matchAll(COMPONENT_RE)) {
      out.push({ kind: "component", name: m[1]!, className: (m[2] ?? m[3])!, ...(m[4] !== undefined && { library: m[4] }) });
    }
  }
  const modules = readText(path.join(dir, MODULES_FILE));
  // Only the mapping literal: the file's RCTLogError format strings are `@"..."` too, never `@"x": @"y"`.
  const mapping = modules?.match(/moduleMapping\s*=\s*@\{([\s\S]*?)\};/)?.[1];
  if (mapping !== undefined) {
    for (const m of mapping.matchAll(MODULE_RE)) {
      out.push({ kind: "module", name: m[1]!, className: m[2]!, ...(m[3] !== undefined && { library: m[3] }) });
    }
  }
  return out;
}

/** Each autolinked library's codegen classes (`codegenConfig.ios`), for providers that do not say the library. */
function librariesByClass(root: string): Map<string, string> {
  const byClass = new Map<string, string>();
  let deps: Record<string, { root?: unknown }> = {};
  try {
    const json = JSON.parse(readFileSync(path.join(projectPaths(root).autolinking, "autolinking.json"), "utf8")) as {
      dependencies?: Record<string, { root?: unknown }>;
    };
    deps = json.dependencies ?? {};
  } catch {
    return byClass;
  }
  for (const [name, dep] of Object.entries(deps)) {
    if (typeof dep.root !== "string") continue;
    let ios: Record<string, unknown> | undefined;
    try {
      const pkg = JSON.parse(readFileSync(path.join(dep.root, "package.json"), "utf8")) as { codegenConfig?: { ios?: Record<string, unknown> } };
      ios = pkg.codegenConfig?.ios;
    } catch {
      continue;
    }
    if (ios === undefined) continue;
    const add = (cls: unknown) => typeof cls === "string" && !byClass.has(cls) && byClass.set(cls, name);
    for (const key of ["componentProvider", "modulesProvider"]) {
      const map = ios[key];
      if (map !== null && typeof map === "object") for (const cls of Object.values(map)) add(cls);
    }
    const components = ios["components"];
    if (components !== null && typeof components === "object") {
      for (const c of Object.values(components)) add((c as { className?: unknown } | null)?.className);
    }
  }
  return byClass;
}

const CLASS = /^_OBJC_CLASS_\$_(\S+)$/;

/** The Objective-C classes `file`'s arm64 code defines, by runtime name. */
async function definedClasses(nm: NmRunner, file: string): Promise<string[]> {
  const out = await nm(["--arch=arm64", "--defined-only", "-j", file]);
  return out
    .split("\n")
    .map((l) => CLASS.exec(l.trim())?.[1])
    .filter((c): c is string => c !== undefined);
}

/** The App binary and each embedded framework's binary: where the classes may live. */
function appImages(appBundle: string): string[] {
  const images = [appBinary(appBundle)];
  const frameworks = path.join(appBundle, "Frameworks");
  let entries: string[] = [];
  try {
    entries = readdirSync(frameworks);
  } catch {
    return images;
  }
  for (const e of entries.sort()) {
    if (e.endsWith(".framework")) {
      const binary = path.join(frameworks, e, e.slice(0, -".framework".length));
      if (existsSync(binary)) images.push(binary);
    } else if (e.endsWith(".dylib")) {
      images.push(path.join(frameworks, e));
    }
  }
  return images;
}

/** `NSClassFromString(@"Module.Class")` finds a Swift class by its mangled runtime name, `_TtC6Module5Class`. */
function runtimeName(className: string): string {
  const parts = className.split(".");
  return parts.length === 2 && parts.every((p) => p !== "") ? `_TtC${parts.map((p) => `${p.length}${p}`).join("")}` : className;
}

const SHOWN = 8;

/**
 * Checks that every class the codegen providers of `root` name is defined in the packed `appBundle` (its App binary or
 * an embedded framework). Returns the lines to print; throws, after removing the app and its .ipa, when one is
 * missing.
 */
export async function checkCodegenClasses(root: string, appBundle: string, nm: NmRunner): Promise<string[]> {
  const wanted = codegenClasses(projectPaths(root).generatedIos);
  if (wanted.length === 0) return [];
  const defined = new Set<string>();
  for (const image of appImages(appBundle)) {
    if (existsSync(image)) for (const c of await definedClasses(nm, image)) defined.add(c);
  }
  if (defined.size === 0) {
    // A binary without its symbol table (stripped) cannot be checked; nothing is refused on that.
    return [
      `ℹ The packed app's binaries list no Objective-C class symbols, so rn-xtool could not check the ${wanted.length} classes ` +
        "React Native's codegen providers name.",
    ];
  }
  const missing = wanted.filter((c) => !defined.has(runtimeName(c.className)));
  if (missing.length === 0) return [];
  const byClass = missing.some((c) => c.library === undefined) ? librariesByClass(root) : new Map<string, string>();
  const libraries = new Set<string>();
  const items = missing.map((c) => {
    const library = c.library ?? byClass.get(c.className);
    if (library !== undefined) libraries.add(library);
    return `  - ${c.className} (${c.kind} ${c.name}, ${library ?? "a library"})`;
  });
  const shown = [...items.slice(0, SHOWN), ...(items.length > SHOWN ? [`  - and ${items.length - SHOWN} more`] : [])];
  const effects: string[] = [];
  if (missing.some((c) => c.kind === "component")) {
    effects.push(
      "With a component class missing, the app would crash at start: +[RCTThirdPartyComponentsProvider thirdPartyFabricComponents] " +
        "throws NSInvalidArgumentException (-[__NSPlaceholderDictionary initWithObjects:forKeys:count:]: attempt to insert nil object).",
    );
  }
  if (missing.some((c) => c.kind === "module")) {
    effects.push('With a module class missing, React Native logs "Module provider <class> cannot be found in the runtime" and the module is unavailable.');
  }
  const named = [...libraries].sort();
  const where =
    named.length > 0
      ? `Check the sources of ${named.map((l) => `node_modules/${l}/Package.swift`).join(", ")}: `
      : "Check the sources of the library's Package.swift: ";
  await removePackedApp(appBundle);
  throw new Error(
    "React Native's codegen names classes the packed app does not define, so rn-xtool removed it and does not install it:\n" +
      `${shown.join("\n")}\n` +
      `${effects.join(" ")}\n` +
      `${where}its target was built without the files that define them. A scaffold persisted in patches/ by an older ` +
      "rn-xtool can be the cause: delete that patch, reinstall the library and build again.\n" +
      `See ${CODEGEN_CLASSES_LINK}`,
  );
}

/** Whether the codegen providers of `root` name any class, so `install` checks the app before installing it. */
export function hasCodegenClasses(root: string): boolean {
  return codegenClasses(projectPaths(root).generatedIos).length > 0;
}
