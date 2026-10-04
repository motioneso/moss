import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingOutputsRepository } from "@moss/meetings";
import { selectMeetingOutputHistoryVersions } from "../../packages/meetings/src/output-repository.js";
import type { MeetingActionCandidate, MeetingOutputAction } from "@moss/shared";
import { makeRecordingDb } from "./helpers/recording-db.js";

const meetingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ids = ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
const action: MeetingOutputAction = {
  text: "Prepare report",
  ownerPhrase: null,
  duePhrase: null,
  evidence: [
    { kind: "personal-note", meetingId, notesRevision: 1, startCharacter: 0, endCharacter: 14 }
  ]
};
afterEach(() => vi.restoreAllMocks());
describe("Meeting candidate JSONB parameters", () => {
  it.each([0, 1, 2])(
    "serializes %i possible matches as JSON text, never a PostgreSQL array",
    async (count) => {
      const { scoped, queries } = makeRecordingDb();
      const repo = new MeetingOutputsRepository();
      vi.spyOn(repo, "lock").mockResolvedValue({
        id: meetingId,
        title: "Meeting",
        personalNotes: "Prepare report",
        notesRevision: 1,
        createdAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T00:00:00.000Z"
      });
      const candidates: MeetingActionCandidate[] = ids.slice(0, count).map((id) => ({
        id,
        meetingId,
        artifactVersion: 1,
        proposal: action,
        reviewState: "dismissed",
        acceptedTaskId: null,
        possibleMatchIds: []
      }));
      vi.spyOn(repo, "candidates").mockResolvedValue(candidates);
      await repo.save(scoped, {
        meetingId,
        inputs: { meetingId, transcript: null, personalNotes: "Prepare report", notesRevision: 1 },
        content: {
          overview: "Report discussed",
          decisions: [],
          openQuestions: [],
          actions: [action],
          warnings: []
        },
        templateId: "general",
        templateVersion: 1,
        modelRoute: "test-only",
        origin: "generated",
        stale: false
      });
      const insert = queries.find((query) =>
        query.sql.startsWith('insert into "app"."meeting_action_candidates"')
      );
      expect(insert).toBeDefined();
      // Compiling the production save path catches pg's array parameter encoding without a DB.
      expect(insert!.sql).toContain('"possible_match_ids"');
      expect(insert!.sql).toContain("$5::jsonb");
      expect(insert!.parameters[4]).toBe(JSON.stringify(ids.slice(0, count)));
      expect(JSON.parse(insert!.parameters[4] as string)).toEqual(ids.slice(0, count));
      expect(insert!.parameters.some(Array.isArray)).toBe(false);
    }
  );
});

describe("Meeting history byte budget", () => {
  it("keeps the old active head while limiting full input snapshots to 2 MiB", () => {
    const metadata = Array.from({ length: 1000 }, (_, index) => ({
      version: 1000 - index,
      bytes: 1024 * 1024
    }));
    expect(selectMeetingOutputHistoryVersions(metadata, 1)).toEqual([1000, 1]);
  });
  it("keeps the recent page plus a tiny older head when they fit", () => {
    const metadata = Array.from({ length: 1000 }, (_, index) => ({
      version: 1000 - index,
      bytes: 1024
    }));
    const selected = selectMeetingOutputHistoryVersions(metadata, 1);
    expect(selected).toHaveLength(101);
    expect(selected).toContain(1);
    expect(selected[0]).toBe(1000);
    expect(selectMeetingOutputHistoryVersions([], null)).toEqual([]);
  });
});

describe("Meeting request reconciliation", () => {
  it("uses bounded live-generation lookup and expires old receipts under the meeting lock", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ request_key: ids[0] }] });
    const repo = new MeetingOutputsRepository();
    const lock = vi.spyOn(repo, "lock").mockResolvedValue({
      id: meetingId,
      title: "Meeting",
      personalNotes: "",
      notesRevision: 0,
      createdAt: "",
      updatedAt: ""
    });
    expect(await repo.pendingGeneration(scoped, meetingId)).toBe(ids[0]);
    expect(lock).toHaveBeenCalledWith(scoped, meetingId);
    expect(queries[0]?.sql).toContain("meeting_output_interrupted");
    expect(queries[0]?.sql).toContain('"expires_at" <= clock_timestamp()');
    expect(queries[1]?.sql).toContain('"expires_at" > clock_timestamp()');
    expect(queries[1]?.sql).toContain('"history_kind" = $2');
    expect(queries[1]?.sql).not.toContain("::jsonb");
    expect(queries[1]?.parameters).toEqual([meetingId, "generate", 1]);
  });

  it("treats reordered request object fields as the same input but preserves value conflicts", async () => {
    const key = ids[0]!;
    const { scoped } = makeRecordingDb({
      rows: [
        {
          meeting_id: meetingId,
          request_key: key,
          input_json: JSON.stringify({
            kind: "review",
            candidateId: ids[1],
            decision: "accept",
            requestKey: key
          }),
          result_json: "{}",
          expires_at: new Date(Date.now() + 10000)
        }
      ]
    });
    const repo = new MeetingOutputsRepository();
    expect(
      await repo.request(
        scoped,
        meetingId,
        key,
        JSON.stringify({ requestKey: key, decision: "accept", candidateId: ids[1], kind: "review" })
      )
    ).toBeDefined();
    await expect(
      repo.request(
        scoped,
        meetingId,
        key,
        JSON.stringify({
          requestKey: key,
          decision: "dismiss",
          candidateId: ids[1],
          kind: "review"
        })
      )
    ).rejects.toMatchObject({ code: "meeting_output_request_conflict" });
  });

  it("does not mark siblings from the same artifact as previous-version matches", async () => {
    const { scoped, queries } = makeRecordingDb({
      rows: [
        {
          id: ids[0],
          version: 0,
          meeting_id: meetingId,
          artifact_version: 1,
          proposal_json: JSON.stringify(action),
          possible_match_ids: [],
          review_state: "pending",
          accepted_task_id: null
        }
      ]
    });
    const repo = new MeetingOutputsRepository();
    vi.spyOn(repo, "lock").mockResolvedValue({
      id: meetingId,
      title: "Meeting",
      personalNotes: "Prepare report",
      notesRevision: 1,
      createdAt: "",
      updatedAt: ""
    });
    vi.spyOn(repo, "candidates").mockResolvedValue([]);
    await repo.save(scoped, {
      meetingId,
      inputs: { meetingId, transcript: null, personalNotes: "Prepare report", notesRevision: 1 },
      content: {
        overview: "Report discussed",
        decisions: [],
        openQuestions: [],
        actions: [action, { ...action, text: "Review report" }],
        warnings: []
      },
      templateId: "general",
      templateVersion: 1,
      modelRoute: "test-only",
      origin: "generated",
      stale: false
    });
    const inserts = queries.filter((query) =>
      query.sql.startsWith('insert into "app"."meeting_action_candidates"')
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.map((query) => query.parameters[4])).toEqual(["[]", "[]"]);
  });
});
