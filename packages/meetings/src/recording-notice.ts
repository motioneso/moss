import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { MEETING_RECORDING_NOTICE, type MeetingRecordingNoticeStatus } from "@moss/shared";
import { MeetingCaptureError } from "./capture-domain.js";

/** Account-owned explicit acknowledgement of the current notice version. Browsers supply a displayed version, never a time. */
export class MeetingRecordingNoticeRepository {
  async get(db: DataContextDb): Promise<MeetingRecordingNoticeStatus> {
    assertDataContextDb(db);
    const result = await sql<{ policy_version: string; acknowledged_at: Date }>`
      SELECT policy_version, acknowledged_at FROM app.meeting_recording_notices
      WHERE owner_user_id=app.current_actor_user_id()
    `.execute(db.db);
    const row = result.rows[0];
    return {
      currentNotice: MEETING_RECORDING_NOTICE,
      acknowledgement: row
        ? { policyVersion: row.policy_version, acknowledgedAt: row.acknowledged_at.toISOString() }
        : null
    };
  }
  async acknowledge(
    db: DataContextDb,
    policyVersion: string
  ): Promise<MeetingRecordingNoticeStatus> {
    assertDataContextDb(db);
    if (policyVersion !== MEETING_RECORDING_NOTICE.policyVersion)
      throw new MeetingCaptureError("meeting_capture_notice_required", 409);
    await sql`
      INSERT INTO app.meeting_recording_notices (policy_version)
      VALUES (${policyVersion})
      ON CONFLICT (owner_user_id) DO UPDATE
        SET policy_version=excluded.policy_version, acknowledged_at=clock_timestamp()
        WHERE app.meeting_recording_notices.policy_version<>excluded.policy_version
    `.execute(db.db);
    return this.get(db);
  }
  async requireCurrent(db: DataContextDb): Promise<string> {
    const status = await this.get(db);
    if (status.acknowledgement?.policyVersion !== MEETING_RECORDING_NOTICE.policyVersion)
      throw new MeetingCaptureError("meeting_capture_notice_required", 409);
    return status.acknowledgement.policyVersion;
  }
}
