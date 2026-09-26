import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";

const request = {
  cwd: "/workspace/project",
  home: "/home/agent",
  sessionId: "agent-session",
  turnId: "turn-1",
  toolCallId: "call-1",
  title: "Run a command",
  toolName: "Bash",
  toolInput: { command: "echo private-command" }
};

function setup(active = true) {
  const yoloMode = vi.fn(async () => active);
  const createPendingAssistantAction = vi.fn(async () => ({ id: "action-1" }));
  const insertActionAuditLog = vi.fn(async () => undefined);
  const emit = vi.fn();
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [],
    repository: { createPendingAssistantAction, insertActionAuditLog } as never,
    runner: {
      withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) => work({})
    } as never,
    tokens,
    confirmations,
    notifier: { emit },
    confirmTimeoutMs: 10,
    yoloMode
  });
  const token = tokens.mint({
    actorUserId: "actor-1",
    chatSessionId: "chat-1",
    allowedToolNames: null
  });
  return { gateway, token, yoloMode, createPendingAssistantAction, insertActionAuditLog, emit };
}

describe("ACP effective actor YOLO permission", () => {
  it("auto-allows ASK with a YOLO audit and no human approval event", async () => {
    const state = setup();
    await expect(state.gateway.requestAcpBuiltInPermission(state.token, request)).resolves.toEqual({
      decision: "allow",
      reason: "Allowed by YOLO mode.",
      asked: false,
      holdDurationMs: null
    });
    expect(state.yoloMode).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "actor-1",
        chatSessionId: "chat-1",
        requestId: expect.any(String)
      })
    );
    expect(state.createPendingAssistantAction).not.toHaveBeenCalled();
    expect(state.emit).not.toHaveBeenCalled();
    expect(state.insertActionAuditLog).toHaveBeenCalledExactlyOnceWith(
      {},
      expect.objectContaining({
        ownerUserId: "actor-1",
        approvalMode: "yolo",
        outcome: "success",
        inputSummary: expect.objectContaining({
          agent: expect.objectContaining({ decision: "allowed" })
        })
      })
    );
    expect(JSON.stringify(state.insertActionAuditLog.mock.calls)).not.toContain("private-command");
  });

  it.each([
    { toolName: "Read", toolInput: { file_path: "/etc/hosts" } },
    { toolName: "Read", toolInput: { file_path: "/workspace/project/.env" } },
    { toolName: "Write", toolInput: { file_path: "/tmp/output.txt" } },
    { toolName: "WebFetch", toolInput: { url: "http://localhost:9999" } }
  ])("auto-allows eligible $toolName requests", async (eligible) => {
    const state = setup();
    await expect(
      state.gateway.requestAcpBuiltInPermission(state.token, { ...request, ...eligible })
    ).resolves.toMatchObject({ decision: "allow", asked: false });
    expect(state.yoloMode).toHaveBeenCalledTimes(1);
    expect(state.createPendingAssistantAction).not.toHaveBeenCalled();
  });

  it("resolves each request again so revocation restores the human card", async () => {
    const state = setup();
    await state.gateway.requestAcpBuiltInPermission(state.token, request);
    state.yoloMode.mockResolvedValue(false);
    await expect(
      state.gateway.requestAcpBuiltInPermission(state.token, request)
    ).resolves.toMatchObject({
      decision: "deny",
      asked: true
    });
    expect(state.yoloMode).toHaveBeenCalledTimes(2);
    expect(state.createPendingAssistantAction).toHaveBeenCalledTimes(1);
    expect(state.emit).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ kind: "action_request" })
    );
  });

  it("keeps YOLO off requests on the human approval path", async () => {
    const state = setup(false);
    await expect(
      state.gateway.requestAcpBuiltInPermission(state.token, request)
    ).resolves.toMatchObject({ decision: "deny", asked: true });
    expect(state.createPendingAssistantAction).toHaveBeenCalledTimes(1);
    expect(state.insertActionAuditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ approvalMode: "timeout" })
    );
  });

  it.each([
    { toolName: "unknown", toolInput: {} },
    { toolName: "Task", toolInput: {} },
    { toolName: "Read", toolInput: { file_path: "/proc/self/environ" } },
    { toolName: "Read", toolInput: { file_path: "/home/agent/auth.json" } },
    { toolName: "Read", toolInput: {} }
  ])("preserves hard denial for $toolName $toolInput", async (denied) => {
    const state = setup();
    await expect(
      state.gateway.requestAcpBuiltInPermission(state.token, { ...request, ...denied })
    ).resolves.toMatchObject({ decision: "deny", asked: false });
    expect(state.yoloMode).not.toHaveBeenCalled();
    expect(state.createPendingAssistantAction).not.toHaveBeenCalled();
    expect(state.insertActionAuditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ approvalMode: "auto", outcome: "failed" })
    );
    expect(state.emit).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ decidedBy: "policy" })
    );
  });

  it("keeps existing automatic policy allowances unchanged", async () => {
    const state = setup();
    await expect(
      state.gateway.requestAcpBuiltInPermission(state.token, {
        ...request,
        toolName: "Read",
        toolInput: { file_path: "/workspace/project/file.txt" }
      })
    ).resolves.toMatchObject({ decision: "allow", reason: "Allowed by policy.", asked: false });
    expect(state.yoloMode).not.toHaveBeenCalled();
    expect(state.insertActionAuditLog).not.toHaveBeenCalled();
  });
});
