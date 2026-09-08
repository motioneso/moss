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
 * Claude goes through the full product path (readiness gate included). OpenCode
 * is not API-ready until task 5 proves its switch-off, so its leg drives the
 * same runner spawn plus the protocol directly and says so: it proves the
 * install-step fix (the pinned binary spawns and answers), not readiness.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { RpcConnection } from "@moss/chat/live";
import { resolveMossEnv } from "@moss/db";

import {
  ClientSideConnection,
  MossAcpClient,
  acceptedOptionValues,
  createTunnelStream,
  findModelOption,
  type AcpTunnel
} from "@moss/acp";
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
        .then(({ cwd, home, pid }) => ({ cwd, home, pid })),
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
 * 2026-09-08) was actually closed. Fails the check if either capability set
 * is non-zero: a real leak, not just a mismatched account.
 */
async function reportActualIdentity(
  label: string,
  home: string | null,
  pid: number | null
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
      `(uid=${identity.uid}, gid=${identity.gid}) CapInh=${identity.inheritableCaps} ` +
      `CapAmb=${identity.ambientCaps} CapEff=${identity.effectiveCaps}`
  );
  if (
    identity.ambientCaps !== "0000000000000000" ||
    identity.inheritableCaps !== "0000000000000000"
  ) {
    throw new Error(
      `${label}: the spawned agent still carries inheritable/ambient capabilities ` +
        `(CapInh=${identity.inheritableCaps} CapAmb=${identity.ambientCaps}) — the privilege drop failed`
    );
  }
}

/** Full product path: readiness gate, runner spawn, protocol, one prompt. */
async function claudeLeg(
  tunnel: AcpTunnel,
  providerKind: AcpProviderKind,
  userId: string,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  const client = new MossAcpClient(tunnel);
  const sessionKey = `acp-handshake-${process.pid}`;
  console.log(
    `[handshake] openSession kind=${providerKind} profile=chat user=${userId} (no tool server)`
  );
  const handle = await client.openSession(sessionKey, "handshake", providerKind, userId, "chat");
  console.log(`[handshake] session open id=${handle.sessionId} cwd=${handle.cwd}`);
  await reportActualIdentity("claude leg", handle.home, handle.pid);
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

/**
 * Runner-plus-protocol leg for a provider behind the readiness gate: same
 * spawn, `initialize`, `session/new`, one prompt, text collected from session
 * updates. Used for OpenCode until task 5 proves its switch-off.
 */
async function directLeg(
  tunnel: AcpTunnel,
  providerKind: AcpProviderKind,
  userId: string,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  const sessionKey = `acp-handshake-${process.pid}`;
  console.log(`[handshake] direct leg kind=${providerKind}: runner spawn plus protocol only`);
  const { cwd, home, pid } = await tunnel.spawn(
    sessionKey,
    "handshake",
    providerKind,
    userId,
    "chat"
  );
  await reportActualIdentity("direct leg", home, pid);
  const stream = createTunnelStream(tunnel, sessionKey);
  let text = "";
  let toolCallsSeen = 0;
  const connection = new ClientSideConnection(
    () => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async (params) => {
        const update = params.update as { sessionUpdate?: string; content?: unknown };
        if (update.sessionUpdate === "agent_message_chunk") {
          const content = update.content as { type?: unknown; text?: string } | undefined;
          if (content?.type === "text") text += content.text ?? "";
        }
        if (update.sessionUpdate === "tool_call") toolCallsSeen += 1;
      }
    }),
    stream
  );
  const init = await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "moss-handshake", version: "0.1.0" }
  });
  console.log(`[handshake] initialize ok protocolVersion=${init.protocolVersion}`);
  const session = await connection.newSession({ cwd, mcpServers: [] });
  console.log(`[handshake] session/new ok id=${session.sessionId}`);
  // Mirror what the chat engine will do in task 7: resolve the model through
  // the advertised option before prompting, since an ACP session starts with
  // no usable default. Prefer the free tier, else the first offered value.
  const modelOption = findModelOption(session.configOptions ?? []);
  if (modelOption) {
    const accepted = acceptedOptionValues(modelOption);
    const offered = accepted ? [...accepted].slice(0, 10) : null;
    console.log(`[handshake] model option id=${modelOption.id} offered=${JSON.stringify(offered)}`);
    const pick =
      (accepted ? [...accepted].find((value) => /spark/i.test(value)) : undefined) ??
      (accepted ? [...accepted][0] : "default");
    if (pick && pick !== "default") {
      await connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: modelOption.id,
        value: pick
      });
      console.log(`[handshake] model set to ${pick}`);
    } else {
      console.log("[handshake] model option takes free-form values; keeping session default");
    }
  } else {
    console.log("[handshake] no model option advertised; keeping session default");
  }
  const response = await Promise.race([
    connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: PROMPT_TEXT }]
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`prompt timed out after ${timeoutMs} ms`)), timeoutMs);
    })
  ]);
  console.log(
    `[handshake] prompt done stopReason=${response.stopReason} toolCallsSeen=${toolCallsSeen} text=${JSON.stringify(text.slice(0, 200))}`
  );
  if (text.trim() !== "hello") {
    throw new Error(`prompt reply was not exactly "hello"`);
  }
  await tunnel.kill(sessionKey);
  console.log(`[handshake] killed after ${Date.now() - started} ms`);
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
    if (providerKind === "opencode") {
      console.log("[handshake] opencode is not API-ready until task 5; proving runner spawn only");
      await directLeg(tunnel, providerKind, userId, timeoutMs - 5000);
    } else {
      await claudeLeg(tunnel, providerKind, userId, timeoutMs - 5000);
    }
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
