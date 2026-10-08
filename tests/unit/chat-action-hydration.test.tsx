import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { recordsFromMessages, useChatStream } from "../../apps/web/src/chat/use-chat-stream.js";

vi.mock("../../apps/web/src/api/client.js", () => ({
  chatStreamUrl: () => "/api/chat/stream",
  getMe: vi.fn(async () => ({ user: { id: "user-1" } })),
  resumeChat: vi.fn(async () => undefined),
  listChatThreadMessages: vi.fn(),
  listChatThreads: vi.fn(),
  listPendingActionRequests: vi.fn()
}));
vi.mock("../../apps/web/src/api/workflows-client.js", () => ({
  listWorkflowApprovals: vi.fn(async () => [])
}));

let renderer: ReactTestRenderer | undefined;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor() {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}
beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(listChatThreadMessages).mockResolvedValue({ messages: [] });
  vi.mocked(listPendingActionRequests).mockResolvedValue({ actions: [] });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function thread(id: string): ChatThreadDto {
  return {
    id,
    ownerUserId: "user-1",
    title: id,
    incognito: false,
    isMain: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastActiveAt: new Date(0).toISOString(),
    lastMessagePreview: null
  };
}

function action(
  id: string,
  status: AiAssistantActionDto["status"] = "pending"
): AiAssistantActionDto {
  return {
    id,
    ownerUserId: "user-1",
    toolModuleId: "notes",
    toolModuleName: "Notes",
    toolName: "notes.write_note",
    permissionId: "notes.write",
    risk: "write",
    status,
    inputSummary: { text: id },
    requestedAt: new Date(0).toISOString(),
    resolvedAt: null,
    updatedAt: new Date(0).toISOString()
  };
}

function Probe({ surface }: { surface: ChatSurface }) {
  const { records, clearRecords, selectionPending } = useChatStream(surface);
  return createElement(
    "button",
    {
      onClick: clearRecords,
      "data-records": JSON.stringify(records),
      "data-pending": selectionPending
    },
    records.map((record) => record.text).join("|")
  );
}

async function mount(surface: ChatSurface = "drawer" as ChatSurface) {
  await act(async () => {
    renderer = create(createElement(Probe, { surface }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function historyMessage(
  id: string,
  body: string,
  role: "user" | "assistant" = "assistant"
): ChatMessageDto {
  return {
    id,
    body,
    role,
    threadId: "thread-a",
    ownerUserId: "user-1",
    status: "stored",
    modelRoute: null,
    tools: [],
    activity: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

describe("thread-scoped pending card hydration", () => {
  it("keeps the composer selection pending until Main resume and history finish", async () => {
    const resumed = deferred<void>();
    const history = deferred<{ messages: ChatMessageDto[] }>();
    vi.mocked(listChatThreads).mockResolvedValue({
      threads: [{ ...thread("main"), isMain: true }]
    });
    vi.mocked(resumeChat).mockReturnValue(resumed.promise);
    vi.mocked(listChatThreadMessages).mockReturnValue(history.promise);
    await mount();
    expect(renderer!.root.findByType("button").props["data-pending"]).toBe(true);
    expect(listChatThreadMessages).not.toHaveBeenCalled();
    await act(async () => resumed.resolve());
    expect(renderer!.root.findByType("button").props["data-pending"]).toBe(true);
    expect(listChatThreadMessages).toHaveBeenCalledExactlyOnceWith("main", "drawer");
    await act(async () => history.resolve({ messages: [] }));
    expect(renderer!.root.findByType("button").props["data-pending"]).toBe(false);
  });

  it("keeps explicit New chat ready without resuming a stale startup Main", async () => {
    const threads = deferred<{ threads: ChatThreadDto[] }>();
    vi.mocked(listChatThreads).mockReturnValue(threads.promise);
    await mount();
    expect(renderer!.root.findByType("button").props["data-pending"]).toBe(true);
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(renderer!.root.findByType("button").props["data-pending"]).toBe(false);
    await act(async () => threads.resolve({ threads: [{ ...thread("old-main"), isMain: true }] }));
    expect(resumeChat).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("button").props["data-pending"]).toBe(false);
  });

  it.each([true, false])(
    "keeps full history once when timeout SSE arrives before history (persisted=%s)",
    async (persisted) => {
      const history = deferred<{ messages: ChatMessageDto[] }>();
      vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
      vi.mocked(listChatThreadMessages).mockReturnValue(history.promise);
      await mount();
      const outcome = {
        kind: "action_result",
        text: "Timed out: Save note",
        actionRequestId: "expired",
        outcome: "denied" as const,
        decidedBy: "timeout" as const
      };
      const decision = { ...outcome, kind: "not_approved", text: "Not approved" };
      const emit = () => {
        for (const record of [outcome, decision])
          FakeEventSource.instances[0]!.onmessage?.({ data: JSON.stringify(record) });
      };
      await act(async () => emit());
      await act(async () =>
        history.resolve({
          messages: [
            historyMessage("user-a", "Earlier question", "user"),
            historyMessage("reply-a", "Earlier answer"),
            ...(persisted
              ? [{ ...historyMessage("timeout-row", ""), activity: [outcome, decision] }]
              : [])
          ]
        })
      );
      await act(async () => emit());

      const records = JSON.parse(renderer!.root.findByType("button").props["data-records"]);
      expect(records.map((record: { kind: string }) => record.kind)).toEqual([
        "user",
        "reply",
        "action_result",
        "not_approved"
      ]);
      expect(records.map((record: { text: string }) => record.text)).toEqual([
        "Earlier question",
        "Earlier answer",
        "Timed out: Save note",
        "Not approved"
      ]);
    }
  );

  it.each(["user", "reply", "thought", "tool"])(
    "does not overwrite a new live %s record with fetched history",
    async (kind) => {
      const history = deferred<{ messages: ChatMessageDto[] }>();
      vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
      vi.mocked(listChatThreadMessages).mockReturnValue(history.promise);
      await mount();
      await act(async () =>
        FakeEventSource.instances[0]!.onmessage?.({
          data: JSON.stringify({ kind, text: "New live turn" })
        })
      );
      await act(async () =>
        history.resolve({ messages: [historyMessage("old-reply", "Stale snapshot")] })
      );
      const records = JSON.parse(renderer!.root.findByType("button").props["data-records"]);
      expect(records).toEqual([{ kind, text: "New live turn" }]);
    }
  );

  it("reads the recovered timeout on the first load after deadline recovery finishes", async () => {
    const recovered = deferred<{ actions: AiAssistantActionDto[] }>();
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
    vi.mocked(listPendingActionRequests).mockReturnValue(recovered.promise);
    await mount();
    expect(listChatThreadMessages).not.toHaveBeenCalled();
    vi.mocked(listChatThreadMessages).mockResolvedValue({
      messages: [
        {
          id: "timeout-row",
          threadId: "thread-a",
          ownerUserId: "user-1",
          role: "assistant",
          status: "stored",
          body: "",
          modelRoute: null,
          tools: [],
          activity: [
            {
              kind: "action_result",
              text: "Timed out: Save note",
              actionRequestId: "expired",
              outcome: "denied",
              decidedBy: "timeout"
            }
          ],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        }
      ]
    });
    await act(async () => recovered.resolve({ actions: [] }));
    expect(JSON.stringify(renderer!.toJSON())).toContain("Timed out: Save note");
    expect(listChatThreadMessages).toHaveBeenCalledExactlyOnceWith("thread-a", "drawer");
  });

  it("restores complete live disclosure and marks metadata-only cards nonapprovable", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
    const presentation = {
      summary: "Send the message",
      outsideContentNotice: true,
      outcomeTitle: "Send message",
      preview: { to: "person@example.test", subject: "Subject", body: "Message" },
      details: { presentation: "human" as const, target: "person@example.test", fields: [] }
    };
    vi.mocked(listPendingActionRequests).mockResolvedValue({
      actions: [
        { ...action("full"), approvalAvailable: true, presentation },
        { ...action("incomplete"), approvalAvailable: false },
        { ...action("missing-presentation"), approvalAvailable: true }
      ]
    });
    await mount();
    const records = JSON.parse(renderer!.root.findByType("button").props["data-records"]);
    expect(records).toEqual([
      expect.objectContaining({
        actionRequestId: "full",
        approvalAvailable: true,
        ...presentation,
        text: presentation.summary
      }),
      expect.objectContaining({ actionRequestId: "incomplete", approvalAvailable: false }),
      expect.objectContaining({ actionRequestId: "missing-presentation", approvalAvailable: false })
    ]);
  });
  it("preserves the server note-delete marker and permanent-delete disclosure after reload", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
    const presentation = {
      summary: "Delete note",
      outcomeTitle: "Delete note",
      outsideContentNotice: true,
      details: {
        presentation: "human" as const,
        approvalKind: "note_delete" as const,
        target: "Quarterly plan",
        fields: [
          { label: "Deletion", value: "Permanently delete this note. There is no trash or undo." }
        ]
      }
    };
    vi.mocked(listPendingActionRequests).mockResolvedValue({
      actions: [
        {
          ...action("delete-note"),
          toolName: "notes.delete",
          approvalAvailable: true,
          presentation
        }
      ]
    });
    await mount();
    const records = JSON.parse(renderer!.root.findByType("button").props["data-records"]);
    expect(records).toEqual([
      expect.objectContaining({
        actionRequestId: "delete-note",
        approvalAvailable: true,
        details: presentation.details
      })
    ]);
  });

  it("restores the explicit native permission discriminator and exact command line", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
    const presentation = {
      summary: "Bash: cat -- /vault/notes/exact  file.md\n  exact continuation",
      nativePermission: true as const,
      outsideContentNotice: true
    };
    vi.mocked(listPendingActionRequests).mockResolvedValue({
      actions: [{ ...action("native"), toolName: "Bash", approvalAvailable: true, presentation }]
    });
    await mount();
    const records = JSON.parse(renderer!.root.findByType("button").props["data-records"]);
    expect(records).toEqual([
      expect.objectContaining({
        actionRequestId: "native",
        approvalAvailable: true,
        nativePermission: true,
        summary: presentation.summary,
        text: presentation.summary
      })
    ]);
  });

  it("restores connected-tool provenance and its complete frozen argument string", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
    const presentation = {
      summary: "Untrusted model summary is not disclosure",
      outcomeTitle: "Connected tool request",
      externalTool: true as const,
      exactArguments: JSON.stringify(
        { names: ["one", "two"], nested: { exact: "  text\n" } },
        null,
        2
      ),
      outsideContentNotice: true
    };
    vi.mocked(listPendingActionRequests).mockResolvedValue({
      actions: [
        {
          ...action("external"),
          toolName: "connected-example.update",
          approvalAvailable: true,
          presentation
        }
      ]
    });
    await mount();
    const records = JSON.parse(renderer!.root.findByType("button").props["data-records"]);
    expect(records).toEqual([
      expect.objectContaining({
        actionRequestId: "external",
        toolName: "connected-example.update",
        approvalAvailable: true,
        externalTool: true,
        exactArguments: presentation.exactArguments
      })
    ]);
  });

  it("drops old-stream events immediately on clear and reconnects for the new conversation", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
    await mount();
    const oldStream = FakeEventSource.instances[0]!;
    const event = (text: string) => ({
      data: JSON.stringify({ kind: "action_request", text, actionRequestId: text })
    });

    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
      oldStream.onmessage?.(event("old-before-cleanup"));
    });
    expect(oldStream.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => {
      oldStream.onmessage?.(event("old-after-reconnect"));
      FakeEventSource.instances[1]!.onmessage?.(event("new-conversation"));
    });
    const visible = JSON.stringify(renderer!.toJSON());
    expect(visible).toContain("new-conversation");
    expect(visible).not.toContain("old-before-cleanup");
    expect(visible).not.toContain("old-after-reconnect");
  });

  it("drops buffered stream events from the previous surface", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
    await mount();
    const oldStream = FakeEventSource.instances[0]!;
    await act(async () => {
      renderer!.update(createElement(Probe, { surface: "m-2222222222222222" as ChatSurface }));
    });
    await act(async () =>
      oldStream.onmessage?.({
        data: JSON.stringify({ kind: "action_request", text: "old-surface" })
      })
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("old-surface");
  });
  it("waits for the selected thread before requesting its pending actions", async () => {
    const threads = deferred<{ threads: ChatThreadDto[] }>();
    vi.mocked(listChatThreads).mockReturnValue(threads.promise);
    await mount();
    expect(listPendingActionRequests).not.toHaveBeenCalled();

    await act(async () => threads.resolve({ threads: [thread("selected"), thread("older")] }));

    expect(listPendingActionRequests).toHaveBeenCalledExactlyOnceWith("selected");
  });

  it("does not request owner-wide actions when the surface has no thread", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
    await mount();

    expect(listPendingActionRequests).not.toHaveBeenCalled();
    expect(listChatThreadMessages).not.toHaveBeenCalled();
  });

  it("hydrates only the selected thread and still excludes resolved requests", async () => {
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-b")] });
    vi.mocked(listPendingActionRequests).mockImplementation(async (id) => ({
      actions:
        id === "thread-b"
          ? [
              action("pending-in-b"),
              action("resolved-in-b", "cancelled"),
              action("timed-out-in-b", "timed_out")
            ]
          : [action("pending-in-a")]
    }));
    await mount();

    const visible = JSON.stringify(renderer!.toJSON());
    expect(visible).toContain("pending-in-b");
    expect(visible).not.toContain("pending-in-a");
    expect(visible).not.toContain("resolved-in-b");
    expect(visible).not.toContain("timed-out-in-b");
  });

  it("discards in-flight hydration when a new chat clears the same surface", async () => {
    const oldActions = deferred<{ actions: AiAssistantActionDto[] }>();
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [thread("thread-a")] });
    vi.mocked(listPendingActionRequests).mockReturnValue(oldActions.promise);
    await mount();

    await act(async () => renderer!.root.findByType("button").props.onClick());
    await act(async () => oldActions.resolve({ actions: [action("pending-in-a")] }));

    expect(JSON.stringify(renderer!.toJSON())).not.toContain("pending-in-a");
  });

  it("ignores a previous surface's late action response after navigation", async () => {
    const oldActions = deferred<{ actions: AiAssistantActionDto[] }>();
    const first = "m-1111111111111111" as ChatSurface;
    const second = "m-2222222222222222" as ChatSurface;
    vi.mocked(listChatThreads).mockImplementation(async (surface) => ({
      threads: [thread(surface === first ? "thread-a" : "thread-b")]
    }));
    vi.mocked(listPendingActionRequests).mockImplementation(async (id) =>
      id === "thread-a" ? oldActions.promise : { actions: [] }
    );
    await mount(first);
    await act(async () => {
      renderer!.update(createElement(Probe, { surface: second }));
    });
    await act(async () => oldActions.resolve({ actions: [action("pending-in-a")] }));

    expect(listPendingActionRequests).toHaveBeenCalledWith("thread-b");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("pending-in-a");
  });

  it("does not continue a stale thread lookup after navigation", async () => {
    const oldThreads = deferred<{ threads: ChatThreadDto[] }>();
    const first = "m-1111111111111111" as ChatSurface;
    const second = "m-2222222222222222" as ChatSurface;
    vi.mocked(listChatThreads).mockImplementation(async (surface) =>
      surface === first ? oldThreads.promise : { threads: [thread("thread-b")] }
    );
    await mount(first);
    await act(async () => {
      renderer!.update(createElement(Probe, { surface: second }));
    });
    await act(async () => oldThreads.resolve({ threads: [thread("thread-a")] }));

    expect(listPendingActionRequests).toHaveBeenCalledExactlyOnceWith("thread-b");
  });
});

describe("late action outcome history", () => {
  it("retains a bodyless action outcome without an empty reply bubble", () => {
    const message: ChatMessageDto = {
      id: "message-1",
      threadId: "thread-a",
      ownerUserId: "user-1",
      role: "assistant",
      status: "stored",
      body: "",
      modelRoute: null,
      tools: [],
      activity: [
        {
          kind: "action_result",
          text: "Not now: Save note",
          actionRequestId: "action-a",
          decidedBy: "timeout",
          outcome: "denied"
        }
      ],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };

    expect(recordsFromMessages([message])).toEqual([
      expect.objectContaining({
        kind: "action_result",
        actionRequestId: "action-a",
        decidedBy: "timeout"
      })
    ]);
  });
});
