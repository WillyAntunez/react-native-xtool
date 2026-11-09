import { describe, expect, it } from "vitest";
import { B1_DEFINES, definesOf, scanIncludes, type ScanEnv } from "../src/project/includeScan.js";

const env: ScanEnv = { defines: definesOf([]), hasInclude: () => undefined };
const lines = (...l: string[]): string => l.join("\n");
/** The spellings `scanIncludes` returns, with their certainty. */
const found = (text: string, e: ScanEnv = env): [string, boolean][] =>
  scanIncludes(text, e).map((i) => [i.spelling, i.certain]);

describe("scanIncludes", () => {
  it("returns each include with its line and form", () => {
    expect(scanIncludes(`#import "A.h"\n#include <B/C.h>\n@import Foundation;\n`, env)).toEqual([
      { line: 1, spelling: "A.h", angle: false, certain: true },
      { line: 2, spelling: "B/C.h", angle: true, certain: true },
    ]);
  });

  it("drops includes in comments and under #if 0", () => {
    const text = lines(
      `// #import "X.h"`,
      `/* a block comment`,
      `#import "Y.h" */`,
      `#if 0`,
      `#import "Z.h"`,
      `#endif`,
      `#import "After.h"`,
    );
    expect(scanIncludes(text, env)).toEqual([{ line: 7, spelling: "After.h", angle: false, certain: true }]);
  });

  it("follows #ifdef/#elif/#else with the known defines", () => {
    expect(found(lines(`#if RCT_NEW_ARCH_ENABLED`, `#import "New.h"`, `#endif`))).toEqual([["New.h", true]]);
    expect(found(lines(`#if TARGET_OS_OSX`, `#import <AppKit/AppKit.h>`, `#endif`))).toEqual([]);
    expect(
      found(lines(`#ifdef DEBUG`, `#import "Dbg.h"`, `#else`, `#import "Rel.h"`, `#endif`)),
    ).toEqual([["Dbg.h", true]]);
    const foo: ScanEnv = { defines: definesOf(["FOO=2"]), hasInclude: () => undefined };
    expect(found(lines(`#if FOO == 2`, `#import "Foo.h"`, `#endif`), foo)).toEqual([["Foo.h", true]]);
  });

  it("marks includes under a condition it cannot evaluate as uncertain", () => {
    expect(found(lines(`#ifdef FB_SONARKIT_ENABLED`, `#import <FlipperKit/FlipperClient.h>`, `#endif`))).toEqual([
      ["FlipperKit/FlipperClient.h", false],
    ]);
    expect(found(lines(`#if __has_include(<X/Y.h>)`, `#import <X/Y.h>`, `#endif`))).toEqual([["X/Y.h", false]]);
    expect(found(lines(`#if SOME_MACRO(1)`, `#import "M.h"`, `#endif`))).toEqual([["M.h", false]]);
    expect(
      found(lines(`#if UNKNOWN`, `#import "U.h"`, `#elif RCT_NEW_ARCH_ENABLED`, `#import "E.h"`, `#endif`)),
    ).toEqual([
      ["U.h", false],
      ["E.h", false],
    ]);
    expect(found(lines(`#if 0 && UNKNOWN`, `#import "No.h"`, `#endif`))).toEqual([]);
    expect(found(lines(`#if 1 || UNKNOWN`, `#import "Yes.h"`, `#endif`))).toEqual([["Yes.h", true]]);
  });

  it("evaluates __has_include with the resolver", () => {
    const text = lines(
      `#if __has_include(<ReactCodegen/RCTModuleProviders.h>)`,
      `#import <ReactCodegen/RCTModuleProviders.h>`,
      `#elif __has_include("RCTModuleProviders.h")`,
      `#import "RCTModuleProviders.h"`,
      `#endif`,
    );
    const first: ScanEnv = { defines: definesOf([]), hasInclude: (s, angle) => angle && s.startsWith("ReactCodegen/") };
    expect(scanIncludes(text, first)).toEqual([
      { line: 2, spelling: "ReactCodegen/RCTModuleProviders.h", angle: true, certain: true },
    ]);
    const none: ScanEnv = { defines: definesOf([]), hasInclude: () => false };
    expect(scanIncludes(text, none)).toEqual([]);
  });

  it("treats an include guard as taken", () => {
    expect(found(lines(`#ifndef APP_H`, `#define APP_H`, `#import "B.h"`, `#endif`))).toEqual([["B.h", true]]);
    expect(found(lines(`#pragma once`, `#import "B.h"`))).toEqual([["B.h", true]]);
  });

  it("does not report an include built from a macro", () => {
    expect(scanIncludes(`#include MY_HEADER\n`, env)).toEqual([]);
  });

  it("reads CRLF, a BOM, spaced and continued directives", () => {
    const text =
      "\uFEFF" +
      '#import "A.h"\r\n#  import <B.h>\r\n' +
      '#if defined(DEBUG) && \\\r\n    defined(RCT_NEW_ARCH_ENABLED)\r\n#import "C.h"\r\n#endif';
    expect(scanIncludes(text, env)).toEqual([
      { line: 1, spelling: "A.h", angle: false, certain: true },
      { line: 2, spelling: "B.h", angle: true, certain: true },
      { line: 5, spelling: "C.h", angle: false, certain: true },
    ]);
  });

  // Edges the brief leaves open.

  it("drops everything after an unterminated block comment", () => {
    expect(found(lines(`#import "A.h"`, `/* never closed`, `#import "B.h"`))).toEqual([["A.h", true]]);
  });

  it("reads a directive after a comment on the same line, and an include with a trailing comment", () => {
    expect(scanIncludes(lines(`/* lead */ #import "A.h" // why`, `#import <B.h> /* note */`), env)).toEqual([
      { line: 1, spelling: "A.h", angle: false, certain: true },
      { line: 2, spelling: "B.h", angle: true, certain: true },
    ]);
  });

  it("drops the #else after a taken #if, and takes it after a false one", () => {
    expect(found(lines(`#if 1`, `#import "T.h"`, `#else`, `#import "F.h"`, `#endif`))).toEqual([["T.h", true]]);
    expect(found(lines(`#if 0`, `#import "T.h"`, `#else`, `#import "F.h"`, `#endif`))).toEqual([["F.h", true]]);
  });

  it("makes an #else after an unknown branch uncertain", () => {
    expect(found(lines(`#ifdef UNKNOWN`, `#import "U.h"`, `#else`, `#import "E.h"`, `#endif`))).toEqual([
      ["U.h", false],
      ["E.h", false],
    ]);
  });

  it("ignores nested groups inside a false branch, even ones that would be taken", () => {
    const text = lines(
      `#if TARGET_OS_OSX`,
      `#if 1`,
      `#import "In.h"`,
      `#else`,
      `#import "Else.h"`,
      `#endif`,
      `#import "Out.h"`,
      `#endif`,
      `#import "After.h"`,
    );
    expect(scanIncludes(text, env)).toEqual([{ line: 9, spelling: "After.h", angle: false, certain: true }]);
  });

  it("keeps an unknown outer group's includes uncertain even under a taken inner #if", () => {
    expect(found(lines(`#ifdef UNKNOWN`, `#if 1`, `#import "In.h"`, `#endif`, `#endif`))).toEqual([["In.h", false]]);
  });

  it("follows an #elif chain to the first true branch only", () => {
    const text = lines(
      `#if TARGET_OS_OSX`,
      `#import "Mac.h"`,
      `#elif TARGET_OS_TV`,
      `#import "TV.h"`,
      `#elif TARGET_OS_IOS`,
      `#import "IOS.h"`,
      `#elif 1`,
      `#import "Later.h"`,
      `#else`,
      `#import "Else.h"`,
      `#endif`,
    );
    expect(found(text)).toEqual([["IOS.h", true]]);
  });

  it("drops the branches after a true #elif that follows an unknown one", () => {
    const text = lines(
      `#if UNKNOWN`,
      `#import "U.h"`,
      `#elif 0`,
      `#import "Zero.h"`,
      `#elif 1`,
      `#import "One.h"`,
      `#else`,
      `#import "Else.h"`,
      `#endif`,
    );
    expect(found(text)).toEqual([
      ["U.h", false],
      ["One.h", false],
    ]);
  });

  it("does not read #import inside a string literal, nor a comment opener inside one", () => {
    const text = lines(
      `NSString *s = @"#import \\"X.h\\" /* not a comment";`,
      `const char *c = "// nor this";`,
      `#import "Real.h"`,
    );
    expect(scanIncludes(text, env)).toEqual([{ line: 3, spelling: "Real.h", angle: false, certain: true }]);
  });

  it("reads a digit separator as part of its number, not as a character literal", () => {
    const text = lines(
      `int n = 1'000; /* opens a comment`,
      `#import "Hidden.h"`,
      `*/`,
      `char c = '"'; // "`,
      `#import "Real.h"`,
    );
    expect(found(text)).toEqual([["Real.h", true]]);
  });

  it("marks #include_next uncertain, and drops it in a false branch", () => {
    expect(found(lines(`#include_next <limits.h>`, `#if 0`, `#include_next <x.h>`, `#endif`))).toEqual([
      ["limits.h", false],
    ]);
  });

  it("evaluates the three-valued operators", () => {
    const at = (cond: string): [string, boolean][] => found(lines(`#if ${cond}`, `#import "C.h"`, `#endif`));
    expect(at(`UNKNOWN && 1`)).toEqual([["C.h", false]]);
    expect(at(`UNKNOWN || 0`)).toEqual([["C.h", false]]);
    expect(at(`!UNKNOWN`)).toEqual([["C.h", false]]);
    expect(at(`!TARGET_OS_OSX && (DEBUG >= 1)`)).toEqual([["C.h", true]]);
    expect(at(`TARGET_OS_IOS != 1 || TARGET_OS_TV`)).toEqual([]);
    expect(at(`0x10 > 010 && 2 <= 2L`)).toEqual([["C.h", true]]);
    expect(at(`defined DEBUG && !defined(TARGET_OS_OSX)`)).toEqual([]);
    expect(at(`UNKNOWN == 1`)).toEqual([["C.h", false]]);
    expect(at(`DEBUG + 1`)).toEqual([["C.h", false]]);
    expect(at(``)).toEqual([["C.h", false]]);
    expect(at(`__has_feature(objc_arc)`)).toEqual([["C.h", false]]);
  });

  it("does not trust a define the file itself changes", () => {
    expect(found(lines(`#undef DEBUG`, `#ifdef DEBUG`, `#import "D.h"`, `#endif`))).toEqual([["D.h", false]]);
    expect(found(lines(`#if 0`, `#undef DEBUG`, `#endif`, `#ifdef DEBUG`, `#import "D.h"`, `#endif`))).toEqual([
      ["D.h", true],
    ]);
  });

  it("detects an include guard only as the file's first directive on an unknown name", () => {
    expect(found(lines(`#import "A.h"`, `#ifndef APP_H`, `#define APP_H`, `#import "B.h"`, `#endif`))).toEqual([
      ["A.h", true],
      ["B.h", false],
    ]);
    expect(found(lines(`#ifndef APP_H`, `#import "B.h"`, `#define APP_H`, `#endif`))).toEqual([["B.h", false]]);
    expect(found(lines(`#ifndef DEBUG`, `#define DEBUG 1`, `#import "B.h"`, `#endif`))).toEqual([]);
  });
});

describe("definesOf", () => {
  it("holds the iOS values", () => {
    expect([...B1_DEFINES]).toEqual([
      ["RCT_NEW_ARCH_ENABLED", "1"],
      ["DEBUG", "1"],
      ["TARGET_OS_MAC", "1"],
      ["TARGET_OS_IPHONE", "1"],
      ["TARGET_OS_IOS", "1"],
      ["TARGET_OS_OSX", "0"],
      ["TARGET_OS_MACCATALYST", "0"],
      ["TARGET_OS_TV", "0"],
      ["TARGET_OS_WATCH", "0"],
      ["TARGET_OS_VISION", "0"],
      ["TARGET_OS_SIMULATOR", "0"],
    ]);
  });

  it("overlays the target's KEY and KEY=VALUE entries", () => {
    const d = definesOf(["FOO", "BAR=2", "DEBUG=0", "EMPTY=", "$(inherited)"]);
    expect(d.get("FOO")).toBe("1");
    expect(d.get("BAR")).toBe("2");
    expect(d.get("DEBUG")).toBe("0");
    expect(d.get("EMPTY")).toBe("");
    expect(d.has("$(inherited)")).toBe(false);
    expect(d.get("TARGET_OS_IOS")).toBe("1");
    expect(B1_DEFINES.get("DEBUG")).toBe("1");
  });
});
