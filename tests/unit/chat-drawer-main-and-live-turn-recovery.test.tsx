import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

import { DEFAULT_CHAT_SURFACE, type ChatSurface, type TranscriptRecord } from "@moss/shared";
import type * as ApiClientModule from "../../apps/web/src/api/client.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof ApiClientModule>()).ApiError,
  chatStreamUrl: () => "/api/chat/stream",
  getMe: vi.fn(async () => ({ user: { id: "owner" } })),
  listPendingActionRequests: vi.fn(async () => ({ actions: [] })),
  sendChatTurn: vi.fn(async () => ({
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    reply: "ok",
    sourceFreshness: null
  })),
  cancelChatTurn: vi.fn(async () => undefined),
  clearChat: vi.fn(async () => undefined),
  endPrivateChat: vi.fn(async () => undefined),
  beaconEndPrivateChat: vi.fn(() => undefined),
  getChatPrivacyState: vi.fn(async () => ({ incognito: false })),
  listChatThreads: vi.fn(async () => ({ threads: [] })),
  listChatThreadMessages: vi.fn(async () => ({ messages: [] })),
  transcribeAudio: vi.fn(),
  resumeChat: vi.fn(async () => ({})),
  listChatSkills: vi.fn(async () => ({ skills: [] })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listCalendarEvents: vi.fn(async () => ({ events: [] })),
  lookupAiCapabilityRoute: vi.fn(async () => ({
    route: { capability: "chat", available: true, reason: "matched-active-model", model: null }
  })),
  getPersonaSettings: vi.fn(async () => ({
    persona: { assistantName: "Alfred", personaText: "" }
  })),
  getChatModelOverrideSettings: vi.fn(async () => ({
    settings: {
      overrideEnabled: false,
      currentOverrideModelId: null,
      effectiveOverrideModelId: null,
      defaultModel: null,
      selectedModel: null,
      selectableOverrideModels: []
    }
  })),
  getChatModelFavorites: vi.fn(async () => ({ modelIds: [] })),
  putChatModelFavorites: vi.fn(async (input: { modelIds: string[] }) => input)
}));
vi.mock("../../apps/web/src/api/workflows-client.js", () => ({
  listWorkflowApprovals: vi.fn(async () => [])
}));

import {
  getChatPrivacyState,
  listChatThreadMessages,
  listChatThreads,
  resumeChat,
  sendChatTurn
} from "../../apps/web/src/api/client.js";
import { useChatStream } from "../../apps/web/src/chat/use-chat-stream.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

function drawer(
  client: QueryClient,
  initialText?: string,
  ownerId?: string,
  surface: ChatSurface = DEFAULT_CHAT_SURFACE
): ReactElement {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      MemoryRouter,
      null,
      createElement(ChatDrawer, {
        open: true,
        onClose: () => undefined,
        records: [],
        clearRecords: () => undefined,
        streamErrorCount: 0,
        isFounder: false,
        initialText,
        ownerId,
        surface
      }) as ReactElement
    )
  );
}

function findByAriaLabel(renderer: ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll((node) => node.props["aria-label"] === label);
  return matches.length > 0 ? matches[0] : null;
}

function findByClassName(renderer: ReactTestRenderer, className: string) {
  return renderer.root.find((node) => node.props.className === className);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function chatThread(id: string, title: string, isMain = false) {
  return {
    id,
    ownerUserId: "owner",
    title,
    incognito: false,
    isMain,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    lastMessagePreview: null
  };
}

it("sends a recovered Main draft after startup history is ready", async () => {
  const previousEventSource = globalThis.EventSource;
  const previousStorage = globalThis.localStorage;
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    }
  );
  const saved = new Map([
    [
      "moss.chatDrafts",
      JSON.stringify({
        ownerId: "owner",
        drafts: { a: "Recovered Main draft" }
      })
    ]
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key)
  });
  const history = deferred<Awaited<ReturnType<typeof listChatThreadMessages>>>();
  vi.mocked(listChatThreadMessages).mockImplementationOnce(() => history.promise);
  vi.mocked(listChatThreads).mockResolvedValue({ threads: [chatThread("a", "Main", true)] });
  vi.mocked(sendChatTurn).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function MainDrawer() {
    const stream = useChatStream(DEFAULT_CHAT_SURFACE);
    return createElement(ChatDrawer, {
      ...stream,
      open: true,
      onClose: () => undefined,
      isFounder: false,
      ownerId: "owner",
      surface: DEFAULT_CHAT_SURFACE
    });
  }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(createElement(QueryClientProvider, { client }, createElement(MainDrawer)));
    });
    await vi.waitFor(async () => {
      await act(async () => {
        expect(renderer.root.findByType("textarea").props.value).toBe("Recovered Main draft");
      });
    });
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
    expect(findByClassName(renderer, "chatd-send").props.disabled).toBe(true);
    await act(async () => {
      renderer.root.findByType("textarea").props.onKeyDown({
        key: "Enter",
        shiftKey: false,
        preventDefault: () => undefined
      });
    });
    expect(sendChatTurn).not.toHaveBeenCalled();
    expect(renderer.root.findByType("textarea").props.value).toBe("Recovered Main draft");
    await act(async () => history.resolve({ messages: [] }));
    await vi.waitFor(async () => {
      await act(async () => {
        expect(findByClassName(renderer, "chatd-send").props.disabled).toBe(false);
      });
    });
    await act(async () => {
      renderer.root.findByType("textarea").props.onKeyDown({
        key: "Enter",
        shiftKey: false,
        preventDefault: () => undefined
      });
    });
    expect(sendChatTurn).toHaveBeenCalledTimes(1);
    expect(sendChatTurn).toHaveBeenCalledWith(
      "Recovered Main draft",
      undefined,
      undefined,
      DEFAULT_CHAT_SURFACE
    );
  } finally {
    await act(async () => renderer?.unmount());
    client.clear();
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
    vi.mocked(listChatThreadMessages).mockReset();
    vi.stubGlobal("EventSource", previousEventSource);
    vi.stubGlobal("localStorage", previousStorage);
  }
});

it("keeps the owner's Main and its draft when a newer shared Main is listed first (#3192)", async () => {
  const drafts = new Map([
    ["moss.chatDrafts", JSON.stringify({ ownerId: "owner", drafts: { "own-main": "Unsent Main" } })]
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => drafts.get(key) ?? null,
    setItem: (key: string, value: string) => drafts.set(key, value),
    removeItem: (key: string) => drafts.delete(key)
  });
  vi.mocked(getChatPrivacyState).mockResolvedValueOnce({ incognito: false });
  vi.mocked(listChatThreads).mockResolvedValueOnce({
    threads: [
      { ...chatThread("shared-main", "Shared planning", true), ownerUserId: "someone-else" },
      chatThread("own-main", "My Main", true)
    ]
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, undefined, "owner"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("Unsent Main");
  await act(async () => findByAriaLabel(renderer, "Open conversations")!.props.onClick());
  expect(findByAriaLabel(renderer, "Main chat")!.props["aria-pressed"]).toBe(true);
  expect(findByAriaLabel(renderer, "Shared planning")!.props["aria-pressed"]).toBe(false);
  expect(JSON.parse(drafts.get("moss.chatDrafts")!).drafts["own-main"]).toBe("Unsent Main");
});

it("shows the live turn in a new side chat before the turn ends", async () => {
  vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: false, threadId: "side-1" });
  vi.mocked(listChatThreadMessages).mockResolvedValue({ messages: [] });
  vi.mocked(listChatThreads).mockResolvedValue({ threads: [chatThread("a", "Main", true)] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (records: readonly TranscriptRecord[]) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(ChatDrawer, {
          open: true,
          onClose: () => undefined,
          records,
          clearRecords: () => undefined,
          streamErrorCount: 0,
          isFounder: false,
          ownerId: "owner",
          surface: DEFAULT_CHAT_SURFACE
        }) as ReactElement
      )
    );
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(view([]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => findByAriaLabel(renderer, "Open conversations")!.props.onClick());
    await act(async () => {
      findByAriaLabel(renderer, "New side chat")!.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      renderer.update(
        view([
          { kind: "user", text: "Turn the porch light on" },
          { kind: "action_request", actionRequestId: "request-1", text: "Approve light.set" }
        ])
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const shown = JSON.stringify(renderer.toJSON());
    expect(shown).toContain("Turn the porch light on");
    expect(findByAriaLabel(renderer, "Action request")).not.toBeNull();
  } finally {
    await act(async () => renderer?.unmount());
    client.clear();
    vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: false });
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
    vi.mocked(listChatThreadMessages).mockReset();
  }
});

it("keeps the previous conversation's live turn out of a reopened side chat", async () => {
  vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: false, threadId: "a" });
  vi.mocked(listChatThreadMessages).mockResolvedValue({ messages: [] });
  vi.mocked(listChatThreads).mockResolvedValue({
    threads: [chatThread("a", "Main", true), chatThread("b", "Porch planning")]
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (records: readonly TranscriptRecord[]) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(ChatDrawer, {
          open: true,
          onClose: () => undefined,
          records,
          clearRecords: () => undefined,
          streamErrorCount: 0,
          isFounder: false,
          ownerId: "owner",
          surface: DEFAULT_CHAT_SURFACE
        }) as ReactElement
      )
    );
  const mainTurn: readonly TranscriptRecord[] = [{ kind: "user", text: "Question asked in Main" }];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(view(mainTurn));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => findByAriaLabel(renderer, "Open conversations")!.props.onClick());
    await act(async () => {
      findByAriaLabel(renderer, "Porch planning")!.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      renderer.update(view(mainTurn));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(vi.mocked(resumeChat)).toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Question asked in Main");
  } finally {
    await act(async () => renderer?.unmount());
    client.clear();
    vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: false });
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [] });
    vi.mocked(listChatThreadMessages).mockReset();
  }
});
