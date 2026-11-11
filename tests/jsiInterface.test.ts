import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readableJsiInterface, UnreadableInterfaceError, unreadableInterfaceLines } from "../src/pipeline/jsiInterface.js";
import { FAKE_SWIFT_INTERFACE } from "./support/fakeJsiBuild.js";

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

const guardText = (jsiVersion: string, compiler: string, n: number, line: number, text: string) =>
  `The ExpoModulesJSI.swiftinterface built for expo-modules-jsi ${jsiVersion} (${compiler}) has ${n} ${n === 1 ? "line" : "lines"} ` +
  `no Swift compiler can parse, for example line ${line}: ${text}. Every module that imports ExpoModulesJSI would fail to ` +
  "compile. Report it at https://github.com/WillyAntunez/react-native-xtool/issues with this message.";

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

  it("names an unknown compiler when the interface does not say", () => {
    expect(() => readableJsiInterface("extension Swift::Set :  where Element : SomethingElse {}\n", "56.0.14")).toThrow(
      guardText("56.0.14", "unknown compiler", 1, 1, "extension Swift::Set :  where Element : SomethingElse {}"),
    );
  });
});
