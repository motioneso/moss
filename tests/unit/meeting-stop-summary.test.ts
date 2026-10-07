import { describe, expect, it, vi } from "vitest";
import type { MeetingOutputInputs } from "@moss/shared";
import {
  MeetingStopSummaryRepository,
  type MeetingStopSummaryRow
} from "../../packages/meetings/src/stop-summary-repository.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import { MeetingOutputsRepository } from "../../packages/meetings/src/output-repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
const meetingId = "11111111-1111-4111-8111-111111111111",
  grantId = "22222222-2222-4222-8222-222222222222",
  requestKey = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const capture = {
    status: "complete",
    state_json: JSON.stringify({
      desired: "stopped",
      stopCutoffMs: 1000,
      finalized: true,
      finalizationDeadline: new Date(Date.now() + 60000).toISOString()
    })
  };
  const db = makeRecordingDb({ rows: [capture] });
  const row: MeetingStopSummaryRow = {
    meeting_id: meetingId,
    owner_user_id: meetingId,
    grant_id: grantId,
    request_key: requestKey,
    template_id: "general",
    status: "waiting",
    code: null,
    due_at: new Date(Date.now() + 60000),
    created_at: new Date(),
    early_enqueued: false,
    input_json: null
  };
  const preferences = new MeetingPreferencesRepository();
  const prefs = vi.spyOn(preferences, "get").mockResolvedValue({
    defaultCaptureMode: null,
    rememberedSource: null,
    summarizeOnStop: true,
    summaryTemplateId: "general"
  });
  const outputs = new MeetingOutputsRepository();
  vi.spyOn(outputs, "head").mockResolvedValue(null);
  vi.spyOn(outputs, "pendingGeneration").mockResolvedValue(null);
  const inputs: MeetingOutputInputs = {
    meetingId,
    personalNotes: "Private notes alone are not enough",
    notesRevision: 3,
    transcript: {
      meetingId,
      ownerUserId: meetingId,
      transcriptRevision: 7,
      cursor: 7,
      cutoffMs: 1000,
      maxSegments: 500,
      maxCharacters: 100000,
      throughMs: 1000,
      omittedSegments: 0,
      containsProvisional: false,
      segments: [
        {
          meetingId,
          segmentId: "segment",
          sourceId: "mic",
          epoch: 1,
          startMs: 0,
          endMs: 1000,
          revision: 1,
          text: "Discuss the project plan",
          finality: "final",
          provenance: "transcription",
          speakerId: null
        }
      ]
    }
  };
  vi.spyOn(outputs, "inputs").mockResolvedValue(inputs);
  const repo = new MeetingStopSummaryRepository(preferences, outputs);
  vi.spyOn(repo, "row").mockImplementation(async () => row);
  return { ...db, row, capture, prefs, outputs, inputs, repo };
}
describe("automatic summary finalization admission", () => {
  it("captures exact evidence revisions and one stable request key after meaningful finalized Stop", async () => {
    const f = fixture();
    expect(await f.repo.admit(f.scoped, meetingId, requestKey)).toEqual({
      requestKey,
      expectedOutputVersion: 0,
      expectedTranscriptRevision: 7,
      expectedNotesRevision: 3,
      templateId: "general",
      templateVersion: 1
    });
    expect(f.queries.at(-1)?.sql).toContain("status='submitted'");
    expect(f.queries.at(-1)?.parameters[0]).not.toContain("Private notes");
  });
  it("does not submit while native finalization is pending before the fixed deadline", async () => {
    const f = fixture();
    f.capture.status = "finalizing";
    f.capture.state_json = JSON.stringify({
      desired: "stopped",
      stopCutoffMs: 1000,
      finalized: false,
      finalizationDeadline: new Date(Date.now() + 60000).toISOString()
    });
    await expect(f.repo.admit(f.scoped, meetingId, requestKey)).rejects.toThrow(
      "finalization is still pending"
    );
    expect(f.outputs.inputs).not.toHaveBeenCalled();
  });
  it.each([
    "recording",
    "revoked",
    "no-cutoff",
    "setting-off",
    "notes-only",
    "provisional",
    "silence",
    "too-late"
  ])("does not dispatch for %s", async (condition) => {
    const f = fixture();
    if (condition === "recording")
      f.capture.state_json = JSON.stringify({ desired: "recording", stopCutoffMs: null });
    if (condition === "revoked") f.capture.status = "revoked";
    if (condition === "no-cutoff")
      f.capture.state_json = JSON.stringify({ desired: "stopped", finalized: true });
    if (condition === "setting-off")
      f.prefs.mockResolvedValue({
        defaultCaptureMode: null,
        rememberedSource: null,
        summarizeOnStop: false,
        summaryTemplateId: "general"
      });
    if (condition === "notes-only")
      vi.mocked(f.outputs.inputs).mockResolvedValue({ ...f.inputs, transcript: null });
    if (condition === "provisional")
      vi.mocked(f.outputs.inputs).mockResolvedValue({
        ...f.inputs,
        transcript: { ...f.inputs.transcript!, containsProvisional: true }
      });
    if (condition === "silence")
      vi.mocked(f.outputs.inputs).mockResolvedValue({
        ...f.inputs,
        transcript: {
          ...f.inputs.transcript!,
          segments: [{ ...f.inputs.transcript!.segments[0]!, text: " ... " }]
        }
      });
    if (condition === "too-late") f.row.due_at = new Date(Date.now() - 300001);
    expect(await f.repo.admit(f.scoped, meetingId, requestKey)).toBeNull();
    expect(f.queries.at(-1)?.sql).toContain("status='skipped'");
  });
  it("replays the reserved metadata input without reselecting evidence", async () => {
    const f = fixture();
    const input = {
      requestKey,
      expectedOutputVersion: 0,
      expectedTranscriptRevision: 1,
      expectedNotesRevision: 0,
      templateId: "general",
      templateVersion: 1
    };
    f.row.input_json = JSON.stringify(input);
    f.row.status = "submitted";
    expect(await f.repo.admit(f.scoped, meetingId, requestKey)).toEqual(input);
    expect(f.outputs.inputs).not.toHaveBeenCalled();
  });
  it("only queues the first early-finalized observation in the same transaction", async () => {
    const f = fixture();
    const enqueue = vi.fn();
    await f.repo.schedule(
      f.scoped,
      { actorUserId: meetingId },
      {
        meetingId,
        grantId,
        deadline: f.row.due_at.toISOString(),
        finalized: true,
        stoppedNow: false
      },
      enqueue
    );
    expect(enqueue).toHaveBeenCalledWith(
      f.scoped,
      { actorUserId: meetingId, resourceId: meetingId, idempotencyKey: requestKey },
      expect.any(Date),
      true
    );
    f.row.early_enqueued = true;
    await f.repo.schedule(
      f.scoped,
      { actorUserId: meetingId },
      {
        meetingId,
        grantId,
        deadline: f.row.due_at.toISOString(),
        finalized: true,
        stoppedNow: false
      },
      enqueue
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });
  it("preserves the admitted delayed summary when optional early enqueue fails", async () => {
    const f = fixture();
    const initialDb = makeRecordingDb({ rows: [{ ...f.row }] });
    vi.mocked(f.repo.row).mockResolvedValueOnce(null);
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Queue outage"));
    const input = {
      meetingId,
      grantId,
      deadline: f.row.due_at.toISOString(),
      finalized: false,
      stoppedNow: true
    };
    await f.repo.schedule(initialDb.scoped, { actorUserId: meetingId }, input, enqueue);
    await f.repo.schedule(
      f.scoped,
      { actorUserId: meetingId },
      { ...input, finalized: true, stoppedNow: false },
      enqueue
    );
    expect(enqueue.mock.calls.map((call) => call[3])).toEqual([false, true]);
    expect(f.queries.map((query) => query.sql)).toEqual([
      "SAVEPOINT meeting_summary_enqueue",
      "ROLLBACK TO SAVEPOINT meeting_summary_enqueue",
      "RELEASE SAVEPOINT meeting_summary_enqueue"
    ]);
    expect(f.row).toMatchObject({ status: "waiting", code: null, early_enqueued: false });
    expect(await f.repo.admit(f.scoped, meetingId, requestKey)).toMatchObject({ requestKey });
  });
  it("can retry optional early enqueue after a transient failure", async () => {
    const f = fixture();
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error("Queue outage"))
      .mockResolvedValueOnce(undefined);
    const input = {
      meetingId,
      grantId,
      deadline: f.row.due_at.toISOString(),
      finalized: true,
      stoppedNow: false
    };
    await f.repo.schedule(f.scoped, { actorUserId: meetingId }, input, enqueue);
    await f.repo.schedule(f.scoped, { actorUserId: meetingId }, input, enqueue);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(f.queries.at(-1)?.sql).toContain("SET early_enqueued=true");
    expect(f.row).toMatchObject({ status: "waiting", code: null });
  });
  it("cannot create an automatic attempt on an ordinary status read", async () => {
    const f = fixture();
    vi.mocked(f.repo.row).mockResolvedValue(null);
    const enqueue = vi.fn();
    await f.repo.schedule(
      f.scoped,
      { actorUserId: meetingId },
      {
        meetingId,
        grantId,
        deadline: f.row.due_at.toISOString(),
        finalized: true,
        stoppedNow: false
      },
      enqueue
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });
});
