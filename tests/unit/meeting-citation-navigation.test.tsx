import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecord, MeetingTranscriptSnapshotResponse } from "@moss/shared";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import { isMeetingAccessDenied, meetingKeys } from "../../packages/meetings/src/web/client.js";

const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Citation review",
  personalNotes: "",
  notesRevision: 0,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
};
function snapshot(revision: number): MeetingTranscriptSnapshotResponse {
  return {
    sources: [
      {
        sourceId: "mic",
        epoch: 1,
        kind: "microphone",
        label: "Test microphone",
        startMs: 0,
        endMs: 10000
      }
    ],
    snapshot: {
      meetingId: meeting.id,
      ownerUserId: "owner",
      transcriptRevision: revision,
      cursor: revision,
      cutoffMs: 10000,
      maxSegments: 500,
      maxCharacters: 100000,
      throughMs: 2000,
      omittedSegments: 0,
      containsProvisional: false,
      segments: [
        {
          meetingId: meeting.id,
          segmentId: "segment",
          sourceId: "mic",
          epoch: 1,
          startMs: 1000,
          endMs: 2000,
          revision,
          text: revision === 1 ? "ORCHID" : revision === 2 ? "MAPLE" : "CEDAR",
          finality: "final",
          provenance: "transcription",
          speakerId: null
        }
      ]
    }
  };
}
let navigate: NavigateFunction;
function NavigationProbe() {
  navigate = useNavigate();
  return null;
}
let renderer: ReactTestRenderer;
let client: QueryClient;
let latest: number;
let latestReads: number;
let denied: boolean;
async function flush() {
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(client.isFetching()).toBe(0);
      if (
        denied ||
        isMeetingAccessDenied(client.getQueryState(meetingKeys.record(meeting.id))?.error)
      ) {
        expect(renderer.root.findAllByProps({ id: "meeting-personal-notes" })).toHaveLength(0);
        expect(JSON.stringify(renderer.toJSON())).not.toContain(meeting.title);
      }
      if (!denied)
        expect(renderer.root.findAllByProps({ id: "meeting-personal-notes" })).toHaveLength(1);
      expect(JSON.stringify(renderer.toJSON())).not.toMatch(
        /Loading (?:your draft|transcript|summaries|referenced text)|Refreshing meeting/
      );
    },
    { timeout: 5000 }
  );
}

async function mount() {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/meetings?id=${meeting.id}`]}>
          <NavigationProbe />
          <MeetingsPage />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  await flush();
}
function transcriptText() {
  return JSON.stringify(renderer.toJSON());
}
async function openCitation(end = 6) {
  await act(async () => {
    await navigate(
      `/meetings?id=${meeting.id}&segmentId=segment&segmentRevision=1&startCharacter=0&endCharacter=${end}`
    );
  });
  await flush();
}
beforeEach(() => {
  denied = false;
  latest = 1;
  latestReads = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: false } }
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const url = new URL(path, "https://example.test");
      if (denied && url.pathname.startsWith("/api/meetings/records/"))
        return new Response("{}", { status: 404 });
      if (url.pathname === "/api/me/locale")
        return new Response(
          JSON.stringify({ locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" } })
        );
      if (url.pathname === "/api/meetings/preferences")
        return new Response(
          JSON.stringify({
            defaultCaptureMode: null,
            rememberedSource: null,
            summarizeOnStop: true,
            summaryTemplateId: "general",
            setupCompletedAt: meeting.createdAt
          })
        );
      if (url.pathname === "/api/meetings/recording-notice")
        return new Response(
          JSON.stringify({
            currentNotice: { policyVersion: "v1", text: "Notice" },
            acknowledgement: null
          })
        );
      if (url.pathname.endsWith("/capture"))
        return new Response(
          JSON.stringify({ capture: null, pendingLinks: [], processingReady: false })
        );
      if (url.pathname.endsWith("/outputs"))
        return new Response(
          JSON.stringify({ artifacts: [], candidates: [], headVersion: 0, templates: [] })
        );
      if (url.pathname.endsWith("/transcript/evidence"))
        return new Response(
          JSON.stringify({
            evidence: {
              segment: snapshot(1).snapshot.segments[0],
              excerpt: "ORCHID".slice(0, Number(url.searchParams.get("endCharacter")))
            }
          })
        );
      if (url.pathname.endsWith("/transcript")) {
        if (!url.searchParams.has("transcriptRevision")) latestReads += 1;
        return new Response(
          JSON.stringify(snapshot(Number(url.searchParams.get("transcriptRevision") ?? latest)))
        );
      }
      if (url.pathname === `/api/meetings/records/${meeting.id}`)
        return new Response(JSON.stringify({ meeting }));
      throw new Error(`Unexpected request ${path}`);
    })
  );
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  client.clear();
  vi.unstubAllGlobals();
});

describe("same-meeting citation navigation (real query lifecycle, unit HTTP fixtures)", () => {
  it("fetches current text beside immutable old evidence and preserves unsaved notes", async () => {
    await mount();
    expect(transcriptText()).toContain("ORCHID");
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-personal-notes" })
        .props.onChange({ target: { value: "Keep my unsaved notes" } })
    );
    const before = latestReads;
    latest = 2;
    await openCitation();
    expect(latestReads).toBeGreaterThan(before);
    expect(transcriptText()).toContain("MAPLE");
    expect(renderer.root.findByProps({ id: `meeting-reference-${meeting.id}` })).toBeDefined();
    expect(transcriptText()).toContain("ORCHID");
    expect(renderer.root.findByProps({ id: "meeting-personal-notes" }).props.value).toBe(
      "Keep my unsaved notes"
    );
    latest = 3;
    await openCitation(5);
    expect(transcriptText()).toContain("CEDAR");
  });
  it("reauthorizes cached title and notes when citation navigation discovers deletion", async () => {
    await mount();
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-personal-notes" })
        .props.onChange({ target: { value: "Private unsaved note" } })
    );
    denied = true;
    await openCitation();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Citation review");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Private unsaved note");
    expect(renderer.root.findAllByProps({ id: "meeting-personal-notes" })).toHaveLength(0);
    expect(client.getQueryData(meetingKeys.editor(meeting.id))).toBeUndefined();
  });
  it("keeps cited old text beside later current revisions", async () => {
    latest = 2;
    await mount();
    await openCitation();
    expect(transcriptText()).toContain("ORCHID");
    expect(transcriptText()).toContain("MAPLE");
    latest = 3;
    await openCitation(5);
    expect(
      client.getQueryData<MeetingTranscriptSnapshotResponse>(meetingKeys.transcript(meeting.id))
        ?.snapshot.transcriptRevision
    ).toBe(3);
    expect(transcriptText()).toContain("ORCHI");
    expect(transcriptText()).toContain("CEDAR");
  });
});
