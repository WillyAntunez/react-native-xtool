import { troubleshootingUrl } from "../docs.js";

/**
 * Known xtool failures whose raw output says little to a user: each gets what happened, whose side
 * it is on and what to do. Output that matches none passes through unchanged (xtool may reword an
 * error; the test fixtures pin today's texts).
 *
 * Sign-in failures are named only on the `auth` paths: xtool's one HTTP client times out the same
 * way for developerservices2 during an install, where "sign-in" would name the wrong cause.
 */

export type XtoolFailureId =
  | "app-id-limit"
  | "gsa-503"
  | "anisette-deadline"
  | "connect-timeout"
  | "login-interrupted";

/** The xtool release that fixed one cause of the sign-in HTTP 503; the gsa-503 message names it. */
export const GSA_503_FIXED_IN_XTOOL = "1.24.0";

/** Apple's limit as its own sentence states it; a free account's 10 per 7 days otherwise. */
function appIdLimitMessage(output: string): string {
  const m = /up to (\d+) App IDs every (\d+) days/i.exec(output);
  const n = m?.[1] ?? "10";
  const days = m?.[2] ?? "7";
  return (
    `Apple refused to register another App ID: a free Apple ID can register ${n} App IDs per ${days} days, and each ` +
    "new bundle identifier takes one. Reuse a bundle identifier that is already installed on your iPhone, without " +
    "the XTL-<Team ID>. prefix xtool adds: set it as ios.bundleIdentifier in the Expo app config, or as " +
    "PRODUCT_BUNDLE_IDENTIFIER of the app target in a bare project, then run `rn-xtool build` and `rn-xtool install` " +
    `again. Or wait until the oldest of those App IDs is ${days} days old. See ${troubleshootingUrl("app-id-limit")}`
  );
}

/** Where a failure is named: anywhere (no scope), on `rn-xtool auth` (`signIn`), or on `auth login` only. */
export interface ExplainOptions {
  /** An `xtool auth` run: sign-in failures are named. */
  signIn?: boolean;
  /** An `xtool auth login` run (implies `signIn`): a cancelled code prompt is named too. */
  login?: boolean;
}

const LOGIN_INTERRUPTED =
  "Sign-in was interrupted. If the verification code never arrived on your trusted devices, that is a known problem " +
  "between xtool and Apple's sign-in, not your project. It went away for others after they turned off Advanced Data " +
  "Protection for the Apple ID (on the iPhone: Settings → your name → iCloud → Advanced Data Protection). Then run " +
  "`rn-xtool auth login` again. Details: https://github.com/xtool-org/xtool/issues/407";

const OUTPUT_FAILURES: ReadonlyArray<{
  id: XtoolFailureId;
  pattern: RegExp;
  message: string | ((output: string) => string);
  scope?: "signIn" | "login";
}> = [
  { id: "app-id-limit", pattern: /maximum App ID limit has been reached/i, message: appIdLimitMessage },
  {
    id: "gsa-503",
    pattern: /GsService2\S*\s+failed:\s+HTTP 503\b/,
    scope: "signIn",
    message:
      "Apple's sign-in service answered HTTP 503 (Service Temporarily Unavailable): Apple refused the request before " +
      "it checked your Apple ID, so this is on Apple's side, not your project or your password. " +
      `xtool ${GSA_503_FIXED_IN_XTOOL} fixed one cause of it: \`rn-xtool doctor\` shows whether your xtool is the ` +
      "version rn-xtool pins, and `rn-xtool setup` installs it. Then try again later. " +
      "Details: https://github.com/xtool-org/xtool/issues/404",
  },
  {
    id: "anisette-deadline",
    pattern: /HTTPClientError\.deadlineExceeded\b/,
    scope: "signIn",
    message:
      "The anisette server xtool signs in through did not answer in time (HTTPClientError.deadlineExceeded). This is " +
      "on the anisette server's side, not your project or your Apple ID; it has been down before and came back on its " +
      "own. Try again later. Details: https://github.com/xtool-org/xtool/issues/401",
  },
  {
    id: "connect-timeout",
    pattern: /HTTPClientError\.connectTimeout\b/,
    scope: "signIn",
    message:
      "A connection xtool needs to sign in timed out (HTTPClientError.connectTimeout): Apple's sign-in server " +
      "(gsa.apple.com) stalls now and then on some networks, and an unreachable anisette server fails the same way. " +
      "Neither is your project or your Apple ID. Run the command again; a sign-in may need a new verification code. " +
      "Details: https://github.com/xtool-org/xtool/issues/414 and https://github.com/xtool-org/xtool/issues/401",
  },
  {
    // xtool ignores SIGINT: Ctrl+C cancels its task, which prints `Cancelled.` and exits 0. The
    // code the user types is the terminal's echo, so a cancelled 2FA prompt reads `Code: Cancelled.`.
    id: "login-interrupted",
    pattern: /^Code:[ \t]*Cancelled\.[ \t]*$/m,
    message: LOGIN_INTERRUPTED,
    scope: "login",
  },
];

function inScope(scope: "signIn" | "login" | undefined, opts: ExplainOptions): boolean {
  if (scope === "login") return opts.login === true;
  if (scope === "signIn") return opts.login === true || opts.signIn === true;
  return true;
}

/** The known failure xtool's output shows (the first match in list order, within `opts`' scope), or undefined. */
export function explainXtoolOutput(
  output: string,
  opts: ExplainOptions = {},
): { id: XtoolFailureId; message: string } | undefined {
  for (const f of OUTPUT_FAILURES) {
    if (inScope(f.scope, opts) && f.pattern.test(output)) {
      return { id: f.id, message: typeof f.message === "string" ? f.message : f.message(output) };
    }
  }
  return undefined;
}

/**
 * An Error explaining a failed xtool run (an execa error: its kept `stderr` and `stdout`), or
 * undefined when the failure is not a known one.
 */
export function explainXtoolError(e: unknown, opts: ExplainOptions = {}): Error | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const r = e as { stderr?: unknown; stdout?: unknown };
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const known = explainXtoolOutput(`${text(r.stderr)}\n${text(r.stdout)}`, opts);
  return known ? new Error(known.message, { cause: e }) : undefined;
}

/**
 * Whether xtool reports a cancelled run: on Ctrl+C it prints `Cancelled.` (after a prompt, on the
 * prompt's line) and exits 0.
 */
export function xtoolCancelled(output: string): boolean {
  return /(?:^|: )Cancelled\.[ \t]*$/m.test(output);
}

/** Runs an xtool call; a known failure rejects with its explanation, any other with the original error. */
export async function explainingXtool<T>(fn: () => Promise<T>, opts: ExplainOptions = {}): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw explainXtoolError(e, opts) ?? e;
  }
}
