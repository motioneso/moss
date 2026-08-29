import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiAssistantActionDto,
  ChatMessageDto,
  ChatSurface,
  ChatThreadDto
} from "@moss/shared";

import {
  listChatThreadMessages,
  listChatThreads,
  listPendingActionRequests
} from "../../apps/web/src/api/client.js";
import { listWorkflowApprovals } from "../../apps/web/src/api/workflows-client.js";
import {
  parseRecord,
  mergeWorkflowApprovalRecords,
  shouldEndPrivateChatOnStreamDisconnect,
  useChatStream
} from "../../apps/web/src/chat/use-chat-stream.js";

vi.mock("../../apps/web/src/api/client.js", () => ({
  chatStreamUrl: (surface?: string) => `/api/chat/stream${surface ? `?surface=${surface}` : ""}`,
  listChatThreadMessages: vi.fn(),
  listChatThreads: vi.fn(),
  listPendingActionRequests: vi.fn(async () => ({ actions: [] }))
}));

vi.mock("../../apps/web/src/api/workflows-client.js", () => ({
  listWorkflowApprovals: vi.fn(async () => [])
}));

afterEach(() => {
  vi.mocked(listChatThreadMessages).mockReset();
  vi.mocked(listChatThreads).mockReset();
  vi.mocked(listPendingActionRequests).mockReset();
  vi.mocked(listPendingActionRequests).mockResolvedValue({ actions: [] });
  vi.mocked(listWorkflowApprovals).mockReset();
  vi.mocked(listWorkflowApprovals).mockResolvedValue([]);
  vi.unstubAllGlobals();
});

function thread(id: string): ChatThreadDto {
  return {
    id,
    ownerUserId: "user-1",
    title: id,
    incognito: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function message(threadId: string, body: string): ChatMessageDto {
  return {
    id: `${threadId}-message`,
    threadId,
    ownerUserId: "user-1",
    role: "assistant",
    status: "stored",
    body,
    modelRoute: null,
    tools: [],
    activity: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function pendingAction(id: string, summaryText: string): AiAssistantActionDto {
  return {
    id,
    ownerUserId: "user-1",
    toolModuleId: "notes",
    toolModuleName: "Notes",
    toolName: "notes.write_note",
    permissionId: "perm-1",
    risk: "write",
    status: "pending",
    inputSummary: { text: summaryText },
    requestedAt: new Date(0).toISOString(),
    resolvedAt: null,
    updatedAt: new Date(0).toISOString()
  };
}

function StreamProbe(props: { surface: ChatSurface }) {
  const { records } = useChatStream(props.surface);
  return createElement("div", null, records.map((record) => record.text).join("|"));
}

describe("parseRecord", () => {
  it("parses a plain reply record", () => {
    expect(parseRecord(JSON.stringify({ kind: "reply", text: "Hello" }))).toMatchObject({
      kind: "reply",
      text: "Hello"
    });
  });

  it("parses an action_request record with all optional fields", () => {
    const data = JSON.stringify({
      kind: "action_request",
      text: "Approve or deny: Write 'x'",
      actionRequestId: "ar_42",
      toolName: "example.write",
      summary: "Write 'x'"
    });
    const record = parseRecord(data);
    expect(record?.kind).toBe("action_request");
    expect(record?.actionRequestId).toBe("ar_42");
    expect(record?.toolName).toBe("example.write");
    expect(record?.summary).toBe("Write 'x'");
  });

  it("parses an action_result record with outcome", () => {
    const data = JSON.stringify({
      kind: "action_result",
      text: "Executed: example.write",
      actionRequestId: "ar_42",
      toolName: "example.write",
      outcome: "executed"
    });
    const record = parseRecord(data);
    expect(record?.outcome).toBe("executed");
  });

  it("parses a structured module result on an action_result record", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "action_result",
        text: "Executed: demo-module.resume.critique",
        toolName: "demo-module.resume.critique",
        outcome: "executed",
        result: { status: "ok", revisionId: "review-1" }
      })
    );
    expect(record?.result).toEqual({ status: "ok", revisionId: "review-1" });
  });

  it("returns null for non-JSON", () => {
    expect(parseRecord("not-json")).toBeNull();
  });

  it("returns null for records with an unknown kind", () => {
    expect(parseRecord(JSON.stringify({ kind: "foreign_kind", text: "Hello" }))).toBeNull();
  });

  it("strips unknown outcome values", () => {
    const data = JSON.stringify({ kind: "action_result", text: "x", outcome: "unknown-value" });
    const record = parseRecord(data);
    expect(record?.outcome).toBeUndefined();
  });
});

describe("shouldEndPrivateChatOnStreamDisconnect", () => {
  it("marks an active private transcript ended when the SSE stream disconnects", () => {
    expect(
      shouldEndPrivateChatOnStreamDisconnect({
        privateMode: true,
        privateEnded: false,
        streamErrorCount: 1
      })
    ).toBe(true);
  });

  it("does not mark ordinary chats ended", () => {
    expect(
      shouldEndPrivateChatOnStreamDisconnect({
        privateMode: false,
        privateEnded: false,
        streamErrorCount: 1
      })
    ).toBe(false);
  });

  it("marks an empty private transcript ended after stream failure", () => {
    expect(
      shouldEndPrivateChatOnStreamDisconnect({
        privateMode: true,
        privateEnded: false,
        streamErrorCount: 1
      })
    ).toBe(true);
  });
});

describe("useChatStream", () => {
  it("keeps a resolved approval card when a refresh no longer returns it", () => {
    const resolved = {
      kind: "workflow_approval" as const,
      text: "Approve the seeded workflow action",
      workflowApprovalId: "approval-1",
      summary: "Approve the seeded workflow action",
      status: "approved" as const
    };

    expect(mergeWorkflowApprovalRecords([resolved], [])).toEqual([resolved]);
  });

  it("replaces the previous transcript when the surface changes", async () => {
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage = null;
        onerror = null;
        close() {}
      }
    );
    const firstSurface = "m-1111111111111111" as ChatSurface;
    const secondSurface = "m-2222222222222222" as ChatSurface;
    vi.mocked(listChatThreads).mockImplementation(async (surface) => ({
      threads: [thread(surface === firstSurface ? "thread-1" : "thread-2")]
    }));
    vi.mocked(listChatThreadMessages).mockImplementation(async (threadId) => ({
      messages: [
        message(threadId, threadId === "thread-1" ? "First transcript" : "Second transcript")
      ]
    }));
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(createElement(StreamProbe, { surface: firstSurface }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("First transcript");

    await act(async () => {
      renderer!.update(createElement(StreamProbe, { surface: secondSurface }));
      await Promise.resolve();
    });
    const switched = JSON.stringify(renderer!.toJSON());
    expect(switched).toContain("Second transcript");
    expect(switched).not.toContain("First transcript");
  });

  it("#1449 — re-hydrates a pending action-request card from listPendingActionRequests on mount", async () => {
    // The real regression seam: unlike app-shell-chat-surface.test.tsx (which mocks useChatStream
    // itself and only asserts the surface argument is defined), this exercises the actual hook
    // against a mocked client boundary. Deleting the listPendingActionRequests() call in
    // use-chat-stream.ts's rehydration effect would leave this mock uncalled and the card unrendered
    // — both assertions below would fail.
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage = null;
        onerror = null;
        close() {}
      }
    );
    const surface = "drawer" as ChatSurface;
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-1")] });
    vi.mocked(listChatThreadMessages).mockResolvedValue({ messages: [] });
    vi.mocked(listPendingActionRequests).mockResolvedValue({
      actions: [pendingAction("action-1", "Approve this note?")]
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(StreamProbe, { surface }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listPendingActionRequests).toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Approve this note?");
  });
});
