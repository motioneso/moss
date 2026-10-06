import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEETING_RECORDING_NOTICE, type MeetingRecord } from "@moss/shared";
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
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
      if (path === "/api/meetings/preferences")
        return new Response(
          JSON.stringify({
            defaultCaptureMode: null,
            rememberedSource: null,
            summarizeOnStop: true,
            summaryTemplateId: "general",
            setupCompletedAt: record.createdAt
          })
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

describe("minimal meeting list (synthetic transport, not live proof)", () => {
  function row(id: string) {
    return renderer.root
      .findAllByType("button")
      .find(
        (node) =>
          String(node.props.className).includes("meetings-history-row") &&
          node
            .findAllByType("span")
            .some(
              (span) => span.children.join("") === (id === first.id ? first.title : second.title)
            )
      )!;
  }
  it("shows summary gist and duration with direct one-click navigation", async () => {
    await mount();
    expect(html()).not.toContain("Capture unavailable");
    expect(html()).not.toContain("Open review");
    expect(historyApi.getMeetingHistoryItem).not.toHaveBeenCalled();
    await act(async () => row(first.id).props.onClick());
    await flush();
    expect(location).toBe(`?id=${first.id}`);
    expect(html()).toContain("Personal notes");
    expect(chat.openMeetingChat).not.toHaveBeenCalled();
  });
  it("keeps search in signed-in memory through direct meeting navigation and Back", async () => {
    await mount();
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-history-search" })
        .props.onChange({ target: { value: "release" } })
    );
    await flush(275);
    await flush();
    expect(historyApi.searchMeetingHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "release", filter: "all" }),
      expect.any(AbortSignal)
    );
    await act(async () => row(first.id).props.onClick());
    await flush();
    await click("Meetings");
    expect(renderer.root.findByProps({ id: "meeting-history-search" }).props.value).toBe("release");
    expect(location).not.toContain("release");
    await act(async () => navigate(-1));
    await flush();
    expect(location).toBe(`?id=${first.id}`);
  });
  it("uses authoritative pagination cursor even for a short page", async () => {
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
    expect(row(second.id)).toBeDefined();
    expect(button("Load older meetings")).toBeUndefined();
  });
  it("resumes offline search after connectivity returns", async () => {
    onlineManager.setOnline(false);
    try {
      await mount();
      expect(historyApi.searchMeetingHistory).not.toHaveBeenCalled();
      expect(html()).toContain("Search will continue when you reconnect");
      await act(async () => onlineManager.setOnline(true));
      await flush();
      expect(row(first.id)).toBeDefined();
    } finally {
      onlineManager.setOnline(true);
    }
  });
  it("keeps search visible through a transient error and retries without a fake empty state", async () => {
    vi.mocked(historyApi.searchMeetingHistory).mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(html()).toContain("Couldn’t load meetings");
    expect(html()).not.toContain("No meetings yet");
    expect(renderer.root.findByProps({ id: "meeting-history-search" })).toBeDefined();
    await click("Try again");
    expect(row(first.id)).toBeDefined();
  });
});
