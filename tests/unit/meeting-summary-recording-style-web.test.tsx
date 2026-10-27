import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecord } from "@moss/shared";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";
import { MeetingSummary } from "../../packages/meetings/src/web/meeting-summary.js";
import { recordingKeys } from "../../packages/meetings/src/web/recording-client.js";
import * as api from "../../packages/meetings/src/web/output-client.js";

vi.mock("../../packages/meetings/src/web/output-client.js", async (original) => ({
  ...(await original<typeof api>()),
  getMeetingOutputs: vi.fn(),
  generateMeetingOutput: vi.fn()
}));
const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Conversation",
  personalNotes: "Ideas for next week",
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
async function mount(typeId: string | null) {
  client.setQueryData(recordingKeys.record(meeting.id), {
    metadata: { typeId },
    configuration: {
      revision: 1,
      types: [{ id: "conversation", name: "Conversation", templateId: "interview", retired: false }]
    }
  });
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
function writeButton() {
  return renderer.root
    .findAllByType("button")
    .find((node) => node.children.join("") === "Write summary")!;
}
async function generate() {
  expect(writeButton().props.disabled).toBe(false);
  await act(async () => writeButton().props.onClick());
  await flush();
  expect(api.generateMeetingOutput).toHaveBeenCalledWith(
    meeting.id,
    expect.objectContaining({ templateId: "interview", templateVersion: 2 })
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // Exercise generation without waiting for the unrelated preferences query.
  client.setQueryDefaults(meetingKeys.preferences, { enabled: false });
  vi.mocked(api.getMeetingOutputs).mockResolvedValue({
    artifacts: [],
    candidates: [],
    headVersion: 0,
    generationAvailability: "available",
    templates: [
      { id: "general", version: 1, name: "General meeting" },
      { id: "interview", version: 2, name: "Interview" }
    ]
  });
  vi.mocked(api.generateMeetingOutput).mockResolvedValue({
    status: "pending",
    requestKey: "pending"
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  client.clear();
  vi.unstubAllGlobals();
});
describe("recording summary style", () => {
  it("uses the configured type style before summary preferences load", async () => {
    await mount("conversation");
    expect(renderer.root.findAllByProps({ id: "meeting-template" })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("Summary style follows the recording type");
    await generate();
  });

  it("keeps the style selector effective for an untyped recording", async () => {
    await mount(null);
    await act(async () =>
      renderer.root
        .findByProps({ id: "meeting-template" })
        .props.onChange({ target: { value: "interview" } })
    );
    await flush();
    await generate();
  });
});
