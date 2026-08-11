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

import { DEFAULT_CHAT_SURFACE, type ChatSurface } from "@moss/shared";
import { moduleChatSurface } from "../../apps/web/src/shell/chat-surface-key.js";

vi.mock("../../apps/web/src/api/client.js", () => ({
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
  sendChatTurn
} from "../../apps/web/src/api/client.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

const moduleSurface = moduleChatSurface("job-search", "profile-1") as ChatSurface;

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
  return renderer.root.find((node) => node.props.className === className);
}

function findByAriaLabel(renderer: ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll((node) => node.props["aria-label"] === label);
  return matches.length > 0 ? matches[0] : null;
}

async function typeAndSend(renderer: ReactTestRenderer, text: string): Promise<void> {
  const textarea = renderer.root.findByType("textarea");
  await act(async () => {
    textarea.props.onChange({ target: { value: text } });
  });
  const sendButton = findByClassName(renderer, "chatd-send");
  await act(async () => {
    sendButton.props.onClick();
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
      findByClassName(renderer, "chatd-send").props.onClick();
      await Promise.resolve();
    });

    // sendChatTurn's promise is still pending, so the drawer is mid-send — the send button has
    // flipped to Stop.
    const stopButton = findByClassName(renderer, "chatd-send");
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
});
