import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MeetingActionCandidate,
  MeetingExportReceipt,
  MeetingOutputArtifact,
  MeetingRecord
} from "@moss/shared";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";
import { MeetingSummary } from "../../packages/meetings/src/web/meeting-summary.js";
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
            tool="rewrite"
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
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryDefaults(meetingKeys.preferences, { staleTime: Infinity });
  client.setQueryData(meetingKeys.preferences, {
    defaultCaptureMode: null,
    rememberedSource: null,
    summarizeOnStop: true,
    summaryTemplateId: "general"
  });
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
  vi.unstubAllGlobals();
});
describe("meeting summary subscription availability", () => {
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
          .find((node) => node.children.includes("Rewrite summary"))?.props.disabled
      ).toBe(true);
      expect(api.generateMeetingOutput).not.toHaveBeenCalled();
    }
  );
});
