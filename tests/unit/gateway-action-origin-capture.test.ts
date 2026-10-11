import { describe, expect, it } from "vitest";
import {
  admissionFixture,
  admissionTool,
  rejectAdmissionCard
} from "./helpers/gateway-admission-fixture.js";

describe("pending request origins are captured from the verified session", () => {
  it.each(["", " \n ", undefined])("cannot approve an undisclosed action (%s)", async (summary) => {
    const tool = admissionTool("notes.edit", {
      risk: "destructive",
      actionLabel: undefined,
      approvalPresentation: undefined,
      summarize: () => summary as string
    });
    const h = admissionFixture([tool]);
    expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({
      ok: false,
      denied: true,
      reason: expect.stringContaining("approval_unavailable")
    });
    expect(h.records).toEqual([]);
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.confirmations.isAwaiting("action-1")).toBe(false);
    expect(h.gateway.getActionRequestPresentation("actor-a", "action-1")).toBeUndefined();
    expect(tool.execute).not.toHaveBeenCalled();
  });
  it.each(["module", "native", "acp"] as const)(
    "ignores model origin fields for %s",
    async (path) => {
      const tool = admissionTool("notes.edit", {
        risk: "destructive",
        summarize: () => "Edit note",
        inputSchema: {
          type: "object",
          properties: { chatThreadId: { type: "string" }, chatSessionId: { type: "string" } }
        }
      });
      const h = admissionFixture([tool], { deps: { yoloMode: async () => false } });
      const createPending = h.deps.repository.createPendingAssistantAction;
      h.deps.repository.createPendingAssistantAction = async (db, input) => ({
        ...(await createPending(db, input)),
        owner_user_id: "actor-a",
        chat_thread_id: input.chatThreadId ?? null,
        chat_session_id: input.chatSessionId ?? null
      });
      const spoofed = { chatThreadId: "conversation-b", chatSessionId: "other-owner:drawer" };
      const pending =
        path === "module"
          ? h.gateway.callTool(h.token, tool.name, spoofed)
          : path === "native"
            ? h.gateway.requestNativeToolPermission(h.token, {
                toolName: "Bash",
                toolInput: { ...spoofed, command: "echo hello" }
              })
            : h.gateway.requestAcpBuiltInPermission(h.token, {
                cwd: "/workspace/project",
                home: null,
                sessionId: "session-1",
                turnId: "turn-1",
                toolCallId: "call-1",
                title: "Move this action to conversation B",
                toolName: "Bash",
                toolInput: { ...spoofed, command: "echo hello" }
              });
      await rejectAdmissionCard(h, pending);
      expect(h.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          chatThreadId: "thread-a",
          chatSessionId: "actor-a:chat",
          expiresAt: expect.any(Date)
        })
      );
      expect(h.records[0]).toMatchObject({
        kind: "action_request",
        originThreadId: "thread-a",
        liveOrigin: { actorUserId: "actor-a", chatSessionId: "actor-a:chat", threadId: "thread-a" }
      });
      expect(h.records[1]).toMatchObject({ kind: "action_result", originThreadId: "thread-a" });
    }
  );
});
