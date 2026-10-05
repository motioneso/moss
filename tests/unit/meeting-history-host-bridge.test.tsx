import { useCallback, useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, useMeetingChat, type MeetingChatActions } from "@moss/module-web-sdk";
import type { MeetingHistoryPage } from "@moss/shared";
import {
  ChatControlsProvider,
  type ChatControls
} from "../../apps/web/src/shell/chat-controls-context.js";
import {
  MeetingHistory,
  type MeetingHistoryProps
} from "../../packages/meetings/src/web/meeting-history.js";
import * as historyApi from "../../packages/meetings/src/web/history-client.js";
import { historyItem } from "./fixtures/meeting-history.js";

// Keep the actual host registration and useMeetingChat hook: a stable hook mock hides loops.
vi.mock("../../packages/meetings/src/web/history-client.js", async (original) => ({
  ...(await original<typeof historyApi>()),
  searchMeetingHistory: vi.fn(),
  getMeetingHistoryItem: vi.fn()
}));

const first = historyItem({
  id: "11223344-1122-4122-8122-112233445566",
  title: "Unavailable synthetic review",
  personalNotes: "Synthetic notes",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
});
const second = { ...first, id: "22334455-1122-4122-8122-112233445566", title: "Available review" };
const basicControls: ChatControls = {
  openChat: () => {},
  openChatWith: () => {},
  openAssistantWithDraft: () => {}
};
const baseProps: MeetingHistoryProps = {
  search: "",
  filter: "all",
  selectedId: first.id,
  detailOpen: true,
  onSearch: () => {},
  onFilter: () => {},
  onSelect: () => {},
  onResults: () => {},
  onOpen: () => {},
  onNew: () => {}
};
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
let bumpHost: () => void;
let selectedChat: string | null;
const cleared = vi.fn();
function Host({ children, initialChat }: { children: ReactNode; initialChat: string | null }) {
  const [meetingId, setMeetingId] = useState(initialChat);
  const [, setRevision] = useState(0);
  bumpHost = () => setRevision((revision) => revision + 1);
  selectedChat = meetingId;
  // Match AppShell: clearing an active chat replaces this callback once.
  const clearMeetingChat = useCallback(
    (id: string) => {
      cleared(id);
      if (meetingId === id) setMeetingId(null);
    },
    [meetingId]
  );
  return (
    <ChatControlsProvider value={{ ...basicControls, clearMeetingChat }}>
      {children}
    </ChatControlsProvider>
  );
}
function tree(props: MeetingHistoryProps = baseProps, initialChat: string | null = null) {
  return (
    <QueryClientProvider client={client}>
      <Host initialChat={initialChat}>
        <MeetingHistory {...props} />
      </Host>
    </QueryClientProvider>
  );
}
// Fixed, short observation windows also bound the broken implementation's repeated requests.
async function flush() {
  for (let step = 0; step < 8; step++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2)));
  }
}
async function mount(initialChat: string | null = null) {
  await act(async () => {
    renderer = create(tree(baseProps, initialChat));
  });
  await flush();
}
function html() {
  return JSON.stringify(renderer!.toJSON());
}
async function expectQuietHost() {
  const searches = vi.mocked(historyApi.searchMeetingHistory).mock.calls.length;
  const details = vi.mocked(historyApi.getMeetingHistoryItem).mock.calls.length;
  const clears = cleared.mock.calls.length;
  for (let step = 0; step < 5; step++) await act(async () => bumpHost());
  await flush();
  expect(historyApi.searchMeetingHistory).toHaveBeenCalledTimes(searches);
  expect(historyApi.getMeetingHistoryItem).toHaveBeenCalledTimes(details);
  expect(cleared).toHaveBeenCalledTimes(clears);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: false })
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected unit-test request")));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryDefaults(["settings", "locale"], { staleTime: Infinity });
  client.setQueryData(["settings", "locale"], {
    locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" }
  });
  vi.mocked(historyApi.searchMeetingHistory)
    .mockReset()
    .mockResolvedValue({
      meetings: [second],
      nextCursor: null
    });
  vi.mocked(historyApi.getMeetingHistoryItem)
    .mockReset()
    .mockImplementation(async (id) => ({ meeting: id === first.id ? first : second }));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client.clear();
  vi.unstubAllGlobals();
});

describe("meeting chat host bridge identities", () => {
  it("keeps optional fallbacks stable and follows independently replaced handlers", async () => {
    let actions!: MeetingChatActions;
    function Probe() {
      actions = useMeetingChat();
      return null;
    }
    const render = async (controls: ChatControls) => {
      await act(async () => {
        const element = (
          <ChatControlsProvider value={controls}>
            <Probe />
          </ChatControlsProvider>
        );
        if (renderer) renderer.update(element);
        else renderer = create(element);
      });
    };
    await render(basicControls);
    const missing = actions;
    await render({ ...basicControls, openChat: () => {} });
    expect(actions.clearMeetingChat).toBe(missing.clearMeetingChat);
    expect(actions.openMeetingChat).toBe(missing.openMeetingChat);
    expect(() => actions.clearMeetingChat(first.id)).not.toThrow();
    expect(() =>
      actions.openMeetingChat({ meetingId: first.id, title: first.title })
    ).not.toThrow();
    const open = vi.fn();
    const clear = vi.fn();
    await render({ ...basicControls, openMeetingChat: open, clearMeetingChat: clear });
    const registered = actions;
    await render({ ...basicControls, openMeetingChat: open, clearMeetingChat: clear });
    expect(actions.clearMeetingChat).toBe(registered.clearMeetingChat);
    expect(actions.openMeetingChat).toBe(registered.openMeetingChat);
    const nextOpen = vi.fn();
    await render({ ...basicControls, openMeetingChat: nextOpen, clearMeetingChat: clear });
    expect(actions.clearMeetingChat).toBe(registered.clearMeetingChat);
    actions.openMeetingChat({ meetingId: second.id, title: second.title });
    expect(nextOpen).toHaveBeenCalledWith({ meetingId: second.id, title: second.title });
    expect(open).not.toHaveBeenCalled();
    const latestOpen = actions.openMeetingChat;
    const nextClear = vi.fn();
    await render({ ...basicControls, openMeetingChat: nextOpen, clearMeetingChat: nextClear });
    expect(actions.openMeetingChat).toBe(latestOpen);
    actions.clearMeetingChat(second.id);
    expect(nextClear).toHaveBeenCalledWith(second.id);
    expect(clear).not.toHaveBeenCalled();
    await render(basicControls);
    expect(actions.clearMeetingChat).toBe(missing.clearMeetingChat);
    expect(actions.openMeetingChat).toBe(missing.openMeetingChat);
  });
});

describe("History denial with the real host bridge (mocked API, not live proof)", () => {
  it("bounds a cold reload with a deleted selection and no open chat", async () => {
    vi.mocked(historyApi.getMeetingHistoryItem).mockRejectedValue(new ApiError(404, "Unavailable"));
    await mount();
    expect(html()).toContain("This meeting is unavailable");
    expect(html()).not.toContain(first.title);
    expect(historyApi.searchMeetingHistory).toHaveBeenCalledTimes(2);
    expect(historyApi.getMeetingHistoryItem).toHaveBeenCalledOnce();
    expect(cleared).toHaveBeenCalledOnce();
    await expectQuietHost();
  });

  it.each([401, 403, 404])(
    "bounds a selected %s revalidation, cache pruning and chat close",
    async (status) => {
      client.setQueryData(historyApi.historyKeys.search("", "all"), {
        pages: [{ meetings: [first, second], nextCursor: null }],
        pageParams: [undefined]
      });
      vi.mocked(historyApi.getMeetingHistoryItem).mockRejectedValue(
        new ApiError(status, "Unavailable")
      );
      await mount(first.id);
      expect(html()).toContain("This meeting is unavailable");
      expect(html()).not.toContain(first.title);
      expect(selectedChat).toBeNull();
      expect(cleared).toHaveBeenCalledWith(first.id);
      expect(historyApi.searchMeetingHistory).toHaveBeenCalledTimes(3);
      expect(historyApi.getMeetingHistoryItem).toHaveBeenCalledOnce();
      expect(client.getQueryData(historyApi.historyKeys.search("", "all"))).toMatchObject({
        pages: [{ meetings: [second] }]
      });
      await expectQuietHost();
    }
  );

  it.each([401, 403])(
    "discards cached pages and cancels old reads after list %s",
    async (status) => {
      await mount(first.id);
      let finish!: (page: MeetingHistoryPage) => void;
      let oldSignal: AbortSignal | undefined;
      vi.mocked(historyApi.searchMeetingHistory).mockImplementation((input, signal) => {
        if (input.filter === "all") {
          oldSignal = signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return Promise.reject(new ApiError(status, "Unavailable"));
      });
      await act(async () => {
        void client.refetchQueries({
          queryKey: historyApi.historyKeys.search("", "all"),
          exact: true
        });
      });
      await act(async () =>
        renderer!.update(tree({ ...baseProps, filter: "needs-review" }, first.id))
      );
      await flush();
      expect(html()).toContain("Meeting history is unavailable");
      expect(selectedChat).toBeNull();
      expect(oldSignal?.aborted).toBe(true);
      expect(client.getQueryData(historyApi.historyKeys.search("", "all"))).toBeUndefined();
      const searches = vi.mocked(historyApi.searchMeetingHistory).mock.calls.length;
      await act(async () => finish({ meetings: [first], nextCursor: null }));
      await flush();
      expect(client.getQueryData(historyApi.historyKeys.search("", "all"))).toBeUndefined();
      expect(html()).not.toContain(first.title);
      expect(historyApi.searchMeetingHistory).toHaveBeenCalledTimes(searches);
      await expectQuietHost();
    }
  );

  it("ignores an aborted older selection denial and bounds a newly selected denial", async () => {
    let rejectOld!: (error: Error) => void;
    let oldSignal: AbortSignal | undefined;
    vi.mocked(historyApi.getMeetingHistoryItem).mockImplementation((id, signal) => {
      if (id !== first.id) return Promise.resolve({ meeting: second });
      oldSignal = signal;
      return new Promise((_resolve, reject) => {
        rejectOld = reject;
      });
    });
    await mount(second.id);
    await act(async () =>
      renderer!.update(tree({ ...baseProps, selectedId: second.id }, second.id))
    );
    await flush();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => rejectOld(new ApiError(404, "Unavailable")));
    await flush();
    expect(html()).toContain(second.title);
    expect(html()).not.toContain("This meeting is unavailable");
    expect(cleared).not.toHaveBeenCalled();
    expect(selectedChat).toBe(second.id);
    vi.mocked(historyApi.getMeetingHistoryItem).mockRejectedValue(new ApiError(404, "Unavailable"));
    await act(async () => renderer!.update(tree(baseProps, second.id)));
    await flush();
    expect(html()).toContain("This meeting is unavailable");
    expect(cleared).toHaveBeenCalledWith(first.id);
    expect(selectedChat).toBe(second.id);
    expect(historyApi.searchMeetingHistory).toHaveBeenCalledTimes(2);
    expect(historyApi.getMeetingHistoryItem).toHaveBeenCalledTimes(3);
    await expectQuietHost();
  });
});
