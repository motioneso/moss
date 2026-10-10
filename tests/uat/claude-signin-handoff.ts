// tests/uat/claude-signin-handoff.ts
//
// #3361: drives Moss's own Claude sign-in for a real-chat UAT run selected with
// JARVIS_UAT_REAL_CHAT_PROVIDER=claude (real-chat-env.ts). Moss shows a one-time Claude link; a
// person approves it in a browser and gets back a code, which Moss feeds to `claude setup-token`.
// The run cannot click that link itself, so the link and the code pass through two private files:
//
//   <dir>/<project>.link  written by the run (0600) for the operator to open
//   <dir>/<project>.code  written by the operator; the run reads it once and deletes it
//
// <dir> is ~/.cache/moss-uat-claude-signin unless JARVIS_UAT_CLAUDE_SIGNIN_DIR is set. The code
// is sign-in material: it is never logged, and it reaches Moss only as the submit-token body.
// Claude mode requires MOSS_UAT_CAPTURE_OFF=1 (real-chat-env.ts), so no trace records that body.
// A plain module, not a spec, so its unit test can import it without registering Playwright tests.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SIGNIN_DIR_ENV = "JARVIS_UAT_CLAUDE_SIGNIN_DIR";
const SIGNIN_WAIT_ENV = "JARVIS_UAT_CLAUDE_SIGNIN_WAIT_MS";

/** Claude's sign-in link lasts 10 minutes, so waiting longer for its code only fails later. */
export const DEFAULT_CLAUDE_SIGNIN_WAIT_MS = 10 * 60_000;
const LINK_DEADLINE_MS = 60_000;
const READY_DEADLINE_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

export interface ClaudeSignInPaths {
  readonly linkFile: string;
  readonly codeFile: string;
}

export function claudeSignInPaths(projectName: string): ClaudeSignInPaths {
  const dir = process.env[SIGNIN_DIR_ENV] ?? join(homedir(), ".cache", "moss-uat-claude-signin");
  return { linkFile: join(dir, `${projectName}.link`), codeFile: join(dir, `${projectName}.code`) };
}

export function claudeSignInWaitMs(): number {
  const raw = Number(process.env[SIGNIN_WAIT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLAUDE_SIGNIN_WAIT_MS;
}

/** The Moss onboarding calls this flow makes, as plain JSON in and out. */
export interface ClaudeSignInApi {
  readonly post: (path: string, data: Record<string, string>) => Promise<unknown>;
}

interface LoginResponse {
  readonly loginId?: string;
  readonly status?: string;
  readonly authorizationUrl?: string;
  readonly message?: string;
}

export interface ClaudeSignInOptions {
  readonly paths: ClaudeSignInPaths;
  readonly codeWaitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const PROVIDER_KIND = "anthropic";

function publishLink(paths: ClaudeSignInPaths, url: string): void {
  const dir = join(paths.linkFile, "..");
  // Lock down only a folder this run made; an existing one keeps its owner's choice.
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dir, 0o700);
  rmSync(paths.codeFile, { force: true });
  writeFileSync(paths.linkFile, `${url}\n`, { mode: 0o600 });
}

function takeCode(paths: ClaudeSignInPaths): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(paths.codeFile, "utf8");
  } catch {
    return undefined;
  }
  // An empty file may be an editor's first write; leave it for the operator to finish.
  const code = raw.trim();
  if (code.length === 0) return undefined;
  rmSync(paths.codeFile, { force: true });
  return code;
}

function failure(step: string, response: LoginResponse): Error {
  return new Error(
    `[uat real-chat] Claude sign-in ${step} ended "${response.status ?? "unknown"}"` +
      (response.message ? `: ${response.message}` : "")
  );
}

/**
 * Begins Moss's Claude sign-in, publishes the link, waits for the operator's code, submits it,
 * and returns once Moss reports the provider ready. Throws on an error status or any deadline;
 * cancels the half-finished login and removes both handoff files either way.
 */
export async function signInClaudeThroughMoss(
  api: ClaudeSignInApi,
  options: ClaudeSignInOptions
): Promise<void> {
  const now = options.now ?? Date.now;
  const log = options.log ?? console.log;
  const poll = async (loginId: string): Promise<LoginResponse> =>
    (await api.post("/api/onboarding/provider-login/poll", {
      providerKind: PROVIDER_KIND,
      loginId
    })) as LoginResponse;

  let login = (await api.post("/api/onboarding/provider-login/begin", {
    providerKind: PROVIDER_KIND
  })) as LoginResponse;
  if (login.status === "ready") return;
  const loginId = login.loginId;
  if (!loginId) throw failure("begin", login);

  let settled = false;
  try {
    const linkDeadline = now() + LINK_DEADLINE_MS;
    while (!login.authorizationUrl) {
      if (login.status === "error") throw failure("begin", login);
      if (now() >= linkDeadline) throw new Error("[uat real-chat] Moss showed no Claude link");
      await options.sleep(POLL_INTERVAL_MS);
      login = await poll(loginId);
    }
    publishLink(options.paths, login.authorizationUrl);
    log(
      `[uat real-chat] Claude sign-in link waiting in ${options.paths.linkFile}; ` +
        `write the code from the approval page to ${options.paths.codeFile}`
    );

    const codeDeadline = now() + options.codeWaitMs;
    let code = takeCode(options.paths);
    while (code === undefined) {
      if (now() >= codeDeadline) {
        throw new Error(
          `[uat real-chat] no Claude sign-in code within ${options.codeWaitMs}ms; ` +
            "the link has expired, rerun to get a fresh one"
        );
      }
      await options.sleep(POLL_INTERVAL_MS);
      code = takeCode(options.paths);
    }

    login = (await api.post("/api/onboarding/provider-login/submit-token", {
      providerKind: PROVIDER_KIND,
      loginId,
      token: code
    })) as LoginResponse;
    const readyDeadline = now() + READY_DEADLINE_MS;
    while (login.status !== "ready") {
      if (login.status === "error") throw failure("submit", login);
      if (now() >= readyDeadline) throw failure("submit", login);
      await options.sleep(POLL_INTERVAL_MS);
      login = await poll(loginId);
    }
    settled = true;
    log("[uat real-chat] Claude sign-in is ready");
  } finally {
    rmSync(options.paths.linkFile, { force: true });
    rmSync(options.paths.codeFile, { force: true });
    if (!settled) {
      await api
        .post("/api/onboarding/provider-login/cancel", { providerKind: PROVIDER_KIND, loginId })
        .catch(() => undefined);
    }
  }
}
