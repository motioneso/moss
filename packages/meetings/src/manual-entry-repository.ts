import { assertDataContextDb, assertUuid, type DataContextDb } from "@moss/db";
import { sql } from "kysely";

/** Manual admission receipts share the owning record's transaction and lock. */
export class ManualEntryRepository {
  async inputHash(db: DataContextDb, meetingId: string): Promise<string | undefined> {
    assertDataContextDb(db);
    assertUuid(meetingId, "Meeting id");
    const result = await sql<{ input_hash: string }>`
      SELECT input_hash FROM app.meeting_manual_entries WHERE meeting_id=${meetingId}::uuid
    `.execute(db.db);
    return result.rows[0]?.input_hash;
  }

  async create(
    db: DataContextDb,
    input: {
      meetingId: string;
      requestKey: string;
      inputHash: string;
      transcriptRevision: number;
    }
  ): Promise<void> {
    assertDataContextDb(db);
    assertUuid(input.meetingId, "Meeting id");
    assertUuid(input.requestKey, "Request key");
    await sql`
      INSERT INTO app.meeting_manual_entries(meeting_id,request_key,input_hash,transcript_revision)
      VALUES(${input.meetingId}::uuid,${input.requestKey}::uuid,${input.inputHash},${input.transcriptRevision})
    `.execute(db.db);
  }
}
