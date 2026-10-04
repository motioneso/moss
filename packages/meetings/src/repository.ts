import {
  assertDataContextDb,
  assertUuid,
  type DataContextDb,
  type MeetingRecordsTable
} from "@moss/db";
import { sql, type Selectable } from "kysely";

import type {
  MeetingRecord,
  CreateMeetingRecordInput,
  MeetingRecordCursor,
  PutMeetingNotesInput,
  PutMeetingNotesResult
} from "@moss/shared";

export class MeetingRecordInputError extends Error {}
export class MeetingRecordConflictError extends Error {
  constructor() {
    super("Meeting request key was already used with different input");
    this.name = "MeetingRecordConflictError";
  }
}

function text(value: string, maxBytes: number, required: boolean): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maxBytes ||
    (required && !value.trim())
  )
    throw new MeetingRecordInputError("Invalid meeting text");
  return value;
}

function record(row: Selectable<MeetingRecordsTable>): MeetingRecord {
  return {
    id: row.id,
    title: row.title,
    personalNotes: row.personal_notes,
    notesRevision: row.notes_revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

/** Draft storage only. Requires the caller's actor-scoped transaction; no capture or jobs. */
export class MeetingRecordsRepository {
  async create(
    scopedDb: DataContextDb,
    input: CreateMeetingRecordInput
  ): Promise<{
    readonly created: boolean;
    readonly meeting: MeetingRecord;
  }> {
    assertDataContextDb(scopedDb);
    assertUuid(input.requestKey, "Meeting request key");
    if (Object.keys(input).some((key) => key !== "requestKey" && key !== "title")) {
      throw new MeetingRecordInputError("Invalid meeting creation input");
    }
    const title = text(input.title, 240, true).trim();
    const inserted = await scopedDb.db
      .insertInto("app.meeting_records")
      .values({ request_key: input.requestKey, title })
      .onConflict((conflict) => conflict.columns(["owner_user_id", "request_key"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { created: true, meeting: record(inserted) };
    // Under READ COMMITTED, a separate statement sees the concurrent insert winner.
    const existing = await scopedDb.db
      .selectFrom("app.meeting_records")
      .selectAll()
      .where("request_key", "=", input.requestKey)
      .executeTakeFirstOrThrow();
    if (existing.title !== title) throw new MeetingRecordConflictError();
    // Replay the original creation snapshot, not later edits. Fetch get() for current notes.
    // Both initial timestamps default to the same transaction-stable now() in SQL.
    return {
      created: false,
      meeting: record({
        ...existing,
        personal_notes: "",
        notes_revision: 0,
        updated_at: existing.created_at
      })
    };
  }

  async get(scopedDb: DataContextDb, id: string): Promise<MeetingRecord | null> {
    assertDataContextDb(scopedDb);
    assertUuid(id, "Meeting id");
    const row = await scopedDb.db
      .selectFrom("app.meeting_records")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? record(row) : null;
  }

  /** Idempotent; an inaccessible or absent record has the same no-content outcome. */
  async remove(scopedDb: DataContextDb, id: string): Promise<void> {
    assertDataContextDb(scopedDb);
    assertUuid(id, "Meeting id");
    await scopedDb.db.deleteFrom("app.meeting_records").where("id", "=", id).execute();
  }

  async list(
    scopedDb: DataContextDb,
    options: {
      readonly limit?: number;
      readonly before?: MeetingRecordCursor;
    } = {}
  ): Promise<MeetingRecord[]> {
    assertDataContextDb(scopedDb);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new MeetingRecordInputError("Invalid meeting page size");
    }
    let query = scopedDb.db.selectFrom("app.meeting_records").selectAll();
    if (options.before) {
      const { id, createdAt } = options.before;
      assertUuid(id, "Meeting cursor id");
      const date = new Date(createdAt);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== createdAt) {
        throw new MeetingRecordInputError("Invalid meeting cursor timestamp");
      }
      query = query.where((eb) =>
        eb.or([
          eb("created_at", "<", date),
          eb.and([eb("created_at", "=", date), eb("id", "<", id)])
        ])
      );
    }
    return (
      await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).execute()
    ).map(record);
  }

  async putNotes(
    scopedDb: DataContextDb,
    input: PutMeetingNotesInput
  ): Promise<PutMeetingNotesResult> {
    assertDataContextDb(scopedDb);
    assertUuid(input.meetingId, "Meeting id");
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      input.expectedRevision >= 2147483647
    ) {
      throw new MeetingRecordInputError("Invalid meeting notes revision");
    }
    assertUuid(input.requestKey, "Meeting notes request key");
    const body = text(input.personalNotes, 64000, false);
    // Serialize writes and receipt lookup on the owner-visible row in the ambient transaction.
    const current = await scopedDb.db
      .selectFrom("app.meeting_records")
      .selectAll()
      .where("id", "=", input.meetingId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return { status: "not-found" };
    const receipt = await scopedDb.db
      .selectFrom("app.meeting_note_writes")
      .selectAll()
      .where("meeting_id", "=", input.meetingId)
      .where("request_key", "=", input.requestKey)
      .executeTakeFirst();
    if (receipt) {
      if (receipt.expected_revision !== input.expectedRevision || receipt.personal_notes !== body) {
        throw new MeetingRecordConflictError();
      }
      return {
        status: "saved",
        replayed: true,
        meeting: record({
          ...current,
          personal_notes: receipt.personal_notes,
          notes_revision: receipt.expected_revision + 1,
          updated_at: receipt.saved_at
        })
      };
    }
    if (current.notes_revision !== input.expectedRevision) {
      return { status: "conflict", meeting: record(current) };
    }
    const updated = await scopedDb.db
      .updateTable("app.meeting_records")
      .set({
        personal_notes: body,
        notes_revision: input.expectedRevision + 1,
        updated_at: sql<Date>`clock_timestamp()`
      })
      .where("id", "=", input.meetingId)
      .where("notes_revision", "=", input.expectedRevision)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new Error("Locked meeting revision changed unexpectedly");
    await scopedDb.db
      .insertInto("app.meeting_note_writes")
      .values({
        meeting_id: input.meetingId,
        request_key: input.requestKey,
        expected_revision: input.expectedRevision,
        personal_notes: body,
        saved_at: updated.updated_at
      })
      .execute();
    return { status: "saved", replayed: false, meeting: record(updated) };
  }
}
