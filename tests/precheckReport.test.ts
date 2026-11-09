import { describe, expect, it } from "vitest";
import {
  parseDiagnostics,
  precheckErrorLines,
  precheckStop,
  PrecheckError,
  STALE_MODULE_CACHE,
  type Diagnostic,
} from "../src/pipeline/precheckReport.js";

const same = (file: string): string => file;

describe("parseDiagnostics", () => {
  it("keeps the include stack of an error in a library header (F4)", () => {
    const output = [
      "In file included from /p/ios-xtool/Sources/App/AppDelegate.mm:3:",
      "In file included from /rn/RCTAppDelegate.h:9:",
      "/rn/react/utils/hash_combine.h:21:3: error: unknown type name 'requires'",
      "   21 |   requires std::is_integral_v<T>",
      "      |   ^",
      "1 error generated.",
      "",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        file: "/rn/react/utils/hash_combine.h",
        line: 21,
        message: "unknown type name 'requires'",
        stack: [
          "In file included from /p/ios-xtool/Sources/App/AppDelegate.mm:3:",
          "In file included from /rn/RCTAppDelegate.h:9:",
        ],
      },
    ]);
  });

  it("drops warnings and notes", () => {
    const output = [
      "/p/a/x.m:2:33: warning: unused variable 'y' [-Wunused-variable]",
      "    2 | int y;",
      "      |     ^",
      "/p/a/x.m:4:1: note: previous definition is here",
      "/p/a/x.m:5:7: error: redefinition of 'z'",
      "1 warning and 1 error generated.",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([{ file: "/p/a/x.m", line: 5, message: "redefinition of 'z'", stack: [] }]);
  });

  it("reads a fatal error for a missing include with its stack", () => {
    const output = [
      "In file included from /p/a/AppDelegate.mm:1:",
      "/p/a/AppDelegate.h:2:9: fatal error: 'React/RCTBridge.h' file not found",
      "    2 | #import <React/RCTBridge.h>",
      "      |         ^~~~~~~~~~~~~~~~~~~",
      "1 error generated.",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        file: "/p/a/AppDelegate.h",
        line: 2,
        message: "'React/RCTBridge.h' file not found",
        stack: ["In file included from /p/a/AppDelegate.mm:1:"],
      },
    ]);
  });

  it("traces a module build back to the app's import", () => {
    const output = [
      "While building module 'Foo' imported from /p/a/x.m:1:",
      "In file included from <module-includes>:1:",
      "In file included from /p/mod/foo.h:1:",
      "/p/mod/bar.h:1:24: error: use of undeclared identifier 'nope'",
      "    1 | int bad(void) { return nope; }",
      "      |                        ^~~~",
      "/p/a/x.m:1:9: fatal error: could not build module 'Foo'",
      "2 errors generated.",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        file: "/p/mod/bar.h",
        line: 1,
        message: "use of undeclared identifier 'nope'",
        stack: [
          "While building module 'Foo' imported from /p/a/x.m:1:",
          "In file included from <module-includes>:1:",
          "In file included from /p/mod/foo.h:1:",
        ],
      },
      { file: "/p/a/x.m", line: 1, message: "could not build module 'Foo'", stack: [] },
    ]);
  });

  it("reads swiftc's errors and skips its excerpts, including their `- error: lines", () => {
    const output = [
      "/p/a/A.swift:1:14: error: cannot convert value of type 'String' to specified type 'Int'",
      "1 | let x: Int = \"a\"",
      "  |              `- error: cannot convert value of type 'String' to specified type 'Int'",
      "2 | func f() { g() }",
      "3 | ",
      "",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      { file: "/p/a/A.swift", line: 1, message: "cannot convert value of type 'String' to specified type 'Int'", stack: [] },
    ]);
  });

  it("keeps errors without a file or a column, as file '' and line 0", () => {
    const output = [
      "error: generate-pch command failed with exit code 1 (use -v to see invocation)",
      "<unknown>:0: error: failed to emit precompiled header '/p/t/a.pch' for bridging header '/p/a/B.h'",
      "clang: error: no such file or directory: '/p/a/x.m'",
      "/p/a/A.swift:7: error: no column here",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      { file: "", line: 0, message: "generate-pch command failed with exit code 1 (use -v to see invocation)", stack: [] },
      { file: "", line: 0, message: "failed to emit precompiled header '/p/t/a.pch' for bridging header '/p/a/B.h'", stack: [] },
      { file: "", line: 0, message: "no such file or directory: '/p/a/x.m'", stack: [] },
      { file: "/p/a/A.swift", line: 7, message: "no column here", stack: [] },
    ]);
  });

  it("keeps a message that itself contains error:, and ignores one inside a source excerpt", () => {
    const output = [
      "/p/a/x.m:3:5: error: expected ';' after 'error: x'",
      "    3 |   NSLog(@\"/p/b.m:9:1: error: not a diagnostic\")",
      "      |     ^",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      { file: "/p/a/x.m", line: 3, message: "expected ';' after 'error: x'", stack: [] },
    ]);
  });

  it("reads CRLF output", () => {
    const output = "In file included from /p/a/x.mm:1:\r\n/p/a/y.h:4:2: error: bad\r\n    4 | x\r\n";
    expect(parseDiagnostics(output)).toEqual([
      { file: "/p/a/y.h", line: 4, message: "bad", stack: ["In file included from /p/a/x.mm:1:"] },
    ]);
  });

  it("keeps the same error twice when clang reports it for two translation units", () => {
    const err = "/p/a/two.h:1:18: error: incompatible pointer to integer conversion [-Wint-conversion]";
    const output = [err, "1 error generated.", err, "1 error generated."].join("\n");
    expect(parseDiagnostics(output)).toHaveLength(2);
  });

  it("starts a fresh stack at each diagnostic", () => {
    const output = [
      "In file included from /p/a/x.mm:1:",
      "/p/a/y.h:4:2: warning: dropped",
      "/p/a/y.h:5:2: error: after a warning",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([{ file: "/p/a/y.h", line: 5, message: "after a warning", stack: [] }]);
  });
});

describe("precheckErrorLines", () => {
  const diag = (n: number): Diagnostic => ({ file: `/p/a/f${n}.m`, line: n, message: `bad ${n}`, stack: [] });

  it("prints the first ten and counts the rest", () => {
    const lines = precheckErrorLines(
      Array.from({ length: 12 }, (_, i) => diag(i + 1)),
      same,
    );
    expect(lines.filter((l) => l.startsWith("✖ precheck — "))).toHaveLength(10);
    expect(lines[0]).toBe("✖ precheck — /p/a/f1.m:1: bad 1");
    expect(lines.at(-1)).toBe("… and 2 more");
    expect(lines.join("\n")).not.toContain("f11.m");
  });

  it("adds no count when there are ten or fewer", () => {
    expect(precheckErrorLines([diag(1)], same)).toEqual(["✖ precheck — /p/a/f1.m:1: bad 1"]);
  });

  it("names the copy's source file", () => {
    const display = (file: string): string => file.replace("/p/ios-xtool/Sources/App/AppMain.m", "ios/ObjcApp/main.m");
    const lines = precheckErrorLines(
      [
        {
          file: "/rn/React/RCTBridge.h",
          line: 12,
          message: "unknown type name 'X'",
          stack: ["In file included from /p/ios-xtool/Sources/App/AppMain.m:3:"],
        },
        { file: "/p/ios-xtool/Sources/App/AppMain.m", line: 7, message: "bad", stack: [] },
      ],
      display,
    );
    expect(lines).toEqual([
      "✖ precheck — /rn/React/RCTBridge.h:12: unknown type name 'X'",
      "  In file included from ios/ObjcApp/main.m:3:",
      "✖ precheck — ios/ObjcApp/main.m:7: bad",
    ]);
  });

  it("names a module build's importer through display", () => {
    const display = (file: string): string => file.replace("/p/copy/", "ios/");
    const lines = precheckErrorLines(
      [{ file: "/p/mod/bar.h", line: 1, message: "m", stack: ["While building module 'Foo' imported from /p/copy/x.m:1:"] }],
      display,
    );
    expect(lines[1]).toBe("  While building module 'Foo' imported from ios/x.m:1:");
  });

  it("prints a file-less error by its message", () => {
    expect(precheckErrorLines([{ file: "", line: 0, message: "generate-pch command failed", stack: [] }], same)).toEqual([
      "✖ precheck — generate-pch command failed",
    ]);
  });
});

describe("precheckStop", () => {
  it("names --skip-precheck in the stop", () => {
    expect(precheckStop(3, "ios-xtool/.precheck/precheck.log").message).toContain("rn-xtool build --skip-precheck");
  });

  it("says the plan's whole message", () => {
    const stop = precheckStop(3, "ios-xtool/.precheck/precheck.log");
    expect(stop).toBeInstanceOf(PrecheckError);
    expect(stop.message).toBe(
      "precheck: 3 error(s) in the app's own sources before xtool-build (the first ten are above; all of them in " +
        "ios-xtool/.precheck/precheck.log). If xtool-build compiles these files, this is a false stop: build with " +
        "rn-xtool build --skip-precheck and report it with rn-xtool doctor --report",
    );
  });
});

describe("STALE_MODULE_CACHE", () => {
  it("knows clang's stale-cache messages", () => {
    expect(STALE_MODULE_CACHE.test("module file '/p/mc/Foo.pcm' is out of date and needs to be rebuilt")).toBe(true);
    expect(STALE_MODULE_CACHE.test("file '/p/h.h' has been modified since the module file '/p/mc/Foo.pcm' was built")).toBe(true);
    expect(STALE_MODULE_CACHE.test("malformed or corrupted AST file: 'x'")).toBe(true);
    expect(STALE_MODULE_CACHE.test("unknown type name 'requires'")).toBe(false);
  });
});
