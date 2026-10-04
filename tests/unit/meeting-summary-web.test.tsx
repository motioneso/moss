import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@moss/module-web-sdk";
import type {
  MeetingActionCandidate,
  MeetingExportReceipt,
  MeetingOutputArtifact,
  MeetingRecord
} from "@moss/shared";
import { MeetingSummary } from "../../packages/meetings/src/web/meeting-summary.js";
import { exportStatus } from "../../packages/meetings/src/web/meeting-vault-export.js";
import { invalidateOutputAccess } from "../../packages/meetings/src/web/output-access.js";
import * as api from "../../packages/meetings/src/web/output-client.js";
vi.mock("../../packages/meetings/src/web/output-client.js", async (original) => ({
  ...(await original<typeof api>()),
  getMeetingOutputs: vi.fn(),
  getMeetingOutputArtifact: vi.fn(),
  generateMeetingOutput: vi.fn(),
  editMeetingOutput: vi.fn(),
  reviewMeetingAction: vi.fn(),
  exportMeetingOutput: vi.fn(),
  getMeetingExports: vi.fn()
}));
const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Review",
  personalNotes: "Review readiness next Friday",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
};
const evidence = {
  kind: "personal-note" as const,
  meetingId: meeting.id,
  notesRevision: 1,
  startCharacter: 0,
  endCharacter: 16
};
const proposal = {
  text: "Review readiness",
  ownerPhrase: null,
  duePhrase: "next Friday",
  evidence: [evidence]
};
const artifact: MeetingOutputArtifact = {
  id: "artifact",
  meetingId: meeting.id,
  version: 1,
  inputs: {
    meetingId: meeting.id,
    personalNotes: meeting.personalNotes,
    notesRevision: 1,
    transcript: null
  },
  templateId: "general",
  templateVersion: 1,
  modelRoute: "route",
  content: {
    overview: "<img src='https://example.test/tracker'>",
    decisions: [{ text: "Review readiness", evidence: [evidence] }],
    openQuestions: [],
    actions: [proposal],
    warnings: []
  },
  origin: "generated",
  stale: false,
  createdAt: meeting.createdAt
};
const candidate: MeetingActionCandidate = {
  id: "candidate",
  meetingId: meeting.id,
  artifactVersion: 1,
  proposal,
  reviewState: "pending",
  acceptedTaskId: null,
  possibleMatchIds: ["earlier"]
};
const receipt: MeetingExportReceipt = {
  meetingId: meeting.id,
  artifactVersion: 1,
  destination: "private-vault",
  audience: "owner",
  idempotencyKey: "key",
  contentHash: "hash",
  noteReference: "meetings/private-version.md",
  writeStatus: "saved",
  indexStatus: "queued",
  indexJobId: "job",
  errorCode: null,
  createdAt: meeting.createdAt,
  updatedAt: meeting.updatedAt
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
async function mount() {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MeetingSummary
            meeting={meeting}
            transcriptRevision={0}
            sourceLoading={false}
            unsavedNotes={false}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  await flush();
}
async function toggle(label: string) {
  await act(async () => {
    renderer.root
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === label)!
      .props.onChange({ target: { checked: true } });
  });
  await flush();
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.mocked(api.getMeetingOutputs).mockResolvedValue({
    artifacts: [artifact],
    candidates: [candidate],
    headVersion: 1,
    templates: [{ id: "general", version: 1, name: "General meeting" }]
  });
  vi.mocked(api.getMeetingExports).mockResolvedValue({ receipts: [] });
  vi.mocked(api.getMeetingOutputArtifact).mockResolvedValue({ artifact });
  vi.mocked(api.generateMeetingOutput).mockResolvedValue({
    status: "saved",
    artifact,
    replayed: false
  });
  vi.mocked(api.reviewMeetingAction).mockResolvedValue({
    ...candidate,
    reviewState: "accepted",
    acceptedTaskId: "task-123"
  });
  vi.mocked(api.editMeetingOutput).mockResolvedValue({ ...artifact, version: 2, origin: "manual" });
  vi.mocked(api.exportMeetingOutput).mockResolvedValue({ receipt });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  client.clear();
  vi.unstubAllGlobals();
});
describe("meeting summary owner review", () => {
  it("requires explicit template selection and renders source text without remote markup", async () => {
    await mount();
    expect(button("Generate new version").props.disabled).toBe(true);
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("next Friday");
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-template" })
        .props.onChange({ target: { value: "general" } })
    );
    await flush();
    await click("Generate new version");
    expect(api.generateMeetingOutput).toHaveBeenCalledWith(
      meeting.id,
      expect.objectContaining({
        templateId: "general",
        templateVersion: 1,
        expectedNotesRevision: 1,
        expectedOutputVersion: 1,
        expectedTranscriptRevision: 0
      })
    );
  });
  it("requires owner and possible-match review; never resolves a relative date", async () => {
    await mount();
    expect(button("Accept Task").props.disabled).toBe(true);
    await toggle("Create in my Tasks after owner review");
    expect(button("Accept Task").props.disabled).toBe(true);
    await toggle("Create a separate Task despite possible matches");
    await click("Accept Task");
    expect(api.reviewMeetingAction).toHaveBeenCalledWith(
      meeting.id,
      candidate.id,
      expect.objectContaining({
        decision: "accept",
        dueAt: null,
        title: "Review readiness",
        createDespitePossibleMatches: true
      })
    );
    expect(renderer.root.findAllByType("a").some((node) => node.props.href === "/tasks")).toBe(
      true
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("task-123");
  });
  it("retries an uncertain acceptance using its frozen original request", async () => {
    vi.mocked(api.reviewMeetingAction).mockRejectedValueOnce(new Error("offline"));
    await mount();
    await toggle("Create in my Tasks after owner review");
    await toggle("Create a separate Task despite possible matches");
    await click("Accept Task");
    const first = vi.mocked(api.reviewMeetingAction).mock.calls[0]![2];
    expect(renderer.root.findByProps({ id: "action-candidate" }).props.disabled).toBe(true);
    await click("Retry review");
    expect(vi.mocked(api.reviewMeetingAction).mock.calls[1]![2]).toEqual(first);
  });
  it("manual editing creates a new version with preserved evidence", async () => {
    await mount();
    await click("Edit this version");
    await act(async () =>
      renderer.root
        .findByProps({ id: "output-overview" })
        .props.onChange({ target: { value: "Reviewed overview" } })
    );
    await flush();
    await click("Save edits as new version");
    expect(api.editMeetingOutput).toHaveBeenCalledWith(
      meeting.id,
      expect.objectContaining({
        expectedOutputVersion: 1,
        content: { ...artifact.content, overview: "Reviewed overview" }
      })
    );
  });
  it("requires explicit private save, restores receipt, and never invents an open-note URL", async () => {
    vi.mocked(api.getMeetingExports).mockResolvedValue({ receipts: [receipt] });
    await mount();
    expect(api.exportMeetingOutput).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("Search indexing queued");
    expect(
      renderer.root
        .findAllByType("a")
        .some((node) => String(node.props.href).includes("private-version"))
    ).toBe(false);
    await click("Retry private save");
    expect(api.exportMeetingOutput).toHaveBeenCalledWith(
      meeting.id,
      expect.objectContaining({ artifactVersion: 1 })
    );
  });
  it("hides private content immediately after a mutation access denial", async () => {
    vi.mocked(api.reviewMeetingAction).mockRejectedValue(new ApiError(403, "Denied"));
    await mount();
    await toggle("Create in my Tasks after owner review");
    await toggle("Create a separate Task despite possible matches");
    await click("Accept Task");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Review readiness");
    expect(JSON.stringify(renderer.toJSON())).toContain("access is unavailable");
  });
  it("does not restore a late private save after the signed-in cache is cleared", async () => {
    let finish!: (value: { receipt: MeetingExportReceipt }) => void;
    vi.mocked(api.exportMeetingOutput).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await mount();
    await click("Save new private version");
    await act(async () => {
      renderer.unmount();
      client.clear();
    });
    await act(async () => {
      finish({ receipt });
    });
    await flush();
    expect(client.getQueriesData({ queryKey: api.outputKeys.session(meeting.id) })).toEqual([]);
  });

  it("preserves manual edits while navigating away and back", async () => {
    await mount();
    await click("Edit this version");
    await act(async () =>
      renderer.root
        .findByProps({ id: "output-overview" })
        .props.onChange({ target: { value: "Unsaved review" } })
    );
    await flush();
    await act(async () => renderer.unmount());
    await mount();
    await click("Edit this version");
    expect(renderer.root.findByProps({ id: "output-overview" }).props.value).toBe("Unsaved review");
  });

  it("reuses generation identity for an unknown result, then uses a new identity after terminal failure", async () => {
    vi.mocked(api.generateMeetingOutput)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiError(422, "Failed"));
    await mount();
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-template" })
        .props.onChange({ target: { value: "general" } })
    );
    await flush();
    await click("Generate new version");
    await click("Check or retry generation");
    const calls = vi.mocked(api.generateMeetingOutput).mock.calls;
    expect(calls[1]![1]).toEqual(calls[0]![1]);
    await click("Generate new version");
    expect(calls[2]![1].requestKey).not.toBe(calls[0]![1].requestKey);
  });

  it.each(["pending", "dismissed", "accepted"] as const)(
    "loads an older candidate artifact and preserves its %s state",
    async (reviewState) => {
      let finish!: (value: { artifact: MeetingOutputArtifact }) => void;
      vi.mocked(api.getMeetingOutputArtifact).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      vi.mocked(api.getMeetingOutputs).mockResolvedValue({
        artifacts: [{ ...artifact, id: "latest", version: 102 }],
        candidates: [
          {
            ...candidate,
            reviewState,
            acceptedTaskId: reviewState === "accepted" ? "old-task" : null
          }
        ],
        headVersion: 102,
        templates: [{ id: "general", version: 1, name: "General meeting" }]
      });
      await mount();
      expect(api.getMeetingOutputArtifact).toHaveBeenCalledWith(
        meeting.id,
        1,
        expect.any(AbortSignal)
      );
      const waiting = JSON.stringify(renderer.toJSON());
      expect(waiting).toContain(
        reviewState === "pending"
          ? "Pending review"
          : reviewState === "accepted"
            ? "Accepted"
            : "Dismissed"
      );
      expect(button("Accept Task")).toBeUndefined();
      await act(async () => finish({ artifact }));
      await flush();
      if (reviewState === "pending") expect(button("Accept Task").props.disabled).toBe(true);
      else expect(button("Accept Task")).toBeUndefined();
      if (reviewState === "accepted")
        expect(JSON.stringify(renderer.toJSON())).toContain("old-task");
      if (reviewState === "dismissed")
        expect(JSON.stringify(renderer.toJSON())).toContain("Dismissed");
    }
  );

  it("selects the active head even when one hundred newer stale versions exist", async () => {
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [
        ...Array.from({ length: 100 }, (_, n) => ({
          ...artifact,
          id: `stale-${n}`,
          version: 102 - n,
          stale: true
        })),
        artifact
      ],
      candidates: [candidate],
      headVersion: 1,
      templates: [{ id: "general", version: 1, name: "General meeting" }]
    });
    await mount();
    expect(renderer.root.findByProps({ id: "meeting-output-version" }).props.value).toBe(1);
    expect(button("Edit this version").props.disabled).toBe(false);
    expect(api.getMeetingOutputArtifact).not.toHaveBeenCalled();
  });

  it("recovers on a fresh authorized reopen, never from a GET started before denial", async () => {
    const authorized = {
      artifacts: [artifact],
      candidates: [candidate],
      headVersion: 1,
      templates: [{ id: "general" as const, version: 1, name: "General meeting" }]
    };
    let finish!: (value: typeof authorized) => void;
    vi.mocked(api.getMeetingOutputs).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await mount();
    await act(async () => invalidateOutputAccess(client, meeting.id));
    await act(async () => finish(authorized));
    await flush();
    expect(client.getQueryData(["meetings", "output-denied", meeting.id])).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Review readiness");
    await act(async () => renderer.unmount());
    await mount();
    expect(client.getQueryData(["meetings", "output-denied", meeting.id])).toBe(false);
    expect(button("Accept Task")).toBeDefined();
  });

  it("does not revive an old acceptance after a fresh authorized session replaces it", async () => {
    let finish!: (value: MeetingActionCandidate) => void;
    vi.mocked(api.reviewMeetingAction).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await mount();
    await toggle("Create in my Tasks after owner review");
    await toggle("Create a separate Task despite possible matches");
    await click("Accept Task");
    await act(async () => invalidateOutputAccess(client, meeting.id));
    await act(async () => renderer.unmount());
    await mount();
    await act(async () =>
      finish({ ...candidate, reviewState: "accepted", acceptedTaskId: "late-task" })
    );
    await flush();
    expect(button("Accept Task")).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("late-task");
  });

  it("keeps an absent exact evidence version separate from meeting access loss", async () => {
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [{ ...artifact, version: 102 }],
      candidates: [candidate],
      headVersion: 102,
      templates: []
    });
    vi.mocked(api.getMeetingOutputArtifact).mockRejectedValue(
      new ApiError(404, "Missing version", "meeting_output_unavailable")
    );
    await mount();
    expect(button("Retry loading action evidence")).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("Pending review");
    expect(client.getQueryData(["meetings", "output-denied", meeting.id])).toBe(false);
  });

  it("distinguishes saved, pending, delayed and conflicting writes from indexing", () => {
    expect(exportStatus(receipt)).toContain("queued");
    expect(exportStatus({ ...receipt, indexStatus: "delayed" })).toContain("Saved");
    expect(exportStatus({ ...receipt, writeStatus: "pending" })).toContain("write is pending");
    expect(exportStatus({ ...receipt, errorCode: "meeting_vault_conflict" })).toContain(
      "not been overwritten"
    );
    expect(exportStatus(receipt)).not.toMatch(/indexed/i);
  });
});
