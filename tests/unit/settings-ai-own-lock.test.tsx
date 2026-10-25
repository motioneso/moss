// @vitest-environment jsdom
// The per-account AI lock lives on Personal > Your assistant (admins only), and a set lock turns
// the chat model picker off.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { MeResponse } from "@moss/shared";

const model = {
  id: "m1",
  providerConfigId: "p1",
  providerKind: "anthropic",
  providerAcpAgentId: "claude-acp",
  providerDisplayName: "Claude",
  modelId: "claude-x",
  displayName: "Claude X",
  capabilities: ["chat"]
};
const pinGet = vi.fn(async (_id: string) => ({
  pin: {
    pinnedModelId: null as string | null,
    pinnedModel: null,
    pinnedProviderId: null,
    pinnedProvider: null,
    effectiveChatModel: model,
    effectiveChatReason: "default",
    availableModels: [model],
    availableProviders: []
  }
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  getMe: vi.fn(async () => ({ user: { id: "u1" } })),
  putChatSettings: vi.fn(),
  putChatModelOverride: vi.fn(),
  putYoloSelf: vi.fn(),
  putChatArchiveSettings: vi.fn(),
  putPersonaSettings: vi.fn(),
  previewPersona: vi.fn(),
  getPersonaSettings: vi.fn(async () => ({
    persona: { assistantName: "Moss", personaText: "Be direct." }
  })),
  getChatSettings: vi.fn(async () => ({ chat: { responseStyle: "balanced" } })),
  getChatModelOverrideSettings: vi.fn(async () => ({
    settings: {
      overrideEnabled: true,
      currentOverrideModelId: null,
      effectiveOverrideModelId: null,
      defaultModel: model,
      selectedModel: null,
      selectableOverrideModels: [model]
    }
  })),
  getYoloSettings: vi.fn(async () => ({
    instanceEnabled: false,
    self: { allowed: false, enabled: false, active: false }
  })),
  getChatArchiveSettings: vi.fn(async () => ({ enabled: false, folder: "" }))
}));
vi.mock("../../apps/web/src/api/client-admin.js", () => ({
  getAdminUserAiPin: (id: string) => pinGet(id),
  putAdminUserAiPin: vi.fn()
}));
vi.mock("../../apps/web/src/api/notes-client.js", () => ({
  getNotesSource: vi.fn(async () => ({ path: null }))
}));

import { AssistantPane } from "../../apps/web/src/settings/settings-ai-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

function meWith(isInstanceAdmin: boolean): MeResponse {
  return {
    user: {
      id: "u1",
      email: "u@example.test",
      emailVerified: true,
      name: "U",
      status: "active",
      isInstanceAdmin,
      isBootstrapOwner: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  };
}

async function render(isAdmin: boolean): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          FeedbackProvider,
          null,
          createElement(AssistantPane, { me: meWith(isAdmin), onNavigate: () => {} })
        )
      )
    );
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return renderer;
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const picker = (renderer: ReactTestRenderer) =>
  renderer.root.findByProps({ "aria-label": "Chat model" });

describe("own AI lock on Your assistant", () => {
  it("shows the lock to an admin, with what it covers, and leaves the picker on while unlocked", async () => {
    const renderer = await render(true);
    expect(text(renderer)).toContain("Lock my own AI to one model");
    expect(text(renderer)).toContain("chat, voice and background work");
    expect(picker(renderer).props.disabled).toBeFalsy();
  });

  it("turns the picker off and says why once a model is locked", async () => {
    const pinned = await pinGet("u1");
    pinGet.mockResolvedValue({
      pin: { ...pinned.pin, pinnedModelId: "m1" as never }
    });
    const renderer = await render(true);
    expect(picker(renderer).props.disabled).toBe(true);
    expect(text(renderer)).toContain("Your own AI lock is set below");
    pinGet.mockReset();
  });

  it("hides the lock from a non-admin and never asks for it", async () => {
    pinGet.mockClear();
    const renderer = await render(false);
    expect(text(renderer)).not.toContain("Lock my own AI");
    expect(pinGet).not.toHaveBeenCalled();
  });
});
