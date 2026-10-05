import { projectMeetingSegments, projectMeetingSources } from "./history-projection.js";
import {
  assertDataContextDb,
  assertUuid,
  type DataContextDb,
  type MeetingTranscriptBatchesTable
} from "@moss/db";
import { sql, type Selectable } from "kysely";
import type {
  IngestMeetingTranscriptInput,
  IngestMeetingTranscriptResult,
  MeetingTranscriptEvidence,
  MeetingTranscriptLedger,
  MeetingTranscriptReceipt,
  MeetingTranscriptRevision,
  MeetingTranscriptSnapshotResponse,
  ReadMeetingTranscriptInput
} from "@moss/shared";
import { resolveMeetingTranscriptEvidence, selectMeetingTranscriptSnapshot } from "./transcript.js";
import { retrieveMeetingTranscript } from "./transcript-retrieval.js";
import {
  applyMeetingTranscriptBatch,
  encodeMeetingTranscriptBatch,
  MEETING_TRANSCRIPT_MAX_BATCHES,
  MEETING_TRANSCRIPT_MAX_STORAGE_BYTES,
  MeetingTranscriptInputError,
  MeetingTranscriptLimitError,
  MeetingTranscriptRequestConflictError
} from "./transcript-batch.js";

type Batch = Selectable<MeetingTranscriptBatchesTable>;
function receipt(batch?: Batch): MeetingTranscriptReceipt {
  return {
    version: batch?.version ?? 0,
    transcriptRevision: batch?.transcript_revision ?? 0,
    cursor: batch?.cursor ?? 0,
    stopCutoffMs: batch?.stop_cutoff_ms ?? null
  };
}

/** Every operation uses the caller's actor transaction. Browser authentication is owned by routes. */
export class MeetingTranscriptRepository {
  private async load(scopedDb: DataContextDb, meetingId: string, lock: boolean) {
    assertDataContextDb(scopedDb);
    assertUuid(meetingId, "Meeting id");
    let query = scopedDb.db
      .selectFrom("app.meeting_records")
      .select(["id", "owner_user_id"])
      .where("id", "=", meetingId);
    // Share locks hold deletion until the snapshot is read; writers take the same row exclusively.
    query = lock ? query.forUpdate() : query.forShare();
    const meeting = await query.executeTakeFirst();
    if (!meeting) return null;
    const size = await scopedDb.db
      .selectFrom("app.meeting_transcript_batches")
      .select(sql<string>`coalesce(sum(octet_length(input_json)), 0)`.as("bytes"))
      .where("meeting_id", "=", meetingId)
      .executeTakeFirstOrThrow();
    const bytes = Number(size.bytes);
    if (!Number.isSafeInteger(bytes) || bytes > MEETING_TRANSCRIPT_MAX_STORAGE_BYTES)
      throw new MeetingTranscriptLimitError();
    const batches = await scopedDb.db
      .selectFrom("app.meeting_transcript_batches")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .orderBy("version")
      .limit(MEETING_TRANSCRIPT_MAX_BATCHES + 1)
      .execute();
    if (batches.length > MEETING_TRANSCRIPT_MAX_BATCHES) throw new MeetingTranscriptLimitError();
    // Persisted inputs were validated under the same record lock at acceptance. Reconstruct
    // history linearly instead of repeatedly copying the entire immutable ledger per event.
    const revisions: MeetingTranscriptRevision[] = [];
    let latest: IngestMeetingTranscriptInput | null = null;
    let cursor = 0;
    for (const batch of batches) {
      latest = JSON.parse(batch.input_json) as IngestMeetingTranscriptInput;
      for (const event of latest.events) {
        // A previously accepted exact event replay has a cursor no newer than the head.
        if (event.cursor <= cursor) continue;
        cursor = event.cursor;
        revisions.push(
          Object.freeze({
            ...event,
            segment: Object.freeze(event.segment),
            transcriptRevision: revisions.length + 1
          })
        );
      }
      if (cursor !== batch.cursor || revisions.length !== batch.transcript_revision)
        throw new MeetingTranscriptInputError();
    }
    const ledger: MeetingTranscriptLedger | null = latest
      ? Object.freeze({
          meetingId,
          ownerUserId: meeting.owner_user_id,
          sources: Object.freeze(latest.sources.map((source) => Object.freeze(source))),
          transcriptRevision: revisions.length,
          cursor,
          revisions: Object.freeze(revisions)
        })
      : null;
    return { meeting, batches, ledger, bytes, receipt: receipt(batches.at(-1)) };
  }

  async ingest(
    scopedDb: DataContextDb,
    input: IngestMeetingTranscriptInput
  ): Promise<IngestMeetingTranscriptResult> {
    assertDataContextDb(scopedDb);
    assertUuid(input.requestKey, "Meeting transcript request key");
    assertUuid(input.meetingId, "Meeting id");
    const encoded = encodeMeetingTranscriptBatch(input);
    input = JSON.parse(encoded) as IngestMeetingTranscriptInput;
    const state = await this.load(scopedDb, input.meetingId, true);
    if (!state) return { status: "not-found" };
    const previous = state.batches.find((batch) => batch.request_key === input.requestKey);
    if (previous) {
      if (previous.input_json !== encoded) throw new MeetingTranscriptRequestConflictError();
      return { status: "saved", replayed: true, receipt: receipt(previous) };
    }
    if (state.receipt.version !== input.expectedVersion)
      return { status: "conflict", receipt: state.receipt };
    if (state.bytes + Buffer.byteLength(encoded) > MEETING_TRANSCRIPT_MAX_STORAGE_BYTES)
      throw new MeetingTranscriptLimitError();
    const ledger = applyMeetingTranscriptBatch(
      state.ledger,
      state.meeting.owner_user_id,
      state.receipt.stopCutoffMs,
      input
    );
    const inserted = await scopedDb.db
      .insertInto("app.meeting_transcript_batches")
      .values({
        meeting_id: input.meetingId,
        request_key: input.requestKey,
        version: input.expectedVersion + 1,
        input_json: encoded,
        transcript_revision: ledger.transcriptRevision,
        cursor: ledger.cursor,
        stop_cutoff_ms: input.stopCutoffMs,
        ...projectMeetingSources(input.sources)
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await projectMeetingSegments(scopedDb, input.meetingId, input.events);
    return { status: "saved", replayed: false, receipt: receipt(inserted) };
  }

  async snapshotWithSources(
    scopedDb: DataContextDb,
    meetingId: string,
    selection: ReadMeetingTranscriptInput
  ): Promise<MeetingTranscriptSnapshotResponse | null> {
    assertUuid(meetingId, "Meeting id");
    meetingId = meetingId.toLowerCase();
    const state = await this.load(scopedDb, meetingId, false);
    if (!state?.ledger) return null;
    const bound =
      state.receipt.stopCutoffMs ?? Math.max(...state.ledger.sources.map((source) => source.endMs));
    if (
      selection.cutoffMs !== undefined &&
      (!Number.isSafeInteger(selection.cutoffMs) || selection.cutoffMs < 0)
    )
      throw new MeetingTranscriptInputError();
    try {
      const snapshot = selectMeetingTranscriptSnapshot(state.ledger, {
        ...selection,
        meetingId,
        ownerUserId: state.meeting.owner_user_id,
        transcriptRevision: selection.transcriptRevision ?? state.ledger.transcriptRevision,
        cutoffMs: Math.min(selection.cutoffMs ?? bound, bound)
      });
      return { snapshot, sources: state.ledger.sources };
    } catch {
      throw new MeetingTranscriptInputError();
    }
  }

  async snapshot(
    scopedDb: DataContextDb,
    meetingId: string,
    selection: ReadMeetingTranscriptInput
  ) {
    return (await this.snapshotWithSources(scopedDb, meetingId, selection))?.snapshot ?? null;
  }

  async evidence(scopedDb: DataContextDb, evidence: MeetingTranscriptEvidence) {
    assertUuid(evidence.meetingId, "Meeting id");
    evidence = { ...evidence, meetingId: evidence.meetingId.toLowerCase() };
    const state = await this.load(scopedDb, evidence.meetingId, false);
    return state?.ledger ? resolveMeetingTranscriptEvidence(state.ledger, evidence) : null;
  }

  async retrieve(
    scopedDb: DataContextDb,
    meetingId: string,
    input: {
      readonly query: string;
      readonly maxSegments: number;
      readonly maxCharacters: number;
    }
  ) {
    assertUuid(meetingId, "Meeting id");
    const state = await this.load(scopedDb, meetingId.toLowerCase(), false);
    if (!state?.ledger) return null;
    return retrieveMeetingTranscript(state.ledger, {
      ...input,
      cutoffMs:
        state.receipt.stopCutoffMs ??
        Math.max(...state.ledger.sources.map((source) => source.endMs))
    });
  }
}
