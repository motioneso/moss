import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ApiError } from "@moss/module-web-sdk";
import type { MeetingCaptureGap } from "@moss/shared";
import {
  MeetingTranscript,
  TranscriptTimeline
} from "../../packages/meetings/src/web/meeting-transcript.js";
import { transcriptTime } from "../../packages/meetings/src/web/transcript-time.js";
import { parseTranscriptEvidence } from "../../packages/meetings/src/web/transcript-evidence.js";
import {
  getMeetingTranscript,
  getMeetingTranscriptEvidence,
  meetingKeys,
  type MeetingTranscriptView
} from "../../packages/meetings/src/web/client.js";

const fixture: MeetingTranscriptView = {
  sources: [
    {
      sourceId: "mic",
      epoch: 1,
      kind: "microphone",
      label: "Desk microphone",
      startMs: 0,
      endMs: 10000
    }
  ],
  snapshot: {
    meetingId: "meeting",
    ownerUserId: "owner",
    transcriptRevision: 2,
    cursor: 2,
    cutoffMs: 10000,
    maxSegments: 500,
    maxCharacters: 100000,
    throughMs: 2000,
    omittedSegments: 3,
    containsProvisional: true,
    segments: [
      {
        meetingId: "meeting",
        segmentId: "s1",
        sourceId: "mic",
        epoch: 1,
        startMs: 1000,
        endMs: 2000,
        revision: 2,
        text: "<script>unsafe</script>\nA correction",
        finality: "provisional",
        provenance: "correction",
        speakerId: "anonymous-1"
      }
    ]
  }
};
afterEach(() => vi.unstubAllGlobals());
describe("retained transcript review", () => {
  it.each([
    [11, "interrupted"],
    [12, "interrupted"],
    [249, "interrupted"],
    [12, "processing-failed"]
  ] as const)(
    "hides a %i ms %s range without changing retained diagnostics",
    (durationMs, reason) => {
      // Cross a displayed second: visibility depends on exact duration, not timestamp labels.
      const gaps = Object.freeze([
        Object.freeze({
          id: "tiny-gap",
          sourceId: "mic",
          epoch: 1,
          startMs: 3995,
          endMs: 3995 + durationMs,
          reason
        })
      ]);
      const original = JSON.stringify(gaps);
      const html = renderToString(<TranscriptTimeline {...fixture} gaps={gaps} />);
      expect(html).not.toContain("meetings-transcript-gap");
      expect(html).not.toContain(" missing");
      expect(html).toContain("A correction");
      expect(JSON.stringify(gaps)).toBe(original);
    }
  );
  it.each([250, 900, 1000])(
    "shows a %i ms missing range alongside hidden tiny gaps",
    (durationMs) => {
      const gaps: MeetingCaptureGap[] = [
        {
          id: "tiny-gap",
          sourceId: "mic",
          epoch: 1,
          startMs: 2500,
          endMs: 2512,
          reason: "interrupted"
        },
        {
          id: "real-gap",
          sourceId: "mic",
          epoch: 1,
          startMs: 3000,
          endMs: 3000 + durationMs,
          reason: "interrupted"
        }
      ];
      const html = renderToString(<TranscriptTimeline {...fixture} gaps={gaps} />).replaceAll(
        "<!-- -->",
        ""
      );
      expect(html.match(/meetings-transcript-gap/g)).toHaveLength(1);
      if (durationMs < 1000) {
        expect(html).toContain("Under a second missing at 0:03");
        expect(html).not.toContain("0:03 to 0:03 missing");
      } else {
        expect(html).toContain("0:03 to 0:04 missing");
      }
    }
  );
  it("shows one missing range for duplicate reports of a failed clip without changing diagnostics", () => {
    const gap: MeetingCaptureGap = {
      id: "failed-upload-request",
      sourceId: "mic",
      epoch: 1,
      startMs: 3000,
      endMs: 4000,
      reason: "processing-failed"
    };
    const gaps = Object.freeze([
      Object.freeze(gap),
      Object.freeze({ ...gap, id: "native-report" })
    ]);
    const html = renderToString(<TranscriptTimeline {...fixture} gaps={gaps} />).replaceAll(
      "<!-- -->",
      ""
    );
    expect(html.match(/0:03 to 0:04 missing/g)).toHaveLength(1);
    expect(gaps).toHaveLength(2);
    expect(gaps.map((entry) => entry.id)).toEqual(["failed-upload-request", "native-report"]);
  });
  it("preserves distinct sources, epochs, precise ranges and failure reasons", () => {
    const gap: MeetingCaptureGap = {
      id: "failed-upload-request",
      sourceId: "mic",
      epoch: 1,
      startMs: 3000,
      endMs: 4000,
      reason: "processing-failed"
    };
    const gaps: MeetingCaptureGap[] = [
      gap,
      { ...gap, id: "output-failure", sourceId: "output" },
      { ...gap, id: "next-epoch", epoch: 2 },
      { ...gap, id: "different-start", startMs: 3001 },
      { ...gap, id: "different-end", endMs: 4001 },
      { ...gap, id: "different-reason", reason: "interrupted" },
      { ...gap, id: "next-clip", startMs: 4000, endMs: 5000 }
    ];
    const html = renderToString(<TranscriptTimeline {...fixture} gaps={gaps} />).replaceAll(
      "<!-- -->",
      ""
    );
    expect(html.match(/meetings-transcript-gap/g)).toHaveLength(gaps.length);
    expect(html).toContain("0:04 to 0:05 missing");
  });
  it("renders source labels, limits, revisions and escaped text without inferred people", () => {
    const html = renderToString(<TranscriptTimeline {...fixture} />).replaceAll("<!-- -->", "");
    expect(html).toContain("You");
    expect(html).toContain("0:01");
    expect(html).not.toContain("Epoch ");
    expect(html).toContain("Still being finalised");
    expect(html).toContain('class="meetings-transcript-turn meetings-transcript-turn--live"');
    expect(html).toContain('class="meetings-transcript-text jds-hint"');
    expect(html).toContain("lines are outside");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("anonymous-1");
    expect(html).not.toContain("<script>");
    expect(transcriptTime(3661000)).toBe("61:01");
  });
  it("hides previously loaded content after an authorization failure", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    });
    client.setQueryData(meetingKeys.transcript("meeting"), fixture);
    client
      .getQueryCache()
      .find({ queryKey: meetingKeys.transcript("meeting") })!
      .setState({ status: "error", error: new ApiError(403, "Forbidden") });
    const html = renderToString(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MeetingTranscript meetingId="meeting" />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(html).toContain("Transcript access is unavailable");
    expect(html).toContain('<section class="meetings-section" aria-label="Transcript">');
    expect(html).not.toContain("A correction");
    client.clear();
  });
  it("never shows cached evidence after denial, and rejects invalid URL ranges", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    });
    const search = "segmentId=s1&segmentRevision=1&startCharacter=0&endCharacter=8";
    const reference = parseTranscriptEvidence("meeting", new URLSearchParams(search));
    const queryKey = ["meetings", "evidence", "meeting", reference];
    client.setQueryData(queryKey, {
      evidence: { segment: fixture.snapshot.segments[0], excerpt: "private old text" }
    });
    client
      .getQueryCache()
      .find({ queryKey })!
      .setState({ status: "error", error: new ApiError(404, "Unavailable") });
    const render = (query: string) =>
      renderToString(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[`/meetings?id=meeting&${query}`]}>
            <MeetingTranscript meetingId="meeting" />
          </MemoryRouter>
        </QueryClientProvider>
      );
    expect(render(search)).toContain("This transcript reference is unavailable");
    expect(render(search)).not.toContain("private old text");
    expect(render("segmentId=s1&segmentRevision=-1")).toContain(
      "This transcript reference is unavailable"
    );
    client.clear();
  });
  it("reads bounded snapshots with credentialed requests and query cancellation", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture)));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await getMeetingTranscript("a/b", 1, controller.signal);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/meetings/records/a%2Fb/transcript?maxSegments=500&maxCharacters=100000&transcriptRevision=1"
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      signal: controller.signal
    });
  });
  it("validates pinned evidence ranges and requests the exact old segment revision", async () => {
    const params = new URLSearchParams(
      "segmentId=s1&segmentRevision=1&startCharacter=0&endCharacter=8"
    );
    const reference = parseTranscriptEvidence("meeting", params)!;
    const fetch = vi.fn().mockResolvedValue(new Response('{"evidence":{}}'));
    vi.stubGlobal("fetch", fetch);
    await getMeetingTranscriptEvidence(reference);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/meetings/records/meeting/transcript/evidence?segmentId=s1&segmentRevision=1&startCharacter=0&endCharacter=8"
    );
    for (const bad of ["-1", "1.5", "Infinity", "9007199254740992", ""]) {
      params.set("segmentRevision", bad);
      expect(parseTranscriptEvidence("meeting", params)).toBeNull();
    }
    expect(
      parseTranscriptEvidence(
        "meeting",
        new URLSearchParams("segmentId=s1&segmentRevision=1&startCharacter=8&endCharacter=8")
      )
    ).toBeNull();
  });
});
