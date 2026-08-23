/**
 * #1533 — ChatDrawer's routing half: every API call the drawer makes must carry `props.surface`
 * (already threaded through in commit 57f92ce2e), and the "Start private chat" control must only
 * ever appear on the default drawer surface, never inside a module surface (private chat is a
 * drawer-only concept — see plan `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md`).
 *
 * Rendered interactively (not `renderToString`) via `react-test-renderer` so real `onClick`/
 * `onChange` handlers can be invoked, the same pattern as `assistant-surface-composer.test.tsx`
 * and `chat-composer-voice.test.tsx` — this repo's vitest environment is `node` (no jsdom), so
 * `act`+`react-test-renderer` is the only way to drive a real interaction without a DOM.
 */
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

// No jsdom in this environment; ChatDrawer's private-mode effect registers a real
// `beforeunload` listener once privateMode goes true, which only this file's tests drive.
vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

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
  }))
}));

import {
  cancelChatTurn,
  clearChat,
  getChatPrivacyState,
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
    // Let the persona/route/privacy/threads queries this mount kicks off resolve and re-render.
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

function buildElement(
  client: QueryClient,
  surface: ChatSurface,
  clearRecords: () => void
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
        clearRecords,
        streamErrorCount: 0,
        isFounder: false,
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
    expect(findByAriaLabel(renderer, "Start private chat")).toBeNull();
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

    // sendChatTurn's promise is still pending, so the drawer is mid-send — the send button has
    // flipped to Stop.
    const stopButton = findByClassName(renderer, "chatd-send")!;
    expect(stopButton.props["aria-label"]).toBe("Stop generating");
    await act(async () => {
      stopButton.props.onClick();
    });

    expect(cancelChatTurn).toHaveBeenCalledWith(moduleSurface);

    // Settle the pending send so the test doesn't leave a dangling unresolved promise.
    await act(async () => {
      resolveSend({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "ok",
        sourceFreshness: null
      });
    });
  });

  it("routes New Chat to clearChat on the module surface", async () => {
    const renderer = await renderDrawer(moduleSurface);
    const newChatButton = findByAriaLabel(renderer, "New chat");
    await act(async () => {
      newChatButton?.props.onClick();
    });
    expect(clearChat).toHaveBeenCalledWith({ surface: moduleSurface });
  });

  it("shows the private-chat control and sends on the default drawer surface", async () => {
    const renderer = await renderDrawer(DEFAULT_CHAT_SURFACE);
    expect(findByAriaLabel(renderer, "Start private chat")).not.toBeNull();

    await typeAndSend(renderer, "Remote only");
    expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith(
      "Remote only",
      undefined,
      undefined,
      DEFAULT_CHAT_SURFACE
    );
  });

  it("clears local surface state on a surface flip", async () => {
    vi.mocked(listChatThreads).mockResolvedValueOnce({
      threads: [
        {
          id: "t1",
          ownerUserId: "user-1",
          title: "Old thread",
          incognito: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z"
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

    await act(async () => {
      findByAriaLabel(renderer, "Show chat history")?.props.onClick();
    });
    const row = findByClassName(renderer, "chatd-sess__row");
    await act(async () => {
      row!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    await flipSurface(renderer, client, moduleSurface, clearRecords);

    expect(findByClassName(renderer, "chatd-empty")).not.toBeNull();
    expect(findByClassName(renderer, "chatd-send")?.props["aria-label"]).toBe("Send");
    expect(findByAriaLabel(renderer, "Hide chat history")).toBeNull();

    await act(async () => {
      resolveSend({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        reply: "ok",
        sourceFreshness: null
      });
    });
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

    // Stage 1: start private chat on the default surface, flip before it resolves. Prime the
    // moduleSurface thread-list response now too — its query fires as soon as we flip below, so
    // this must be queued before that flip, not at the start of stage 2.
    vi.mocked(listChatThreads).mockResolvedValueOnce({
      threads: [
        {
          id: "t1",
          ownerUserId: "user-1",
          title: "Job thread",
          incognito: false,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z"
        }
      ]
    });
    await act(async () => {
      findByAriaLabel(renderer, "Start private chat")?.props.onClick();
    });
    await flipSurface(renderer, client, moduleSurface, clearRecords);
    await act(async () => {
      resolvePrivate(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearRecords).not.toHaveBeenCalled();

    // Stage 2: resume that thread on moduleSurface, flip before it resolves. Still on
    // moduleSurface from stage 1's flip — no re-flip needed (a same-value flip wouldn't
    // re-trigger the already-fetched thread-list query anyway).
    let resolveResume!: (value: void) => void;
    vi.mocked(resumeChat).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        })
    );
    await act(async () => {
      findByAriaLabel(renderer, "Show chat history")?.props.onClick();
    });
    const row = findByClassName(renderer, "chatd-sess__row")!;
    await act(async () => {
      row.props.onClick();
    });
    await flipSurface(renderer, client, moduleSurfaceB, clearRecords);
    await act(async () => {
      resolveResume(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearRecords).not.toHaveBeenCalled();

    // Stage 3: queue a Stop-drained message on moduleSurfaceB, flip before it can drain.
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
    // moduleSurface -> moduleSurfaceB: showHistory + sendError reset.
    const clientA = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecordsA = vi.fn();
    const rendererA = await mountWithClient(clientA, moduleSurface, clearRecordsA);

    await act(async () => {
      findByAriaLabel(rendererA, "Show chat history")?.props.onClick();
    });

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
    expect(findByAriaLabel(rendererA, "Hide chat history")).toBeNull();

    // DEFAULT_CHAT_SURFACE -> moduleSurface: privateMode + showHistory reset.
    const clientB = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearRecordsB = vi.fn();
    const rendererB = await mountWithClient(clientB, DEFAULT_CHAT_SURFACE, clearRecordsB);

    await act(async () => {
      findByAriaLabel(rendererB, "Start private chat")?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      findByAriaLabel(rendererB, "Show chat history")?.props.onClick();
    });
    expect(findByAriaLabel(rendererB, "Start private chat")?.props["aria-pressed"]).toBe(true);

    await flipSurface(rendererB, clientB, moduleSurface, clearRecordsB);

    expect(findByAriaLabel(rendererB, "Start private chat")).toBeNull();
    expect(findByAriaLabel(rendererB, "Hide chat history")).toBeNull();
  });

  // #1780. The drawer seeds private mode from the server on open, and the toggle sets it from what
  // the user just did. Nothing ordered the two, so a privacy response still in flight when the user
  // pressed the button landed second and wrote its stale "not private" over a session that had
  // already gone private — the drawer then said "not private" about a private session, which is the
  // one direction this control must never be wrong in.
  //
  // The ordering used to depend on which microtask the query happened to settle in, which is why it
  // failed roughly one CI run in ten and never locally. Here the response is held open deliberately
  // and released after the click, so a regression fails every run rather than one in ten.
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

    // The user turns private mode on while the privacy fetch is still outstanding.
    await act(async () => {
      findByAriaLabel(renderer, "Start private chat")?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findByAriaLabel(renderer, "Start private chat")?.props["aria-pressed"]).toBe(true);

    // Now the stale answer comes back saying the session is not private. It must not win.
    // Flushed with a macrotask, not a couple of microtask drains: react-query notifies through its
    // own scheduler, so a microtask-only drain returns before the effect that would clobber the flag
    // has run, and the test would pass without ever exercising the race.
    await act(async () => {
      releasePrivacy({ incognito: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(findByAriaLabel(renderer, "Start private chat")?.props["aria-pressed"]).toBe(true);
  });

  // The other half of the same rule: seeding still has to work when the user has done nothing, or a
  // reload during a private session would come back showing the session as ordinary.
  it("still seeds private mode from the server when the user has not touched the toggle", async () => {
    vi.mocked(getChatPrivacyState).mockImplementationOnce(async () => ({ incognito: true }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = await mountWithClient(client, DEFAULT_CHAT_SURFACE, vi.fn());
    // A macrotask rather than the usual pair of microtask drains: the seeded value has to travel
    // query -> effect -> re-render, and counting ticks is exactly the guesswork that made this file
    // flaky in the first place.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(findByAriaLabel(renderer, "Start private chat")?.props["aria-pressed"]).toBe(true);
  });
});
