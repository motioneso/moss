import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

import { DEFAULT_CHAT_SURFACE, type TranscriptRecord } from "@moss/shared";
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

import { sendChatTurn } from "../../apps/web/src/api/client.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";
import { VoiceInputThread } from "../../apps/web/src/chat/voice-requests.js";

vi.mock("virtual:moss-module-web", () => ({
  MODULE_WEB_ROUTES: [],
  MODULE_WEB_CONTRIBUTIONS: [],
  MODULE_PERSISTENT_CONTROLS: [],
  MODULE_VISUAL_CONTRACTS: [],
  MODULE_VISUAL_RENDERERS: []
}));
it("keeps the sent message on screen while the turn runs, even when an earlier message has the same words", async () => {
  let finish!: () => void;
  vi.mocked(sendChatTurn).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            userMessageId: "user-2",
            assistantMessageId: "assistant-2",
            reply: "ok",
            sourceFreshness: null
          });
      })
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const earlier = { kind: "user" as const, text: "hi", messageId: "user-1" };
  const element = () =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(ChatDrawer, {
          open: true,
          onClose: () => {},
          records: [earlier, { kind: "reply" as const, text: "hello", messageId: "assistant-1" }],
          clearRecords: () => {},
          streamErrorCount: 0,
          isFounder: false,
          surface: DEFAULT_CHAT_SURFACE
        })
      )
    );
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(element());
    });
    await vi.waitFor(async () => {
      await act(async () =>
        expect(renderer.root.findByType("textarea").props.disabled).toBe(false)
      );
    });
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "hi" } });
    });
    await act(async () => {
      renderer.root
        .findAll((n) => n.type === "button" && n.props["aria-label"] === "Send")[0]!
        .props.onClick();
    });
    const shown = (): readonly TranscriptRecord[] =>
      renderer.root.findByType(VoiceInputThread).props.records;
    expect(shown().filter((r) => r.kind === "user" && r.text === "hi")).toHaveLength(2);
    await act(async () => finish());
    await vi.waitFor(async () => {
      await act(async () =>
        expect(renderer.root.findByType("textarea").props.disabled).toBe(false)
      );
    });
  } finally {
    await act(async () => renderer?.unmount());
    client.clear();
  }
});
