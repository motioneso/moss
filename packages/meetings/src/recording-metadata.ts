import { assertDataContextDb, assertUuid, type DataContextDb } from "@moss/db";
import { sql } from "kysely";
import type { RecordingMetadata, RecordingInterpretation } from "@moss/shared";
import {
  RecordingIdentityError,
  RecordingTypesRepository,
  requireRecordingType
} from "./recording-types.js";

interface MetadataRow {
  meeting_id: string;
  revision: number;
  type_id: string | null;
  type_source: RecordingMetadata["typeSource"];
  title_source: RecordingMetadata["titleSource"];
  side: RecordingMetadata["side"];
  confidence: number | null;
  reason: string | null;
  recorded_at: Date | null;
  source: RecordingMetadata["source"];
  output_version: number | null;
}
function metadata(row: MetadataRow): RecordingMetadata {
  return {
    meetingId: row.meeting_id,
    revision: row.revision,
    typeId: row.type_id,
    typeSource: row.type_source,
    titleSource: row.title_source,
    side: row.side,
    confidence: row.confidence,
    reason: row.reason,
    recordedAt: row.recorded_at?.toISOString() ?? null,
    source: row.source,
    outputVersion: row.output_version
  };
}
/** All writers hold the owning recording lock before touching metadata. */
export class RecordingMetadataRepository {
  /** Called only in the transaction that creates a new recording. */
  async create(
    db: DataContextDb,
    meetingId: string,
    initial: Pick<RecordingMetadata, "titleSource" | "typeId" | "source" | "recordedAt">
  ) {
    assertDataContextDb(db);
    assertUuid(meetingId, "Meeting id");
    await sql`INSERT INTO app.meeting_recording_metadata(meeting_id,title_source,type_id,type_source,source,recorded_at)
      VALUES(${meetingId}::uuid,${initial.titleSource},${initial.typeId},${initial.typeId === null ? "automatic" : "user"},
      ${initial.source},${initial.recordedAt === null ? null : new Date(initial.recordedAt)})`.execute(
      db.db
    );
  }
  async get(db: DataContextDb, meetingId: string): Promise<RecordingMetadata | null> {
    assertDataContextDb(db);
    assertUuid(meetingId, "Meeting id");
    const row = (
      await sql<MetadataRow>`SELECT * FROM app.meeting_recording_metadata WHERE meeting_id=${meetingId}::uuid`.execute(
        db.db
      )
    ).rows[0];
    return row ? metadata(row) : null;
  }
  async ensure(db: DataContextDb, meetingId: string): Promise<RecordingMetadata> {
    assertDataContextDb(db);
    assertUuid(meetingId, "Meeting id");
    await sql`INSERT INTO app.meeting_recording_metadata(meeting_id,title_source)
      SELECT id,CASE WHEN title='Untitled meeting' THEN 'automatic' ELSE 'user' END
      FROM app.meeting_records WHERE id=${meetingId}::uuid
      ON CONFLICT(meeting_id) DO NOTHING`.execute(db.db);
    const result = await this.get(db, meetingId);
    if (!result) throw new RecordingIdentityError("meeting_not_found", 404);
    return result;
  }
  async markUserTitle(db: DataContextDb, meetingId: string) {
    await this.ensure(db, meetingId);
    await sql`UPDATE app.meeting_recording_metadata SET title_source='user',revision=revision+1 WHERE meeting_id=${meetingId}::uuid`.execute(
      db.db
    );
  }
  async putType(db: DataContextDb, meetingId: string, expectedRevision: number, typeId: string) {
    assertDataContextDb(db);
    assertUuid(meetingId, "Meeting id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new RecordingIdentityError("recording_invalid_input");
    const record = await db.db
      .selectFrom("app.meeting_records")
      .select("id")
      .where("id", "=", meetingId)
      .forUpdate()
      .executeTakeFirst();
    if (!record) throw new RecordingIdentityError("meeting_not_found", 404);
    requireRecordingType(await new RecordingTypesRepository().get(db), typeId);
    const current = await this.ensure(db, meetingId);
    if (current.revision !== expectedRevision)
      throw new RecordingIdentityError("recording_revision_conflict", 409);
    await sql`UPDATE app.meeting_recording_metadata SET type_id=${typeId},type_source='user',revision=revision+1 WHERE meeting_id=${meetingId}::uuid`.execute(
      db.db
    );
    return (await this.get(db, meetingId))!;
  }
  async apply(
    db: DataContextDb,
    before: RecordingMetadata,
    interpretation: RecordingInterpretation,
    outputVersion: number
  ) {
    const current = await this.get(db, before.meetingId);
    if (!current || current.revision !== before.revision) return;
    await sql`UPDATE app.meeting_recording_metadata SET
      type_id=${current.typeSource === "user" ? current.typeId : interpretation.typeId},
      side=${interpretation.side},confidence=${interpretation.confidence},reason=${interpretation.reason},
      output_version=${outputVersion},revision=revision+1
      WHERE meeting_id=${before.meetingId}::uuid AND revision=${before.revision}`.execute(db.db);
  }
}
