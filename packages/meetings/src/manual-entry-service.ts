import { createHash } from "node:crypto";
import { assertDataContextDb, isUuid, type AccessContext, type DataContextDb } from "@moss/db";
import type { ManualTranscriptInput } from "@moss/shared";
import { sql } from "kysely";
import { MeetingRecordsRepository } from "./repository.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";
import { RecordingMetadataRepository } from "./recording-metadata.js";
import {
  RecordingTypesRepository,
  RecordingIdentityError,
  requireRecordingType
} from "./recording-types.js";
import {
  MeetingStopSummaryRepository,
  type MeetingStopSummaryEnqueue
} from "./stop-summary-repository.js";

export function validateManualTranscript(input: ManualTranscriptInput): ManualTranscriptInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["requestKey", "title", "typeId", "recordedAt", "transcript"].includes(key)
    ) ||
    !isUuid(input.requestKey) ||
    typeof input.transcript !== "string" ||
    !input.transcript.trim() ||
    input.transcript.includes("\0") ||
    input.transcript.length > 100000 ||
    (input.title !== undefined &&
      (typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.includes("\0") ||
        Buffer.byteLength(input.title.trim()) > 240)) ||
    (input.typeId !== undefined &&
      (typeof input.typeId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.typeId))) ||
    (input.recordedAt !== undefined &&
      (typeof input.recordedAt !== "string" || !Number.isFinite(Date.parse(input.recordedAt))))
  )
    throw new RecordingIdentityError("recording_invalid_input");
  return {
    requestKey: input.requestKey.toLowerCase(),
    ...(input.title === undefined ? {} : { title: input.title.trim() }),
    ...(input.typeId === undefined ? {} : { typeId: input.typeId }),
    ...(input.recordedAt === undefined
      ? {}
      : { recordedAt: new Date(input.recordedAt).toISOString() }),
    transcript: input.transcript
  };
}
/** Create evidence and its automatic-generation admission in the same owner transaction. */
export class ManualEntryService {
  constructor(private readonly enqueue: MeetingStopSummaryEnqueue) {}
  async create(db: DataContextDb, actor: AccessContext, raw: ManualTranscriptInput) {
    assertDataContextDb(db);
    const input = validateManualTranscript(raw);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    // The record creation's owner/request unique constraint serializes concurrent retries.
    const records = new MeetingRecordsRepository();
    const created = await records.create(db, {
      requestKey: input.requestKey,
      title: input.title ?? "Untitled meeting"
    });
    const meetingId = created.meeting.id;
    await records.get(db, meetingId, { forUpdate: true });
    const previous = (
      await sql<{
        input_hash: string;
      }>`SELECT input_hash FROM app.meeting_manual_entries WHERE meeting_id=${meetingId}::uuid`.execute(
        db.db
      )
    ).rows[0];
    if (previous) {
      if (previous.input_hash !== hash)
        throw new RecordingIdentityError("recording_request_conflict", 409);
      return { meetingId, replayed: true };
    }
    if (!created.created) throw new RecordingIdentityError("recording_request_conflict", 409);
    const types = await new RecordingTypesRepository().get(db);
    if (input.typeId) requireRecordingType(types, input.typeId);
    await new RecordingMetadataRepository().create(db, meetingId, {
      source: "manual-transcript",
      titleSource: input.title === undefined ? "automatic" : "user",
      typeId: input.typeId ?? null,
      recordedAt: input.recordedAt ?? null
    });
    const ingested = await new MeetingTranscriptRepository().ingest(db, {
      meetingId,
      requestKey: input.requestKey,
      expectedVersion: 0,
      stopCutoffMs: 1,
      sources: [
        {
          sourceId: "manual-transcript",
          epoch: 1,
          kind: "recording",
          label: "Pasted transcript",
          startMs: 0,
          endMs: 1
        }
      ],
      events: [
        {
          cursor: 1,
          segment: {
            meetingId,
            segmentId: "manual-transcript",
            sourceId: "manual-transcript",
            epoch: 1,
            startMs: 0,
            endMs: 1,
            revision: 1,
            text: input.transcript,
            finality: "final",
            provenance: "correction",
            speakerId: null
          }
        }
      ]
    });
    if (ingested.status !== "saved")
      throw new RecordingIdentityError("recording_entry_failed", 409);
    await sql`INSERT INTO app.meeting_manual_entries(meeting_id,request_key,input_hash,transcript_revision)
      VALUES(${meetingId}::uuid,${input.requestKey}::uuid,${hash},${ingested.receipt.transcriptRevision})`.execute(
      db.db
    );
    await new MeetingStopSummaryRepository().scheduleManual(
      db,
      actor,
      {
        meetingId,
        transcriptRevision: ingested.receipt.transcriptRevision,
        templateId: input.typeId ? requireRecordingType(types, input.typeId).templateId : "general"
      },
      this.enqueue
    );
    return { meetingId, replayed: false };
  }
}
