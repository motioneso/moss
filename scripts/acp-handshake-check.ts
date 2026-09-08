/**
 * Slice 1 task 4 — first kill gate: one check script that asks the runner to
 * spawn a provider's agent for the signed-in user, runs `initialize`,
 * `session/new`, one `session/prompt` with no tools, and exits non-zero on any
 * failure or after 60 s.
 *
 * Usage: pnpm tsx scripts/acp-handshake-check.ts --provider=anthropic [--timeout-ms=60000]
 *
 * Claude goes through the full product path (readiness gate included). OpenCode
 * is not API-ready until task 5 proves its switch-off, so its leg drives the
 * same runner spawn plus the protocol directly and says so: it proves the
 * install-step fix (the pinned binary spawns and answers), not readiness.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientSideConnection,
  MossAcpClient,
  acceptedOptionValues,
  createTunnelStream,
  findModelOption,
  type AcpTunnel
} from "@moss/acp";
import type { AcpProviderKind } from "@moss/acp";

import { AcpHost } from "../packages/cli-runner/src/acp-host.js";

const PROMPT_TEXT = "reply with exactly: hello";

function usageError(message: string): never {
  console.error(`[handshake] usage error: ${message}`);
  console.error(
    "[handshake] usage: pnpm tsx scripts/acp-handshake-check.ts --provider=anthropic|openai|opencode [--timeout-ms=60000]"
  );
  process.exit(2);
}

function parseArgs(): { providerKind: AcpProviderKind; timeoutMs: number; homeBase: string } {
  const providerArg = process.argv.find((arg) => arg.startsWith("--provider="));
  if (!providerArg) usageError("missing --provider=");
  const providerKind = providerArg.slice("--provider=".length) as AcpProviderKind;
  if (providerKind !== "anthropic" && providerKind !== "openai" && providerKind !== "opencode") {
    usageError(`unsupported provider: ${providerKind}`);
  }
  const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
  const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout-ms=".length)) : 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) usageError("bad --timeout-ms=");
  // The runner's per-user home base holds the login store the host reads; it is
  // not $HOME. Defaults to $HOME only for a box without a runner layout.
  const homeArg = process.argv.find((arg) => arg.startsWith("--home-base="));
  const homeBase = homeArg ? homeArg.slice("--home-base=".length) : (process.env.HOME ?? "");
  if (!homeBase) usageError("bad --home-base=");
  return { providerKind, timeoutMs, homeBase };
}

function loopbackTunnel(host: AcpHost): AcpTunnel {
  return {
    spawn: (sessionKey, projectId, providerKind) =>
      host.spawn(sessionKey, projectId, providerKind).then(({ cwd, home }) => ({ cwd, home })),
    send: (sessionKey, line) => {
      host.send(sessionKey, line);
      return Promise.resolve();
    },
    read: (sessionKey, afterSeq) => Promise.resolve(host.read(sessionKey, afterSeq)),
    kill: (sessionKey) => {
      host.kill(sessionKey);
      return Promise.resolve();
    },
    execStart: (sessionKey, projectId, command, timeoutMs) =>
      host.execStart(sessionKey, projectId, command, timeoutMs).then(({ execId }) => ({ execId })),
    execPoll: (sessionKey, execId) => Promise.resolve(host.execPoll(sessionKey, execId)),
    execKill: (sessionKey, execId) => {
      host.execKill(sessionKey, execId);
      return Promise.resolve();
    }
  };
}

/** Full product path: readiness gate, runner spawn, protocol, one prompt. */
async function claudeLeg(
  tunnel: AcpTunnel,
  providerKind: AcpProviderKind,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  const client = new MossAcpClient(tunnel);
  const sessionKey = `acp-handshake-${process.pid}`;
  console.log(`[handshake] openSession kind=${providerKind} profile=chat (no tool server)`);
  const handle = await client.openSession(sessionKey, "handshake", providerKind, "chat");
  console.log(`[handshake] session open id=${handle.sessionId} cwd=${handle.cwd}`);
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
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  const sessionKey = `acp-handshake-${process.pid}`;
  console.log(`[handshake] direct leg kind=${providerKind}: runner spawn plus protocol only`);
  const { cwd } = await tunnel.spawn(sessionKey, "handshake", providerKind);
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
  const { providerKind, timeoutMs, homeBase } = parseArgs();
  const wall = setTimeout(() => {
    console.error(`[handshake] FAIL: wall deadline ${timeoutMs} ms exceeded`);
    process.exit(1);
  }, timeoutMs);
  try {
    const neutralBase = mkdtempSync(join(tmpdir(), "acp-handshake-"));
    const host = new AcpHost({ neutralBase, homeBase });
    const tunnel = loopbackTunnel(host);
    if (providerKind === "opencode") {
      console.log("[handshake] opencode is not API-ready until task 5; proving runner spawn only");
      await directLeg(tunnel, providerKind, timeoutMs - 5000);
    } else {
      await claudeLeg(tunnel, providerKind, timeoutMs - 5000);
    }
    console.log(`[handshake] PASS kind=${providerKind}`);
    clearTimeout(wall);
    process.exit(0);
  } catch (error) {
    console.error(
      `[handshake] FAIL kind=${providerKind}: ${error instanceof Error ? error.message : String(error)}`
    );
    clearTimeout(wall);
    process.exit(1);
  }
}

void main();
