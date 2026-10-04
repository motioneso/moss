import { createHash, randomUUID } from "node:crypto";
import {
  assertDataContextDb,
  assertUuid,
  type DataContextDb,
  type MeetingActionCandidatesTable
} from "@moss/db";
import { sql, type Selectable } from "kysely";
import type {
  MeetingActionCandidate,
  MeetingOutputAction,
  MeetingOutputArtifact,
  MeetingOutputContent,
  MeetingOutputInputs,
  ReviewMeetingActionInput
} from "@moss/shared";
import { MeetingRecordsRepository } from "./repository.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";
import { validateMeetingOutput } from "./output-validation.js";

export class MeetingOutputError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
    readonly currentVersions?: {
      outputVersion: number;
      notesRevision?: number;
      transcriptRevision?: number;
    }
  ) {
    super(code);
  }
}
export type MeetingTaskCreator = (
  db: DataContextDb,
  input: {
    title: string;
    dueAt: string | null;
    source: "meeting";
    sourceRef: string;
    externalKey: string;
  }
) => Promise<{ id: string }>;
function candidate(row: Selectable<MeetingActionCandidatesTable>): MeetingActionCandidate {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    artifactVersion: row.artifact_version,
    proposal: JSON.parse(row.proposal_json) as MeetingOutputAction,
    possibleMatchIds: row.possible_match_ids,
    reviewState: row.review_state,
    acceptedTaskId: row.accepted_task_id
  };
}
function identity(action: MeetingOutputAction) {
  // A model cannot choose candidate identity. Exact source/range + proposal equality only;
  // all nonexact proposals are reviewable possible matches, never automatic replacements.
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}
export class MeetingOutputsRepository {
  private readonly records = new MeetingRecordsRepository();
  private readonly transcripts = new MeetingTranscriptRepository();

  async lock(db: DataContextDb, meetingId: string) {
    assertDataContextDb(db);
    const meeting = await this.records.get(db, meetingId, { forUpdate: true });
    if (!meeting) throw new MeetingOutputError("meeting_not_found", 404);
    return meeting;
  }
  async inputs(db: DataContextDb, meetingId: string): Promise<MeetingOutputInputs> {
    const meeting = await this.lock(db, meetingId);
    const transcript = await this.transcripts.snapshot(db, meeting.id, {
      maxSegments: 500,
      maxCharacters: 100000
    });
    return {
      meetingId: meeting.id,
      transcript,
      personalNotes: meeting.personalNotes,
      notesRevision: meeting.notesRevision
    };
  }
  async head(db: DataContextDb, meetingId: string) {
    assertDataContextDb(db);
    assertUuid(meetingId, "Meeting id");
    const row = await db.db
      .selectFrom("app.meeting_output_artifacts")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("inactive", "=", false)
      .orderBy("version", "desc")
      .executeTakeFirst();
    return row ? (JSON.parse(row.artifact_json) as MeetingOutputArtifact) : null;
  }
  async getArtifact(
    db: DataContextDb,
    meetingId: string,
    version: number
  ): Promise<MeetingOutputArtifact | null> {
    assertDataContextDb(db);
    assertUuid(meetingId, "Meeting id");
    const row = await db.db
      .selectFrom("app.meeting_output_artifacts")
      .select("artifact_json")
      .where("meeting_id", "=", meetingId)
      .where("version", "=", version)
      .executeTakeFirst();
    return row ? (JSON.parse(row.artifact_json) as MeetingOutputArtifact) : null;
  }
  async list(db: DataContextDb, meetingId: string) {
    const inputs = await this.inputs(db, meetingId);
    const rows = await db.db
      .selectFrom("app.meeting_output_artifacts")
      .select("artifact_json")
      .where("meeting_id", "=", meetingId)
      .orderBy("version", "desc")
      .limit(100)
      .execute();
    const head = await this.head(db, meetingId);
    const history = rows.map(
      ({ artifact_json }) => JSON.parse(artifact_json) as MeetingOutputArtifact
    );
    // Late stale generations must not evict the current editable head from the bounded page.
    if (head && !history.some((artifact) => artifact.version === head.version)) history.push(head);
    const artifacts = history.map((artifact) => {
      return {
        ...artifact,
        stale:
          artifact.stale ||
          artifact.inputs.notesRevision !== inputs.notesRevision ||
          (artifact.inputs.transcript?.transcriptRevision ?? 0) !==
            (inputs.transcript?.transcriptRevision ?? 0)
      };
    });
    return {
      artifacts,
      candidates: await this.candidates(db, meetingId),
      headVersion: head?.version ?? 0
    };
  }
  async candidates(db: DataContextDb, meetingId: string) {
    assertDataContextDb(db);
    return (
      await db.db
        .selectFrom("app.meeting_action_candidates")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .orderBy("artifact_version")
        .orderBy("id")
        .limit(1000)
        .execute()
    ).map(candidate);
  }
  async request(db: DataContextDb, meetingId: string, requestKey: string, input: string) {
    assertDataContextDb(db);
    assertUuid(requestKey, "Meeting output request key");
    const row = await db.db
      .selectFrom("app.meeting_output_requests")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("request_key", "=", requestKey)
      .executeTakeFirst();
    if (row && row.input_json !== input)
      throw new MeetingOutputError("meeting_output_request_conflict");
    if (row && row.result_json === null && row.expires_at.getTime() <= Date.now()) {
      const result_json = JSON.stringify({
        status: "failed",
        requestKey,
        code: "meeting_output_interrupted"
      });
      await this.finish(db, meetingId, requestKey, JSON.parse(result_json));
      return { ...row, result_json };
    }
    return row;
  }
  async reserve(db: DataContextDb, meetingId: string, requestKey: string, input: string) {
    await db.db
      .insertInto("app.meeting_output_requests")
      .values({
        meeting_id: meetingId,
        request_key: requestKey,
        input_json: input,
        result_json: null
      })
      .execute();
  }
  async finish(db: DataContextDb, meetingId: string, requestKey: string, result: unknown) {
    await db.db
      .updateTable("app.meeting_output_requests")
      .set({ result_json: JSON.stringify(result) })
      .where("meeting_id", "=", meetingId)
      .where("request_key", "=", requestKey)
      .where("result_json", "is", null)
      .execute();
  }
  async save(
    db: DataContextDb,
    input: Omit<MeetingOutputArtifact, "id" | "version" | "createdAt">
  ): Promise<MeetingOutputArtifact> {
    await this.lock(db, input.meetingId);
    input = { ...input, content: validateMeetingOutput(input.content, input.inputs) };
    const previous = await db.db
      .selectFrom("app.meeting_output_artifacts")
      .select("version")
      .where("meeting_id", "=", input.meetingId)
      .orderBy("version", "desc")
      .executeTakeFirst();
    const version = (previous?.version ?? 0) + 1;
    if (version > 1000) throw new MeetingOutputError("meeting_output_limit", 400);
    const artifact: MeetingOutputArtifact = {
      ...input,
      id: randomUUID(),
      version,
      createdAt: new Date().toISOString()
    };
    await db.db
      .insertInto("app.meeting_output_artifacts")
      .values({
        id: artifact.id,
        meeting_id: input.meetingId,
        version,
        artifact_json: JSON.stringify(artifact),
        inactive: input.stale
      })
      .execute();
    if (!input.stale) {
      const existing = await this.candidates(db, input.meetingId);
      if (existing.length + input.content.actions.length > 1000)
        throw new MeetingOutputError("meeting_output_limit", 400);
      for (const action of input.content.actions) {
        const inserted = await db.db
          .insertInto("app.meeting_action_candidates")
          .values({
            meeting_id: input.meetingId,
            identity_key: identity(action),
            artifact_version: version,
            proposal_json: JSON.stringify(action),
            possible_match_ids: sql<
              string[]
            >`${JSON.stringify(existing.map((item) => item.id))}::jsonb`,
            accepted_task_id: null
          })
          .onConflict((conflict) => conflict.columns(["meeting_id", "identity_key"]).doNothing())
          .returningAll()
          .executeTakeFirst();
        if (inserted) existing.push(candidate(inserted));
      }
    }
    return artifact;
  }
  async edit(
    db: DataContextDb,
    meetingId: string,
    input: { requestKey: string; expectedOutputVersion: number; content: MeetingOutputContent }
  ) {
    await this.lock(db, meetingId);
    const encoded = JSON.stringify({ kind: "edit", ...input });
    const replay = await this.request(db, meetingId, input.requestKey, encoded);
    if (replay?.result_json) return JSON.parse(replay.result_json) as MeetingOutputArtifact;
    const head = await this.head(db, meetingId);
    if (!head || head.version !== input.expectedOutputVersion)
      throw new MeetingOutputError("meeting_output_version_conflict", 409, {
        outputVersion: head?.version ?? 0
      });
    let content: MeetingOutputContent;
    try {
      content = validateMeetingOutput(input.content, head.inputs);
    } catch {
      throw new MeetingOutputError("meeting_output_invalid_input", 400);
    }
    await this.reserve(db, meetingId, input.requestKey, encoded);
    const artifact = await this.save(db, { ...head, content, origin: "manual", stale: false });
    await this.finish(db, meetingId, input.requestKey, artifact);
    return artifact;
  }
  async review(
    db: DataContextDb,
    meetingId: string,
    candidateId: string,
    input: ReviewMeetingActionInput,
    createTask: MeetingTaskCreator
  ) {
    await this.lock(db, meetingId);
    assertUuid(candidateId, "Meeting candidate id");
    const encoded = JSON.stringify({ kind: "review", candidateId, ...input });
    const replay = await this.request(db, meetingId, input.requestKey, encoded);
    if (replay?.result_json) return JSON.parse(replay.result_json) as MeetingActionCandidate;
    const row = await db.db
      .selectFrom("app.meeting_action_candidates")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("id", "=", candidateId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new MeetingOutputError("meeting_action_unavailable", 404);
    let result = candidate(row);
    if (result.reviewState === "pending") {
      if (input.decision === "accept") {
        if (result.possibleMatchIds.length && input.createDespitePossibleMatches !== true)
          throw new MeetingOutputError("meeting_action_match_review_required");
        if (!input.title?.trim() || input.title.length > 500 || input.title.includes("\0"))
          throw new MeetingOutputError("meeting_output_invalid_input", 400);
        if (
          input.dueAt &&
          (!Number.isFinite(Date.parse(input.dueAt)) ||
            new Date(input.dueAt).toISOString() !== input.dueAt)
        )
          throw new MeetingOutputError("meeting_output_invalid_input", 400);
        const artifact = await this.getArtifact(db, meetingId, result.artifactVersion);
        if (!artifact) throw new MeetingOutputError("meeting_output_evidence_unavailable", 409);
        validateMeetingOutput(
          {
            overview: "Reviewed action",
            decisions: [],
            openQuestions: [],
            actions: [result.proposal],
            warnings: []
          },
          artifact.inputs
        );
        // The public Tasks operation uses this same owner transaction. No evidence excerpt
        // is copied; a surviving Task retains only the owner's reviewed text and provenance.
        const task = await createTask(db, {
          title: input.title.trim(),
          dueAt: input.dueAt ?? null,
          source: "meeting",
          sourceRef: result.meetingId,
          externalKey: `meeting:${result.meetingId}:candidate:${result.id}`
        });
        result = { ...result, reviewState: "accepted", acceptedTaskId: task.id };
      } else if (input.decision === "dismiss") result = { ...result, reviewState: "dismissed" };
      else throw new MeetingOutputError("meeting_output_invalid_input", 400);
      await db.db
        .updateTable("app.meeting_action_candidates")
        .set({ review_state: result.reviewState, accepted_task_id: result.acceptedTaskId })
        .where("id", "=", candidateId)
        .execute();
    } else if ((input.decision === "accept") !== (result.reviewState === "accepted"))
      throw new MeetingOutputError("meeting_action_review_conflict");
    await this.reserve(db, meetingId, input.requestKey, encoded);
    await this.finish(db, meetingId, input.requestKey, result);
    return result;
  }
}
