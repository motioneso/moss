import type { ProviderKind } from "@moss/ai";
import type { AcpToolServer } from "@moss/acp";

import { AcpChatEngine, RpcAcpTunnel } from "./acp-chat-engine.js";
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import { CliChatUnavailableError } from "./errors.js";
import { CLI_VERSION_TOO_OLD_MESSAGE, isCliVersionTooOldError } from "./cli-version-errors.js";
import type { CliChatEngine, EngineLaunchOpts } from "./types.js";

/**
 * #2689 slice 4: one throwaway turn for the version check. It drives an engine that is not tied
 * to any saved conversation, so nothing here reaches chat history, memory or the vault. The pass
 * signal is the tool call the program reports over the agent protocol. The model's words are
 * never read.
 */

export type CheckTurnFailure = "tool_call_missing" | "timeout" | "check_unavailable";

export type CheckTurnResult =
  | { readonly ok: true; readonly replyText: string }
  | { readonly ok: false; readonly reason: CheckTurnFailure };

export interface CheckTurnOptions {
  readonly engine: CliChatEngine;
  readonly launch: EngineLaunchOpts;
  readonly prompt: string;
  /** The tool the turn must call, matched against the end of the reported name. Omit for none. */
  readonly toolName?: string;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** The program shows "app.getMapSlice" as "mcp__jarvis__app_getMapSlice". */
const normalize = (name: string) => name.replace(/\./g, "_");

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runCheckTurn(options: CheckTurnOptions): Promise<CheckTurnResult> {
  const { engine, launch, prompt, toolName, timeoutMs } = options;
  const pollMs = options.pollMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let called = false;
  let replyText = "";
  try {
    await engine.launch(launch);
    await engine.submit(prompt);
    for (;;) {
      const batch = await engine.readNew(0);
      for (const record of batch.records) {
        if (
          toolName &&
          record.kind === "tool" &&
          normalize(record.toolName ?? "").endsWith(normalize(toolName))
        )
          called = true;
        if (record.kind === "reply") replyText += record.text;
      }
      if (batch.complete) break;
      if (now() >= deadline) {
        await engine.interrupt().catch(() => undefined);
        return { ok: false, reason: "timeout" };
      }
      await sleep(pollMs);
    }
    return called || !toolName
      ? { ok: true, replyText }
      : { ok: false, reason: "tool_call_missing" };
  } catch (error) {
    // A refusal for an old tool version is a real failure of the candidate; anything else
    // (no login, runner down) says nothing about the candidate.
    return {
      ok: false,
      reason:
        isCliVersionTooOldError(error) ||
        (error instanceof CliChatUnavailableError && error.message === CLI_VERSION_TOO_OLD_MESSAGE)
          ? "tool_call_missing"
          : "check_unavailable"
    };
  } finally {
    await engine.kill().catch(() => undefined);
  }
}

/** An engine for one throwaway check session that runs the staged candidate tools. */
export function createCandidateCheckEngine(opts: {
  readonly connection: RpcConnection;
  readonly provider: ProviderKind;
  readonly userId: string;
  readonly sessionKey: string;
  readonly toolServer?: AcpToolServer;
}): CliChatEngine {
  return new AcpChatEngine(opts.provider, opts.sessionKey, {
    tunnel: new RpcAcpTunnel(opts.connection, opts.sessionKey, { useCandidate: true }),
    userId: opts.userId,
    projectId: opts.sessionKey,
    ...(opts.toolServer ? { toolServer: opts.toolServer } : {})
  });
}
