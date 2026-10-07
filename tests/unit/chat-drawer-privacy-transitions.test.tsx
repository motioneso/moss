import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  beaconEndPrivateChat: vi.fn(),
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
  clearChat,
  endPrivateChat,
  getChatPrivacyState,
  sendChatTurn
} from "../../apps/web/src/api/client.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
const clearRecords = vi.fn();

beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(clearChat).mockReset().mockResolvedValue(undefined);
  vi.mocked(endPrivateChat).mockReset().mockResolvedValue(undefined);
  vi.mocked(getChatPrivacyState).mockReset().mockResolvedValue({ incognito: false });
  vi.mocked(sendChatTurn).mockClear();
  clearRecords.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  client.clear();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

async function mount() {
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
            clearRecords,
            streamErrorCount: 0,
            isFounder: false,
            surface: DEFAULT_CHAT_SURFACE
          })
        )
      )
    );
  });
  await flushQueries();
}

async function flushQueries() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pickPrivate(label: "Start private chat" | "Leave private chat") {
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "More chat options" }).props.onClick()
  );
  await act(async () => renderer!.root.findByProps({ "aria-label": label }).props.onClick());
}

function privateBannerVisible() {
  return (
    renderer!.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.split(" ").includes("chatd-private") &&
        node.findAll(
          (child) =>
            child.type === "span" && child.children.join("").includes("not saved to history")
        ).length > 0
    ).length > 0
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("private chat transition presentation", () => {
  it("allows editing during private activation but sends only after acknowledgement", async () => {
    const gate = deferred<void>();
    vi.mocked(clearChat).mockReturnValueOnce(gate.promise);
    await mount();
    await pickPrivate("Start private chat");

    const textarea = renderer!.root.findByType("textarea");
    expect(textarea.props.disabled).toBeFalsy();
    await act(async () => textarea.props.onChange({ target: { value: "secret during race" } }));
    expect(textarea.props.value).toBe("secret during race");
    await act(async () =>
      textarea.props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} })
    );
    expect(sendChatTurn).not.toHaveBeenCalled();
    expect(privateBannerVisible()).toBe(false);
    expect(clearRecords).not.toHaveBeenCalled();

    await act(async () => gate.resolve());
    expect(privateBannerVisible()).toBe(true);
    expect(clearRecords).toHaveBeenCalledTimes(1);
    await act(async () =>
      textarea.props.onChange({ target: { value: "send after acknowledgement" } })
    );
    await act(async () =>
      textarea.props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} })
    );
    expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith(
      "send after acknowledgement",
      undefined,
      undefined,
      DEFAULT_CHAT_SURFACE
    );
  });

  it("hides the private banner optimistically, fences focus refetch, and restores failed close", async () => {
    vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: true });
    const gate = deferred<void>();
    vi.mocked(endPrivateChat).mockReturnValueOnce(gate.promise);
    await mount();
    expect(privateBannerVisible()).toBe(true);
    await pickPrivate("Leave private chat");
    expect(privateBannerVisible()).toBe(false);
    expect(clearRecords).not.toHaveBeenCalled();

    const privacyReads = vi.mocked(getChatPrivacyState).mock.calls.length;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await flushQueries();
    expect(vi.mocked(getChatPrivacyState).mock.calls.length).toBeGreaterThan(privacyReads);
    expect(privateBannerVisible()).toBe(false);
    expect(clearRecords).not.toHaveBeenCalled();

    await act(async () => gate.reject(new Error("Could not end private chat")));
    await flushQueries();
    expect(privateBannerVisible()).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Could not end private chat");
    expect(clearRecords).not.toHaveBeenCalled();
  });

  it("keeps the banner hidden on successful close and resets the stream only after acknowledgement", async () => {
    vi.mocked(getChatPrivacyState).mockResolvedValue({ incognito: true });
    const gate = deferred<void>();
    vi.mocked(endPrivateChat).mockReturnValueOnce(gate.promise);
    await mount();
    await pickPrivate("Leave private chat");
    expect(privateBannerVisible()).toBe(false);
    expect(clearRecords).not.toHaveBeenCalled();

    await act(async () => gate.resolve());
    expect(privateBannerVisible()).toBe(false);
    expect(clearRecords).toHaveBeenCalledTimes(1);
  });
});
