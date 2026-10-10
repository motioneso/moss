/** WEB-01: the drawer keeps the typed draft when it refuses a send, and clears it when it accepts. */
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

// No jsdom in this environment; ChatDrawer's private-mode effect registers a real
// `beforeunload` listener once privateMode goes true, which only this file's tests drive.
vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
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

import { clearChat, sendChatTurn } from "../../apps/web/src/api/client.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

async function mountDrawer(): Promise<ReactTestRenderer> {
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
            surface: DEFAULT_CHAT_SURFACE
          }) as ReactElement
        )
      )
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

const textarea = (renderer: ReactTestRenderer) => renderer.root.findByType("textarea");

async function typeText(renderer: ReactTestRenderer, value: string) {
  await act(async () => {
    textarea(renderer).props.onChange({ target: { value } });
  });
}

async function pressEnter(renderer: ReactTestRenderer) {
  await act(async () => {
    textarea(renderer).props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault: () => {} });
    await Promise.resolve();
  });
}

async function clickByLabel(renderer: ReactTestRenderer, label: string) {
  await act(async () => {
    renderer.root.find((n) => n.props["aria-label"] === label).props.onClick();
    await Promise.resolve();
  });
}

describe("ChatDrawer send refusal (WEB-01)", () => {
  afterEach(() => vi.clearAllMocks());

  it("keeps the typed draft when the drawer refuses the send", async () => {
    const renderer = await mountDrawer();

    // Starting a private chat waits on the server. The box stays editable but the drawer refuses sends.
    vi.mocked(clearChat).mockImplementationOnce(() => new Promise<void>(() => undefined));
    await clickByLabel(renderer, "More chat options");
    await clickByLabel(renderer, "Start private chat");
    await typeText(renderer, "keep this draft");
    await pressEnter(renderer);

    expect(sendChatTurn).not.toHaveBeenCalled();
    expect(textarea(renderer).props.value).toBe("keep this draft");
  });

  it("clears the draft when the drawer accepts the send", async () => {
    const renderer = await mountDrawer();
    await typeText(renderer, "send this");
    await pressEnter(renderer);

    expect(sendChatTurn).toHaveBeenCalledOnce();
    expect(textarea(renderer).props.value).toBe("");
  });
});
