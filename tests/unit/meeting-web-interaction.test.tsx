import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, hasSessionUnsavedChanges } from "@moss/module-web-sdk";
import {
  MEETING_RECORDING_NOTICE,
  type MeetingHistoryPage,
  type MeetingRecord,
  type MeetingCapturePreferences
} from "@moss/shared";
import { historyItem } from "./fixtures/meeting-history.js";
import * as historyApi from "../../packages/meetings/src/web/history-client.js";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import { MeetingNotes } from "../../packages/meetings/src/web/meeting-record.js";
import * as api from "../../packages/meetings/src/web/client.js";
import { MeetingNotesPane } from "../../packages/meetings/src/web/meeting-notes-pane.js";
import { useSignOutGuard } from "../../apps/web/src/shell/use-sign-out-guard.js";

vi.mock("../../packages/meetings/src/web/client.js", async (original) => {
  const actual = await original<typeof api>();
  return {
    ...actual,
    getMeeting: vi.fn(),
    listMeetings: vi.fn(),
    saveMeetingNotes: vi.fn(),
    createMeeting: vi.fn(),
    getMeetingPreferences: vi.fn(),
    putMeetingPreferences: vi.fn(),
    deleteMeeting: vi.fn()
  };
});
vi.mock("../../packages/meetings/src/web/history-client.js", async (original) => ({
  ...(await original<typeof historyApi>()),
  searchMeetingHistory: vi.fn(),
  getMeetingHistoryItem: vi.fn()
}));
const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Design review",
  personalNotes: "Saved notes",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
};
const preferences: MeetingCapturePreferences = {
  defaultCaptureMode: null,
  rememberedSource: null,
  summarizeOnStop: true,
  summaryTemplateId: "general",
  setupCompletedAt: "2026-10-06T00:00:00Z"
};
let renderer: ReactTestRenderer;
let client: QueryClient;
let location: string;
let navigate: NavigateFunction;
function Location() {
  location = useLocation().search;
  navigate = useNavigate();
  return null;
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function waitForRender(assertion: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {});
      assertion();
    },
    { timeout: 5000 }
  );
}
function button(label: string) {
  return renderer.root
    .findAllByType("button")
    .find(
      (node) =>
        node.props["aria-label"] === label ||
        node.children.join("") === label ||
        (String(node.props.className).includes("meetings-history-row") &&
          node.findAll((child) => child.type === "span" && child.children.join("") === label)
            .length > 0)
    )!;
}
async function click(label: string) {
  if (label === "Delete meeting" && !button(label)) await click("Meeting actions");
  await act(async () => {
    expect(button(label)?.props.disabled).not.toBe(true);
    button(label).props.onClick();
  });
  await flush();
}
async function awaitAutosave() {
  const count = vi.mocked(api.saveMeetingNotes).mock.calls.length;
  await waitForRender(() => expect(api.saveMeetingNotes).toHaveBeenCalledTimes(count + 1));
  await flush();
}
async function typeNotes(text: string) {
  await act(async () => {
    renderer.root
      .findByProps({ id: "meeting-personal-notes" })
      .props.onChange({ target: { value: text } });
  });
  await flush();
}
async function mount(path = `/meetings?id=${meeting.id}`) {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <main>
            <MeetingsPage />
          </main>
          <Location />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  await flush();
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  // Keep the actual query options and their cancellation/denial handling. Its lexical
  // getMeeting binding uses requestJson, so stub the transport rather than that binding.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/me/locale")
        return new Response(
          JSON.stringify({ locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" } })
        );
      if (path === "/api/meetings/recording-notice")
        return new Response(
          JSON.stringify({
            currentNotice: MEETING_RECORDING_NOTICE,
            acknowledgement: {
              policyVersion: MEETING_RECORDING_NOTICE.policyVersion,
              acknowledgedAt: "2026-10-06T00:00:00Z"
            }
          })
        );
      if (path === "/api/me/sessions") return new Response(JSON.stringify({ sessions: [] }));
      if (path === "/api/companion/recording-capabilities")
        return new Response(JSON.stringify({ devices: [] }));
      if (path === "/api/meetings/output-availability")
        return new Response(
          JSON.stringify({ generationAvailability: "model-unavailable", templates: [] })
        );
      if (path === "/api/meetings/capture/devices")
        return new Response(JSON.stringify({ devices: [], processingReady: false }));
      if (!path.startsWith("/api/meetings/records/"))
        throw new Error(`Unexpected unit request: ${path}`);
      if (path.endsWith("/capture"))
        return new Response(
          JSON.stringify({ pendingLinks: [], capture: null, processingReady: false })
        );
      if (path.endsWith("/outputs"))
        return new Response(
          JSON.stringify({ artifacts: [], candidates: [], headVersion: 0, templates: [] })
        );
      if (path.endsWith("/exports")) return new Response(JSON.stringify({ receipts: [] }));
      if (path.includes("/transcript"))
        return new Response('{"code":"meeting_transcript_unavailable"}', { status: 404 });
      try {
        const result = await api.getMeeting(decodeURIComponent(path.split("/").at(-1)!));
        return new Response(JSON.stringify(result));
      } catch (error) {
        if (error instanceof ApiError)
          return new Response(JSON.stringify({ message: error.message, code: error.code }), {
            status: error.status
          });
        throw error;
      }
    })
  );
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false }
    }
  });
  client.setQueryData(["settings", "locale"], {
    locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" }
  });
  client.setQueryData(api.meetingKeys.record(meeting.id), { meeting });
  vi.mocked(api.getMeeting).mockResolvedValue({ meeting });
  vi.mocked(api.getMeetingPreferences).mockResolvedValue(preferences);
  vi.mocked(api.createMeeting).mockReset().mockResolvedValue({ meeting, created: true });
  vi.mocked(api.saveMeetingNotes)
    .mockReset()
    .mockImplementation(async (input) => ({
      status: "saved",
      replayed: false,
      meeting: {
        ...meeting,
        personalNotes: input.personalNotes,
        notesRevision: input.expectedRevision + 1
      }
    }));
  vi.mocked(api.listMeetings).mockResolvedValue({ meetings: [meeting] });
  vi.mocked(historyApi.searchMeetingHistory).mockResolvedValue({
    meetings: [historyItem(meeting)],
    nextCursor: null
  });
  vi.mocked(historyApi.getMeetingHistoryItem).mockResolvedValue({ meeting: historyItem(meeting) });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  client.clear();
  vi.unstubAllGlobals();
});

describe("meeting UI interactions (unit transport stubs, not live proof)", () => {
  it.each(["/meetings", "/meetings?view=history", `/meetings?id=${meeting.id}`])(
    "keeps the shell as the only main landmark at %s",
    async (path) => {
      await mount(path);
      expect(renderer.root.findAllByType("main")).toHaveLength(1);
    }
  );
  it("does not count a single personal-notes editor as note records", async () => {
    await mount();
    for (const text of ["", "One line", "One line\nTwo lines\nThree lines"]) {
      await typeNotes(text);
      expect(renderer.root.findByProps({ id: "meeting-review-tab-notes" }).children).toEqual([
        "Notes"
      ]);
    }
  });
  it("keeps typed notes through list navigation and reopening before autosave", async () => {
    await mount();
    await typeNotes("Unsaved note");
    await click("Meetings");
    await click("Design review");
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Unsaved note"
    );
    expect(api.saveMeetingNotes).not.toHaveBeenCalled();
  });
  it("retries a failed note save with the same key and input", async () => {
    vi.mocked(api.saveMeetingNotes)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        status: "saved",
        replayed: true,
        meeting: { ...meeting, personalNotes: "Submitted", notesRevision: 2 }
      });
    await mount();
    await typeNotes("Submitted");
    await awaitAutosave();
    await typeNotes("Newer edits");
    await click("Retry save");
    expect(vi.mocked(api.saveMeetingNotes).mock.calls[1]?.[0]).toEqual(
      vi.mocked(api.saveMeetingNotes).mock.calls[0]?.[0]
    );
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Newer edits"
    );
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
      phase: "idle"
    });
  });
  it("requires conflict review and preserves typed text", async () => {
    vi.mocked(api.saveMeetingNotes).mockRejectedValue(
      new ApiError(409, "Conflict", "meeting_notes_conflict")
    );
    vi.mocked(api.getMeeting).mockResolvedValue({
      meeting: { ...meeting, personalNotes: "Other window", notesRevision: 3 }
    });
    await mount();
    await typeNotes("My edits");
    await awaitAutosave();
    expect(renderer.root.findByProps({ id: "meeting-current-notes" }).props.value).toBe(
      "Other window"
    );
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
      phase: "conflict"
    });
    await click("Keep my version");
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "My edits"
    );
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
      phase: "idle"
    });
  });
  it("canceling delete keeps edits and does not issue a delete", async () => {
    await mount();
    await typeNotes("Keep me");
    await click("Delete meeting");
    await click("Cancel");
    expect(api.deleteMeeting).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe("Keep me");
  });
  it("explicit deletion invalidates history and removes editor cache", async () => {
    vi.mocked(api.deleteMeeting).mockResolvedValue(undefined);
    await mount();
    await click("Delete meeting");
    await click("Permanently delete meeting");
    expect(api.deleteMeeting).toHaveBeenCalledWith(meeting.id);
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toBeUndefined();
    expect(client.getQueryData(["meetings", "title", meeting.id])).toBeUndefined();
  });
  it("clears the deleted route and cached rows while retaining search and pruning legacy filter caches", async () => {
    const remaining = historyItem({ ...meeting, id: "22334455-1122-4122-8122-112233445566" });
    const listKey = historyApi.historyKeys.search("private words", "notes-only");
    client.setQueryData(historyApi.historyKeys.view, { query: "private words" });
    client.setQueryData<InfiniteData<MeetingHistoryPage>>(listKey, {
      pages: [{ meetings: [historyItem(meeting), remaining], nextCursor: null }],
      pageParams: [undefined]
    });
    // The refresh is intentionally unresolved: navigation must not reselect the cached deletion.
    vi.mocked(historyApi.searchMeetingHistory).mockReturnValue(new Promise(() => {}));
    vi.mocked(historyApi.getMeetingHistoryItem).mockResolvedValue({ meeting: remaining });
    vi.mocked(api.deleteMeeting).mockResolvedValue(undefined);
    await mount(`/meetings?id=${meeting.id}&selected=${meeting.id}&state=notes-only`);
    await click("Delete meeting");
    await click("Permanently delete meeting");
    expect(new URLSearchParams(location)).toEqual(new URLSearchParams());
    expect(client.getQueryData(historyApi.historyKeys.view)).toEqual({ query: "private words" });
    expect(
      client.getQueryData<InfiniteData<MeetingHistoryPage>>(listKey)?.pages[0]?.meetings
    ).toEqual([remaining]);
    expect(historyApi.getMeetingHistoryItem).not.toHaveBeenCalledWith(
      meeting.id,
      expect.anything()
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Retry selected meeting");
  });
  it.each([false, true])(
    "cancels pre-deletion history reads before pruning (prior error: %s)",
    async (priorError) => {
      const listKey = historyApi.historyKeys.search("old query", "all");
      client.setQueryData<InfiniteData<MeetingHistoryPage>>(listKey, {
        pages: [{ meetings: [historyItem(meeting)], nextCursor: null }],
        pageParams: [undefined]
      });
      if (priorError) {
        await client
          .fetchInfiniteQuery({
            queryKey: listKey,
            initialPageParam: undefined,
            staleTime: 0,
            queryFn: async () => {
              throw new ApiError(503, "Unavailable");
            }
          })
          .catch(() => undefined);
      }
      let finishList!: (page: MeetingHistoryPage) => void;
      let listSignal!: AbortSignal;
      const oldList = client
        .fetchInfiniteQuery({
          queryKey: listKey,
          initialPageParam: undefined,
          staleTime: 0,
          queryFn: ({ signal }) => {
            listSignal = signal;
            return new Promise<MeetingHistoryPage>((resolve) => {
              finishList = resolve;
            });
          }
        })
        .catch(() => undefined);
      let finishDetail!: (value: { meeting: ReturnType<typeof historyItem> }) => void;
      let detailSignal!: AbortSignal;
      const oldDetail = client
        .fetchQuery({
          queryKey: historyApi.historyKeys.item(meeting.id),
          queryFn: ({ signal }) => {
            detailSignal = signal;
            return new Promise<{ meeting: ReturnType<typeof historyItem> }>((resolve) => {
              finishDetail = resolve;
            });
          }
        })
        .catch(() => undefined);
      vi.mocked(historyApi.searchMeetingHistory).mockResolvedValue({
        meetings: [],
        nextCursor: null
      });
      vi.mocked(api.deleteMeeting).mockResolvedValue(undefined);
      await mount();
      await click("Delete meeting");
      await click("Permanently delete meeting");
      expect(listSignal.aborted).toBe(true);
      expect(detailSignal.aborted).toBe(true);
      await act(async () => {
        finishList({ meetings: [historyItem(meeting)], nextCursor: null });
        finishDetail({ meeting: historyItem(meeting) });
        await Promise.all([oldList, oldDetail]);
      });
      expect(
        client.getQueryData<InfiniteData<MeetingHistoryPage>>(listKey)?.pages[0]?.meetings
      ).toEqual([]);
      expect(client.getQueryData(historyApi.historyKeys.item(meeting.id))).toBeUndefined();
      expect(client.getQueryState(listKey)?.status).toBe(priorError ? "error" : "success");
    }
  );
  it("keeps the current review and selection when deletion is not confirmed", async () => {
    vi.mocked(api.deleteMeeting).mockRejectedValue(new Error("offline"));
    await mount(`/meetings?id=${meeting.id}&selected=${meeting.id}`);
    await click("Delete meeting");
    await click("Permanently delete meeting");
    expect(new URLSearchParams(location).get("id")).toBe(meeting.id);
    expect(JSON.stringify(renderer.toJSON())).toContain("Couldn’t confirm deletion");
  });
  it.each(["history", "review"])(
    "a delayed delete preserves a newer %s navigation and its selection",
    async (view) => {
      const other = { ...meeting, id: "22334455-1122-4122-8122-112233445566" };
      let finish!: () => void;
      vi.mocked(api.deleteMeeting).mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      vi.mocked(historyApi.searchMeetingHistory).mockResolvedValue({
        meetings: [historyItem(other)],
        nextCursor: null
      });
      vi.mocked(historyApi.getMeetingHistoryItem).mockResolvedValue({
        meeting: historyItem(other)
      });
      vi.mocked(api.getMeeting).mockImplementation(async (id) => ({
        meeting: id === other.id ? other : meeting
      }));
      await mount();
      await click("Delete meeting");
      await click("Permanently delete meeting");
      const destination = view === "history" ? "" : `?id=${other.id}`;
      await act(async () => navigate(`/meetings${destination}`));
      await flush();
      await act(async () => finish());
      await flush();
      expect(location).toBe(destination);
    }
  );
  it("retries uncertain meeting creation with one key", async () => {
    vi.mocked(api.createMeeting)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ meeting, created: false });
    await mount("/meetings");
    await click("New meeting");
    await click("Retry opening meeting");
    expect(vi.mocked(api.createMeeting).mock.calls[1]?.[0]).toEqual(
      vi.mocked(api.createMeeting).mock.calls[0]?.[0]
    );
  });
  it("opens a notes-ready meeting without changing saved sources or starting capture", async () => {
    const savedPreferences = { ...preferences, defaultCaptureMode: "selected-app" as const };
    vi.mocked(api.getMeetingPreferences).mockResolvedValue(savedPreferences);
    await mount("/meetings");
    await click("New meeting");
    expect(api.createMeeting).toHaveBeenCalledWith({
      requestKey: expect.any(String),
      title: "Untitled meeting"
    });
    expect(new URLSearchParams(location).get("id")).toBe(meeting.id);
    expect(api.putMeetingPreferences).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith("/capture/start"))
    ).toBe(false);
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Saved notes"
    );
  });
  it("remounts with edits retained only in the authenticated query client", async () => {
    await mount();
    await typeNotes("Recovered after navigation");
    await act(async () => renderer.unmount());
    await mount();
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Recovered after navigation"
    );
    await act(async () => renderer.unmount());
    client.clear();
    client.setQueryData(api.meetingKeys.record(meeting.id), { meeting });
    await mount();
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Saved notes"
    );
  });
  it("keeps uncertain create identity through another meeting and back", async () => {
    vi.mocked(api.createMeeting).mockRejectedValue(new Error("offline"));
    await mount("/meetings");
    await click("New meeting");
    await act(async () => navigate(`/meetings?id=${meeting.id}`));
    await flush();
    await click("Meetings");
    await click("Retry opening meeting");
    expect(vi.mocked(api.createMeeting).mock.calls[1]?.[0]).toEqual(
      vi.mocked(api.createMeeting).mock.calls[0]?.[0]
    );
  });
  it("does not repopulate notes after the signed-in cache is cleared", async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof api.saveMeetingNotes>>) => void;
    vi.mocked(api.saveMeetingNotes).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    await mount();
    await typeNotes("Pending notes");
    await awaitAutosave();
    await act(async () => renderer.unmount());
    client.clear();
    await act(async () =>
      resolveSave({
        status: "saved",
        replayed: false,
        meeting: { ...meeting, personalNotes: "Pending notes", notesRevision: 2 }
      })
    );
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toBeUndefined();
    expect(client.getQueryData(api.meetingKeys.record(meeting.id))).toBeUndefined();
  });
  it.each([401, 403, 404])(
    "a later %s denial prevents an earlier save from resurrecting private data",
    async (status) => {
      let resolveSave!: (value: Awaited<ReturnType<typeof api.saveMeetingNotes>>) => void;
      vi.mocked(api.saveMeetingNotes).mockReturnValue(
        new Promise((resolve) => {
          resolveSave = resolve;
        })
      );
      await mount();
      await typeNotes("Private pending edit");
      await awaitAutosave();
      vi.mocked(api.getMeeting).mockRejectedValue(new ApiError(status, "Denied"));
      await act(async () => {
        await client.refetchQueries({ queryKey: api.meetingKeys.record(meeting.id) });
      });
      await flush();
      expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toBeUndefined();
      expect(client.getQueryData(["meetings", "title", meeting.id])).toBeUndefined();
      await act(async () =>
        resolveSave({
          status: "saved",
          replayed: false,
          meeting: { ...meeting, personalNotes: "Private pending edit", notesRevision: 2 }
        })
      );
      await flush();
      expect(client.getQueryState(api.meetingKeys.record(meeting.id))?.status).toBe("error");
      expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toBeUndefined();
      expect(JSON.stringify(renderer.toJSON())).not.toContain("Private pending edit");
      expect(JSON.stringify(renderer.toJSON())).not.toContain("Design review");
      // Re-entry after a later successful authorization must not recover the invalidated save.
      vi.mocked(api.getMeeting).mockResolvedValue({ meeting });
      await click("Try again");
      expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
        "Saved notes"
      );
    }
  );
  it("keeps the active panel and notes node mounted during background record reads", async () => {
    await mount();
    await act(async () =>
      renderer.root.findByProps({ id: "meeting-review-tab-notes" }).props.onClick()
    );
    await typeNotes("Keep this exact editor");
    const editor = renderer.root.findByProps({ id: "meeting-personal-notes" });
    let finish!: (value: { meeting: MeetingRecord }) => void;
    vi.mocked(api.getMeeting).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => {
      void client.refetchQueries({ queryKey: api.meetingKeys.record(meeting.id) });
    });
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" })).toBe(editor);
    expect(renderer.root.findByProps({ id: "meeting-review-panel-notes" }).props.hidden).toBe(
      false
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("Design review");
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    await act(async () => finish({ meeting }));
    await flush();
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" })).toBe(editor);
  });
  it("retains sign-out warning through history navigation and clears it after saving", async () => {
    await mount();
    await typeNotes("Needs saving");
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    await click("Meetings");
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    await click("Design review");
    vi.mocked(api.saveMeetingNotes).mockResolvedValue({
      status: "saved",
      replayed: false,
      meeting: { ...meeting, personalNotes: "Needs saving", notesRevision: 2 }
    });
    await awaitAutosave();
    expect(hasSessionUnsavedChanges(client)).toBe(false);
  });
  it("uses the shared sign-out confirmation without a second notes beforeunload guard", async () => {
    const signOut = vi.fn(() => {
      // The shell clears the authenticated cache immediately before location.assign.
      client.clear();
      expect(hasSessionUnsavedChanges(client)).toBe(false);
      expect(
        vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === "beforeunload")
      ).toHaveLength(0);
    });
    let guard!: ReturnType<typeof useSignOutGuard>;
    function Review() {
      guard = useSignOutGuard(client, signOut);
      return <MeetingNotes meeting={meeting} onDeleted={() => {}} />;
    }
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Review />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await typeNotes("Keep unless I confirm");
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    await act(async () => guard.request());
    expect(guard.confirming).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => guard.cancel());
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Keep unless I confirm"
    );
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    await act(async () => guard.request());
    await act(async () => guard.confirm());
    expect(signOut).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "updates the shared marker when a note save finishes after navigation (newer edits: %s)",
    async (newerEdits) => {
      let resolveSave!: (value: Awaited<ReturnType<typeof api.saveMeetingNotes>>) => void;
      vi.mocked(api.saveMeetingNotes).mockReturnValue(
        new Promise((resolve) => {
          resolveSave = resolve;
        })
      );
      await mount();
      await typeNotes("Submitted notes");
      await awaitAutosave();
      if (newerEdits) await typeNotes("Newer unsaved notes");
      await click("Meetings");
      expect(renderer.root.findAllByType(MeetingNotes)).toHaveLength(0);
      expect(hasSessionUnsavedChanges(client)).toBe(true);
      await act(async () =>
        resolveSave({
          status: "saved",
          replayed: false,
          meeting: { ...meeting, personalNotes: "Submitted notes", notesRevision: 2 }
        })
      );
      expect(hasSessionUnsavedChanges(client)).toBe(newerEdits);
      expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
        text: newerEdits ? "Newer unsaved notes" : "Submitted notes",
        base: { personalNotes: "Submitted notes" },
        phase: "idle"
      });
    }
  );
  it("retains unsaved recovery through an ordinary transient read failure", async () => {
    await mount();
    await typeNotes("Recover my edit");
    vi.mocked(api.getMeeting).mockRejectedValueOnce(new Error("Offline"));
    await act(async () => {
      await client.refetchQueries({ queryKey: api.meetingKeys.record(meeting.id) });
    });
    await flush();
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
      text: "Recover my edit"
    });
    vi.mocked(api.getMeeting).mockResolvedValue({ meeting });
    await click("Try again");
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Recover my edit"
    );
  });
  it("refreshes clean notes from a newer real record and preserves dirty edits", async () => {
    await mount();
    // Settle the initial transport read before injecting a newer record. Record observer
    // notification, the rebase effect, and editor observer notification are separate turns.
    await waitForRender(() => {
      expect(client.getQueryState(api.meetingKeys.record(meeting.id))).toMatchObject({
        status: "success",
        fetchStatus: "idle"
      });
      expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
        "Saved notes"
      );
    });
    await act(async () => {
      client.setQueryData(api.meetingKeys.record(meeting.id), {
        meeting: { ...meeting, personalNotes: "New saved version", notesRevision: 2 }
      });
    });
    await waitForRender(() => {
      expect(renderer.root.findByType(MeetingNotes).props.meeting.notesRevision).toBe(2);
      expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
        "New saved version"
      );
      expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
        base: { notesRevision: 2 },
        text: "New saved version"
      });
    });
    await typeNotes("My unsaved version");
    await act(async () => {
      client.setQueryData(api.meetingKeys.record(meeting.id), {
        meeting: { ...meeting, personalNotes: "Another saved version", notesRevision: 3 }
      });
    });
    await waitForRender(() => {
      expect(renderer.root.findByType(MeetingNotes).props.meeting.notesRevision).toBe(3);
      expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
        "My unsaved version"
      );
      expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
        base: { notesRevision: 2 },
        text: "My unsaved version"
      });
    });
  });
  it("never downgrades a newer record when an old save receipt is replayed", async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof api.saveMeetingNotes>>) => void;
    vi.mocked(api.saveMeetingNotes).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    await mount();
    await typeNotes("Submitted");
    await awaitAutosave();
    await act(async () => {
      client.setQueryData(api.meetingKeys.record(meeting.id), {
        meeting: { ...meeting, personalNotes: "Revision three", notesRevision: 3 }
      });
    });
    await act(async () =>
      resolveSave({
        status: "saved",
        replayed: true,
        meeting: { ...meeting, personalNotes: "Submitted", notesRevision: 2 }
      })
    );
    await flush();
    expect(
      client.getQueryData<{ meeting: MeetingRecord }>(api.meetingKeys.record(meeting.id))?.meeting
        .notesRevision
    ).toBe(3);
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Submitted"
    );
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
      phase: "conflict"
    });
    await click("Keep my version");
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toMatchObject({
      phase: "idle"
    });
  });
  it("a delayed creation rejection unlocks retry after leaving and remounting the list", async () => {
    let rejectCreate!: (error: Error) => void;
    vi.mocked(api.createMeeting).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      })
    );
    await mount("/meetings");
    await click("New meeting");
    await act(async () => navigate(`/meetings?id=${meeting.id}`));
    await flush();
    await click("Meetings");
    expect(button("Opening meeting…").props.disabled).toBe(true);
    await act(async () =>
      rejectCreate(new ApiError(400, "Invalid input", "meeting_invalid_input"))
    );
    await flush();
    expect(button("New meeting").props.disabled).toBe(false);
    expect(button("Retry opening meeting")).toBeDefined();
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
  });
  it("a delete finishing after navigation does not leave a newly opened one-time setup", async () => {
    let resolveDelete!: () => void;
    vi.mocked(api.deleteMeeting).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      })
    );
    await mount();
    await click("Delete meeting");
    await click("Permanently delete meeting");
    vi.mocked(api.getMeetingPreferences).mockResolvedValue({
      ...preferences,
      setupCompletedAt: null
    });
    await act(async () => navigate("/meetings"));
    await flush();
    await click("New meeting");
    await act(async () => resolveDelete());
    await flush();
    expect(JSON.stringify(renderer.toJSON())).toContain("Set up Meetings");
    expect(api.createMeeting).not.toHaveBeenCalled();
  });
  it("blocks rapid duplicate note submissions before a render", async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof api.saveMeetingNotes>>) => void;
    vi.mocked(api.saveMeetingNotes).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    await mount();
    await typeNotes("Submit once");
    await act(async () => {
      const save = renderer.root.findByType(MeetingNotesPane).props.editor.save;
      save();
      save();
    });
    expect(api.saveMeetingNotes).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolveSave({
        status: "saved",
        replayed: false,
        meeting: { ...meeting, personalNotes: "Submit once", notesRevision: 2 }
      })
    );
  });
});
