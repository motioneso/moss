import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { RecordRow } from "../../apps/web/src/chat/message-row.js";
import { parseRecord } from "../../apps/web/src/chat/use-chat-stream.js";
import { ChatGatewayNotifier } from "../../packages/chat/src/gateway-notifier.js";
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
              description: "Delete the requested item.",
              permissionId: "example.delete",
              risk: "destructive",
              execute
            }
          ]
        }
      ],
      repository: {
        createPendingAssistantAction: async () => ({ id: "approval-outcome" }),
        insertActionAuditLog: async () => {}
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_session, record) => records.push(record) },
      confirmTimeoutMs: test.outcome === "timeout" ? 5 : 1000
    });
    const token = tokens.mint({
      actorUserId: "u1",
      chatSessionId: "s1",
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
      expect(confirmations.resolve("approval-outcome", test.outcome)).toBe(true);
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
    const injectRecord = vi.fn((_actor: string, _record: TranscriptRecord) => {});
    new ChatGatewayNotifier({ injectRecord } as unknown as ChatSessionManager).emit(
      "u1",
      records[1]!
    );
    const displayed = parseRecord(JSON.stringify(injectRecord.mock.calls[0]?.[1]));
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
