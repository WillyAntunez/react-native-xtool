import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  explainingXtool,
  explainXtoolError,
  explainXtoolOutput,
  GSA_503_FIXED_IN_XTOOL,
} from "../src/tools/xtoolErrors.js";

const fixture = (name: string): string =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xtool-errors", `${name}.txt`),
    "utf8",
  );

const SIGN_IN = {
  "gsa-503":
    "Apple's sign-in service answered HTTP 503 (Service Temporarily Unavailable): Apple refused the request before it " +
    "checked your Apple ID, so this is on Apple's side, not your project or your password. " +
    `xtool ${GSA_503_FIXED_IN_XTOOL} fixed one cause of it: \`rn-xtool doctor\` shows whether your xtool is the version ` +
    "rn-xtool pins, and `rn-xtool setup` installs it. Then try again later. " +
    "Details: https://github.com/xtool-org/xtool/issues/404",
  "anisette-deadline":
    "The anisette server xtool signs in through did not answer in time (HTTPClientError.deadlineExceeded). This is on " +
    "the anisette server's side, not your project or your Apple ID; it has been down before and came back on its own. " +
    "Try again later. Details: https://github.com/xtool-org/xtool/issues/401",
  "connect-timeout":
    "A connection xtool needs to sign in timed out (HTTPClientError.connectTimeout): Apple's sign-in server " +
    "(gsa.apple.com) stalls now and then on some networks, and an unreachable anisette server fails the same way. " +
    "Neither is your project or your Apple ID. Run the command again; a sign-in may need a new verification code. " +
    "Details: https://github.com/xtool-org/xtool/issues/414 and https://github.com/xtool-org/xtool/issues/401",
} as const;

const LOGIN_INTERRUPTED =
  "Sign-in was interrupted. If the verification code never arrived on your trusted devices, that is a known problem " +
  "between xtool and Apple's sign-in, not your project. It went away for others after they turned off Advanced Data " +
  "Protection for the Apple ID (on the iPhone: Settings → your name → iCloud → Advanced Data Protection). Then run " +
  "`rn-xtool auth login` again. Details: https://github.com/xtool-org/xtool/issues/407";

describe("explainXtoolOutput", () => {
  it.each(Object.entries(SIGN_IN))("names each pinned sign-in failure: %s", (id, message) => {
    expect(explainXtoolOutput(fixture(id), { signIn: true })).toEqual({ id, message });
    expect(explainXtoolOutput(fixture(id), { login: true })).toEqual({ id, message });
  });

  it.each(Object.keys(SIGN_IN))("names a sign-in failure only on the sign-in paths: %s", (id) => {
    // xtool's one HTTP client times out the same way for developerservices2 during an install.
    expect(explainXtoolOutput(fixture(id))).toBeUndefined();
  });

  it("names the xtool release that fixed one cause of the 503", () => {
    expect(GSA_503_FIXED_IN_XTOOL).toBe("1.24.0");
  });

  it("passes unknown output through unchanged", async () => {
    expect(explainXtoolOutput("Error: something new\n", { login: true })).toBeUndefined();
    const devServices503 =
      "Error: POST https://developerservices2.apple.com/services/QH65B2/listTeams.action failed: HTTP 503. Details:\n";
    expect(explainXtoolOutput(devServices503, { login: true })).toBeUndefined();
    const unknown = Object.assign(new Error("Command failed"), { stderr: "Error: something new\n", exitCode: 1 });
    expect(explainXtoolError(unknown, { login: true })).toBeUndefined();
    await expect(explainingXtool(() => Promise.reject(unknown), { login: true })).rejects.toBe(unknown);
  });
});

describe("explainXtoolError", () => {
  it("reads both stderr and stdout", () => {
    const signIn = { signIn: true };
    expect(explainXtoolError({ stdout: fixture("anisette-deadline") }, signIn)?.message).toBe(
      SIGN_IN["anisette-deadline"],
    );
    expect(explainXtoolError({ stderr: fixture("gsa-503"), stdout: undefined }, signIn)?.message).toBe(
      SIGN_IN["gsa-503"],
    );
    expect(explainXtoolError(new Error("HTTPClientError.connectTimeout"), signIn)).toBeUndefined();
    expect(explainXtoolError("HTTPClientError.connectTimeout", signIn)).toBeUndefined();
  });
});

describe("an interrupted login", () => {
  // xtool ignores SIGINT: Ctrl+C cancels its task, which prints `Cancelled.` and exits 0. At the
  // 2FA prompt the output reads `Code: Cancelled.` (what the user typed is the terminal's echo).
  it("gets the verification-code hint after the code prompt", () => {
    expect(explainXtoolOutput(fixture("login-interrupted"), { login: true })).toEqual({
      id: "login-interrupted",
      message: LOGIN_INTERRUPTED,
    });
    expect(explainXtoolError({ stdout: fixture("login-interrupted") }, { login: true })?.message).toBe(
      LOGIN_INTERRUPTED,
    );
  });

  it("only on the login path", () => {
    expect(explainXtoolOutput(fixture("login-interrupted"))).toBeUndefined();
    expect(explainXtoolOutput(fixture("login-interrupted"), { signIn: true })).toBeUndefined();
  });

  it("not when cancelled before the code prompt, or after a code was entered", () => {
    expect(explainXtoolOutput("Apple ID: Cancelled.\n", { login: true })).toBeUndefined();
    expect(explainXtoolOutput("Logging in...\nCode: Select a team\nChoice (0-1): Cancelled.\n", { login: true }))
      .toBeUndefined();
  });

  it("does not read a signal or exit status: xtool exits 0 when cancelled", () => {
    expect(explainXtoolError({ signal: "SIGINT" }, { login: true })).toBeUndefined();
    expect(explainXtoolError({ exitCode: 130 }, { login: true })).toBeUndefined();
  });

  it("a known output pattern wins over the cancel", () => {
    const both = `${fixture("gsa-503")}Code: Cancelled.\n`;
    expect(explainXtoolOutput(both, { login: true })?.id).toBe("gsa-503");
  });
});

describe("explainingXtool", () => {
  it("resolves with the call's value", async () => {
    await expect(explainingXtool(async () => 42)).resolves.toBe(42);
  });

  it("rejects with the explanation of a known failure", async () => {
    const e = Object.assign(new Error("Command failed"), { stderr: fixture("connect-timeout"), exitCode: 1 });
    await expect(explainingXtool(() => Promise.reject(e), { signIn: true })).rejects.toThrow(SIGN_IN["connect-timeout"]);
  });
});
