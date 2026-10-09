import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

import { DEFAULT_CHAT_SURFACE, type ChatSurface } from "@moss/shared";
import type * as ApiClientModule from "../../apps/web/src/api/client.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof ApiClientModule>()).ApiError,
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

import {
  getChatPrivacyState,
  listChatThreadMessages,
  listChatThreads,
  resumeChat,
  sendChatTurn,
  transcribeAudio
} from "../../apps/web/src/api/client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { boundDraftKey, unselectedDraftKey } from "../../apps/web/src/chat/chat-draft-storage.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";
import { moduleChatSurface } from "../../apps/web/src/shell/chat-surface-key.js";

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

class FakeMediaRecorder {
  ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  constructor(_stream: unknown) {}
  start() {
    /* no-op */
  }
}

it("reuses a cleared starter after the caller clears it", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, "Starter"));
    await Promise.resolve();
  });

  let textarea = renderer.root.findByType("textarea");
  expect(textarea.props.value).toBe("Starter");
  await act(async () => textarea.props.onChange({ target: { value: "" } }));
  await act(async () => {
    renderer.update(drawer(client));
    await Promise.resolve();
  });
  await act(async () => {
    renderer.update(drawer(client, "Starter"));
    await Promise.resolve();
  });

  textarea = renderer.root.findByType("textarea");
  expect(textarea.props.value).toBe("Starter");
});

it("does not move an unresolved starter into a later untouched conversation", async () => {
  const drafts = new Map([
    ["moss.chatDrafts", JSON.stringify({ ownerId: "owner", drafts: { a: "genuine unsent" } })]
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => drafts.get(key) ?? null,
    setItem: (key: string, value: string) => drafts.set(key, value),
    removeItem: (key: string) => drafts.delete(key)
  });
  const privacy = deferred<{ incognito: boolean; threadId: string }>();
  const threads = deferred<{
    threads: Array<{
      id: string;
      ownerUserId: string;
      title: string;
      incognito: boolean;
      isMain: boolean;
      createdAt: string;
      updatedAt: string;
      lastActiveAt: string;
      lastMessagePreview: null;
    }>;
  }>();
  const thread = (id: string, title: string, isMain = false) => ({
    id,
    ownerUserId: "owner",
    title,
    incognito: false,
    isMain,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    lastMessagePreview: null
  });
  vi.mocked(getChatPrivacyState).mockImplementationOnce(() => privacy.promise);
  vi.mocked(listChatThreads).mockImplementationOnce(() => threads.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, "Starter", "owner"));
    await Promise.resolve();
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("Starter");
  await act(async () => {
    privacy.resolve({ incognito: false, threadId: "a" });
    threads.resolve({ threads: [thread("a", "Main chat", true), thread("b", "Side chat")] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("genuine unsent");

  await act(async () => {
    findByAriaLabel(renderer, "Open conversations")!.props.onClick();
  });
  await act(async () => {
    findByAriaLabel(renderer, "Side chat")!.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("");

  await act(async () => renderer.unmount());
  vi.mocked(getChatPrivacyState).mockResolvedValueOnce({ incognito: false, threadId: "b" });
  vi.mocked(listChatThreads).mockResolvedValueOnce({
    threads: [thread("a", "Main chat", true), thread("b", "Side chat")]
  });
  const remountedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(drawer(remountedClient, undefined, "owner"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("");
});

it("does not reseed a no-ID starter while its first send is in flight", async () => {
  const sent = deferred<{
    userMessageId: string;
    assistantMessageId: string;
    reply: string;
    sourceFreshness: null;
  }>();
  vi.mocked(sendChatTurn).mockImplementationOnce(() => sent.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, "Starter"));
    await Promise.resolve();
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("Starter");
  await act(async () => {
    findByClassName(renderer, "chatd-send").props.onClick();
    await Promise.resolve();
  });
  expect(sendChatTurn).toHaveBeenCalledWith("Starter", undefined, undefined, DEFAULT_CHAT_SURFACE);
  await act(async () => {
    client.setQueryData(queryKeys.chat.privacy(DEFAULT_CHAT_SURFACE), {
      incognito: false,
      threadId: "first-thread"
    });
    await Promise.resolve();
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("");

  await act(async () => {
    sent.resolve({
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      reply: "ok",
      sourceFreshness: null
    });
    await Promise.resolve();
  });
});

it("keeps delayed speech with its edited A starter without disturbing B's untouched starter", async () => {
  const transcript = deferred<{ text: string }>();
  vi.mocked(transcribeAudio).mockReturnValueOnce(transcript.promise);
  const recorders: FakeMediaRecorder[] = [];
  class RecordingFakeMediaRecorder extends FakeMediaRecorder {
    constructor(stream: unknown) {
      super(stream);
      recorders.push(this);
    }
  }
  const track = { stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) }
  });
  vi.stubGlobal("MediaRecorder", RecordingFakeMediaRecorder);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const moduleSurface = moduleChatSurface("job-search", "profile-voice") as ChatSurface;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, "A starter"));
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    findByAriaLabel(renderer, "Record voice message")!.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(recorders).toHaveLength(1);
    recorders[0]!.onstop?.();
    await Promise.resolve();
  });
  await act(async () => {
    renderer.root.findByType("textarea").props.onChange({ target: { value: "A starter second" } });
  });
  await act(async () => {
    renderer.update(drawer(client, "B starter", undefined, moduleSurface));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("B starter");

  await act(async () => {
    transcript.resolve({ text: "voice" });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("B starter");

  await act(async () => {
    renderer.update(drawer(client, "A starter"));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("A starter second voice");
  await act(async () => {
    renderer.root.findByType("textarea").props.onChange({ target: { value: "" } });
    await Promise.resolve();
  });
  await act(async () => {
    renderer.update(drawer(client, "A starter"));
    await Promise.resolve();
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("");
});

it("retires a starter supplied during a failed B selection", async () => {
  const resumed = deferred<void>();
  vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: false, threadId: "a" });
  vi.mocked(listChatThreads).mockResolvedValue({
    threads: [
      {
        id: "b",
        ownerUserId: "owner",
        title: "Side chat",
        incognito: false,
        isMain: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lastActiveAt: "2026-01-01T00:00:00Z",
        lastMessagePreview: null
      }
    ]
  });
  vi.mocked(resumeChat).mockImplementationOnce(() => resumed.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => findByAriaLabel(renderer, "Open conversations")!.props.onClick());
  await act(async () => findByAriaLabel(renderer, "Side chat")!.props.onClick());
  await act(async () => {
    renderer.update(drawer(client, "Starter"));
    await Promise.resolve();
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("Starter");
  await act(async () => {
    resumed.reject(new Error("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("");
});

it("keeps a caller supplied after successful B selection ahead of cached A privacy", async () => {
  vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: false, threadId: "a" });
  vi.mocked(listChatThreads).mockResolvedValue({
    threads: [
      {
        id: "b",
        ownerUserId: "owner",
        title: "Side chat",
        incognito: false,
        isMain: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lastActiveAt: "2026-01-01T00:00:00Z",
        lastMessagePreview: null
      }
    ]
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => findByAriaLabel(renderer, "Open conversations")!.props.onClick());
  await act(async () => {
    findByAriaLabel(renderer, "Side chat")!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    renderer.update(drawer(client, "Starter"));
    await Promise.resolve();
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("Starter");
});

it("keeps a collided module fallback active without replacing canonical A", async () => {
  const moduleSurface = moduleChatSurface("job-search", "profile-1") as ChatSurface;
  const drafts = new Map([
    [
      "moss.chatDrafts",
      JSON.stringify({ ownerId: "owner", drafts: { a: "Canonical A", b: "Canonical B" } })
    ]
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => drafts.get(key) ?? null,
    setItem: (key: string, value: string) => drafts.set(key, value),
    removeItem: (key: string) => drafts.delete(key)
  });
  const privacy = deferred<{ incognito: boolean; threadId: string }>();
  vi.mocked(getChatPrivacyState).mockImplementationOnce(() => privacy.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, undefined, "owner", moduleSurface));
    await Promise.resolve();
  });
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "Fallback A" } })
  );
  await act(async () => {
    privacy.resolve({ incognito: false, threadId: "a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("Fallback A");
  expect(JSON.parse(drafts.get("moss.chatDrafts")!).drafts.a).toBe("Canonical A");
});

it("binds an edited restored module fallback after remount without replacing canonical A", async () => {
  const moduleSurface = moduleChatSurface("job-search", "profile-1") as ChatSurface;
  const fallbackKey = unselectedDraftKey(moduleSurface);
  const drafts = new Map([
    [
      "moss.chatDrafts",
      JSON.stringify({
        ownerId: "owner",
        drafts: { [fallbackKey]: "Restored fallback", a: "Canonical A" }
      })
    ]
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => drafts.get(key) ?? null,
    setItem: (key: string, value: string) => drafts.set(key, value),
    removeItem: (key: string) => drafts.delete(key)
  });
  const privacy = deferred<{ incognito: boolean; threadId: string }>();
  vi.mocked(getChatPrivacyState).mockImplementationOnce(() => privacy.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, undefined, "owner", moduleSurface));
    await Promise.resolve();
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("Restored fallback");
  await act(async () =>
    renderer.root
      .findByType("textarea")
      .props.onChange({ target: { value: "Restored fallback, edited" } })
  );
  await act(async () => {
    privacy.resolve({ incognito: false, threadId: "a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(renderer.root.findByType("textarea").props.value).toBe("Restored fallback, edited");
  expect(JSON.parse(drafts.get("moss.chatDrafts")!).drafts).toMatchObject({
    a: "Canonical A",
    [boundDraftKey(moduleSurface, "a")]: "Restored fallback, edited"
  });
});

it("waits for module identity after reloading canonical and bound A drafts", async () => {
  const moduleSurface = moduleChatSurface("job-search", "profile-1") as ChatSurface;
  const drafts = new Map([
    [
      "moss.chatDrafts",
      JSON.stringify({
        ownerId: "owner",
        drafts: {
          a: "Canonical A",
          [boundDraftKey(moduleSurface, "a")]: "Bound A"
        }
      })
    ]
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => drafts.get(key) ?? null,
    setItem: (key: string, value: string) => drafts.set(key, value),
    removeItem: (key: string) => drafts.delete(key)
  });
  const privacy = deferred<{ incognito: boolean; threadId: string }>();
  vi.mocked(getChatPrivacyState).mockImplementationOnce(() => privacy.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, undefined, "owner", moduleSurface));
    await Promise.resolve();
  });

  expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
  expect(findByClassName(renderer, "chatd-send").props.disabled).toBe(true);
  await act(async () => {
    privacy.resolve({ incognito: false, threadId: "a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(renderer.root.findByType("textarea").props.disabled).toBeFalsy();
  expect(renderer.root.findByType("textarea").props.value).toBe("Bound A");
});

it("retries a failed module identity load and allows a settled no-ID send", async () => {
  const moduleSurface = moduleChatSurface("job-search", "profile-1") as ChatSurface;
  const privacy = deferred<{ incognito: boolean; threadId?: string }>();
  vi.mocked(getChatPrivacyState)
    .mockImplementationOnce(() => privacy.promise)
    .mockResolvedValueOnce({ incognito: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client, undefined, undefined, moduleSurface));
    await Promise.resolve();
  });

  expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
  await act(async () => {
    privacy.reject(new Error("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(findByAriaLabel(renderer, "Retry conversation identity")).not.toBeNull();
  await act(async () => {
    findByAriaLabel(renderer, "Retry conversation identity")!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(findByAriaLabel(renderer, "Retry conversation identity")).toBeNull();
  expect(renderer.root.findByType("textarea").props.disabled).toBeFalsy();
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "No-ID draft" } })
  );
  await act(async () => {
    findByClassName(renderer, "chatd-send").props.onClick();
    await Promise.resolve();
  });

  expect(sendChatTurn).toHaveBeenCalledWith("No-ID draft", undefined, undefined, moduleSurface);
});

it("retains a cached transcript and restores the composer after a failed refetch", async () => {
  vi.mocked(listChatThreads).mockResolvedValueOnce({
    threads: [
      {
        id: "broken-thread",
        ownerUserId: "user-1",
        title: "Broken thread",
        incognito: false,
        isMain: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lastActiveAt: "2026-01-01T00:00:00Z",
        lastMessagePreview: null
      }
    ]
  });
  const messages = [
    {
      id: "cached-message",
      threadId: "broken-thread",
      ownerUserId: "user-1",
      body: "Cached answer",
      role: "assistant" as const,
      status: "stored" as const,
      modelRoute: null,
      tools: [],
      activity: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z"
    }
  ];
  let resolveRetry!: (result: { messages: typeof messages }) => void;
  vi.mocked(listChatThreadMessages)
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        })
    );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.chat.messages("broken-thread", DEFAULT_CHAT_SURFACE), { messages });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(drawer(client));
    await Promise.resolve();
  });

  await act(async () => {
    findByAriaLabel(renderer, "Open conversations")!.props.onClick();
  });
  await act(async () => {
    findByAriaLabel(renderer, "Broken thread")!.props.onClick();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(JSON.stringify(renderer.toJSON())).toContain("Cached answer");
  expect(JSON.stringify(renderer.toJSON())).toContain("Could not load conversation.");
  expect(renderer.root.findByType("textarea").props.disabled).toBe(true);

  await act(async () => {
    findByAriaLabel(renderer, "Retry conversation")!.props.onClick();
    await Promise.resolve();
  });
  await act(async () => {
    resolveRetry({ messages });
    await vi.waitFor(() => expect(findByAriaLabel(renderer, "Retry conversation")).toBeNull(), {
      interval: 1
    });
  });

  expect(renderer.root.findByType("textarea").props.disabled).toBeFalsy();
});
