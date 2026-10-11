import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { assertDataContextDb, type AccessContext, type DataContextDb } from "@moss/db";
import type { GenerateMeetingOutputInput, MeetingAutomaticSummary } from "@moss/shared";
import { MeetingPreferencesRepository } from "./preferences.js";
import { MeetingOutputsRepository } from "./output-repository.js";
import { getMeetingOutputTemplate } from "./output-validation.js";

export interface MeetingStopSummaryRow {
  meeting_id: string;
  owner_user_id: string;
  grant_id: string;
  request_key: string;
  template_id: string;
  status: "waiting" | "submitted" | "skipped";
  code: string | null;
  due_at: Date;
  created_at: Date;
  early_enqueued: boolean;
  input_json: string | null;
}
export interface MeetingStopSummaryPayload {
  actorUserId: string;
  resourceId: string;
  idempotencyKey: string;
}
export type MeetingStopSummaryEnqueue = (
  db: DataContextDb,
  payload: MeetingStopSummaryPayload,
  at: Date,
  early: boolean
) => Promise<void>;
/** Durable intent shares the capture transaction; optional enqueue uses a savepoint so Stop survives queue failure. */
export class MeetingStopSummaryRepository {
  constructor(
    private readonly preferences = new MeetingPreferencesRepository(),
    private readonly outputs = new MeetingOutputsRepository()
  ) {}
  async row(db: DataContextDb, meetingId: string): Promise<MeetingStopSummaryRow | null> {
    assertDataContextDb(db);
    return (
      (
        await sql<MeetingStopSummaryRow>`SELECT * FROM app.meeting_stop_summaries WHERE meeting_id=${meetingId}::uuid`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  private async enqueueSafely(
    db: DataContextDb,
    row: MeetingStopSummaryRow,
    payload: MeetingStopSummaryPayload,
    at: Date,
    early: boolean,
    enqueue: MeetingStopSummaryEnqueue
  ): Promise<boolean> {
    await sql`SAVEPOINT meeting_summary_enqueue`.execute(db.db);
    try {
      await enqueue(db, payload, at, early);
      await sql`RELEASE SAVEPOINT meeting_summary_enqueue`.execute(db.db);
      return true;
    } catch {
      // Optional queue infrastructure must never roll back the capture Stop/cutoff.
      await sql`ROLLBACK TO SAVEPOINT meeting_summary_enqueue`.execute(db.db);
      await sql`RELEASE SAVEPOINT meeting_summary_enqueue`.execute(db.db);
      // Early dispatch is only an optimization: the admitted delayed job remains valid.
      // Leave early_enqueued false so a later finalized observation may try again.
      if (!early) {
        await this.skip(db, row.meeting_id, "meeting_output_queue_unavailable");
        row.status = "skipped";
        row.code = "meeting_output_queue_unavailable";
      }
      return false;
    }
  }
  async schedule(
    db: DataContextDb,
    actor: AccessContext,
    input: {
      meetingId: string;
      grantId: string;
      deadline: string;
      finalized: boolean;
      stoppedNow: boolean;
    },
    enqueue: MeetingStopSummaryEnqueue
  ): Promise<void> {
    assertDataContextDb(db);
    let row = await this.row(db, input.meetingId);
    if (!row && input.stoppedNow) {
      const preferences = await this.preferences.get(db);
      const dueAt = new Date(input.deadline);
      row = (
        await sql<MeetingStopSummaryRow>`INSERT INTO app.meeting_stop_summaries (meeting_id,grant_id,request_key,template_id,status,code,due_at)
        VALUES (${input.meetingId}::uuid,${input.grantId}::uuid,${randomUUID()}::uuid,${preferences.summaryTemplateId},${preferences.summarizeOnStop ? "waiting" : "skipped"},${preferences.summarizeOnStop ? null : "setting-off"},${dueAt}) RETURNING *`.execute(
          db.db
        )
      ).rows[0]!;
      if (row.status === "waiting")
        await this.enqueueSafely(
          db,
          row,
          {
            actorUserId: actor.actorUserId,
            resourceId: row.meeting_id,
            idempotencyKey: row.request_key
          },
          dueAt,
          false,
          enqueue
        );
    }
    if (
      row?.status === "waiting" &&
      row.grant_id === input.grantId &&
      input.finalized &&
      !row.early_enqueued
    ) {
      if (
        await this.enqueueSafely(
          db,
          row,
          {
            actorUserId: actor.actorUserId,
            resourceId: row.meeting_id,
            idempotencyKey: row.request_key
          },
          new Date(),
          true,
          enqueue
        )
      )
        await sql`UPDATE app.meeting_stop_summaries SET early_enqueued=true WHERE meeting_id=${input.meetingId}::uuid`.execute(
          db.db
        );
    }
  }
  private async skip(db: DataContextDb, meetingId: string, code: string): Promise<null> {
    await sql`UPDATE app.meeting_stop_summaries SET status='skipped',code=${code} WHERE meeting_id=${meetingId}::uuid`.execute(
      db.db
    );
    return null;
  }
  /** Runs under the meeting lock; returns only a fixed metadata input, never provider work. */
  async admit(
    db: DataContextDb,
    meetingId: string,
    requestKey: string
  ): Promise<GenerateMeetingOutputInput | null> {
    const row = await this.row(db, meetingId);
    if (!row || row.request_key !== requestKey || row.status === "skipped") return null;
    if (row.input_json) return JSON.parse(row.input_json) as GenerateMeetingOutputInput;
    if (row.due_at.getTime() + 300000 <= Date.now())
      return this.skip(db, meetingId, "meeting_output_interrupted");
    const capture = (
      await sql<{
        status: string;
        state_json: string | null;
      }>`SELECT status,state_json FROM app.meeting_capture_grants WHERE id=${row.grant_id}::uuid AND meeting_id=${meetingId}::uuid`.execute(
        db.db
      )
    ).rows[0];
    const state = capture?.state_json
      ? (JSON.parse(capture.state_json) as {
          desired?: string;
          stopCutoffMs?: number | null;
          finalized?: boolean;
          finalizationDeadline?: string | null;
        })
      : null;
    if (
      !state ||
      capture?.status === "revoked" ||
      state.desired !== "stopped" ||
      state.stopCutoffMs == null
    )
      return this.skip(db, meetingId, "capture-interrupted");
    if (
      !state.finalized &&
      (!state.finalizationDeadline || Date.parse(state.finalizationDeadline) >= Date.now())
    )
      throw new Error("Meeting finalization is still pending");
    if (!(await this.preferences.get(db)).summarizeOnStop)
      return this.skip(db, meetingId, "setting-off");
    if (await this.outputs.head(db, meetingId)) return this.skip(db, meetingId, "existing-output");
    if (await this.outputs.pendingGeneration(db, meetingId))
      return this.skip(db, meetingId, "existing-request");
    const inputs = await this.outputs.inputs(db, meetingId);
    if (
      !inputs.transcript ||
      inputs.transcript.containsProvisional ||
      !inputs.transcript.segments.some(
        (segment) => segment.finality === "final" && /[\p{L}\p{N}]/u.test(segment.text)
      )
    )
      return this.skip(db, meetingId, "no-meaningful-transcript");
    const template = getMeetingOutputTemplate(row.template_id, 1);
    if (!template) return this.skip(db, meetingId, "template-unavailable");
    const input: GenerateMeetingOutputInput = {
      requestKey,
      expectedOutputVersion: 0,
      expectedTranscriptRevision: inputs.transcript.transcriptRevision,
      expectedNotesRevision: inputs.notesRevision,
      templateId: template.id,
      templateVersion: template.version
    };
    await sql`UPDATE app.meeting_stop_summaries SET status='submitted',input_json=${JSON.stringify(input)} WHERE meeting_id=${meetingId}::uuid`.execute(
      db.db
    );
    return input;
  }
  async status(db: DataContextDb, meetingId: string): Promise<MeetingAutomaticSummary | null> {
    const row = await this.row(db, meetingId);
    if (!row) return null;
    if (row.status === "skipped")
      return {
        status: row.code?.startsWith("meeting_output_") ? "failed" : "skipped",
        requestKey: row.request_key,
        code: row.code ?? undefined,
        expiresAt: null
      };
    const request = (
      await sql<{
        expires_at: Date;
        result_json: string | null;
      }>`SELECT expires_at,result_json FROM app.meeting_output_requests WHERE meeting_id=${meetingId}::uuid AND request_key=${row.request_key}::uuid`.execute(
        db.db
      )
    ).rows[0];
    if (!request) {
      const expiresAt = new Date(row.due_at.getTime() + 300000);
      return {
        status: expiresAt.getTime() <= Date.now() ? "failed" : "waiting",
        requestKey: row.request_key,
        code: expiresAt.getTime() <= Date.now() ? "meeting_output_interrupted" : undefined,
        expiresAt: expiresAt.toISOString()
      };
    }
    if (!request.result_json)
      return {
        status: request.expires_at.getTime() <= Date.now() ? "failed" : "pending",
        requestKey: row.request_key,
        code: request.expires_at.getTime() <= Date.now() ? "meeting_output_interrupted" : undefined,
        expiresAt: request.expires_at.toISOString()
      };
    const result = JSON.parse(request.result_json) as { status: "saved" | "failed"; code?: string };
    return {
      status: result.status,
      requestKey: row.request_key,
      code: result.code,
      expiresAt: null
    };
  }
}
