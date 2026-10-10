import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MeetingRecord } from "@moss/shared";
import { historyItem } from "./fixtures/meeting-history.js";
import { historyKeys } from "../../packages/meetings/src/web/history-client.js";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";
import { meetingLinkKeys } from "../../packages/meetings/src/web/meeting-link-state.js";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";
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
  client.setQueryData(meetingLinkKeys.sessions, {
    sessions: [
      {
        id: "linked-mac",
        source: "companion",
        deviceLabel: "Studio Mac",
        lastSeenAt: meeting.createdAt
      }
    ]
  });
  client.setQueryData(meetingLinkKeys.capabilities, {
    devices: [{ deviceId: "linked-mac", state: "approved", revision: 1, policyVersion: 1 }]
  });
  client.setQueryData(captureKeys.devices, { devices: [], processingReady: true });
  seed?.(client);
  return renderToString(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <MeetingsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Meetings screen", () => {
  it("discovers its package-owned route", () => {
    const found = scanModuleWeb({ rootDir: process.cwd() });
    expect(found.routes).toContainEqual(
      expect.objectContaining({ moduleId: "meetings", path: "/meetings", icon: "mic" })
    );
    expect(found.contributions.meetings).toContain("@moss/meetings/web");
  });
  it("opens on a minimal list with one New meeting action", () => {
    const html = render("/meetings");
    expect(html).toContain("New meeting");
    expect(html).toContain('class="jds-btn jds-btn--link"');
    expect(html).toContain('href="/settings?section=modules&amp;module=meetings"');
    expect(html).not.toContain("Meeting title (optional)");
    expect(html).not.toContain("Prepare this meeting");
    expect(html).not.toContain("Start meeting");
  });
  it("distinguishes loading from empty history", () => {
    const loading = render("/meetings?view=history");
    expect(loading).toContain("Loading meetings");
    expect(loading).not.toContain("Your first draft");
    const empty = render("/meetings?view=history", (client) =>
      client.setQueryData(historyKeys.search("", "all"), {
        pages: [{ meetings: [], nextCursor: null }],
        pageParams: [undefined]
      })
    );
    expect(empty).toContain("No meetings yet. Start with New meeting.");
    expect(empty).not.toContain("Loading meetings");
  });
  it("shows factual history columns and server search", () => {
    const html = render("/meetings?view=history", (client) =>
      client.setQueryData(historyKeys.search("", "all"), {
        pages: [{ meetings: [historyItem(meeting)], nextCursor: null }],
        pageParams: [undefined]
      })
    );
    expect(html).toContain("Design review");
    expect(html).toContain("Search meetings");
    expect(html).not.toContain("Processing");
    expect(html).not.toContain("Capture");
    expect(html).not.toContain("Unavailable");
    expect(html).not.toContain("Saved to vault");
  });
  it("opens transcript and notes without a separate Ask Moss button", () => {
    const html = render(`/meetings?id=${meeting.id}`, (client) =>
      client.setQueryData(meetingKeys.record(meeting.id), { meeting })
    );
    expect(html).toContain("Design review");
    expect(html).toContain("First notes");
    expect(html).not.toContain("Ask Moss");
    expect(html).toContain("Transcript");
    expect(html).toContain("Personal notes");
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
