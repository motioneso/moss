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
  listPendingActionRequests,
  resumeChat
} from "../../apps/web/src/api/client.js";
import { listWorkflowApprovals } from "../../apps/web/src/api/workflows-client.js";
import {
  parseRecord,
  mergeWorkflowApprovalRecords,
  shouldEndPrivateChatOnStreamDisconnect,
  streamRetryDelayMs,
  useChatStream
} from "../../apps/web/src/chat/use-chat-stream.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../apps/web/src/api/client.js", () => ({
  chatStreamUrl: (surface?: string) => `/api/chat/stream${surface ? `?surface=${surface}` : ""}`,
  getMe: vi.fn(async () => ({
    user: {
      id: "user-1",
      email: "owner@example.test",
      emailVerified: false,
      name: "Owner",
      isInstanceAdmin: false,
      status: "active",
      isBootstrapOwner: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  })),
  listChatThreadMessages: vi.fn(),
  listChatThreads: vi.fn(),
  listPendingActionRequests: vi.fn(async () => ({ actions: [] })),
  resumeChat: vi.fn()
}));

vi.mock("../../apps/web/src/api/workflows-client.js", () => ({
  listWorkflowApprovals: vi.fn(async () => [])
}));

afterEach(() => {
  vi.mocked(listChatThreadMessages).mockReset();
  vi.mocked(listChatThreads).mockReset();
  vi.mocked(listPendingActionRequests).mockReset();
  vi.mocked(listPendingActionRequests).mockResolvedValue({ actions: [] });
  vi.mocked(resumeChat).mockReset();
  vi.mocked(listWorkflowApprovals).mockReset();
  vi.mocked(listWorkflowApprovals).mockResolvedValue([]);
  vi.unstubAllGlobals();
});

function thread(id: string, isMain = false): ChatThreadDto {
  return {
    id,
    ownerUserId: "user-1",
    title: id,
    incognito: false,
    isMain,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastActiveAt: new Date(0).toISOString(),
    lastMessagePreview: null
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
      summary: "Write 'x'",
      outcomeTitle: "Write your note"
    });
    const record = parseRecord(data);
    expect(record?.kind).toBe("action_request");
    expect(record?.actionRequestId).toBe("ar_42");
    expect(record?.toolName).toBe("example.write");
    expect(record?.summary).toBe("Write 'x'");
    expect(record?.outcomeTitle).toBe("Write your note");
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
    });
    await vi.waitFor(() =>
      expect(JSON.stringify(renderer!.toJSON())).toContain("First transcript")
    );

    await act(async () => {
      renderer!.update(createElement(StreamProbe, { surface: secondSurface }));
    });
    await vi.waitFor(() =>
      expect(JSON.stringify(renderer!.toJSON())).toContain("Second transcript")
    );
    const switched = JSON.stringify(renderer!.toJSON());
    expect(switched).toContain("Second transcript");
    expect(switched).not.toContain("First transcript");
  });

  it("hydrates Main and rebinds the drawer before reading a warmer side transcript", async () => {
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage = null;
        onerror = null;
        close() {}
      }
    );
    vi.mocked(listChatThreads).mockResolvedValue({
      threads: [thread("side-thread"), thread("main-thread", true)]
    });
    vi.mocked(listChatThreadMessages).mockImplementation(async (threadId) => ({
      messages: [
        message(threadId, threadId === "main-thread" ? "Main transcript" : "Side transcript")
      ]
    }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(StreamProbe, { surface: "drawer" as ChatSurface }));
    });

    await vi.waitFor(() => expect(resumeChat).toHaveBeenCalledWith("main-thread", "drawer"));
    await vi.waitFor(() =>
      expect(listChatThreadMessages).toHaveBeenCalledWith("main-thread", "drawer")
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain("Main transcript");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Side transcript");
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
    });

    await vi.waitFor(() => expect(listPendingActionRequests).toHaveBeenCalledWith("thread-1"));
    expect(JSON.stringify(renderer!.toJSON())).toContain("Approve this note?");
  });

  // #2737: EventSource retries a dropped connection itself, but an HTTP error response closes it
  // for good. The hook must reopen it, or later action results never reach the drawer.
  describe("reopening a refused stream", () => {
    class FakeEventSource {
      static readonly CLOSED = 2;
      static instances: FakeEventSource[] = [];
      readyState = 0;
      closed = false;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        FakeEventSource.instances.push(this);
      }
      close() {
        this.closed = true;
        this.readyState = FakeEventSource.CLOSED;
      }
    }

    function refuse(source: FakeEventSource) {
      source.readyState = FakeEventSource.CLOSED;
      source.onerror?.();
    }

    async function mountDrawer(): Promise<ReactTestRenderer> {
      vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(createElement(StreamProbe, { surface: "drawer" as ChatSurface }));
        await Promise.resolve();
      });
      return renderer!;
    }

    afterEach(() => {
      FakeEventSource.instances = [];
      vi.useRealTimers();
    });

    it("reopens a closed stream after a delay and shows its records", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("EventSource", FakeEventSource);
      const renderer = await mountDrawer();

      await act(async () => refuse(FakeEventSource.instances[0]!));
      expect(FakeEventSource.instances).toHaveLength(1);

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(FakeEventSource.instances).toHaveLength(2);

      await act(async () => {
        FakeEventSource.instances[1]!.onmessage?.({
          data: JSON.stringify({
            kind: "action_result",
            text: "Executed: notes.create",
            toolName: "notes.create",
            outcome: "executed"
          })
        });
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Executed: notes.create");
    });

    it("backs off between repeated refusals", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("EventSource", FakeEventSource);
      await mountDrawer();

      await act(async () => refuse(FakeEventSource.instances[0]!));
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      await act(async () => refuse(FakeEventSource.instances[1]!));
      await act(async () => {
        vi.advanceTimersByTime(1_999);
      });
      expect(FakeEventSource.instances).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(FakeEventSource.instances).toHaveLength(3);
    });

    it("leaves a still-retrying stream to the browser", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("EventSource", FakeEventSource);
      await mountDrawer();

      await act(async () => FakeEventSource.instances[0]!.onerror?.());
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    it("resets the delay once a reopened stream connects", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("EventSource", FakeEventSource);
      await mountDrawer();

      await act(async () => refuse(FakeEventSource.instances[0]!));
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      await act(async () => FakeEventSource.instances[1]!.onopen?.());
      await act(async () => refuse(FakeEventSource.instances[1]!));
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(FakeEventSource.instances).toHaveLength(3);
    });

    it("caps the delay at 30 seconds", () => {
      expect([0, 1, 2, 4, 5, 10, 40].map(streamRetryDelayMs)).toEqual([
        1_000, 2_000, 4_000, 16_000, 30_000, 30_000, 30_000
      ]);
    });

    it("does not end a new private chat after the stream recovers", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("EventSource", FakeEventSource);
      vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
      let errorCount = -1;
      function ErrorCountProbe() {
        errorCount = useChatStream("drawer" as ChatSurface).streamErrorCount;
        return null;
      }
      await act(async () => {
        create(createElement(ErrorCountProbe));
        await Promise.resolve();
      });

      await act(async () => refuse(FakeEventSource.instances[0]!));
      expect(errorCount).toBe(1);
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      await act(async () => FakeEventSource.instances[1]!.onopen?.());

      expect(errorCount).toBe(0);
      expect(
        shouldEndPrivateChatOnStreamDisconnect({
          privateMode: true,
          privateEnded: false,
          streamErrorCount: errorCount
        })
      ).toBe(false);
    });

    it("stops reopening once unmounted", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("EventSource", FakeEventSource);
      const renderer = await mountDrawer();

      await act(async () => refuse(FakeEventSource.instances[0]!));
      await act(async () => renderer.unmount());
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(FakeEventSource.instances).toHaveLength(1);
    });
  });
});
