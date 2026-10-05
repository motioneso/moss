import { afterEach, describe, expect, it, vi } from "vitest";
import {
  searchMeetingHistory,
  getMeetingHistoryItem
} from "../../packages/meetings/src/web/history-client.js";
import {
  historyFilter,
  indexingStatus,
  processingStatus,
  transcriptSpan,
  vaultStatus
} from "../../packages/meetings/src/web/history-presentation.js";
import { historyItem } from "./fixtures/meeting-history.js";

const draft = historyItem({
  id: "11223344-1122-4122-8122-112233445566",
  title: "Synthetic review",
  personalNotes: "",
  notesRevision: 0,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
});
afterEach(() => vi.unstubAllGlobals());

describe("history transport and truthful labels", () => {
  it("sends private search only in a credentialed POST body with a cancel signal", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"meetings":[],"nextCursor":null}'));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const input = {
      query: "private words",
      filter: "transcript" as const,
      limit: 30,
      before: { id: draft.id, createdAt: draft.createdAt }
    };
    await searchMeetingHistory(input, controller.signal);
    const [path, options] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/meetings/history/search");
    expect(options).toMatchObject({
      method: "POST",
      credentials: "include",
      signal: controller.signal
    });
    expect(JSON.parse(options.body)).toEqual(input);
  });
  it("retrieves the selected metadata independently by ID", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ meeting: draft })));
    vi.stubGlobal("fetch", fetch);
    await getMeetingHistoryItem(draft.id);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/meetings/history/${draft.id}`);
  });
  it("keeps summary generation, transcript and previous saved-version facts separate", () => {
    const meeting = {
      ...draft,
      transcript: {
        ...draft.transcript,
        status: "retained" as const,
        segmentCount: 2,
        provisionalSegmentCount: 1,
        finalSegmentCount: 1,
        span: { startMs: 1000, endMs: 65000 }
      },
      summary: {
        ...draft.summary,
        status: "stale" as const,
        version: 2,
        generation: { status: "failed" as const, expiresAt: draft.createdAt }
      },
      vault: {
        savedVersionCount: 1,
        latest: {
          artifactVersion: 2,
          writeStatus: "failed" as const,
          indexStatus: "not-requested" as const,
          updatedAt: draft.updatedAt
        }
      }
    };
    expect(transcriptSpan(meeting)).toBe("0:01–1:05");
    expect(processingStatus(meeting)).toBe("Generation failed");
    expect(vaultStatus(meeting)).toBe("Save failed");
    expect(indexingStatus(meeting)).toBeNull();
    expect(
      processingStatus({ ...meeting, summary: { ...meeting.summary, generation: null } })
    ).toBe("Summary needs review");
    expect(
      indexingStatus({
        ...meeting,
        vault: {
          ...meeting.vault,
          latest: { ...meeting.vault.latest, writeStatus: "saved", indexStatus: "queued" }
        }
      })
    ).toBe("Search indexing queued");
  });
  it("does not infer completion, duration or native capture from a retained span", () => {
    expect(processingStatus(draft)).toBe("Not generated");
    expect(transcriptSpan(draft)).toBeNull();
    expect(vaultStatus(draft)).toBe("Not saved");
    expect(historyFilter("made-up-state")).toBe("all");
    expect(historyFilter("needs-review")).toBe("needs-review");
  });
});
