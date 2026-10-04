import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@moss/module-web-sdk";
import type { MeetingRecord } from "@moss/shared";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import * as api from "../../packages/meetings/src/web/client.js";

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
const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Design review",
  personalNotes: "Saved notes",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
};
let renderer: ReactTestRenderer;
let client: QueryClient;
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
function button(label: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.join("") === label)!;
}
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
  });
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
          <MeetingsPage />
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
      if (!path.startsWith("/api/meetings/records/"))
        throw new Error(`Unexpected unit request: ${path}`);
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
  vi.mocked(api.getMeetingPreferences).mockResolvedValue({ defaultCaptureMode: null });
  vi.mocked(api.listMeetings).mockResolvedValue({ meetings: [meeting] });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  client.clear();
  vi.unstubAllGlobals();
});

describe("meeting UI interactions (unit transport stubs, not live proof)", () => {
  it("keeps typed notes through masthead history navigation and reopening", async () => {
    await mount();
    await typeNotes("Unsaved note");
    await click("View meeting history");
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
    await click("Save notes");
    await typeNotes("Newer edits");
    await click("Retry save");
    expect(vi.mocked(api.saveMeetingNotes).mock.calls[1]?.[0]).toEqual(
      vi.mocked(api.saveMeetingNotes).mock.calls[0]?.[0]
    );
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Newer edits"
    );
    expect(button("Save notes").props.disabled).toBe(false);
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
    await click("Save notes");
    expect(renderer.root.findByProps({ id: "meeting-current-notes" }).props.value).toBe(
      "Other window"
    );
    expect(button("Save notes").props.disabled).toBe(true);
    await click("Keep my version");
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "My edits"
    );
    expect(button("Save notes").props.disabled).toBe(false);
  });
  it("canceling delete keeps edits and does not issue a delete", async () => {
    await mount();
    await typeNotes("Keep me");
    await click("Delete draft");
    await click("Cancel");
    expect(api.deleteMeeting).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe("Keep me");
  });
  it("explicit deletion invalidates history and removes editor cache", async () => {
    vi.mocked(api.deleteMeeting).mockResolvedValue(undefined);
    await mount();
    await click("Delete draft");
    await click("Permanently delete draft");
    expect(api.deleteMeeting).toHaveBeenCalledWith(meeting.id);
    expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toBeUndefined();
  });
  it("retries uncertain draft creation with one key", async () => {
    vi.mocked(api.createMeeting)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ meeting, created: false });
    await mount("/meetings");
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-title" })
        .props.onChange({ target: { value: "Design review" } })
    );
    await click("Create draft");
    await click("Retry creating draft");
    expect(vi.mocked(api.createMeeting).mock.calls[1]?.[0]).toEqual(
      vi.mocked(api.createMeeting).mock.calls[0]?.[0]
    );
  });
  it("never saves a default just by choosing a mode; explicit switch saves it", async () => {
    vi.mocked(api.putMeetingPreferences).mockResolvedValue({ defaultCaptureMode: "selected-app" });
    await mount("/meetings");
    await click("Microphone and selected app");
    expect(api.putMeetingPreferences).not.toHaveBeenCalled();
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Use this capture mode as my default" })
        .props.onChange({ target: { checked: true } })
    );
    await flush();
    expect(api.putMeetingPreferences).toHaveBeenCalledWith(
      { defaultCaptureMode: "selected-app" },
      expect.anything()
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
  it("keeps uncertain create identity when Setup is left and reopened", async () => {
    vi.mocked(api.createMeeting).mockRejectedValue(new Error("offline"));
    await mount("/meetings");
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-title" })
        .props.onChange({ target: { value: "Design review" } })
    );
    await click("Create draft");
    await click("View meeting history");
    await click("New meeting draft");
    expect(renderer.root.findByProps({ id: "meeting-title" }).props.value).toBe("Design review");
    await click("Retry creating draft");
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
    await click("Save notes");
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
      await click("Save notes");
      vi.mocked(api.getMeeting).mockRejectedValue(new ApiError(status, "Denied"));
      await act(async () => {
        await client.refetchQueries({ queryKey: api.meetingKeys.record(meeting.id) });
      });
      await flush();
      expect(client.getQueryData(api.meetingKeys.editor(meeting.id))).toBeUndefined();
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
      await click("Retry loading draft");
      expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
        "Saved notes"
      );
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
    await click("Retry loading draft");
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Recover my edit"
    );
  });
  it("refreshes clean notes from a newer real record and preserves dirty edits", async () => {
    await mount();
    await act(async () => {
      client.setQueryData(api.meetingKeys.record(meeting.id), {
        meeting: { ...meeting, personalNotes: "New saved version", notesRevision: 2 }
      });
    });
    await flush();
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "New saved version"
    );
    await typeNotes("My unsaved version");
    await act(async () => {
      client.setQueryData(api.meetingKeys.record(meeting.id), {
        meeting: { ...meeting, personalNotes: "Another saved version", notesRevision: 3 }
      });
    });
    await flush();
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "My unsaved version"
    );
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
    await click("Save notes");
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
    expect(button("Save notes").props.disabled).toBe(true);
    await click("Keep my version");
    expect(button("Save notes").props.disabled).toBe(false);
  });
  it("a delayed validation rejection unlocks the remounted setup title", async () => {
    let rejectCreate!: (error: Error) => void;
    vi.mocked(api.createMeeting).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      })
    );
    await mount("/meetings");
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-title" })
        .props.onChange({ target: { value: "Design review" } })
    );
    await flush();
    await click("Create draft");
    await click("View meeting history");
    await click("New meeting draft");
    expect(renderer.root.findByProps({ id: "meeting-title" }).props.disabled).toBe(true);
    await act(async () =>
      rejectCreate(new ApiError(400, "Invalid input", "meeting_invalid_input"))
    );
    await flush();
    expect(renderer.root.findByProps({ id: "meeting-title" }).props.disabled).toBe(false);
    expect(renderer.root.findByProps({ id: "meeting-title" }).props.value).toBe("Design review");
  });
  it("a delete finishing after navigation does not leave the new setup", async () => {
    let resolveDelete!: () => void;
    vi.mocked(api.deleteMeeting).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      })
    );
    await mount();
    await click("Delete draft");
    await click("Permanently delete draft");
    await click("View meeting history");
    await click("New meeting draft");
    await act(async () => resolveDelete());
    await flush();
    expect(renderer.root.findByProps({ id: "meeting-title" })).toBeDefined();
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
      const save = button("Save notes").props.onClick;
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
