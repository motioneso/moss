import { createHash } from "node:crypto";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { MeetingExportReceipt } from "@moss/shared";
import { MeetingOutputsRepository, MeetingOutputError } from "./output-repository.js";
import { renderMeetingExport } from "./export-render.js";

export class MeetingExportsRepository {
  private readonly outputs = new MeetingOutputsRepository();
  /** Serializes owner-visible export attempts with edits/deletion of the meeting. */
  async lock(db: DataContextDb, meetingId: string): Promise<void> {
    await this.outputs.lock(db, meetingId);
  }
  async content(db: DataContextDb, meetingId: string, version: number): Promise<string> {
    const artifact = await this.outputs.getArtifact(db, meetingId, version);
    if (!artifact) throw new MeetingOutputError("meeting_output_unavailable", 404);
    return renderMeetingExport(artifact);
  }
  async list(db: DataContextDb, meetingId: string): Promise<MeetingExportReceipt[]> {
    assertDataContextDb(db);
    const rows = await db.db
      .selectFrom("app.meeting_export_receipts")
      .select("receipt_json")
      .where("meeting_id", "=", meetingId)
      .orderBy("artifact_version", "desc")
      .limit(1000)
      .execute();
    return rows.map((row) => JSON.parse(row.receipt_json) as MeetingExportReceipt);
  }
  async request(
    db: DataContextDb,
    meetingId: string,
    requestKey: string,
    version: number
  ): Promise<MeetingExportReceipt | null> {
    assertDataContextDb(db);
    const row = await db.db
      .selectFrom("app.meeting_export_requests")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("request_key", "=", requestKey)
      .executeTakeFirst();
    if (row && row.artifact_version !== version)
      throw new MeetingOutputError("meeting_export_request_conflict");
    return row?.result_json ? (JSON.parse(row.result_json) as MeetingExportReceipt) : null;
  }
  async reserve(
    db: DataContextDb,
    meetingId: string,
    requestKey: string,
    version: number
  ): Promise<void> {
    assertDataContextDb(db);
    await db.db
      .insertInto("app.meeting_export_requests")
      .values({
        meeting_id: meetingId,
        request_key: requestKey,
        artifact_version: version,
        result_json: null
      })
      .onConflict((conflict) => conflict.columns(["meeting_id", "request_key"]).doNothing())
      .execute();
  }
  async receipt(
    db: DataContextDb,
    meetingId: string,
    version: number
  ): Promise<MeetingExportReceipt | null> {
    assertDataContextDb(db);
    const row = await db.db
      .selectFrom("app.meeting_export_receipts")
      .select("receipt_json")
      .where("meeting_id", "=", meetingId)
      .where("artifact_version", "=", version)
      .executeTakeFirst();
    return row ? (JSON.parse(row.receipt_json) as MeetingExportReceipt) : null;
  }
  async intend(
    db: DataContextDb,
    meetingId: string,
    version: number,
    content: string
  ): Promise<void> {
    assertDataContextDb(db);
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    const current = await this.receipt(db, meetingId, version);
    if (current) {
      if (current.contentHash !== contentHash)
        throw new MeetingOutputError("meeting_export_content_conflict");
      return;
    }
    const now = new Date().toISOString();
    const receipt: MeetingExportReceipt = {
      meetingId,
      artifactVersion: version,
      destination: "private-vault",
      audience: "owner",
      idempotencyKey: `meeting:${meetingId}:artifact:${version}:private-vault`,
      contentHash,
      noteReference: null,
      writeStatus: "pending",
      indexStatus: "not-requested",
      indexJobId: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now
    };
    await db.db
      .insertInto("app.meeting_export_receipts")
      .values({
        meeting_id: meetingId,
        artifact_version: version,
        content_hash: contentHash,
        receipt_json: JSON.stringify(receipt),
        history_write_status: receipt.writeStatus,
        history_index_status: receipt.indexStatus,
        history_updated_at: receipt.updatedAt
      })
      .execute();
  }
  async finish(
    db: DataContextDb,
    requestKey: string,
    receipt: MeetingExportReceipt
  ): Promise<void> {
    assertDataContextDb(db);
    await db.db
      .updateTable("app.meeting_export_receipts")
      .set({
        receipt_json: JSON.stringify(receipt),
        history_write_status: receipt.writeStatus,
        history_index_status: receipt.indexStatus,
        history_updated_at: receipt.updatedAt
      })
      .where("meeting_id", "=", receipt.meetingId)
      .where("artifact_version", "=", receipt.artifactVersion)
      .execute();
    await db.db
      .updateTable("app.meeting_export_requests")
      .set({ result_json: JSON.stringify(receipt) })
      .where("meeting_id", "=", receipt.meetingId)
      .where("request_key", "=", requestKey)
      .where("result_json", "is", null)
      .execute();
  }
}
