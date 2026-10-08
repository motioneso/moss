// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MEETING_CHAT_TITLE_QUERY_KEY, type MeetingChatSelection } from "@moss/shared";
import type * as ApiClientModule from "../../apps/web/src/api/client.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof ApiClientModule>()).ApiError,
  listChatThreads: vi.fn(async () => ({ threads: [] })),
  listChatThreadMessages: vi.fn(async () => ({ messages: [] }))
}));
vi.mock("../../apps/web/src/chat/chat-drawer.js", () => ({
  ChatDrawer: ({
    meetingContext
  }: {
    meetingContext: MeetingChatSelection & { title: string };
  }) => <section aria-label="Ready meeting chat">{meetingContext.title}</section>
}));

import { MeetingChatDrawer } from "../../apps/web/src/chat/meeting-chat-drawer.js";

const meetingId = "11223344-1122-4122-8122-112233445566";
const selection = { meetingId, selectionId: "first-selection", title: "About this meeting" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const titleResponse = (title = "Private meeting title") =>
  json({ meeting: { id: meetingId, title, personalNotes: "Private notes must not be cached" } });
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) =>
    url.startsWith("/api/meetings/records/") ? titleResponse() : json({ available: true })
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function tick(milliseconds = 5) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
async function mount(currentSelection = selection) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MeetingChatDrawer
          key={currentSelection.selectionId}
          selection={currentSelection}
          onClose={() => {}}
          isFounder={false}
        />
      </QueryClientProvider>
    )
  );
  // Access, title and history each notify their observer on a separate scheduled tick.
  for (let step = 0; step < 3; step += 1) await tick();
}
function readCount(prefix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(prefix)).length;
}

it("keeps the public title-query namespace and per-meeting prefix semantics", async () => {
  expect(MEETING_CHAT_TITLE_QUERY_KEY).toBe("meeting-chat-title");
  const first = [MEETING_CHAT_TITLE_QUERY_KEY, meetingId, "first"];
  const second = [MEETING_CHAT_TITLE_QUERY_KEY, meetingId, "second"];
  const other = [MEETING_CHAT_TITLE_QUERY_KEY, "other-meeting", "first"];
  client.setQueryData(first, "First title");
  client.setQueryData(second, "Second title");
  client.setQueryData(other, "Other title");
  await client.invalidateQueries({ queryKey: [MEETING_CHAT_TITLE_QUERY_KEY, meetingId] });
  expect(client.getQueryState(first)?.isInvalidated).toBe(true);
  expect(client.getQueryState(second)?.isInvalidated).toBe(true);
  expect(client.getQueryState(other)?.isInvalidated).toBe(false);
});

it("polls access every five seconds without downloading records or notes on each poll", async () => {
  await mount();
  expect(host.textContent).toBe("Private meeting title");
  expect(readCount("/api/chat/meeting-context")).toBe(1);
  expect(readCount("/api/meetings/records/")).toBe(1);
  expect(client.getQueryData(["meeting-chat-title", meetingId, selection.selectionId])).toBe(
    "Private meeting title"
  );
  for (let poll = 1; poll <= 4; poll += 1) {
    await tick(5000);
    expect(readCount("/api/chat/meeting-context")).toBe(poll + 1);
    expect(readCount("/api/meetings/records/")).toBe(1);
  }
  await tick(40_000);
  expect(readCount("/api/meetings/records/")).toBe(2);
});

it("refreshes the title on focus even while its longer-lived cache is fresh", async () => {
  await mount();
  fetchMock.mockImplementation(async (url: string) =>
    url.startsWith("/api/meetings/records/")
      ? titleResponse("Renamed elsewhere")
      : json({ available: true })
  );
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await tick();
  expect(host.textContent).toBe("Renamed elsewhere");
  expect(readCount("/api/meetings/records/")).toBe(2);
});

it.each([401, 403, 404])(
  "keeps a five-second %s denial closed when a title read resolves late",
  async (status) => {
    await mount();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/meetings/records/")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : json({ available: true })
    );
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["meeting-chat-title", meetingId] });
    });
    expect(finish).toEqual(expect.any(Function));
    fetchMock.mockImplementation(async () => json({ error: "Unavailable" }, status));
    await tick(5000);
    await tick();
    expect(host.textContent).toContain("Meeting unavailable");
    await act(async () => finish(titleResponse("Late private title")));
    await tick();
    expect(host.textContent).toContain("Meeting unavailable");
    expect(host.textContent).not.toContain("Late private title");
    expect(host.querySelector('[aria-label="Ready meeting chat"]')).toBeNull();
    const readsAfterDenial = fetchMock.mock.calls.length;
    await tick(60_000);
    expect(fetchMock.mock.calls).toHaveLength(readsAfterDenial);
  }
);

it.each([401, 403, 404])(
  "hides a previously loaded title when its refresh returns %s",
  async (status) => {
    await mount();
    expect(host.textContent).toBe("Private meeting title");
    fetchMock.mockImplementation(async () => json({ error: "Unavailable" }, status));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["meeting-chat-title", meetingId] });
    });
    await tick();
    expect(host.textContent).toContain("Meeting unavailable");
    expect(host.textContent).not.toContain("Private meeting title");
  }
);

it("does not reuse a cached title for a new account selection of the same meeting", async () => {
  await mount();
  let finish!: (response: Response) => void;
  fetchMock.mockImplementation(async (url: string) =>
    url.startsWith("/api/meetings/records/")
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : json({ available: true })
  );
  await mount({ ...selection, selectionId: "new-account-selection" });
  expect(host.textContent).not.toContain("Private meeting title");
  expect(host.querySelector('[aria-label="Ready meeting chat"]')).toBeNull();
  await act(async () => finish(titleResponse("Current account title")));
  await tick();
  await tick();
  expect(host.textContent).toBe("Current account title");
});
