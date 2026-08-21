/**
 * #1756 — the chat drawer's "docked to a running draft" mode: a `docked` prop that renders the
 * drawer in the document flow beside the draft page at desktop width, rather than as the fixed
 * global overlay. The CSS media query (not this test) falls back to the ordinary overlay at the
 * mobile breakpoint — the mockup's stacked layout is a static-file limitation and must not be
 * copied, per the design ruling on `draft.html`.
 *
 * Same no-jsdom / react-test-renderer pattern as chat-drawer-surface.test.tsx.
 */
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

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
  }))
}));

import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

async function renderDrawer(docked?: boolean): Promise<ReactTestRenderer> {
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
            surface: DEFAULT_CHAT_SURFACE,
            docked
          }) as ReactElement
        )
      )
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe("ChatDrawer docked mode (#1756)", () => {
  it("renders the plain overlay dialog when docked is not set", async () => {
    const renderer = await renderDrawer();
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.props.className).toBe("chatd");
  });

  it("adds the docked modifier class when docked is true", async () => {
    const renderer = await renderDrawer(true);
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.props.className).toBe("chatd chatd--docked");
  });
});
