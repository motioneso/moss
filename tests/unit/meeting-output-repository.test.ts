import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingOutputsRepository } from "@moss/meetings";
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
