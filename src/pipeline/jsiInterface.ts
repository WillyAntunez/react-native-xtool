/**
 * The guard on the ExpoModulesJSI.swiftinterface rn-xtool's own jsi build writes. The build passes
 * `-no-verify-emitted-module-interface`, so an interface no compiler can read leaves the `jsi` step green and every
 * module that imports ExpoModulesJSI fails much later, at `xtool-build`. This stops the build at `jsi` instead.
 */

export interface UnreadableLine {
  /** 1-based. */
  line: number;
  text: string;
}

/**
 * An extension with an empty conformance list: `extension <type> :<spaces>where …` (or `… : {`). Swift 6.4 prints
 * these as placeholders for conformances to an internal `~Copyable` protocol; no Swift compiler parses them.
 */
const EMPTY_CONFORMANCE = /^[ \t]*(?:@\S+[ \t]+)*extension[ \t]+\S.*?[ \t]:[ \t]*(?:where\b|\{)/;

/** The lines that declare an extension with an empty conformance list: `extension <type> :<spaces>where …`. */
export function unreadableInterfaceLines(text: string): UnreadableLine[] {
  return text
    .split("\n")
    .map((t, i) => ({ line: i + 1, text: t.replace(/\r$/, "") }))
    .filter((l) => EMPTY_CONFORMANCE.test(l.text));
}

export class UnreadableInterfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableInterfaceError";
  }
}

/**
 * The interface ExpoModulesJSIHeaders.xcframework ships: `text` itself. Throws UnreadableInterfaceError (naming the
 * first unreadable line and the interface's compiler) when it holds a line no Swift compiler can parse.
 */
export function readableJsiInterface(text: string, jsiVersion: string): string {
  const bad = unreadableInterfaceLines(text);
  if (bad.length === 0) return text;
  const compiler = /^\/\/ swift-compiler-version:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1] ?? "unknown compiler";
  const first = bad[0]!;
  throw new UnreadableInterfaceError(
    `The ExpoModulesJSI.swiftinterface built for expo-modules-jsi ${jsiVersion} (${compiler}) has ${bad.length} ` +
      `${bad.length === 1 ? "line" : "lines"} no Swift compiler can parse, for example line ${first.line}: ${first.text}. ` +
      "Every module that imports ExpoModulesJSI would fail to compile. " +
      "Report it at https://github.com/WillyAntunez/react-native-xtool/issues with this message.",
  );
}
