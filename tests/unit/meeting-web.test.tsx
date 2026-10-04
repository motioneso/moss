import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MeetingRecord } from "@moss/shared";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";
import {
  beginNoteSave,
  finishNoteSave,
  hasUnsavedNotes,
  newEditor,
  rebaseNoteEdits
} from "../../packages/meetings/src/web/editor-state.js";
import { scanModuleWeb } from "../../packages/settings-ui/src/vite.js";

const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Design review",
  personalNotes: "First notes",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
};
function render(path: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({
    // SSR fixtures show settled data; query lifecycle/focus is covered separately.
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnMount: false } }
  });
  seed?.(client);
  return renderToString(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <MeetingsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Meetings draft screen", () => {
  it("discovers its package-owned route", () => {
    const found = scanModuleWeb({ rootDir: process.cwd() });
    expect(found.routes).toContainEqual(
      expect.objectContaining({ moduleId: "meetings", path: "/meetings", icon: "mic" })
    );
    expect(found.contributions.meetings).toContain("@moss/meetings/web");
  });
  it("offers three explicit capture choices, with recording and source checks unavailable", () => {
    const html = render("/meetings", (client) =>
      client.setQueryData(meetingKeys.preferences, { defaultCaptureMode: null })
    );
    expect(html).toContain("Microphone and computer audio");
    expect(html).toContain("Microphone and selected app");
    expect(html).toContain("Microphone only");
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toMatch(
      /disabled=""[^>]*aria-describedby="meeting-capture-unavailable"[^>]*>Start meeting/
    );
    expect(html).toContain("native capture is not implemented");
    expect(html).toContain("/settings?section=aiproviders");
    expect(html).not.toContain("Ready to start");
  });
  it("distinguishes loading from empty history", () => {
    const loading = render("/meetings?view=history");
    expect(loading).toContain("Loading your meeting drafts");
    expect(loading).not.toContain("Your first draft");
    const empty = render("/meetings?view=history", (client) =>
      client.setQueryData(meetingKeys.history, {
        pages: [{ meetings: [] }],
        pageParams: [undefined]
      })
    );
    expect(empty).toContain("Your first draft starts here");
    expect(empty).not.toContain("Loading your meeting drafts");
  });
  it("labels actual history records only as unrecorded drafts", () => {
    const html = render("/meetings?view=history", (client) =>
      client.setQueryData(meetingKeys.history, {
        pages: [{ meetings: [meeting] }],
        pageParams: [undefined]
      })
    );
    expect(html).toContain("Design review");
    expect(html).toContain("Draft · Not recorded");
    expect(html).not.toContain("Saved to vault");
  });
  it("opens real notes and explicitly disables meeting chat", () => {
    const html = render(`/meetings?id=${meeting.id}`, (client) =>
      client.setQueryData(meetingKeys.record(meeting.id), { meeting })
    );
    expect(html).toContain("Design review");
    expect(html).toContain("First notes");
    expect(html).toContain("Meeting chat needs an available transcript");
    expect(html).toMatch(/disabled=""[^>]*aria-describedby="meeting-chat-unavailable"/);
  });
});

describe("meeting note request state", () => {
  it("retries the same snapshot and key even when typing continues", () => {
    const start = beginNoteSave({ ...newEditor(meeting), text: "Sent notes" }, "first-key");
    const retry = beginNoteSave({ ...start, phase: "failed", text: "Newer edits" }, "second-key");
    expect(retry.pending).toEqual(start.pending);
    expect(retry.text).toBe("Newer edits");
    const saved = finishNoteSave(retry, {
      ...meeting,
      personalNotes: "Sent notes",
      notesRevision: 2
    });
    expect(saved.text).toBe("Newer edits");
    expect(hasUnsavedNotes(saved)).toBe(true);
    expect(beginNoteSave(saved, "third-key").pending).toMatchObject({
      requestKey: "third-key",
      expectedRevision: 2,
      personalNotes: "Newer edits"
    });
  });
  it("conflict review rebases explicitly without replacing typed notes", () => {
    const state = {
      ...newEditor(meeting),
      text: "My edits",
      phase: "conflict" as const,
      latest: { ...meeting, notesRevision: 5, personalNotes: "Other edits" }
    };
    const rebased = rebaseNoteEdits(state);
    expect(rebased.text).toBe("My edits");
    expect(rebased.base.personalNotes).toBe("Other edits");
    expect(beginNoteSave(rebased, "new-key").pending?.expectedRevision).toBe(5);
  });
});
