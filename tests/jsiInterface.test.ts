import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readableJsiInterface, UnreadableInterfaceError, unreadableInterfaceLines } from "../src/pipeline/jsiInterface.js";
import { FAKE_SWIFT_INTERFACE } from "./support/fakeJsiBuild.js";
import { troubleshootingUrl } from "../src/docs.js";
import { SWIFT_VERSION } from "../src/versions.js";

/**
 * jsi 56.0.14's ExpoModulesJSI.swiftinterface as Swift 6.4.1 wrote it without the `@_spi(Internal)` marks: its four
 * header lines, then the stub block, verbatim.
 */
const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "jsi-interface", "ExpoModulesJSI-56.0.14.swiftinterface"),
  "utf8",
);
const STUBS = [
  "extension Swift::Optional :  where Wrapped : _ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}",
  "extension Swift::Array :  where Element : _ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}",
  "extension Swift::Dictionary :  where Key : _ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}",
  "extension ExpoModulesJSI::JavaScriptRef :  where T : _ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}",
];
const COMPILER = "Swift version 6.4.1 (swift-6.4.1-RELEASE)";

const guardText = (jsiVersion: string, compiler: string, n: number, line: number, text: string, lever = "") =>
  `The ExpoModulesJSI.swiftinterface built for expo-modules-jsi ${jsiVersion} (${compiler}) has ${n} ${n === 1 ? "line" : "lines"} ` +
  `no Swift compiler can parse, for example line ${line}: ${text}. Every module that imports ExpoModulesJSI would fail to ` +
  `compile.${lever} See ${troubleshootingUrl("unreadable-expomodulesjsi-interface")}, and report it at ` +
  "https://github.com/WillyAntunez/react-native-xtool/issues with the output of `rn-xtool doctor --report`.";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("unreadableInterfaceLines", () => {
  it("finds the extensions Swift 6.4.1 printed without a protocol", () => {
    const lines = FIXTURE.split("\n");
    const found = unreadableInterfaceLines(FIXTURE);
    expect(found.map((l) => l.text)).toEqual(STUBS);
    expect(found.map((l) => l.line)).toEqual(STUBS.map((s) => lines.indexOf(s) + 1));
    expect(found[0]!.text.startsWith("extension Swift::Optional :  where")).toBe(true);
  });
});

describe("unreadableInterfaceLines on other shapes", () => {
  const flagged = (text: string) => unreadableInterfaceLines(text).map((l) => l.text);

  it.each([
    ["an empty first slot", "extension X : , P {}"],
    ["an empty slot before where", "extension X : P,  where T : Q {}"],
    ["an empty slot before the body", "extension X : P, {}"],
    ["an empty slot between two", "extension X : P, , Q {}"],
    ["no space before the colon", "extension X: where T : Q {}"],
    ["no space before the colon, then the body", "extension Swift::Optional:{}"],
    ["no space around the colon", "extension X:where T : Q {}"],
    ["attributes with spaces on the line", "@available(iOS 16.4, *) extension X :  where T : Q {}"],
    ["several attributes and a modifier", '@_spi(Internal) @available(*, deprecated, message: "a, b") public extension X : {}'],
    ["a bound generic type", "extension Swift::Dictionary<Swift::String, Swift::Int> :  where Value : Q {}"],
  ])("flags %s", (_shape, line) => {
    expect(flagged(`import Swift\n${line}\n`)).toEqual([line]);
  });

  it.each([
    ["where", "extension X :\n  where T : Q {}"],
    ["the body", "extension X :\n{}"],
    ["the end of the interface", "extension X :"],
    ["an empty slot on the next line", "extension X : P,\n  , Q {}"],
  ])("flags a line that ends its list before %s", (_next, text) => {
    expect(flagged(text)).toEqual([text.split("\n")[0]]);
  });

  it.each([
    ["a conformance", "extension Swift::Optional : Swift::Copyable where Wrapped : ~Swift::Copyable {}"],
    ["~Copyable", "extension X : ~Swift::Copyable {}"],
    ["@_spi and @available on the line", "@_spi(Internal) @available(iOS 16.4, *) extension X : P {}"],
    ["a where clause alone", "extension X where T : P, U : Q {}"],
    ["a where clause right after the type", "extension Swift::Optional where Wrapped : Swift::Equatable {"],
    ["attributes in the list", "extension X : @unchecked Swift::Sendable, @retroactive P {}"],
    ["a bound generic type", "extension Swift::Dictionary<Swift::String, Swift::Int> : P {}"],
    ["dictionary sugar", "extension [Swift::String : Swift::Int] : P {}"],
    ["an extension with no list", "extension X {"],
    ["a line comment", "// extension X :  where T : Q {}"],
    ["a doc comment", "/// extension X : , P {}"],
    ["a block comment", "/* extension X :  where T : Q {} */"],
    ["a block comment over lines", "/*\nextension X :  where T : Q {}\n*/"],
    ["a comment after the list", "extension X : P { // , where"],
    ["a string literal", '@available(*, deprecated, message: "extension X :  where") extension Y : P {}'],
    ["a list that goes on on the next line", "extension X :\n  P where T : Q {}"],
    ["a list whose last slot is on the next line", "extension X : P,\n  Q {}"],
    ["a member named like the keyword", "  public func `extension`(x: Swift::Int) -> Swift::Int"],
  ])("does not flag %s", (_shape, text) => {
    expect(flagged(text)).toEqual([]);
  });
});

describe("readableJsiInterface", () => {
  it("passes a readable interface unchanged", () => {
    expect(readableJsiInterface(FAKE_SWIFT_INTERFACE, "57.1.3")).toBe(FAKE_SWIFT_INTERFACE);
    // The fixture with its four pairs (each stub and the `@available` line before it) taken out by hand.
    const lines = FIXTURE.split("\n");
    const pairs = new Set(STUBS.flatMap((s) => [lines.indexOf(s) - 1, lines.indexOf(s)]));
    const readable = lines.filter((_, i) => !pairs.has(i)).join("\n");
    expect(readable).toContain("extension Swift::Optional : Swift::Copyable where");
    expect(readableJsiInterface(readable, "56.0.14")).toBe(readable);
  });

  it("stops on a broken line it does not know", () => {
    const text = `// swift-compiler-version: ${COMPILER}\nextension Swift::Set :  where Element : SomethingElse {}\n`;
    const err = thrown(() => readableJsiInterface(text, "56.0.14"));
    expect(err).toBeInstanceOf(UnreadableInterfaceError);
    expect((err as Error).message).toBe(
      guardText("56.0.14", COMPILER, 1, 2, "extension Swift::Set :  where Element : SomethingElse {}"),
    );
  });

  it("stops on Swift 6.4.1's stubs", () => {
    const err = thrown(() => readableJsiInterface(FIXTURE, "56.0.14"));
    expect(err).toBeInstanceOf(UnreadableInterfaceError);
    expect((err as Error).message).toBe(guardText("56.0.14", COMPILER, 4, FIXTURE.split("\n").indexOf(STUBS[0]!) + 1, STUBS[0]!));
  });

  it("names a Swift other than the verified one as the likely cause", () => {
    const [major, minor] = SWIFT_VERSION.split(".").map(Number) as [number, number];
    const line = "extension Swift::Set :  where Element : SomethingElse {}";
    for (const found of [`${major}.${minor + 1}.0`, `${major}.${minor - 1}`]) {
      const compiler = `Swift version ${found} (swift-${found}-RELEASE)`;
      expect(() => readableJsiInterface(`// swift-compiler-version: ${compiler}\n${line}\n`, "56.0.14")).toThrow(
        guardText(
          "56.0.14",
          compiler,
          1,
          2,
          line,
          ` It was written by Swift ${found}, and this rn-xtool release was verified with Swift ${SWIFT_VERSION}: a newer ` +
            "or older Swift is the likely cause.",
        ),
      );
    }
  });

  it("names an unknown compiler when the interface does not say", () => {
    expect(() => readableJsiInterface("extension Swift::Set :  where Element : SomethingElse {}\n", "56.0.14")).toThrow(
      guardText("56.0.14", "unknown compiler", 1, 1, "extension Swift::Set :  where Element : SomethingElse {}"),
    );
  });
});
