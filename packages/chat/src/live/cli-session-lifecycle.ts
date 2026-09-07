import { join } from "node:path";

import { resolveTmuxSocketPath, type TmuxIo } from "@moss/ai";

export const SESSION_PREFIX = "jarv1s-live-";

/**
 * Every raw tmux verb here MUST target the same private `-S` socket that
 * `TmuxMultiplexer.open()` used for this `homeBase` (#1142) — otherwise these
 * list/kill helpers silently query the shared default server and never see (or
 * reap) sessions the multiplexer actually created.
 */
function socketArgs(homeBase: string | undefined): string[] {
  return ["-S", resolveTmuxSocketPath(homeBase)];
}

/** Kill only the exact canonical mux session, even when no engine object survives. */
export async function killMuxSessionByName(
  io: Pick<TmuxIo, "run">,
  sessionKey: string,
  homeBase?: string
): Promise<void> {
  const name = `${SESSION_PREFIX}${sanitizeSessionKey(sessionKey)}`;
  await io.run("tmux", [...socketArgs(homeBase), "kill-session", "-t", `=${name}`]);
}

/** Enumerate live canonical session keys from the multiplexer. */
export async function listLiveMuxSessions(
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
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .map((name) => name.slice(SESSION_PREFIX.length))
    .filter((key) => key.length > 0);
}

/** Remove one sanitized session's neutral directory. */
export async function removeNeutralDir(
  io: Pick<TmuxIo, "run">,
  neutralBase: string,
  sessionKey: string
): Promise<void> {
  await io.run("rm", ["-rf", deriveNeutralDir(neutralBase, sessionKey)]);
}

export function deriveNeutralDir(neutralBase: string, sessionKey: string): string {
  return join(neutralBase, sanitizeSessionKey(sessionKey));
}

export function sanitizeSessionKey(sessionKey: string): string {
  if (
    sessionKey.length === 0 ||
    sessionKey.includes("/") ||
    sessionKey.includes("\\") ||
    sessionKey.includes("\0") ||
    sessionKey === "." ||
    sessionKey === ".." ||
    sessionKey.includes("..") ||
    // The build deadline folder lives directly under the runner base, so a
    // session with this name would land where the startup clean-out never
    // wipes. Mirrors ACP_DEADLINE_DIR in packages/cli-runner/src/exec-records.ts.
    sessionKey === "acp-deadlines"
  ) {
    throw new Error("invalid sessionKey");
  }
  return sessionKey;
}
