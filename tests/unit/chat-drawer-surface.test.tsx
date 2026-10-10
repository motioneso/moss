import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
import { DEFAULT_CHAT_SURFACE, type ChatSurface } from "@moss/shared";
import { moduleChatSurface } from "../../apps/web/src/shell/chat-surface-key.js";
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
  listChatSkills: vi.fn(async () => ({ skills: [] })),
  resumeChat: vi.fn(async () => ({})),
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
  cancelChatTurn,
  clearChat,
  endPrivateChat,
  getChatPrivacyState,
  listChatThreadMessages,
  listChatThreads,
  resumeChat,
  sendChatTurn
} from "../../apps/web/src/api/client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";
const moduleSurface = moduleChatSurface("job-search", "profile-1") as ChatSurface;
const moduleSurfaceB = moduleChatSurface("job-search", "profile-2") as ChatSurface;
async function renderDrawer(surface: ChatSurface): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(ChatDrawer, {
            open: true,
            onClose: () => undefined,
            records: [],
            clearRecords: vi.fn(),
            streamErrorCount: 0,
            isFounder: false,
            surface
          }) as ReactElement
        )
      )
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}
function findByClassName(renderer: ReactTestRenderer, className: string) {
  const matches = renderer.root.findAll((node) => node.props.className === className);
  return matches.length > 0 ? matches[0] : null;
}
function findByAriaLabel(renderer: ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll((node) => node.props["aria-label"] === label);
  return matches.length > 0 ? matches[0] : null;
}
function menuIsOpen(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props.role === "menu").length > 0;
}
async function menuItem(renderer: ReactTestRenderer, label: string) {
  if (!menuIsOpen(renderer)) {
    await act(async () => {
      findByAriaLabel(renderer, "More chat options")!.props.onClick();
    });
  }
  if (label === "Start private chat") {
    return findByAriaLabel(renderer, label) ?? findByAriaLabel(renderer, "Leave private chat");
  }
  return findByAriaLabel(renderer, label);
}
async function clickMenuItem(renderer: ReactTestRenderer, label: string, flush = false) {
  const item = await menuItem(renderer, label);
  await act(async () => {
    item!.props.onClick();
    if (flush) {
      await Promise.resolve();
      await Promise.resolve();
    }
  });
}
async function openConversations(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    findByAriaLabel(renderer, "Open conversations")!.props.onClick();
  });
}
async function selectConversation(renderer: ReactTestRenderer, title: string): Promise<void> {
  await openConversations(renderer);
  await act(async () => {
    findByAriaLabel(renderer, title)!.props.onClick();
  });
}
async function startNewSideChat(renderer: ReactTestRenderer): Promise<void> {
  await openConversations(renderer);
  await act(async () => {
    findByAriaLabel(renderer, "New side chat")!.props.onClick();
  });
}
function buildElement(
  client: QueryClient,
  surface: ChatSurface,
  clearRecords: () => void,
  open = true,
  initialText?: string
): ReactElement {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      MemoryRouter,
      null,
      createElement(ChatDrawer, {
        open,
        onClose: () => undefined,
        records: [],
        clearRecords,
        streamErrorCount: 0,
        isFounder: false,
        initialText,
        surface
      }) as ReactElement
    )
  );
}
async function mountWithClient(
  client: QueryClient,
  surface: ChatSurface,
  clearRecords: () => void
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(buildElement(client, surface, clearRecords));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}
async function flipSurface(
  renderer: ReactTestRenderer,
  client: QueryClient,
  surface: ChatSurface,
  clearRecords: () => void
): Promise<void> {
  await act(async () => {
    renderer.update(buildElement(client, surface, clearRecords));
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function typeAndSend(renderer: ReactTestRenderer, text: string): Promise<void> {
  const textarea = renderer.root.findByType("textarea");
  await act(async () => {
    textarea.props.onChange({ target: { value: text } });
  });
  const sendButton = findByClassName(renderer, "chatd-send");
  await act(async () => {
    sendButton!.props.onClick();
    await Promise.resolve();
  });
}
describe("ChatDrawer surface routing (#1533)", () => {
  afterEach(() => {
    vi.mocked(sendChatTurn).mockClear();
    vi.mocked(cancelChatTurn).mockClear();
    vi.mocked(clearChat).mockClear();
    vi.mocked(getChatPrivacyState).mockClear();
    vi.mocked(listChatThreadMessages).mockClear();
    vi.mocked(listChatThreads).mockClear();
    vi.mocked(resumeChat).mockClear();
  });
  it("reads privacy state and thread history for the module surface, not the drawer's", async () => {
    await renderDrawer(moduleSurface);
    expect(getChatPrivacyState).toHaveBeenCalledWith(moduleSurface);
    expect(listChatThreads).toHaveBeenCalledWith(moduleSurface);
  });
  it("hides the private-chat control on a module surface", async () => {
    const renderer = await renderDrawer(moduleSurface);
    expect(await menuItem(renderer, "Start private chat")).toBeNull();
  });

  it("keeps conversations closed until the three-line trigger opens them", async () => {
    const renderer = await renderDrawer(DEFAULT_CHAT_SURFACE);

    expect(findByAriaLabel(renderer, "Open conversations")?.props["aria-expanded"]).toBe(false);
    expect(renderer.root.findAllByProps({ "aria-label": "Conversations" })).toHaveLength(0);

    await openConversations(renderer);

    expect(renderer.root.findAllByProps({ "aria-label": "Conversations" })).toHaveLength(1);
  });

  it("sends on the module surface, not the default drawer surface", async () => {
    const renderer = await renderDrawer(moduleSurface);
    await typeAndSend(renderer, "Remote only");
    expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith(
      "Remote only",
      undefined,
      undefined,
      moduleSurface
    );
  });

  it("routes Stop to cancelChatTurn on the module surface", async () => {
    let resolveSend!: (value: {
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      sourceFreshness: null;
    }) => void;
    vi.mocked(sendChatTurn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );

    const renderer = await renderDrawer(moduleSurface);
    const textarea = renderer.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "Remote only" } });
    });
    await act(async () => {
      findByClassName(renderer, "chatd-send")!.props.onClick();
      await Promise.resolve();
    });

    const stopButton = findByClassName(renderer, "chatd-send")!;
    expect(stopButton.props["aria-label"]).toBe("Stop generating");
    await act(async () => {
      stopButton.props.onClick();
    });

    expect(cancelChatTurn).toHaveBeenCalledWith(moduleSurface);

    await act(async () => {
      resolveSend({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "ok",
        sourceFreshness: null
      });
    });
  });

  it("drains a queued send after normal completion", async () => {
    let resolveFirst!: (value: {
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      sourceFreshness: null;
    }) => void;
    vi.mocked(sendChatTurn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );

    const renderer = await renderDrawer(moduleSurface);
    await typeAndSend(renderer, "first");
    const textarea = renderer.root.findByType("textarea");
    await act(async () => textarea.props.onChange({ target: { value: "second" } }));
    await act(async () => {
      textarea.props.onKeyDown({
        key: "Enter",
        shiftKey: false,
        preventDefault: () => undefined
      });
    });

    expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith(
      "first",
      undefined,
      undefined,
      moduleSurface
    );
    expect(findByClassName(renderer, "chatd-next__text")?.children.join("")).toBe('Next: "second"');

    await act(async () => {
      resolveFirst({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "first",
        sourceFreshness: null
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendChatTurn).toHaveBeenCalledTimes(2);
    expect(sendChatTurn).toHaveBeenLastCalledWith("second", undefined, undefined, moduleSurface);
  });

  it("keeps a queued send when the composer remounts before the first turn completes", async () => {
    let resolveFirst!: (value: {
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      sourceFreshness: null;
    }) => void;
    vi.mocked(sendChatTurn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, moduleSurface, clearRecords);
    await typeAndSend(renderer, "first");

    const textarea = renderer.root.findByType("textarea");
    await act(async () => textarea.props.onChange({ target: { value: "second" } }));
    await act(async () => {
      textarea.props.onKeyDown({
        key: "Enter",
        shiftKey: false,
        preventDefault: () => undefined
      });
    });
    expect(findByClassName(renderer, "chatd-next__text")?.children.join("")).toBe('Next: "second"');

    await act(async () => {
      renderer.update(buildElement(client, moduleSurface, clearRecords, false));
    });
    await act(async () => {
      renderer.update(buildElement(client, moduleSurface, clearRecords, true));
      await Promise.resolve();
    });

    await act(async () => {
      resolveFirst({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "first",
        sourceFreshness: null
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendChatTurn).toHaveBeenCalledTimes(2);
    expect(sendChatTurn).toHaveBeenLastCalledWith("second", undefined, undefined, moduleSurface);
  });

  it("routes New side chat to clearChat on the module surface", async () => {
    const renderer = await renderDrawer(moduleSurface);
    await startNewSideChat(renderer);
    expect(clearChat).toHaveBeenCalledWith({ surface: moduleSurface });
  });

  it("seeds a delayed starter and keeps an unselected module draft separate from Main", async () => {
    vi.mocked(getChatPrivacyState).mockResolvedValueOnce({
      incognito: false,
      threadId: "main-thread"
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(buildElement(client, DEFAULT_CHAT_SURFACE, clearRecords, false));
      renderer.update(
        buildElement(client, DEFAULT_CHAT_SURFACE, clearRecords, true, "Main starter")
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    let textarea = renderer.root.findByType("textarea");
    expect(textarea.props.value).toBe("Main starter");
    await act(async () => textarea.props.onChange({ target: { value: "Main draft" } }));

    await act(async () => {
      renderer.update(buildElement(client, moduleSurface, clearRecords, true, "Module starter"));
      await Promise.resolve();
      await Promise.resolve();
    });
    textarea = renderer.root.findByType("textarea");
    expect(textarea.props.value).toBe("Module starter");
    await act(async () => textarea.props.onChange({ target: { value: "Module draft" } }));

    await flipSurface(renderer, client, DEFAULT_CHAT_SURFACE, clearRecords);
    expect(renderer.root.findByType("textarea").props.value).toBe("Main draft");
  });

  it("waits for New side chat to finish before clearing the stream", async () => {
    let finish!: () => void;
    vi.mocked(clearChat).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, moduleSurface, clearRecords);
    await startNewSideChat(renderer);
    expect(clearChat).toHaveBeenCalledTimes(1);
    expect(clearRecords).not.toHaveBeenCalled();
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
    await act(async () => {
      finish();
    });
    expect(clearRecords).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("textarea").props.disabled).toBeFalsy();
  });

  it("does not clear a new surface when an earlier New side chat request finishes", async () => {
    let finish!: () => void;
    let resolveIdentity!: (state: { incognito: boolean }) => void;
    vi.mocked(clearChat).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, moduleSurface, clearRecords);
    await startNewSideChat(renderer);
    vi.mocked(getChatPrivacyState).mockImplementationOnce(
      () =>
        new Promise<{ incognito: boolean }>((resolve) => {
          resolveIdentity = resolve;
        })
    );
    await flipSurface(renderer, client, moduleSurfaceB, clearRecords);
    await act(async () => {
      resolveIdentity({ incognito: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      finish();
    });
    expect(clearRecords).not.toHaveBeenCalled();
    expect(renderer.root.findByType("textarea").props.disabled).toBeFalsy();
  });

  it("unblocks the composer when New side chat fails during a send", async () => {
    let finishSend!: (value: Awaited<ReturnType<typeof sendChatTurn>>) => void;
    vi.mocked(sendChatTurn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSend = resolve;
        })
    );
    vi.mocked(clearChat).mockRejectedValueOnce(new Error("Could not switch"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, moduleSurface, clearRecords);
    await typeAndSend(renderer, "first");
    await startNewSideChat(renderer);
    expect(clearRecords).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("Could not switch");
    await act(async () => {
      finishSend({
        userMessageId: "old-user",
        assistantMessageId: "old-reply",
        reply: "old",
        sourceFreshness: null
      });
    });
    await typeAndSend(renderer, "second");
    expect(sendChatTurn).toHaveBeenCalledTimes(2);
  });

  it("waits for private close before clearing and reconnecting the transcript", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, clearRecords);
    await clickMenuItem(renderer, "Start private chat", true);
    clearRecords.mockClear();
    let finish!: () => void;
    vi.mocked(endPrivateChat).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await clickMenuItem(renderer, "Start private chat");
    expect(clearRecords).not.toHaveBeenCalled();
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
    await act(async () => {
      finish();
    });
    expect(clearRecords).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("textarea").props.disabled).toBeFalsy();
  });

  it("shows the private-chat control and sends on the default drawer surface", async () => {
    const renderer = await renderDrawer(DEFAULT_CHAT_SURFACE);
    expect(await menuItem(renderer, "Start private chat")).not.toBeNull();

    await typeAndSend(renderer, "Remote only");
    expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith(
      "Remote only",
      undefined,
      undefined,
      DEFAULT_CHAT_SURFACE
    );
  });

  it("keeps Main and private drafts separate", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, vi.fn());
    const textarea = renderer.root.findByType("textarea");

    await act(async () => textarea.props.onChange({ target: { value: "Main draft" } }));
    await clickMenuItem(renderer, "Start private chat", true);
    expect(renderer.root.findByType("textarea").props.value).toBe("");

    await act(async () =>
      renderer.root.findByType("textarea").props.onChange({ target: { value: "Private draft" } })
    );
    await clickMenuItem(renderer, "Start private chat", true);
    expect(renderer.root.findByType("textarea").props.value).toBe("Main draft");
  });

  it("clears local surface state on a surface flip", async () => {
    vi.mocked(listChatThreads).mockResolvedValueOnce({
      threads: [
        {
          id: "t1",
          ownerUserId: "user-1",
          title: "Old thread",
          incognito: false,
          isMain: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lastActiveAt: "2026-01-01T00:00:00Z",
          lastMessagePreview: null
        }
      ]
    });
    let resolveSend!: (value: {
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      sourceFreshness: null;
    }) => void;
    vi.mocked(sendChatTurn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, clearRecords);

    const textarea = renderer.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "Remote only" } });
    });
    await act(async () => {
      findByClassName(renderer, "chatd-send")!.props.onClick();
      await Promise.resolve();
    });

    await selectConversation(renderer, "Old thread");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByClassName(renderer, "chatd-send")?.props["aria-label"]).toBe("Send");

    await flipSurface(renderer, client, moduleSurface, clearRecords);

    expect(findByClassName(renderer, "chatd-empty")).not.toBeNull();
    expect(findByClassName(renderer, "chatd-send")?.props["aria-label"]).toBe("Send");
    expect(findByAriaLabel(renderer, "Open conversations")?.props["aria-expanded"]).toBe(false);

    await act(async () => {
      resolveSend({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "ok",
        sourceFreshness: null
      });
    });
  });

  it("shows a retry action when the selected conversation transcript cannot load", async () => {
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
    vi.mocked(listChatThreadMessages).mockRejectedValueOnce(new Error("offline"));
    const renderer = await renderDrawer(DEFAULT_CHAT_SURFACE);

    await selectConversation(renderer, "Broken thread");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain("Could not load conversation.");
    expect(findByAriaLabel(renderer, "Retry conversation")).not.toBeNull();
  });

  it("shows side chats in the order the server sent them, not resorted by the client", async () => {
    vi.mocked(listChatThreads).mockResolvedValueOnce({
      threads: [
        {
          id: "t-resumed",
          ownerUserId: "user-1",
          title: "resumed",
          incognito: false,
          isMain: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lastActiveAt: "2026-03-03T00:00:00Z",
          lastMessagePreview: null
        },
        {
          id: "t-middle",
          ownerUserId: "user-1",
          title: "middle",
          incognito: false,
          isMain: false,
          createdAt: "2026-02-01T00:00:00Z",
          updatedAt: "2026-02-01T00:00:00Z",
          lastActiveAt: "2026-02-01T00:00:00Z",
          lastMessagePreview: null
        },
        {
          id: "t-newest-updated",
          ownerUserId: "user-1",
          title: "newest-updated",
          incognito: false,
          isMain: false,
          createdAt: "2026-03-01T00:00:00Z",
          updatedAt: "2026-03-01T00:00:00Z",
          lastActiveAt: "2026-01-01T00:00:00Z",
          lastMessagePreview: null
        }
      ]
    });

    const renderer = await renderDrawer(DEFAULT_CHAT_SURFACE);

    await openConversations(renderer);

    const titles = ["resumed", "middle", "newest-updated"];
    const rows = renderer.root.findAll((node) => titles.includes(node.props["aria-label"]));
    expect(rows.map((row) => row.props["aria-label"])).toEqual(titles);
  });

  it("opens conversations without changing the transcript scroll position", async () => {
    vi.mocked(listChatThreads).mockResolvedValueOnce({
      threads: [
        {
          id: "t-newest",
          ownerUserId: "user-1",
          title: "newest",
          incognito: false,
          isMain: false,
          createdAt: "2026-03-01T00:00:00Z",
          updatedAt: "2026-03-01T00:00:00Z",
          lastActiveAt: "2026-03-01T00:00:00Z",
          lastMessagePreview: null
        },
        {
          id: "t-oldest",
          ownerUserId: "user-1",
          title: "oldest",
          incognito: false,
          isMain: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lastActiveAt: "2026-01-01T00:00:00Z",
          lastMessagePreview: null
        }
      ]
    });

    const scrollRequests: number[] = [];
    const bodyMock = {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTo(options: { top: number }) {
        scrollRequests.push(options.top);
        this.scrollTop = options.top;
      }
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(buildElement(client, DEFAULT_CHAT_SURFACE, vi.fn()), {
        createNodeMock: (element) =>
          (element.props as { className?: string }).className === "chatd__body" ? bodyMock : null
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const scrollCountBeforeOpen = scrollRequests.length;
    await openConversations(renderer);

    expect(scrollRequests).toHaveLength(scrollCountBeforeOpen);
  });

  it("guards a stale sendChatTurn resolution — invalidates the surface it started on", async () => {
    let resolveSend!: (value: {
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      sourceFreshness: null;
    }) => void;
    vi.mocked(sendChatTurn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, moduleSurface, clearRecords);

    const textarea = renderer.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "Remote only" } });
    });
    await act(async () => {
      findByClassName(renderer, "chatd-send")!.props.onClick();
      await Promise.resolve();
    });

    await flipSurface(renderer, client, moduleSurfaceB, clearRecords);

    await act(async () => {
      resolveSend({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "ok",
        sourceFreshness: null
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.chat.threads(moduleSurface) });
    expect(findByClassName(renderer, "chatd-empty")).not.toBeNull();
    expect(findByClassName(renderer, "chatd-send")?.props["aria-label"]).toBe("Send");
  });

  it("guards stale resumeChat/startPrivateChat and discards a queued Stop after a flip", async () => {
    let resolvePrivate!: (value: undefined) => void;
    vi.mocked(clearChat).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrivate = resolve;
        })
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecords = vi.fn();
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, clearRecords);

    vi.mocked(listChatThreads).mockResolvedValueOnce({
      threads: [
        {
          id: "t1",
          ownerUserId: "user-1",
          title: "Job thread",
          incognito: false,
          isMain: false,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          lastActiveAt: "2026-01-02T00:00:00Z",
          lastMessagePreview: null
        }
      ]
    });
    await clickMenuItem(renderer, "Start private chat");
    await flipSurface(renderer, client, moduleSurface, clearRecords);
    await act(async () => {
      resolvePrivate(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearRecords).not.toHaveBeenCalled();

    let resolveResume!: (value: void) => void;
    vi.mocked(resumeChat).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        })
    );
    await selectConversation(renderer, "Job thread");
    await flipSurface(renderer, client, moduleSurfaceB, clearRecords);
    await act(async () => {
      resolveResume(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearRecords).not.toHaveBeenCalled();

    let resolveSend!: (value: {
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      sourceFreshness: null;
    }) => void;
    vi.mocked(sendChatTurn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );
    const textarea = renderer.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "first" } });
    });
    await act(async () => {
      findByClassName(renderer, "chatd-send")!.props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      textarea.props.onChange({ target: { value: "queued" } });
    });
    await act(async () => {
      textarea.props.onKeyDown({
        key: "Enter",
        shiftKey: false,
        preventDefault: () => undefined
      });
    });
    await act(async () => {
      findByClassName(renderer, "chatd-send")!.props.onClick();
    });

    const callsBefore = vi.mocked(sendChatTurn).mock.calls.length;
    await flipSurface(renderer, client, DEFAULT_CHAT_SURFACE, clearRecords);
    expect(vi.mocked(sendChatTurn).mock.calls.length).toBe(callsBefore);

    await act(async () => {
      resolveSend({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "ok",
        sourceFreshness: null
      });
    });
  });

  it("resets state on a flip in both directions", async () => {
    const clientA = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecordsA = vi.fn();
    const rendererA = await mountWithClient(clientA, moduleSurface, clearRecordsA);

    await openConversations(rendererA);

    vi.mocked(sendChatTurn).mockRejectedValueOnce(new Error("boom"));
    const textarea = rendererA.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "fails" } });
    });
    await act(async () => {
      findByClassName(rendererA, "chatd-send")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findByClassName(rendererA, "form-error")).not.toBeNull();

    await flipSurface(rendererA, clientA, moduleSurfaceB, clearRecordsA);

    expect(findByClassName(rendererA, "form-error")).toBeNull();
    expect(findByAriaLabel(rendererA, "Open conversations")?.props["aria-expanded"]).toBe(false);

    const clientB = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecordsB = vi.fn();
    const rendererB = await mountWithClient(clientB, DEFAULT_CHAT_SURFACE, clearRecordsB);

    await clickMenuItem(rendererB, "Start private chat", true);
    await openConversations(rendererB);
    expect((await menuItem(rendererB, "Start private chat"))?.props["aria-checked"]).toBe(true);

    await flipSurface(rendererB, clientB, moduleSurface, clearRecordsB);

    expect(await menuItem(rendererB, "Start private chat")).toBeNull();
    expect(findByAriaLabel(rendererB, "Open conversations")?.props["aria-expanded"]).toBe(false);
  });

  it("keeps private mode on when a privacy response arrives after the user turned it on", async () => {
    let releasePrivacy!: (state: { incognito: boolean }) => void;
    vi.mocked(getChatPrivacyState).mockImplementationOnce(
      () =>
        new Promise<{ incognito: boolean }>((resolve) => {
          releasePrivacy = resolve;
        })
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, vi.fn());

    await clickMenuItem(renderer, "Start private chat", true);
    expect((await menuItem(renderer, "Start private chat"))?.props["aria-checked"]).toBe(true);

    await act(async () => {
      releasePrivacy({ incognito: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((await menuItem(renderer, "Start private chat"))?.props["aria-checked"]).toBe(true);
  });

  it("leaves private chat when the checked More menu item is chosen again", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, vi.fn());
    vi.mocked(clearChat).mockClear();
    vi.mocked(endPrivateChat).mockClear();

    await clickMenuItem(renderer, "Start private chat", true);
    expect((await menuItem(renderer, "Start private chat"))?.props["aria-checked"]).toBe(true);
    expect(clearChat).toHaveBeenCalledTimes(1);
    expect(findByAriaLabel(renderer, "Leave private chat")).not.toBeNull();
    expect(findByAriaLabel(renderer, "Start private chat")).toBeNull();

    await clickMenuItem(renderer, "Start private chat", true);

    expect(endPrivateChat).toHaveBeenCalledWith(DEFAULT_CHAT_SURFACE);
    expect(clearChat).toHaveBeenCalledTimes(1);
    expect((await menuItem(renderer, "Start private chat"))?.props["aria-checked"]).toBe(false);
    expect(findByAriaLabel(renderer, "Start private chat")).not.toBeNull();
    expect(findByAriaLabel(renderer, "Leave private chat")).toBeNull();
  });

  it("still seeds private mode from the server when the user has not touched the toggle", async () => {
    vi.mocked(getChatPrivacyState).mockImplementationOnce(async () => ({ incognito: true }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, vi.fn());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((await menuItem(renderer, "Start private chat"))?.props["aria-checked"]).toBe(true);
  });
});
