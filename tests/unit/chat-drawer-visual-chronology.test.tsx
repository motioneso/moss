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

import { installBuiltInVisualTemplates, type VisualReplyV1 } from "@moss/shared";
import { sendChatTurn } from "../../apps/web/src/api/client.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";
import { VoiceInputThread } from "../../apps/web/src/chat/voice-requests.js";

vi.mock("virtual:moss-module-web", () => ({
  MODULE_WEB_ROUTES: [],
  MODULE_WEB_CONTRIBUTIONS: [],
  MODULE_PERSISTENT_CONTROLS: [],
  MODULE_VISUAL_CONTRACTS: [],
  MODULE_VISUAL_RENDERERS: [
    async () => ({
      default: {
        "test.chronology": ({ snapshot }: { snapshot: { retrievedAt: string } }) =>
          createElement("p", null, `Source retrieved ${snapshot.retrievedAt}`)
      }
    })
  ]
}));
installBuiltInVisualTemplates([
  {
    kind: "test.chronology",
    snapshotKind: "test.chronology",
    validate: () => true,
    format: () => "chronology"
  }
]);
const time2 = "2026-10-24T18:15:17.599Z";
const time3 = "2026-10-24T18:15:26.289Z";
function visual(timestamp: string): VisualReplyV1 {
  return {
    version: 1,
    catalogVersion: "moss.builtins.1",
    blocks: [{ blockId: "block", kind: "test.chronology", snapshotRefs: ["snapshot"] }],
    snapshots: [
      {
        ref: "snapshot",
        kind: "test.chronology",
        origin: "source",
        source: { id: "test", label: "Test source" },
        retrievedAt: timestamp,
        coverage: "One result",
        fields: { value: 2 }
      }
    ],
    interactions: [],
    fallbackText: `Source retrieved ${timestamp}`
  };
}
const r2 = {
  kind: "reply" as const,
  text: "Reply 2",
  messageId: "f319efa3-3b82-4420-9212-8d71b41f2750",
  visualReply: visual(time2)
};
const r3 = {
  kind: "reply" as const,
  text: "Reply 3",
  messageId: "bbfbd37d-eb69-4a47-90f8-a34936901d14",
  visualReply: visual(time3)
};
const u2 = { kind: "user" as const, text: "prompt 2", messageId: "user-2" };
const u3 = { kind: "user" as const, text: "prompt 3", messageId: "user-3" };

it("keeps a saved HTTP-only reply before a later streamed reply at the actual ChatDrawer visual boundary", async () => {
  vi.mocked(sendChatTurn)
    .mockResolvedValueOnce({
      userMessageId: u2.messageId,
      assistantMessageId: r2.messageId,
      reply: r2.text,
      sourceFreshness: null,
      visualReply: r2.visualReply
    })
    .mockResolvedValueOnce({
      userMessageId: u3.messageId,
      assistantMessageId: r3.messageId,
      reply: r3.text,
      sourceFreshness: null,
      visualReply: r3.visualReply
    });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let live: readonly TranscriptRecord[] = [];
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
          records: live,
          clearRecords: () => {},
          streamErrorCount: 0,
          isFounder: false,
          surface: DEFAULT_CHAT_SURFACE
        })
      )
    );
  let renderer!: ReactTestRenderer;
  async function send(text: string) {
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: text } });
    });
    await act(async () => {
      renderer.root
        .findAll((n) => n.type === "button" && n.props["aria-label"] === "Send")[0]!
        .props.onClick();
    });
    await vi.waitFor(async () => {
      await act(async () =>
        expect(renderer.root.findByType("textarea").props.disabled).toBe(false)
      );
    });
  }
  try {
    await act(async () => {
      renderer = create(element());
    });
    await vi.waitFor(async () => {
      await act(async () =>
        expect(renderer.root.findByType("textarea").props.disabled).toBe(false)
      );
    });
    await send(u2.text);
    // The user's event arrives, but reply 2's SSE event is lost. Its saved HTTP fallback remains.
    live = [u2];
    await act(async () => renderer.update(element()));
    await send(u3.text);
    // The later turn is streamed and reconciles with its HTTP fallback.
    live = [u2, u3, r3];
    await act(async () => renderer.update(element()));
    await vi.waitFor(async () => {
      await act(async () => expect(JSON.stringify(renderer.toJSON())).toContain(time3));
    });
    const records: readonly TranscriptRecord[] =
      renderer.root.findByType(VoiceInputThread).props.records;
    const replies = records.filter((r) => r.kind === "reply");
    const slots = renderer.root.findAll(
      (n) => n.type === "div" && n.props["aria-label"] === "Visual reply"
    );
    expect(slots).toHaveLength(2);
    expect(
      slots
        .at(-1)
        ?.findAll((n) => n.type === "p")
        .map((n) => n.children.join(""))
    ).toContain(`Source retrieved ${time3}`);
    expect(replies.map((r) => r.messageId)).toEqual([r2.messageId, r3.messageId]);
  } finally {
    await act(async () => renderer?.unmount());
    client.clear();
  }
});
