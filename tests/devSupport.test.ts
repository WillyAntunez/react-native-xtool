/**
 * The auto-reload helper rn-xtool copies into apps without expo-dev-client (templates/dev-support): its policy,
 * compiled with the host cc and driven by event scripts; the React Native names its glue looks up at run time, checked
 * against the pinned React Native releases; and the glue itself, syntax-checked for iOS where the Darwin SDK exists.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sdkBundle } from "../src/commands/setup.js";
import { packageRoot, toolEnv } from "../src/tools/exec.js";
import { needsTarball, packageFromTarball } from "./support/tarballs.js";
import { hasTool, tool } from "./support/tools.js";

const ROOT = packageRoot();
const TEMPLATES = path.join(ROOT, "templates", "dev-support");
const INCLUDE = path.join(TEMPLATES, "include");
const POLICY = path.join(TEMPLATES, "RNXAutoReloadPolicy.c");
const GLUE = path.join(TEMPLATES, "RNXAutoReload.m");

/**
 * Reads `<event> <time>` lines and prints the action of each step, with `+alert` when the alert is due after it and
 * shown. An event that ends in `!` stands for a step after which UIKit refuses to present the alert: `+alert-refused`.
 */
const DRIVER = String.raw`#include <stdio.h>
#include <string.h>
#include "RNXtoolDevSupport.h"

static const char *const ACTIONS[] = {"none", "connect", "retry-later", "disconnect", "reload", "stop"};
static const struct { const char *name; rnx_event event; } EVENTS[] = {
  {"failed", RNX_EVENT_BUNDLE_FAILED},   {"loaded", RNX_EVENT_BUNDLE_LOADED},
  {"ready", RNX_EVENT_METRO_READY},      {"unreachable", RNX_EVENT_METRO_UNREACHABLE},
  {"denied", RNX_EVENT_LOCAL_NETWORK_DENIED}, {"retry", RNX_EVENT_RETRY_DUE},
  {"foreground", RNX_EVENT_FOREGROUND},  {"resign", RNX_EVENT_RESIGN_ACTIVE},
  {"background", RNX_EVENT_BACKGROUND},
};

int main(void) {
  rnx_state state;
  rnx_init(&state);
  char name[32];
  double now;
  while (scanf("%31s %lf", name, &now) == 2) {
    const char *event = name;
    size_t length = strlen(name);
    bool refused = length > 0 && name[length - 1] == '!';
    if (refused) name[length - 1] = '\0';
    if (strcmp(name, "failed-bg") == 0) {
      state.foreground = false;
      event = "failed";
    }
    size_t i = 0;
    while (i < sizeof EVENTS / sizeof EVENTS[0] && strcmp(EVENTS[i].name, event) != 0) i++;
    if (i == sizeof EVENTS / sizeof EVENTS[0]) {
      fprintf(stderr, "unknown event %s\n", name);
      return 2;
    }
    rnx_action action = rnx_step(&state, EVENTS[i].event, now);
    const char *alert = "";
    if (rnx_should_alert(&state, now)) {
      alert = refused ? "+alert-refused" : "+alert";
      if (!refused) rnx_alert_shown(&state);
    }
    printf("%s%s\n", ACTIONS[action], alert);
  }
  return 0;
}
`;

const HAS_CC = hasTool("cc");

describe.skipIf(!HAS_CC)(`auto-reload policy${HAS_CC ? "" : " (needs cc)"}`, () => {
  let dir = "";
  let driver = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rnx-policy-"));
    const main = path.join(dir, "main.c");
    writeFileSync(main, DRIVER);
    driver = path.join(dir, "driver");
    const r = tool("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", INCLUDE, POLICY, main, "-o", driver]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The actions for `script` ("failed 0, ready 1"), as "connect, reload". */
  const run = (script: string): string => {
    const r = tool(driver, [], { input: script.split(", ").join("\n") + "\n" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim().split("\n").join(", ");
  };

  it("reloads after Allow", () => {
    expect(run("failed 0, unreachable 0.1, unreachable 0.2, retry 2.1, ready 5, loaded 6")).toBe(
      "connect, retry-later, none, connect, reload, none",
    );
  });
  it("recovers an app opened before Metro", () => {
    expect(run("failed 0, unreachable 0, retry 2, unreachable 2, retry 4, ready 4.5")).toBe(
      "connect, retry-later, connect, retry-later, connect, reload",
    );
  });
  it("does not reload when Metro was reachable at once", () => {
    expect(run("failed 0, ready 0.1, failed 1, ready 1.1")).toBe("connect, stop, connect, stop");
  });
  it("reloads at most once per failure", () => {
    expect(run("failed 0, unreachable 0.1, retry 2, ready 3, ready 3.1, unreachable 3.2, retry 5")).toBe(
      "connect, retry-later, connect, reload, none, none, none",
    );
  });
  it("never reloads after a bundle loaded", () => {
    expect(run("failed 0, loaded 0.5, ready 1, failed 2")).toBe("connect, stop, none, none");
  });
  it("keeps trying while access is denied, then gives up after 5 minutes", () => {
    expect(run("failed 0, denied 1, retry 299, denied 300.5, retry 302, foreground 303, failed 400")).toBe(
      "connect, retry-later, connect, stop, none, none, none",
    );
  });
  it("waits for the foreground", () => {
    expect(run("failed-bg 0, retry 2, foreground 3, ready 3.1")).toBe("none, none, connect, reload");
    expect(run("failed 0, unreachable 0.1, background 1, retry 2, ready 2.5, foreground 10")).toBe(
      "connect, retry-later, disconnect, none, none, connect",
    );
  });
  it("no alert while the system prompt is up", () => {
    expect(run("foreground 0, failed 0.1, resign 0.2, denied 0.3, retry 2.3, denied 2.4, retry 4.4, denied 4.5")).toBe(
      "none, connect, none, retry-later, connect, retry-later, connect, retry-later",
    );
  });
  it("alerts once after Don't Allow", () => {
    expect(
      run(
        "foreground 0, failed 0.1, resign 0.2, denied 0.3, retry 2.3, denied 2.4, retry 4.4, foreground 5, denied 5.1, " +
          "retry 7.1, denied 7.2, retry 9.2, denied 9.3, retry 11.3, denied 11.4",
      ),
    ).toBe(
      "none, connect, none, retry-later, connect, retry-later, connect, none, retry-later, connect, retry-later, " +
        "connect+alert, retry-later, connect, retry-later",
    );
  });
  it("tries the alert again when UIKit refuses to present it", () => {
    expect(run("foreground 0, failed 0.1, denied 0.2, retry! 3.2, denied! 3.3, retry 5.3, denied 5.4, retry 7.4")).toBe(
      "none, connect, retry-later, connect+alert-refused, retry-later+alert-refused, connect+alert, retry-later, connect",
    );
  });
  it("no alert after 5 minutes, even when UIKit refused it until then", () => {
    expect(
      run(
        "foreground 0, failed 0.1, denied 0.2, retry! 3.2, denied! 3.3, retry! 299, denied 300.5, retry 302.5, " +
          "foreground 303",
      ),
    ).toBe(
      "none, connect, retry-later, connect+alert-refused, retry-later+alert-refused, connect+alert-refused, stop, " +
        "none, none",
    );
  });
  it("no alert once access is allowed", () => {
    expect(run("foreground 0, failed 0.1, resign 0.2, denied 0.3, foreground 2, retry 2.3, ready 2.5, denied 6")).toBe(
      "none, connect, none, retry-later, none, connect, reload, none",
    );
  });
  it("no alert when Metro is down but access is allowed", () => {
    expect(
      run("foreground 0, failed 0.1, unreachable 0.2, retry 2.2, unreachable 2.3, retry 4.3, unreachable 4.4"),
    ).toBe("none, connect, retry-later, connect, retry-later, connect, retry-later");
  });
  it("a denial ends when Metro is out of reach for another reason", () => {
    expect(
      run("foreground 0, failed 0.1, denied 0.2, retry 2.2, unreachable 2.3, retry 4.3, unreachable 4.4"),
    ).toBe("none, connect, retry-later, connect, retry-later, connect, retry-later");
  });
  it("a denial ends when Metro is reachable", () => {
    expect(run("foreground 0, failed 0.1, denied 0.2, retry 2.2, ready 2.3, failed 3.5, ready 3.6")).toBe(
      "none, connect, retry-later, connect, reload, connect, stop",
    );
  });
  it("a denial ends when the app comes back to the foreground", () => {
    expect(
      run("foreground 0, failed 0.1, denied 0.2, retry 2.2, denied 2.3, background 3, foreground 20, retry 23.5"),
    ).toBe("none, connect, retry-later, connect, retry-later, disconnect, connect, connect");
  });
});

const PINNED_RN = ["react-native@0.86.3", "react-native@0.87.1", "react-native@0.88.1"];

describe.each(PINNED_RN.map((spec) => [spec, needsTarball(spec)]))(
  "the names exist in each pinned React Native: %s%s",
  (spec, needs) => {
    const read = (file: string) => readFileSync(path.join(packageFromTarball(spec)!, file), "utf8");
    it.skipIf(needs !== "")("declares the notifications and the reload function", () => {
      expect(read("React/Base/RCTConstants.h")).toContain(
        "RCT_EXTERN NSString *const RCTJavaScriptDidFailToLoadNotification;",
      );
      const constants = read("React/Base/RCTConstants.m");
      expect(constants).toContain(
        'NSString *const RCTJavaScriptDidFailToLoadNotification = @"RCTJavaScriptDidFailToLoadNotification";',
      );
      expect(constants).toContain(
        'NSString *const RCTJavaScriptDidLoadNotification = @"RCTJavaScriptDidLoadNotification";',
      );
      expect(read("React/Base/RCTReloadCommand.h")).toContain(
        "RCT_EXTERN void RCTTriggerReloadCommandListeners(NSString *reason);",
      );
    });
    it.skipIf(needs !== "")("posts the failure and one of the loaded notifications", () => {
      const instance = read("ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm");
      expect(instance).toContain("postNotificationName:RCTJavaScriptDidFailToLoadNotification");
      expect(
        instance.includes("postNotificationName:RCTJavaScriptDidLoadNotification") ||
          instance.includes('postNotificationName:@"RCTInstanceDidLoadBundle"'),
      ).toBe(true);
    });
  },
);

describe("the glue uses those names as strings", () => {
  const glue = () => readFileSync(GLUE, "utf8");
  it("looks them up by name, at run time", () => {
    const text = glue();
    for (const name of [
      '@"RCTJavaScriptDidFailToLoadNotification"',
      '@"RCTJavaScriptDidLoadNotification"',
      '@"RCTInstanceDidLoadBundle"',
      '"RCTTriggerReloadCommandListeners"',
      "dlsym(RTLD_DEFAULT",
    ]) {
      expect(text).toContain(name);
    }
  });
  it("counts the alert as shown only when UIKit presented it", () => {
    expect(glue()).toContain("[self showLocalNetworkAlert]) rnx_alert_shown(&_state);");
    expect(glue()).toContain("return alert.presentingViewController != nil;");
  });
  it("imports no React header", () => {
    expect(glue()).not.toContain("#import <React");
    expect(glue()).not.toContain("#include <React");
  });
  it("is wrapped in #if DEBUG", () => {
    const code = glue()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"));
    expect(code[0]).toBe("#if DEBUG");
    expect(code.at(-1)).toBe("#endif");
  });
});

const IOS_SDK = path.join(sdkBundle(), "Developer", "Platforms", "iPhoneOS.platform", "Developer", "SDKs", "iPhoneOS.sdk");
const HAS_IOS_TOOLS = existsSync(IOS_SDK) && tool("clang", ["--version"], { env: toolEnv() }).status === 0;

describe.skipIf(!HAS_IOS_TOOLS)(
  `compiles for iOS${HAS_IOS_TOOLS ? "" : " (needs the Darwin SDK and the Swift toolchain's clang: rn-xtool setup)"}`,
  () => {
    const syntaxCheck = (file: string, extra: string[]) =>
      tool(
        "clang",
        [
          "-fsyntax-only",
          ...extra,
          "-Wall",
          "-Wextra",
          "-Werror",
          "-target",
          "arm64-apple-ios16.4",
          "-isysroot",
          IOS_SDK,
          "-DDEBUG=1",
          "-I",
          INCLUDE,
          file,
        ],
        { env: toolEnv() },
      );
    it("the Objective-C glue, under ARC", () => {
      const r = syntaxCheck(GLUE, ["-fobjc-arc"]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
    it("the policy", () => {
      const r = syntaxCheck(POLICY, []);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  },
);

describe("the npm package", () => {
  it("ships the templates", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("templates");
  });
});
