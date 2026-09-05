/**
 * #1533 — ChatModelPill's routing half: a same-provider mutation must call `switchChatProvider`
 * and invalidate the threads query for the exact `surface` the pill was invoked on (not a
 * hardcoded drawer default), and `ChatDrawer` must forward its own `props.surface` into the pill
 * unchanged. See plan `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md`
 * Phase 3.
 *
 * Rendered interactively via `react-test-renderer` (this repo's vitest environment is `node`, no
 * jsdom) — same pattern as `chat-drawer-surface.test.tsx`.
 */
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No jsdom — ChatModelPill's dismissable-menu effect registers real `document` listeners once
// its menu opens, and ChatDrawer's private-mode effect touches `window`.
vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

import { DEFAULT_CHAT_SURFACE, type AiConfiguredModelDto, type ChatSurface } from "@moss/shared";
import { moduleChatSurface } from "../../apps/web/src/shell/chat-surface-key.js";
import type * as ApiClientModule from "../../apps/web/src/api/client.js";
import type * as ChatModelPillModule from "../../apps/web/src/chat/chat-model-pill.js";

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
  getChatModelOverrideSettings: vi.fn(),
  putChatModelOverride: vi.fn(),
  switchChatProvider: vi.fn()
}));

vi.mock("../../apps/web/src/chat/chat-model-pill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChatModelPillModule>();
  return { ...actual, ChatModelPill: vi.fn(actual.ChatModelPill) };
});

import {
  clearChat,
  getChatModelOverrideSettings,
  putChatModelOverride,
  switchChatProvider
} from "../../apps/web/src/api/client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";
import { ChatModelPill } from "../../apps/web/src/chat/chat-model-pill.js";

const moduleSurface = moduleChatSurface("job-search", "profile-1") as ChatSurface;
const moduleSurfaceB = moduleChatSurface("job-search", "profile-2") as ChatSurface;

function model(overrides: Partial<AiConfiguredModelDto>): AiConfiguredModelDto {
  return {
    id: "m-default",
    providerConfigId: "provider-a",
    providerKind: "anthropic",
    providerDisplayName: "Anthropic",
    providerStatus: "active",
    providerModelId: "claude",
    displayName: "Claude",
    capabilities: ["chat"],
    status: "active",
    tier: "interactive",
    allowUserOverride: true,
    origin: "discovered",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides
  };
}

const defaultModel = model({ id: "default", providerConfigId: "provider-a" });
const sameProviderModel = model({
  id: "same-provider",
  providerConfigId: "provider-a",
  providerModelId: "same-provider-model",
  displayName: "Same Provider Model"
});
const crossProviderModel = model({
  id: "cross-provider",
  providerConfigId: "provider-b",
  providerKind: "openai-compatible",
  providerDisplayName: "OpenAI",
  providerModelId: "cross-provider-model",
  displayName: "Cross Provider Model"
});

function settingsFixture() {
  return {
    overrideEnabled: true,
    currentOverrideModelId: null,
    effectiveOverrideModelId: null,
    defaultModel,
    selectedModel: null,
    selectableOverrideModels: [sameProviderModel, crossProviderModel]
  };
}

function buildPillElement(
  client: QueryClient,
  props: {
    readonly disabled: boolean;
    readonly privateMode: boolean;
    readonly surface: ChatSurface;
    readonly onCrossProviderSwitch: (surface: ChatSurface) => void;
  }
): ReactElement {
  return createElement(QueryClientProvider, { client }, createElement(ChatModelPill, props));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPill(
  client: QueryClient,
  surface: ChatSurface,
  onCrossProviderSwitch: (surface: ChatSurface) => void = vi.fn()
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      buildPillElement(client, {
        disabled: false,
        privateMode: false,
        surface,
        onCrossProviderSwitch
      })
    );
  });
  // getChatModelOverrideSettings resolves through react-query's internal promise chain — a
  // macrotask flush (not a couple of microtask Promise.resolve() ticks) is needed before the
  // component settles out of its `isLoading` (chatd-model--muted) render and the real trigger
  // button mounts. Same pattern as settings-ai-pane.test.tsx's `flush()`.
  await flush();
  return renderer;
}

function menuButtons(renderer: ReactTestRenderer) {
  const menu = renderer.root.findAll((node) => node.props.className === "chatd-model__menu");
  return menu.length > 0 ? menu[0]!.findAllByType("button") : [];
}

async function openMenu(renderer: ReactTestRenderer): Promise<void> {
  const trigger = renderer.root.findAll(
    (node) => node.props.className === "chatd-model__trigger"
  )[0];
  await act(async () => {
    trigger!.props.onClick();
  });
}

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

describe("ChatModelPill mutation surface routing (#1533)", () => {
  beforeEach(() => {
    vi.mocked(getChatModelOverrideSettings).mockResolvedValue({ settings: settingsFixture() });
    vi.mocked(putChatModelOverride).mockResolvedValue({ settings: settingsFixture() });
    vi.mocked(switchChatProvider).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.mocked(getChatModelOverrideSettings).mockReset();
    vi.mocked(putChatModelOverride).mockReset();
    vi.mocked(switchChatProvider).mockReset();
  });

  it("calls switchChatProvider and invalidates threads for the surface it was invoked on", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const renderer = await renderPill(client, moduleSurface);

    await openMenu(renderer);
    const buttons = menuButtons(renderer);
    await act(async () => {
      buttons[1]!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(switchChatProvider).toHaveBeenCalledExactlyOnceWith(moduleSurface);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.chat.threads(moduleSurface) });
  });

  it("does not invalidate/clear the newly rendered surface's threads key when a same-provider mutation resolves after a surface flip", async () => {
    let resolveSwitch!: (value: undefined) => void;
    vi.mocked(switchChatProvider).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSwitch = resolve;
        })
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const onCrossProviderSwitch = vi.fn();
    const renderer = await renderPill(client, moduleSurface, onCrossProviderSwitch);

    await openMenu(renderer);
    const buttons = menuButtons(renderer);
    await act(async () => {
      buttons[1]!.props.onClick();
      await Promise.resolve();
    });

    // Parent (ChatDrawer) re-renders the pill with a new surface before switchChatProvider's
    // promise settles.
    await act(async () => {
      renderer.update(
        buildPillElement(client, {
          disabled: false,
          privateMode: false,
          surface: moduleSurfaceB,
          onCrossProviderSwitch
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveSwitch(undefined);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.chat.threads(moduleSurface) });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: queryKeys.chat.threads(moduleSurfaceB)
    });
  });
});

describe("ChatDrawer forwards its surface into ChatModelPill (#1533)", () => {
  afterEach(() => {
    vi.mocked(ChatModelPill).mockClear();
    vi.mocked(clearChat).mockClear();
    vi.mocked(getChatModelOverrideSettings).mockReset();
  });

  it("passes its exact props.surface into the pill, and the cross-provider callback resolves against that same surface", async () => {
    vi.mocked(getChatModelOverrideSettings).mockResolvedValue({
      settings: {
        overrideEnabled: false,
        currentOverrideModelId: null,
        effectiveOverrideModelId: null,
        defaultModel: null,
        selectedModel: null,
        selectableOverrideModels: []
      }
    });
    await renderDrawer(moduleSurface);

    const calls = vi.mocked(ChatModelPill).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const pillProps = calls[calls.length - 1]![0];
    expect(pillProps.surface).toBe(moduleSurface);

    await act(async () => {
      pillProps.onCrossProviderSwitch(pillProps.surface);
    });

    expect(clearChat).toHaveBeenCalledWith({ surface: moduleSurface });
  });

  it("passes the default drawer surface when mounted without a module surface", async () => {
    vi.mocked(getChatModelOverrideSettings).mockResolvedValue({
      settings: {
        overrideEnabled: false,
        currentOverrideModelId: null,
        effectiveOverrideModelId: null,
        defaultModel: null,
        selectedModel: null,
        selectableOverrideModels: []
      }
    });
    await renderDrawer(DEFAULT_CHAT_SURFACE);

    const calls = vi.mocked(ChatModelPill).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const pillProps = calls[calls.length - 1]![0];
    expect(pillProps.surface).toBe(DEFAULT_CHAT_SURFACE);
  });
});
