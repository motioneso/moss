import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, hasSessionUnsavedChanges } from "@moss/module-web-sdk";
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
async function chooseTemplate() {
  await act(async () =>
    renderer.root
      .findByProps({ id: "meeting-template" })
      .props.onChange({ target: { value: "general" } })
  );
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
    generationAvailability: "available" as const,
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
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});
describe("meeting summary owner review", () => {
  it.each([
    [
      "subscription-unsupported",
      "Summaries on this subscription aren’t supported yet. No other model was used."
    ],
    [
      "subscription-isolation-unavailable",
      "Claude summaries aren’t available on this server setup. No other model was used."
    ]
  ] as const)(
    "disables Generate with the specific subscription reason: %s",
    async (generationAvailability, message) => {
      vi.mocked(api.getMeetingOutputs).mockResolvedValue({
        artifacts: [artifact],
        candidates: [],
        headVersion: 1,
        generationAvailability,
        templates: [{ id: "general", version: 1, name: "General meeting" }]
      });
      await mount();
      await chooseTemplate();
      expect(JSON.stringify(renderer.toJSON())).toContain(message);
      expect(
        renderer.root
          .findAllByType("button")
          .find((node) => node.children.includes("Generate new version"))?.props.disabled
      ).toBe(true);
      expect(api.generateMeetingOutput).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    "blocks generation with no supported model and offers role-aware recovery: admin=%s",
    async (admin) => {
      vi.mocked(api.getMeetingOutputs).mockResolvedValue({
        artifacts: [],
        candidates: [],
        headVersion: 0,
        templates: [{ id: "general", version: 1, name: "General meeting" }],
        generationAvailability: "model-unavailable"
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ user: { isInstanceAdmin: admin } })))
      );
      await mount();
      await chooseTemplate();
      expect(button("Generate summary").props.disabled).toBe(true);
      // Also guard stale/programmatic handlers instead of relying only on the HTML attribute.
      await click("Generate summary");
      expect(api.generateMeetingOutput).not.toHaveBeenCalled();
      const rendered = JSON.stringify(renderer.toJSON());
      expect(rendered).toContain(
        "Your default model is unavailable or cannot produce structured summaries."
      );
      expect(rendered).toContain("No other model will be used.");
      expect(rendered).toContain(admin ? "Settings → AI providers" : "Contact an instance admin");
    }
  );

  it("enables notes-only generation after refreshing repaired model configuration", async () => {
    const response = {
      artifacts: [],
      candidates: [],
      headVersion: 0,
      templates: [{ id: "general" as const, version: 1, name: "General meeting" }]
    };
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      ...response,
      generationAvailability: "model-unavailable"
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"user":{"isInstanceAdmin":false}}'))
    );
    await mount();
    await chooseTemplate();
    expect(button("Generate summary").props.disabled).toBe(true);
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      ...response,
      generationAvailability: "available"
    });
    await click("Refresh summaries");
    expect(button("Generate summary").props.disabled).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      "Your default model is unavailable or cannot produce structured summaries."
    );
    await click("Generate summary");
    expect(api.generateMeetingOutput).toHaveBeenCalledWith(
      meeting.id,
      expect.objectContaining({ expectedTranscriptRevision: 0, expectedNotesRevision: 1 })
    );
  });

  it.each(["pending", "offline", "error", "check-failed"] as const)(
    "fails closed on %s availability refresh without hiding saved summaries",
    async (refresh) => {
      await mount();
      await chooseTemplate();
      expect(button("Generate new version").props.disabled).toBe(false);
      if (refresh === "offline") onlineManager.setOnline(false);
      else if (refresh === "pending")
        vi.mocked(api.getMeetingOutputs).mockImplementationOnce(() => new Promise(() => {}));
      else if (refresh === "error")
        vi.mocked(api.getMeetingOutputs).mockRejectedValueOnce(new Error("offline"));
      else
        vi.mocked(api.getMeetingOutputs).mockResolvedValueOnce({
          artifacts: [artifact],
          candidates: [candidate],
          headVersion: 1,
          templates: [],
          generationAvailability: "check-failed"
        });
      await click("Refresh summaries");
      expect(button("Generate new version").props.disabled).toBe(true);
      await click("Generate new version");
      expect(api.generateMeetingOutput).not.toHaveBeenCalled();
      expect(button("Edit this version")).toBeDefined();
      expect(JSON.stringify(renderer.toJSON())).toContain(
        refresh === "pending" || refresh === "offline"
          ? "Checking summary model availability"
          : "Couldn’t check summary model availability"
      );
    }
  );

  it("keeps an existing request check available when model configuration becomes unavailable", async () => {
    vi.mocked(api.generateMeetingOutput).mockResolvedValueOnce({
      status: "pending",
      requestKey: "pending-request"
    });
    await mount();
    await chooseTemplate();
    await click("Generate new version");
    const first = vi.mocked(api.generateMeetingOutput).mock.calls[0]![1];
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [artifact],
      candidates: [candidate],
      headVersion: 1,
      templates: [],
      generationAvailability: "model-unavailable"
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"user":{"isInstanceAdmin":false}}'))
    );
    await click("Refresh summaries");
    expect(button("Check or retry generation").props.disabled).toBe(false);
    await click("Check or retry generation");
    expect(vi.mocked(api.generateMeetingOutput).mock.calls[1]![1]).toEqual(first);
  });

  it.each(["response", "http-error"] as const)(
    "explains an unsupported summary model from a %s without offering blind retries",
    async (transport) => {
      const code = "meeting_output_route_unavailable";
      if (transport === "response")
        vi.mocked(api.generateMeetingOutput).mockResolvedValueOnce({
          status: "failed",
          requestKey: "failed-request",
          code
        });
      else
        vi.mocked(api.generateMeetingOutput).mockRejectedValueOnce(
          new ApiError(422, "Private provider credential error", code)
        );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response('{"user":{"isInstanceAdmin":false}}'))
      );
      await mount();
      await chooseTemplate();
      await click("Generate new version");
      await flush();
      const rendered = JSON.stringify(renderer.toJSON());
      expect(rendered).toContain("No other model will be used.");
      expect(rendered).toContain("Check its connection and try again.");
      expect(rendered).toContain("Contact an instance admin");
      expect(rendered).not.toContain("Private provider credential error");
      expect(rendered).not.toContain("Choose Generate to start a new request");
      expect(
        renderer.root
          .findAllByType(Link)
          .filter((node) => node.props.to === "/settings?section=aiproviders")
      ).toHaveLength(0);
      expect(button("Check or retry generation")).toBeUndefined();
      await act(async () => renderer.unmount());
      await mount();
      expect(JSON.stringify(renderer.toJSON())).toContain("Contact an instance admin");
      expect(api.generateMeetingOutput).toHaveBeenCalledOnce();
    }
  );

  it.each([true, false, "unavailable"] as const)(
    "offers AI provider settings only with confirmed admin access: %s",
    async (admin) => {
      vi.mocked(api.generateMeetingOutput).mockRejectedValueOnce(
        new ApiError(422, "Private provider error", "meeting_output_route_unavailable")
      );
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            admin === "unavailable"
              ? new Response("Unavailable", { status: 503 })
              : new Response(JSON.stringify({ user: { isInstanceAdmin: admin } }))
          )
      );
      await mount();
      await chooseTemplate();
      await click("Generate new version");
      await flush();
      const links = renderer.root
        .findAllByType(Link)
        .filter((node) => node.props.to === "/settings?section=aiproviders");
      expect(links).toHaveLength(admin === true ? 1 : 0);
      const rendered = JSON.stringify(renderer.toJSON());
      expect(rendered).toContain(
        admin === true ? "Settings → AI providers" : "Contact an instance admin"
      );
      expect(rendered).not.toContain("Private provider error");
      expect(rendered).not.toContain("Meeting profiles");
    }
  );

  it.each(["response", "http-error"] as const)(
    "does not display unknown failure codes or provider text from a %s",
    async (transport) => {
      const code = "Private provider credential error";
      if (transport === "response")
        vi.mocked(api.generateMeetingOutput).mockResolvedValueOnce({
          status: "failed",
          requestKey: "failed-request",
          code
        });
      else
        vi.mocked(api.generateMeetingOutput).mockRejectedValueOnce(new ApiError(422, code, code));
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await mount();
      await chooseTemplate();
      await click("Generate new version");
      const rendered = JSON.stringify(renderer.toJSON());
      expect(rendered).not.toContain(code);
      expect(rendered).toContain("Generation failed. Review the saved inputs");
      expect(fetch).not.toHaveBeenCalled();
      expect(button("Check or retry generation")).toBeUndefined();
    }
  );

  it("explains a changed model configuration before starting a new request", async () => {
    vi.mocked(api.generateMeetingOutput).mockRejectedValueOnce(
      new ApiError(422, "Private credentials rotated", "meeting_output_route_changed")
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"user":{"isInstanceAdmin":false}}'))
    );
    await mount();
    await chooseTemplate();
    await click("Generate new version");
    await flush();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "The summary model configuration changed during generation"
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Private credentials rotated");
    expect(button("Check or retry generation")).toBeUndefined();
    await click("Generate new version");
    const calls = vi.mocked(api.generateMeetingOutput).mock.calls;
    expect(calls[1]![1].requestKey).not.toBe(calls[0]![1].requestKey);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Contact an instance admin");
  });

  it("requires explicit template selection and renders source text without remote markup", async () => {
    await mount();
    expect(button("Generate new version").props.disabled).toBe(true);
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("next Friday");
    await chooseTemplate();
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
    expect(JSON.stringify(renderer.toJSON())).toContain("Accepted");
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
  it("explains unavailable private export without claiming the saved note was changed", async () => {
    vi.mocked(api.exportMeetingOutput).mockRejectedValueOnce(
      new ApiError(409, "Private module configuration", "meeting_export_unavailable")
    );
    await mount();
    await click("Save new private version");
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("Notes is a required built-in module");
    expect(rendered).toContain("Settings → Modules");
    expect(rendered).not.toContain("saved note was changed");
    expect(rendered).not.toContain("Private module configuration");
    await click("Save new private version");
    expect(JSON.stringify(renderer.toJSON())).toContain("Search indexing queued");
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
    await chooseTemplate();
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
        generationAvailability: "available" as const,
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
        expect(JSON.stringify(renderer.toJSON())).toContain("Accepted");
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
      generationAvailability: "available" as const,
      templates: [{ id: "general", version: 1, name: "General meeting" }]
    });
    await mount();
    expect(renderer.root.findByProps({ id: "meeting-output-version" }).props.value).toBe(1);
    expect(button("Edit this version").props.disabled).not.toBe(true);
    expect(api.getMeetingOutputArtifact).not.toHaveBeenCalled();
  });

  it("recovers on a fresh authorized reopen, never from a GET started before denial", async () => {
    const authorized = {
      artifacts: [artifact],
      candidates: [candidate],
      headVersion: 1,
      generationAvailability: "available" as const,
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
      generationAvailability: "available" as const,
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

  it("keeps manual editor state mounted through summary refetch and registers unsaved edits", async () => {
    await mount();
    await click("Edit this version");
    await act(async () =>
      renderer.root
        .findByProps({ id: "output-overview" })
        .props.onChange({ target: { value: "Keep this edit" } })
    );
    await flush();
    const editor = renderer.root.findByProps({ id: "output-overview" });
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    let finish!: (value: api.MeetingOutputsResponse) => void;
    vi.mocked(api.getMeetingOutputs).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => {
      void client.refetchQueries({ queryKey: api.outputKeys.list(meeting.id) });
    });
    expect(renderer.root.findByProps({ id: "output-overview" })).toBe(editor);
    await act(async () =>
      finish({
        artifacts: [artifact],
        candidates: [candidate],
        headVersion: 1,
        generationAvailability: "available" as const,
        templates: [{ id: "general", version: 1, name: "General meeting" }]
      })
    );
    await flush();
    expect(renderer.root.findByProps({ id: "output-overview" }).props.value).toBe("Keep this edit");
    await click("Discard edits");
    expect(hasSessionUnsavedChanges(client)).toBe(false);
  });
  it("pins visible unsaved edits when a newer head arrives and lets the owner reopen kept edits", async () => {
    await mount();
    await click("Edit this version");
    await act(async () =>
      renderer.root
        .findByProps({ id: "output-overview" })
        .props.onChange({ target: { value: "Keep version one edits" } })
    );
    await flush();
    const editor = renderer.root.findByProps({ id: "output-overview" });
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [
        { ...artifact, version: 2, content: { ...artifact.content, overview: "Newer head" } },
        artifact
      ],
      candidates: [candidate],
      headVersion: 2,
      generationAvailability: "available" as const,
      templates: []
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: api.outputKeys.list(meeting.id) });
    });
    await flush();
    expect(renderer.root.findByProps({ id: "output-overview" })).toBe(editor);
    expect(editor.props.value).toBe("Keep version one edits");
    expect(button("Save edits as new version").props.disabled).toBe(true);
    expect(renderer.root.findByProps({ id: "kept-summary-edits" }).props.value).toContain(
      "Keep version one edits"
    );
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [{ ...artifact, version: 102 }],
      candidates: [candidate],
      headVersion: 102,
      generationAvailability: "available" as const,
      templates: [],
      omittedArtifactCount: 101
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: api.outputKeys.list(meeting.id) });
    });
    await flush();
    expect(renderer.root.findByProps({ id: "output-overview" })).toBe(editor);
    expect(renderer.root.findByProps({ id: "meeting-output-version" }).props.value).toBe(1);
    await click("Close editor");
    await click("Review kept edits");
    expect(renderer.root.findByProps({ id: "output-overview" }).props.value).toBe(
      "Keep version one edits"
    );
  });

  it("retains an old candidate review node while its exact source refreshes", async () => {
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [{ ...artifact, version: 102 }],
      candidates: [candidate],
      headVersion: 102,
      generationAvailability: "available" as const,
      templates: []
    });
    await mount();
    const input = renderer.root.findByProps({ id: "action-candidate" });
    let finish!: (value: { artifact: MeetingOutputArtifact }) => void;
    vi.mocked(api.getMeetingOutputArtifact).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => {
      void client.refetchQueries({ queryKey: ["meetings", "output-artifact", meeting.id, 1] });
    });
    expect(renderer.root.findByProps({ id: "action-candidate" })).toBe(input);
    await act(async () => finish({ artifact }));
    await flush();
    expect(renderer.root.findByProps({ id: "action-candidate" })).toBe(input);
  });

  it("shows the confirmed owner-edited title after accepting a suggestion", async () => {
    await mount();
    await act(async () =>
      renderer.root
        .findByProps({ id: "action-candidate" })
        .props.onChange({ target: { value: "My reviewed Task title" } })
    );
    await flush();
    await toggle("Create in my Tasks after owner review");
    await toggle("Create a separate Task despite possible matches");
    await click("Accept Task");
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Created as: My reviewed Task title · Accepted"
    );
  });

  it("selects its own generated result after closing a clean editor, then selects its own saved edit", async () => {
    await mount();
    await click("Edit this version");
    await click("Close editor");
    await chooseTemplate();
    const generated = { ...artifact, id: "generated-2", version: 2 };
    vi.mocked(api.generateMeetingOutput).mockResolvedValueOnce({
      status: "saved",
      artifact: generated,
      replayed: false
    });
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [generated, artifact],
      candidates: [candidate],
      headVersion: 2,
      generationAvailability: "available" as const,
      templates: [{ id: "general", version: 1, name: "General meeting" }]
    });
    await click("Generate new version");
    expect(renderer.root.findByProps({ id: "meeting-output-version" }).props.value).toBe(2);
    expect(renderer.root.findAllByProps({ id: "output-overview" })).toHaveLength(0);
    await click("Edit this version");
    await act(async () =>
      renderer.root
        .findByProps({ id: "output-overview" })
        .props.onChange({ target: { value: "Owner saved version three" } })
    );
    await flush();
    const manual = {
      ...generated,
      id: "manual-3",
      version: 3,
      origin: "manual" as const,
      content: { ...artifact.content, overview: "Owner saved version three" }
    };
    vi.mocked(api.editMeetingOutput).mockResolvedValueOnce(manual);
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [manual, generated, artifact],
      candidates: [candidate],
      headVersion: 3,
      generationAvailability: "available" as const,
      templates: [{ id: "general", version: 1, name: "General meeting" }]
    });
    await click("Save edits as new version");
    expect(renderer.root.findByProps({ id: "meeting-output-version" }).props.value).toBe(3);
    expect(renderer.root.findAllByProps({ id: "output-overview" })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("Owner saved version three");
    expect(hasSessionUnsavedChanges(client)).toBe(false);
  });

  it("preserves edits made during generation and offers the completed version without rebasing", async () => {
    await mount();
    await chooseTemplate();
    let finish!: (result: Awaited<ReturnType<typeof api.generateMeetingOutput>>) => void;
    vi.mocked(api.generateMeetingOutput).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await click("Generate new version");
    await click("Edit this version");
    await act(async () =>
      renderer.root
        .findByProps({ id: "output-overview" })
        .props.onChange({ target: { value: "Keep my in-flight edits" } })
    );
    await flush();
    const editor = renderer.root.findByProps({ id: "output-overview" });
    const generated = { ...artifact, id: "generated-2", version: 2 };
    vi.mocked(api.getMeetingOutputs).mockResolvedValue({
      artifacts: [generated, artifact],
      candidates: [candidate],
      headVersion: 2,
      generationAvailability: "available" as const,
      templates: [{ id: "general", version: 1, name: "General meeting" }]
    });
    await act(async () => finish({ status: "saved", artifact: generated, replayed: false }));
    await flush();
    expect(renderer.root.findByProps({ id: "meeting-output-version" }).props.value).toBe(1);
    expect(renderer.root.findByProps({ id: "output-overview" })).toBe(editor);
    expect(editor.props.value).toBe("Keep my in-flight edits");
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    await click("View generated version");
    expect(renderer.root.findByProps({ id: "meeting-output-version" }).props.value).toBe(2);
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-output-version" })
        .props.onChange({ target: { value: "1" } })
    );
    await flush();
    await click("Review kept edits");
    expect(renderer.root.findByProps({ id: "output-overview" }).props.value).toBe(
      "Keep my in-flight edits"
    );
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
