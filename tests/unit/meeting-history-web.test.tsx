import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@moss/module-web-sdk";
import {
  MEETING_RECORDING_NOTICE,
  type MeetingHistoryItem,
  type MeetingRecord
} from "@moss/shared";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import * as historyApi from "../../packages/meetings/src/web/history-client.js";
import { historyItem } from "./fixtures/meeting-history.js";

const chat = vi.hoisted(() => ({ openMeetingChat: vi.fn(), clearMeetingChat: vi.fn() }));
vi.mock("@moss/module-web-sdk", async (original) => ({
  ...(await original<object>()),
  useMeetingChat: () => chat
}));
vi.mock("../../packages/meetings/src/web/history-client.js", async (original) => ({
  ...(await original<typeof historyApi>()),
  searchMeetingHistory: vi.fn(),
  getMeetingHistoryItem: vi.fn()
}));

const record: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Synthetic review",
  personalNotes: "Saved notes",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
};
const first = historyItem(record, {
  transcript: {
    status: "retained",
    revision: 1,
    segmentCount: 2,
    finalSegmentCount: 1,
    provisionalSegmentCount: 1,
    span: { startMs: 1000, endMs: 5000 },
    sources: [{ kind: "microphone", label: "Declared desk source" }],
    omittedSourceCount: 1
  },
  summary: {
    status: "available",
    version: 1,
    origin: "generated",
    createdAt: record.createdAt,
    generation: null
  },
  actions: { pending: 2, accepted: 1, dismissed: 0 },
  vault: {
    savedVersionCount: 1,
    latest: {
      artifactVersion: 1,
      writeStatus: "saved",
      indexStatus: "queued",
      updatedAt: record.updatedAt
    }
  }
});
const second = historyItem({
  ...record,
  id: "22334455-1122-4122-8122-112233445566",
  title: "Other synthetic review"
});
let renderer: ReactTestRenderer;
let client: QueryClient;
let location = "";
let navigate: NavigateFunction;
interface FocusNode {
  region: "results" | "rail";
  focus: () => void;
  contains: (node: FocusNode | null) => boolean;
}
let activeNode: FocusNode | null = null;
const searchFocus = vi.fn();
function Location() {
  location = useLocation().search;
  navigate = useNavigate();
  return null;
}
async function flush(ms = 15) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function mount() {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/meetings?view=history"]}>
          <MeetingsPage />
          <Location />
        </MemoryRouter>
      </QueryClientProvider>,
      {
        createNodeMock: (element) => {
          const region = ["section", "input", "button"].includes(String(element.type))
            ? "results"
            : "rail";
          const isSearch =
            element.type === "input" &&
            typeof element.props === "object" &&
            element.props !== null &&
            "id" in element.props &&
            element.props.id === "meeting-history-search";
          const node: FocusNode = {
            region,
            focus: () => {
              activeNode = node;
              if (isSearch) searchFocus();
            },
            contains: (candidate) => candidate?.region === region
          };
          return node;
        }
      }
    );
  });
  await flush();
  await flush();
}
function button(name: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.join("") === name)!;
}
async function click(name: string) {
  await act(async () => button(name).props.onClick());
  await flush();
  await flush();
}
function html() {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  vi.clearAllMocks();
  activeNode = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: false })
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/me/locale")
        return new Response(
          JSON.stringify({ locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" } })
        );
      if (path === "/api/meetings/recording-notice")
        return new Response(
          JSON.stringify({ currentNotice: MEETING_RECORDING_NOTICE, acknowledgement: null })
        );
      if (path === "/api/meetings/capture/devices")
        return new Response(JSON.stringify({ devices: [], processingReady: false }));
      if (path.endsWith("/capture"))
        return new Response(
          JSON.stringify({ pendingLinks: [], capture: null, processingReady: false })
        );
      if (path.endsWith("/outputs"))
        return new Response(
          JSON.stringify({ artifacts: [], candidates: [], headVersion: 0, templates: [] })
        );
      if (path.includes("/transcript"))
        return new Response('{"code":"meeting_transcript_unavailable"}', { status: 404 });
      return new Response(JSON.stringify({ meeting: record }));
    })
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["settings", "locale"], {
    locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" }
  });
  vi.mocked(historyApi.searchMeetingHistory).mockResolvedValue({
    meetings: [first, second],
    nextCursor: null
  });
  vi.mocked(historyApi.getMeetingHistoryItem).mockImplementation(async (id) => ({
    meeting: id === first.id ? first : second
  }));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  client.clear();
  vi.unstubAllGlobals();
});

describe("History selection and search (unit transport stubs, not live proof)", () => {
  it("renders factual rail metadata and uses existing meeting chat without opening review", async () => {
    await mount();
    expect(html()).toContain("Transcript span ");
    expect(html()).toContain("0:01–0:05");
    expect(html()).toContain("1 final · 1 provisional");
    expect(html()).toContain("2 to review");
    expect(html()).toContain("Search indexing queued");
    expect(html()).toContain("Accepted suggestions");
    expect(html()).not.toContain("Indexed");
    expect(html()).not.toContain("Open note");
    await click("Synthetic review");
    expect(location).toContain("view=history");
    expect(location).not.toContain("?id=");
    await click("Ask Moss");
    expect(chat.openMeetingChat).toHaveBeenCalledWith({ meetingId: first.id, title: first.title });
    await click("Other synthetic review");
    expect(button("Ask Moss").props.disabled).toBe(true);
    expect(html()).not.toContain("Declared desk source");
  });
  it("keeps search in session memory through review/back, and resets selection on filter changes", async () => {
    await mount();
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-history-search" })
        .props.onChange({ target: { value: "private cedar" } })
    );
    await flush(275);
    await flush();
    expect(historyApi.searchMeetingHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "private cedar", filter: "all" }),
      expect.any(AbortSignal)
    );
    expect(location).not.toContain("private");
    await click("Synthetic review");
    await click("Open review");
    expect(location).toContain(`id=${first.id}`);
    await click("View meeting history");
    expect(renderer.root.findByProps({ id: "meeting-history-search" }).props.value).toBe(
      "private cedar"
    );
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-history-filter" })
        .props.onChange({ target: { value: "needs-review" } })
    );
    await flush();
    expect(location).toContain("state=needs-review");
    expect(location).not.toContain("selected=");
    expect(historyApi.searchMeetingHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: "private cedar",
        filter: "needs-review",
        before: undefined
      }),
      expect.any(AbortSignal)
    );
  });
  it("uses the authoritative cursor even when a page has fewer than thirty rows", async () => {
    const cursor = { id: first.id, createdAt: first.createdAt };
    vi.mocked(historyApi.searchMeetingHistory)
      .mockResolvedValueOnce({ meetings: [first], nextCursor: cursor })
      .mockResolvedValueOnce({ meetings: [second], nextCursor: null });
    await mount();
    await click("Load older meetings");
    expect(historyApi.searchMeetingHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: cursor }),
      expect.any(AbortSignal)
    );
    expect(button("Other synthetic review")).toBeDefined();
    expect(button("Load older meetings")).toBeUndefined();
  });
  it("does not redirect a delayed selected-item response into a newer selection", async () => {
    let finish!: (value: { meeting: MeetingHistoryItem }) => void;
    vi.mocked(historyApi.getMeetingHistoryItem).mockImplementation((id) =>
      id === first.id
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ meeting: second })
    );
    await mount();
    await click("Other synthetic review");
    await act(async () => finish({ meeting: first }));
    await flush();
    expect(html()).not.toContain("Declared desk source");
    expect(button("Ask Moss").props.disabled).toBe(true);
    expect(location).toContain(`selected=${second.id}`);
  });
  it("suppresses known-denied metadata and selected chat on revalidation", async () => {
    await mount();
    await click("Synthetic review");
    vi.mocked(historyApi.getMeetingHistoryItem).mockRejectedValue(
      new ApiError(404, "Unavailable", "meeting_not_found")
    );
    await act(async () =>
      client.refetchQueries({ queryKey: historyApi.historyKeys.item(first.id) })
    );
    await flush();
    expect(html()).toContain("This meeting is unavailable");
    expect(html()).not.toContain("Declared desk source");
    expect(button("Synthetic review")).toBeUndefined();
    expect(button("Ask Moss")).toBeUndefined();
    expect(chat.clearMeetingChat).toHaveBeenCalledWith(first.id);
  });
  it("moves focus out of hidden mobile panels on browser Back and Forward", async () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: true })
    });
    vi.stubGlobal("document", {
      get activeElement() {
        return activeNode;
      }
    });
    await mount();
    await click("Synthetic review");
    expect(activeNode?.region).toBe("rail");
    await act(async () => navigate(-1));
    await flush();
    expect(activeNode?.region).toBe("results");
    await act(async () => navigate(1));
    await flush();
    expect(activeNode?.region).toBe("rail");
  });
  it("keeps an authorization failure visible when the narrow detail pane was selected", async () => {
    await mount();
    await click("Synthetic review");
    vi.mocked(historyApi.searchMeetingHistory).mockRejectedValue(
      new ApiError(403, "Unavailable", "module_unavailable")
    );
    await act(async () => client.refetchQueries({ queryKey: historyApi.historyKeys.lists }));
    await flush();
    expect(html()).toContain("Meeting history is unavailable");
    expect(html()).not.toContain("meetings-history--detail");
    expect(button("Retry loading history")).toBeDefined();
    expect(html()).not.toContain("Declared desk source");
  });
  it("clears auto-selected chat immediately when a list denial removes all visible rows", async () => {
    await mount();
    expect(location).not.toContain("selected=");
    await click("Ask Moss");
    expect(chat.openMeetingChat).toHaveBeenCalledWith({ meetingId: first.id, title: first.title });
    vi.mocked(historyApi.searchMeetingHistory).mockRejectedValue(
      new ApiError(403, "Unavailable", "module_unavailable")
    );
    await act(async () => client.refetchQueries({ queryKey: historyApi.historyKeys.lists }));
    await flush();
    expect(chat.clearMeetingChat).toHaveBeenCalledWith(first.id);
    expect(html()).not.toContain("Declared desk source");
    expect(button("Ask Moss")).toBeUndefined();
  });
  it("returns focus to search when the selected row became unavailable", async () => {
    await mount();
    await click("Synthetic review");
    vi.mocked(historyApi.getMeetingHistoryItem).mockRejectedValue(
      new ApiError(404, "Unavailable", "meeting_not_found")
    );
    await act(async () =>
      client.refetchQueries({ queryKey: historyApi.historyKeys.item(first.id) })
    );
    await flush();
    expect(button("Synthetic review")).toBeUndefined();
    await click("Back to results");
    expect(searchFocus).toHaveBeenCalledOnce();
    expect(location).toContain("panel=results");
  });
  it("discards other cached searches and late reads after a global list denial", async () => {
    await mount();
    let lateSuccess!: (value: Awaited<ReturnType<typeof historyApi.searchMeetingHistory>>) => void;
    let rejectCurrent!: (error: Error) => void;
    vi.mocked(historyApi.searchMeetingHistory)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          lateSuccess = resolve;
        })
      )
      .mockRejectedValueOnce(new ApiError(403, "Unavailable", "module_unavailable"))
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectCurrent = reject;
        })
      );
    await act(async () => {
      void client.refetchQueries({
        queryKey: historyApi.historyKeys.search("", "all"),
        exact: true
      });
    });
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-history-filter" })
        .props.onChange({ target: { value: "needs-review" } })
    );
    await flush();
    expect(html()).toContain("Meeting history is unavailable");
    expect(client.getQueryData(historyApi.historyKeys.search("", "all"))).toBeUndefined();
    await act(async () => lateSuccess({ meetings: [first], nextCursor: null }));
    await flush();
    expect(client.getQueryData(historyApi.historyKeys.search("", "all"))).toBeUndefined();
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-history-filter" })
        .props.onChange({ target: { value: "all" } })
    );
    await flush();
    expect(button("Synthetic review")).toBeUndefined();
    expect(html()).not.toContain("Declared desk source");
    await act(async () => rejectCurrent(new ApiError(401, "Unavailable", "unauthenticated")));
    await flush();
    expect(html()).toContain("Meeting history is unavailable");
  });
  it("labels paused offline queries and resumes them when connectivity returns", async () => {
    onlineManager.setOnline(false);
    try {
      await mount();
      expect(historyApi.searchMeetingHistory).not.toHaveBeenCalled();
      expect(html()).toContain("Search will continue when you reconnect");
      expect(html()).not.toContain("Couldn’t load meeting history");
      await act(async () => onlineManager.setOnline(true));
      await flush();
      await flush();
      expect(historyApi.searchMeetingHistory).toHaveBeenCalledOnce();
      expect(button("Synthetic review")).toBeDefined();
      expect(html()).not.toContain("Search will continue when you reconnect");
    } finally {
      onlineManager.setOnline(true);
    }
  });
  it("keeps filters mounted and retries a transient list failure without inventing an empty history", async () => {
    vi.mocked(historyApi.searchMeetingHistory).mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(html()).toContain("Couldn’t load meeting history");
    expect(html()).not.toContain("Your first draft starts here");
    await click("Retry loading history");
    expect(button("Synthetic review")).toBeDefined();
  });
});
