import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { RecordRow } from "../../apps/web/src/chat/message-row.js";
import { parseRecord } from "../../apps/web/src/chat/use-chat-stream.js";
import { createChatGatewayNotifier } from "../../packages/chat/src/gateway-notifier.js";
import { DataContextRunner, type AiAssistantActionRequest } from "@moss/db";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
import type { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";

const declined =
  "The user declined this action, so it was not done. Do not try it again; acknowledge the user's decision.";
const timedOut =
  "Approval timed out, so this action was not done. Do not try it again; let the user know.";
const cancelled =
  "The approval request was cancelled, so this action was not done. Do not try it again; let the user know.";

describe.each(["module", "native", "acp"] as const)("%s approval outcomes", (path) => {
  it.each([
    {
      outcome: "rejected",
      reason: declined,
      decidedBy: "person",
      eventReason: "You declined this action."
    },
    {
      outcome: "timeout",
      reason: timedOut,
      decidedBy: "timeout",
      eventReason: "Action timed out."
    },
    {
      outcome: "cancelled",
      reason: cancelled,
      decidedBy: "cancelled",
      eventReason: "Action cancelled."
    }
  ] as const)("reports $outcome truthfully without executing or inviting a retry", async (test) => {
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const records: GatewaySessionRecord[] = [];
    const chatSessionId = surfaceSessionKey("u1");
    const { scoped } = makeRecordingDb();
    const runner = Object.create(DataContextRunner.prototype) as DataContextRunner;
    vi.spyOn(runner, "withDataContext").mockImplementation((_access, work) => work(scoped));
    const repository = new AiRepository();
    let action: AiAssistantActionRequest | undefined;
    vi.spyOn(repository, "createPendingAssistantAction").mockImplementation(async (_db, input) => {
      const now = new Date();
      action = {
        id: "42000000-0000-4000-8000-000000000001",
        owner_user_id: "u1",
        chat_thread_id: input.chatThreadId ?? null,
        chat_session_id: input.chatSessionId ?? null,
        expires_at: input.expiresAt ?? null,
        outcome_recorded_at: null,
        outcome_ignored_at: null,
        tool_module_id: input.toolModuleId,
        tool_module_name: input.toolModuleName,
        tool_name: input.toolName,
        permission_id: input.permissionId,
        risk: input.risk,
        status: "pending",
        input_summary: input.inputSummary,
        request_id: input.requestId ?? null,
        requested_at: now,
        resolved_at: null,
        updated_at: now
      };
      return action;
    });
    vi.spyOn(repository, "getAssistantAction").mockImplementation(async (_db, id) =>
      action?.id === id ? action : undefined
    );
    vi.spyOn(repository, "resolveAssistantAction").mockImplementation(async (_db, id, input) => {
      if (action?.id !== id || action.status !== "pending") return undefined;
      action = { ...action, status: input.status, resolved_at: new Date(), updated_at: new Date() };
      return action;
    });
    vi.spyOn(repository, "expireAssistantAction").mockImplementation(async (_db, id) => {
      if (
        action?.id !== id ||
        action.status !== "pending" ||
        !action.expires_at ||
        action.expires_at.getTime() > Date.now()
      )
        return undefined;
      action = { ...action, status: "timed_out", resolved_at: new Date(), updated_at: new Date() };
      return action;
    });
    vi.spyOn(repository, "insertActionAuditLog").mockResolvedValue(undefined);
    const execute = vi.fn(async () => ({ data: { deleted: true } }));
    const gateway = new AssistantToolGateway({
      provenance: {
        isTainted: async () => false,
        recordAdmission: async () => {},
        runAutomatic: async (_actor, _thread, callback) => ({
          kind: "ran",
          value: await callback()
        })
      },
      resolveActiveModules: async () => [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          publisher: "test",
          lifecycle: "optional",
          compatibility: { jarv1s: ">=0.0.0" },
          assistantTools: [
            {
              name: "example.delete",
              actionLabel: "Delete requested item",
              approvalContent: "user_authored",
              approvalPresentation: async () => ({ target: "Requested item", fields: [] }),
              description: "Delete the requested item.",
              permissionId: "example.delete",
              risk: "destructive",
              execute
            }
          ]
        }
      ],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (_session, record) => records.push(record) },
      confirmTimeoutMs: test.outcome === "timeout" ? 5 : 1000
    });
    const token = tokens.mint({
      actorUserId: "u1",
      chatSessionId,
      threadId: "clean-thread",
      allowedToolNames: null
    });
    const pending =
      path === "module"
        ? gateway.callTool(token, "example.delete", {})
        : path === "native"
          ? gateway.requestNativeToolPermission(token, {
              toolName: "Bash",
              toolInput: { command: "delete" }
            })
          : gateway.requestAcpBuiltInPermission(token, {
              cwd: "/runner/session/acp/project",
              home: "/home/agent",
              sessionId: "agent-session",
              turnId: "turn-1",
              toolCallId: "call-1",
              title: "Delete the requested item",
              toolName: "Bash",
              toolInput: { command: "delete" }
            });
    if (test.outcome !== "timeout") {
      await vi.waitFor(() => expect(records[0]).toMatchObject({ kind: "action_request" }));
      await gateway.resolveActionRequest(
        "u1",
        "42000000-0000-4000-8000-000000000001",
        test.outcome
      );
    }
    await expect(pending).resolves.toMatchObject(
      path === "module"
        ? { ok: false, denied: true, reason: test.reason }
        : { decision: "deny", reason: test.reason }
    );
    expect(execute).not.toHaveBeenCalled();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      kind: "action_result",
      outcome: "denied",
      decidedBy: test.decidedBy,
      reason: test.eventReason
    });
    // Person-facing copy follows the real notifier, stream parser and chat row; model-only
    // instructions belong solely to the tool reply asserted above.
    const injectOriginRecord = vi.fn(
      async (_actor: string, _thread: string, _record: TranscriptRecord) => ({
        historyPersisted: false
      })
    );
    const notifier = createChatGatewayNotifier(
      { injectOriginRecord } as unknown as ChatSessionManager,
      runner,
      repository
    );
    notifier.emit(chatSessionId, records[1]!);
    await notifier.flush(chatSessionId);
    expect(injectOriginRecord).toHaveBeenCalledOnce();
    expect(injectOriginRecord.mock.calls[0]?.slice(0, 2)).toEqual(["u1", action?.chat_thread_id]);
    const displayed = parseRecord(JSON.stringify(injectOriginRecord.mock.calls[0]?.[2]));
    expect(displayed?.text).toBe(`Not changed — ${test.eventReason}`);
    expect(displayed).not.toBeNull();
    const html = renderToString(createElement(RecordRow, { record: displayed! }));
    expect(html).toContain(
      test.outcome === "rejected"
        ? "You declined"
        : test.outcome === "timeout"
          ? "Timed out"
          : "Cancelled"
    );
    expect(html).not.toContain("Not changed");
    expect(html).not.toMatch(/The user declined|Do not try|let the user know|acknowledge/);
  });
});
