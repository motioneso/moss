/**
 * Login MUX-session helpers (login-contract §L.6.1). Extracted from module-build-cli-engine.ts so that
 * file stays under the 1000-line maintainability cap; this is the cohesive cluster of helpers that
 * operate on `jarv1s-login-*` tmux sessions (the disk liveness signal the unified admission gate,
 * the startup sweep, and the v0.1.3 max-age reaper consume). They depend only on the shared
 * `TmuxIo` run seam — no engine state — so they live cleanly on their own. module-build-cli-engine.ts
 * re-exports them, so every existing import site is unchanged.
 */
import { resolveTmuxSocketPath, type TmuxIo } from "@moss/ai";

/**
 * Every raw tmux verb here MUST target the same private `-S` socket that
 * `TmuxMultiplexer.open()` used for this `homeBase` (#1142) — otherwise these
 * list/kill helpers silently query the shared default server and never see (or
 * reap) sessions the multiplexer actually created.
 */
function socketArgs(homeBase: string | undefined): string[] {
  return ["-S", resolveTmuxSocketPath(homeBase)];
}

/**
 * Session name prefix for Jarv1s LOGIN sessions (login-contract §L.6.1). DISTINCT from the chat
 * `SESSION_PREFIX` so login sessions are invisible to the chat `listLiveMuxSessions` enumeration /
 * §5 reconciliation (a login is not a chat session — it has no MCP token to reconcile), and the
 * chat helpers never touch a login session. The login canonical name is `jarv1s-login-<provider>`
 * (the provider is a fixed enum literal — no traversal risk).
 */
export const LOGIN_SESSION_PREFIX = "jarv1s-login-";

/**
 * login-contract §L.6.1: kill a live `jarv1s-login-<provider>` mux session BY CANONICAL NAME, even
 * when the login service holds no in-memory reservation for it (post-restart / late-success
 * orphan). Uses the SAME leading-`=` exact-name guard as `killMuxSessionByName` (so a kill can
 * never prefix-over-reach) but the LOGIN prefix — do NOT reuse `killMuxSessionByName`, which is
 * hardwired to `SESSION_PREFIX` and would target `=jarv1s-live-<provider>`. `provider` is a fixed
 * enum literal (no traversal risk). Idempotent — killing an absent session is not an error.
 */
export async function killLoginMuxSession(
  io: Pick<TmuxIo, "run">,
  provider: string,
  homeBase?: string
): Promise<void> {
  const name = `${LOGIN_SESSION_PREFIX}${provider}`;
  await io.run("tmux", [...socketArgs(homeBase), "kill-session", "-t", `=${name}`]);
}

/**
 * login-contract §L.6.1: enumerate the providers of every LIVE `jarv1s-login-*` mux session via
 * tmux `list-sessions` — the disk liveness signal the unified admission gate (§L.6.1) and the
 * startup sweep (§L.3.4) consume (the in-memory login reservation is not the sole source of truth,
 * per the base D13/D14 lesson). Strips the LOGIN prefix to recover each provider. Tolerates "no
 * server running" (nonzero exit → empty list).
 */
export async function listLoginMuxSessions(
  io: Pick<TmuxIo, "run">,
  homeBase?: string
): Promise<string[]> {
  const listed = await io.run("tmux", [
    ...socketArgs(homeBase),
    "list-sessions",
    "-F",
    "#{session_name}"
  ]);
  if (listed.code !== 0) return [];
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith(LOGIN_SESSION_PREFIX))
    .map((name) => name.slice(LOGIN_SESSION_PREFIX.length))
    .filter((p) => p.length > 0);
}

/** A live `jarv1s-login-*` mux session with its age (now − tmux `session_created`). */
export interface LoginMuxSessionAge {
  readonly provider: string;
  readonly ageMs: number;
}

/**
 * v0.1.3 (max-age reaper): enumerate live `jarv1s-login-*` mux sessions WITH their age, derived
 * from tmux `#{session_created}` (epoch SECONDS). Used by the LoginService max-age reaper to
 * release the §L.6.1 single-active gate from a login that hung/was abandoned past its lifetime
 * (a disk session a failed kill stranded would otherwise keep `isLoginActive()` true until the
 * next restart). Tolerates "no server running" (nonzero exit → empty list) and a malformed
 * created field (skips that row). `nowMs` is injectable for deterministic tests.
 */
export async function listLoginMuxSessionsWithAge(
  io: Pick<TmuxIo, "run">,
  nowMs: number = Date.now(),
  homeBase?: string
): Promise<LoginMuxSessionAge[]> {
  const listed = await io.run("tmux", [
    ...socketArgs(homeBase),
    "list-sessions",
    "-F",
    "#{session_name} #{session_created}"
  ]);
  if (listed.code !== 0) return [];
  const out: LoginMuxSessionAge[] = [];
  for (const line of listed.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(LOGIN_SESSION_PREFIX)) continue;
    const sep = trimmed.lastIndexOf(" ");
    if (sep <= 0) continue;
    const name = trimmed.slice(0, sep);
    const createdSec = Number(trimmed.slice(sep + 1).trim());
    if (!Number.isFinite(createdSec)) continue;
    const provider = name.slice(LOGIN_SESSION_PREFIX.length);
    if (!provider) continue;
    out.push({ provider, ageMs: nowMs - createdSec * 1000 });
  }
  return out;
}
