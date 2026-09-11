/**
 * Slice 1 task 4 — first kill gate: one check script that connects to the REAL,
 * already-running cli-runner over its socket (the same way the app does), asks
 * it to spawn a provider's agent for the signed-in user, runs `initialize`,
 * `session/new`, one `session/prompt` with no tools, and exits non-zero on any
 * failure or after 60 s. Task 5b (#2427): this script builds no launcher of its
 * own — it is a client of the one already listening on `JARVIS_CLI_RUNNER_SOCKET`,
 * proving the real per-user account handover rather than an in-process stand-in.
 *
 * Usage:
 *   JARVIS_CLI_RUNNER_SOCKET=/run/jarv1s/cli-runner.sock \
 *   JARVIS_CLI_RUNNER_RPC_SECRET=... \
 *   pnpm tsx scripts/acp-handshake-check.ts --provider=anthropic --user-id=<real Moss user id> [--timeout-ms=60000]
 *
 * --user-id= is required and must be a real Moss user id — never inferred from
 * the OS/operator's account (task 5b, Astra-Reviewer finding 5b, 2026-09-08).
 * Identity evidence comes from reading /proc/<pid>/status for the spawned
 * agent's own child pid, not from stat()-ing the home folder it was handed.
 *
 * Claude and OpenCode go through the full product path, including the
 * readiness gate. The live proof separately verifies OpenCode's deny settings
 * in its per-user home and remains a merge gate rather than a readiness flag.
 */

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

import { RpcConnection } from "@moss/chat/live";
import { resolveMossEnv } from "@moss/db";

import { MossAcpClient, type AcpTunnel } from "@moss/acp";
import type { AcpProviderKind } from "@moss/acp";

const PROMPT_TEXT = "reply with exactly: hello";

function usageError(message: string): never {
  console.error(`[handshake] usage error: ${message}`);
  console.error(
    "[handshake] usage: pnpm tsx scripts/acp-handshake-check.ts --provider=anthropic|openai|opencode --user-id=<real Moss user id> [--timeout-ms=60000]"
  );
  process.exit(2);
}

function parseArgs(): { providerKind: AcpProviderKind; userId: string; timeoutMs: number } {
  const providerArg = process.argv.find((arg) => arg.startsWith("--provider="));
  if (!providerArg) usageError("missing --provider=");
  const providerKind = providerArg.slice("--provider=".length) as AcpProviderKind;
  if (providerKind !== "anthropic" && providerKind !== "openai" && providerKind !== "opencode") {
    usageError(`unsupported provider: ${providerKind}`);
  }
  // Never inferred from the OS/operator's username (task 5b, Astra-Reviewer
  // finding 5b, 2026-09-08): the OS account running this script is not a Moss
  // person, and slots belong to people, so the check must be told which real
  // user id to spawn as.
  const userIdArg = process.argv.find((arg) => arg.startsWith("--user-id="));
  if (!userIdArg) usageError("missing --user-id= (a real Moss user id, not the OS account)");
  const userId = userIdArg.slice("--user-id=".length);
  if (userId.length === 0) usageError("--user-id= must not be empty");
  const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
  const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout-ms=".length)) : 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) usageError("bad --timeout-ms=");
  return { providerKind, userId, timeoutMs };
}

/** Same two env vars the app reads to reach the cli-runner (carve-out names, see resolveMossEnv). */
function readRunnerConnectionEnv(): { socketPath: string; rpcSecret: string } {
  const socketPath = resolveMossEnv(process.env, "JARVIS_CLI_RUNNER_SOCKET");
  const rpcSecret = resolveMossEnv(process.env, "JARVIS_CLI_RUNNER_RPC_SECRET");
  if (!socketPath) {
    usageError(
      "JARVIS_CLI_RUNNER_SOCKET is not set — this check talks to a running cli-runner, it does not start one"
    );
  }
  if (!rpcSecret) {
    usageError(
      "JARVIS_CLI_RUNNER_RPC_SECRET is not set — the running cli-runner will refuse an unauthenticated connection"
    );
  }
  return { socketPath, rpcSecret };
}

/**
 * The launcher's own account, read from the socket file it owns — the real
 * running process's kernel-recorded owner, not a name this script infers or
 * is told (task 5b, Astra-Reviewer round-four finding, 2026-09-08).
 */
async function launcherUidFromSocket(socketPath: string): Promise<number> {
  const info = await stat(socketPath);
  return info.uid;
}

/**
 * Backs `AcpTunnel` with the real socket connection to the already-running
 * cli-runner, exactly the wiring `packages/acp/src/tunnel.ts` anticipates for
 * production use. No launcher is constructed here; every call crosses the
 * socket to the process that owns the account switch.
 */
function rpcTunnel(conn: RpcConnection): AcpTunnel {
  return {
    spawn: (sessionKey, projectId, providerKind, userId, profile) =>
      conn
        .acpSpawn(sessionKey, { projectId, providerKind, userId, profile })
        .then(({ cwd, home, pid, uid, gid }) => ({ cwd, home, pid, uid, gid })),
    send: (sessionKey, line) => conn.acpSend(sessionKey, { line }).then(() => undefined),
    read: (sessionKey, afterSeq) => conn.acpRead(sessionKey, { afterSeq }),
    kill: (sessionKey) => conn.acpKill(sessionKey).then(() => undefined),
    // Neither leg below runs a build; this check never needs the exec verbs, so
    // they are left unimplemented rather than adding client-side RPC methods
    // nothing here calls.
    execStart: () =>
      Promise.reject(new Error("acp-handshake-check: execStart is not used by this check")),
    execPoll: () =>
      Promise.reject(new Error("acp-handshake-check: execPoll is not used by this check")),
    execKill: () =>
      Promise.reject(new Error("acp-handshake-check: execKill is not used by this check"))
  };
}

/** Resolves an OS uid to an account name via `id -un`, or a labeled uid if the box has no entry for it. */
function accountNameForUid(uid: number): string {
  try {
    return execFileSync("id", ["-un", String(uid)], { encoding: "utf8" }).trim();
  } catch {
    return `uid ${uid} (no account entry on this box)`;
  }
}

interface ProcIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly permittedCaps: string;
  readonly inheritableCaps: string;
  readonly ambientCaps: string;
  readonly effectiveCaps: string;
}

function parseProcStatus(text: string): ProcIdentity {
  const line = (name: string): string => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text);
    if (!match) throw new Error(`/proc/<pid>/status has no ${name} line`);
    return match[1]!.trim();
  };
  return {
    uid: Number(line("Uid").split(/\s+/)[0]),
    gid: Number(line("Gid").split(/\s+/)[0]),
    permittedCaps: line("CapPrm"),
    inheritableCaps: line("CapInh"),
    ambientCaps: line("CapAmb"),
    effectiveCaps: line("CapEff")
  };
}

/**
 * Proves the identity and privilege state the agent actually runs with by
 * reading its own child pid's `/proc/<pid>/status` — never a folder-owner
 * `stat()`, which only shows what was asked for and says nothing about
 * whether the ambient-capability leak (task 5b, Astra-Reviewer finding 2,
 * 2026-09-08) was actually closed. Fails the check if the account is not
 * exactly the slot the runner spawned it as, or if any of the four
 * privilege sets (permitted, effective, inheritable, ambient) is non-zero —
 * checking only two of the four sets, or only that the account is not root,
 * passed a still-privileged process in Astra-Reviewer's finding 5,
 * 2026-09-08.
 */
async function reportActualIdentity(
  label: string,
  home: string | null,
  pid: number | null,
  expectedUid: number,
  expectedGid: number,
  launcherUid: number
): Promise<void> {
  if (pid === null) {
    throw new Error(
      `${label}: the runner returned no pid for the spawned agent, cannot prove its identity`
    );
  }
  const raw = await readFile(`/proc/${pid}/status`, "utf8");
  const identity = parseProcStatus(raw);
  const account = accountNameForUid(identity.uid);
  console.log(
    `[handshake] ${label}: pid=${pid} home=${home ?? "(none)"} account=${account} ` +
      `(uid=${identity.uid}, gid=${identity.gid}, expected uid=${expectedUid} gid=${expectedGid}, ` +
      `launcher uid=${launcherUid}) CapPrm=${identity.permittedCaps} CapEff=${identity.effectiveCaps} ` +
      `CapInh=${identity.inheritableCaps} CapAmb=${identity.ambientCaps}`
  );
  if (identity.uid !== expectedUid || identity.gid !== expectedGid) {
    throw new Error(
      `${label}: the spawned agent runs as uid=${identity.uid} gid=${identity.gid}, ` +
        `not the slot account it was spawned as (uid=${expectedUid} gid=${expectedGid})`
    );
  }
  // Equality with the expected uid/gid is not enough on its own: fixtures where
  // BOTH expected and actual are 0 (root) or both equal the launcher's own
  // account passed cleanly with zero capabilities (task 5b, Astra-Reviewer
  // round-four finding, 2026-09-08). The slot must be neither.
  if (identity.uid === 0) {
    throw new Error(`${label}: the spawned agent runs as root (uid=0), not a per-person slot`);
  }
  if (identity.uid === launcherUid) {
    throw new Error(
      `${label}: the spawned agent runs as the launcher's own account (uid=${launcherUid}), ` +
        `not a per-person slot`
    );
  }
  if (
    identity.permittedCaps !== "0000000000000000" ||
    identity.effectiveCaps !== "0000000000000000" ||
    identity.ambientCaps !== "0000000000000000" ||
    identity.inheritableCaps !== "0000000000000000"
  ) {
    throw new Error(
      `${label}: the spawned agent still carries privileges ` +
        `(CapPrm=${identity.permittedCaps} CapEff=${identity.effectiveCaps} ` +
        `CapInh=${identity.inheritableCaps} CapAmb=${identity.ambientCaps}) — the privilege drop failed`
    );
  }
}

/** Full product path: readiness gate, runner spawn, protocol, one prompt. */
async function standardLeg(
  tunnel: AcpTunnel,
  providerKind: AcpProviderKind,
  userId: string,
  timeoutMs: number,
  socketPath: string
): Promise<void> {
  const started = Date.now();
  const client = new MossAcpClient(tunnel);
  const sessionKey = `acp-handshake-${process.pid}`;
  console.log(
    `[handshake] openSession kind=${providerKind} profile=chat user=${userId} (no tool server)`
  );
  const handle = await client.openSession(sessionKey, "handshake", providerKind, userId, "chat");
  console.log(`[handshake] session open id=${handle.sessionId} cwd=${handle.cwd}`);
  const launcherUid = await launcherUidFromSocket(socketPath);
  await reportActualIdentity(
    `${providerKind} leg`,
    handle.home,
    handle.pid,
    handle.uid,
    handle.gid,
    launcherUid
  );
  const result = await client.prompt(handle, PROMPT_TEXT, { timeoutMs });
  console.log(
    `[handshake] prompt done stopReason=${result.stopReason} toolCallsSeen=${result.toolCallsSeen} text=${JSON.stringify(result.text.slice(0, 200))}`
  );
  if (result.text.trim() !== "hello") {
    throw new Error(`prompt reply was not exactly "hello"`);
  }
  await client.close(handle);
  console.log(`[handshake] closed after ${Date.now() - started} ms`);
}

async function main(): Promise<void> {
  const { providerKind, userId, timeoutMs } = parseArgs();
  const { socketPath, rpcSecret } = readRunnerConnectionEnv();
  const wall = setTimeout(() => {
    console.error(`[handshake] FAIL: wall deadline ${timeoutMs} ms exceeded`);
    process.exit(1);
  }, timeoutMs);
  console.log(`[handshake] connecting to the running cli-runner at ${socketPath}`);
  const conn = new RpcConnection({ socketPath, rpcSecret });
  try {
    await conn.ensureConnected();
    const tunnel = rpcTunnel(conn);
    await standardLeg(tunnel, providerKind, userId, timeoutMs - 5000, socketPath);
    console.log(`[handshake] PASS kind=${providerKind}`);
    clearTimeout(wall);
    conn.close();
    process.exit(0);
  } catch (error) {
    console.error(
      `[handshake] FAIL kind=${providerKind}: ${error instanceof Error ? error.message : String(error)}`
    );
    clearTimeout(wall);
    conn.close();
    process.exit(1);
  }
}

void main();
