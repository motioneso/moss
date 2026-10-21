import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

const RECORDING_ID = /^(?:amsg_)?[0-9]{10}_[A-Za-z0-9_-]{1,24}$/;
export class RecordingVoiceIneligibleError extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

interface Enablement {
  id: string;
  source_device_id: string;
  inventory_json: string;
  enabled_at: Date;
  disabled_at: Date | null;
}

export function parseVoiceEnablement(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Invalid ring inventory snapshot");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 4 ||
    input.version !== 2 ||
    typeof input.sourceDeviceId !== "string" ||
    !isUuid(input.sourceDeviceId) ||
    typeof input.requestKey !== "string" ||
    !isUuid(input.requestKey) ||
    !Array.isArray(input.recordingIds) ||
    input.recordingIds.length > 1024 ||
    !input.recordingIds.every((id) => typeof id === "string" && RECORDING_ID.test(id)) ||
    new Set(input.recordingIds).size !== input.recordingIds.length
  )
    throw new HttpError(400, "Invalid ring inventory snapshot");
  return {
    sourceDeviceId: input.sourceDeviceId.toLowerCase(),
    requestKey: input.requestKey.toLowerCase(),
    inventoryJson: JSON.stringify([...input.recordingIds].sort())
  };
}

export function voiceEnablementStatus(row: Enablement) {
  return {
    id: row.id,
    sourceDeviceId: row.source_device_id,
    enabledAt: row.enabled_at.toISOString(),
    enabled: row.disabled_at === null
  };
}

/** Snapshots are immutable. A repeated enable request never grants a fresh capture window. */
export class RecordingVoiceEnablementRepository {
  async enable(db: DataContextDb, value: unknown) {
    assertDataContextDb(db);
    const input = parseVoiceEnablement(value);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.actor_user_id') || ${input.sourceDeviceId}, 1))`.execute(
      db.db
    );
    const prior = (
      await sql<Enablement>`SELECT * FROM app.meeting_recording_voice_enablements WHERE source_device_id=${input.sourceDeviceId}::uuid AND request_key=${input.requestKey}::uuid FOR UPDATE`.execute(
        db.db
      )
    ).rows[0];
    if (prior) {
      if (prior.inventory_json !== input.inventoryJson)
        throw new HttpError(409, "Ring inventory snapshot changed");
      return voiceEnablementStatus(prior);
    }
    await sql`UPDATE app.meeting_recording_voice_enablements SET disabled_at=clock_timestamp() WHERE source_device_id=${input.sourceDeviceId}::uuid AND disabled_at IS NULL`.execute(
      db.db
    );
    const row = (
      await sql<Enablement>`INSERT INTO app.meeting_recording_voice_enablements(id,source_device_id,request_key,inventory_json) VALUES(${randomUUID()}::uuid,${input.sourceDeviceId}::uuid,${input.requestKey}::uuid,${input.inventoryJson}) RETURNING *`.execute(
        db.db
      )
    ).rows[0]!;
    return voiceEnablementStatus(row);
  }

  async disable(db: DataContextDb, id: string) {
    assertDataContextDb(db);
    if (!isUuid(id)) throw new HttpError(400, "Invalid voice enablement");
    const row = (
      await sql<Enablement>`UPDATE app.meeting_recording_voice_enablements SET disabled_at=COALESCE(disabled_at,clock_timestamp()) WHERE id=${id}::uuid RETURNING *`.execute(
        db.db
      )
    ).rows[0];
    return row ? voiceEnablementStatus(row) : null;
  }

  async admit(
    db: DataContextDb,
    input: {
      enablementId: string;
      sourceDeviceId: string;
      recordingId: string;
      capturedAt: string | null;
      startMs: number;
      endMs: number;
    }
  ) {
    assertDataContextDb(db);
    const row = (
      await sql<
        Enablement & { received_at: Date }
      >`SELECT *,clock_timestamp() AS received_at FROM app.meeting_recording_voice_enablements WHERE id=${input.enablementId}::uuid AND source_device_id=${input.sourceDeviceId}::uuid FOR SHARE`.execute(
        db.db
      )
    ).rows[0];
    if (!row || row.disabled_at !== null)
      throw new RecordingVoiceIneligibleError(
        "Enable hold-to-talk before sending new voice recordings"
      );
    const baseline =
      (
        await sql`SELECT 1 FROM app.meeting_recording_voice_enablements WHERE source_device_id=${input.sourceDeviceId}::uuid AND inventory_json::jsonb ? ${input.recordingId} LIMIT 1`.execute(
          db.db
        )
      ).rows.length > 0;
    if (baseline)
      throw new RecordingVoiceIneligibleError(
        "Recordings in the enablement inventory remain meeting imports"
      );
    // A missing phone-observed capture time is deliberately uncertain, even with ring timestamps.
    const capturedMs = input.capturedAt === null ? NaN : Date.parse(input.capturedAt);
    const automatic =
      Number.isFinite(capturedMs) &&
      capturedMs > row.enabled_at.getTime() &&
      capturedMs <= row.received_at.getTime() &&
      Math.abs(capturedMs - input.startMs) <= 1500 &&
      input.endMs <= row.received_at.getTime();
    return { enablementId: row.id, automatic, capturedAt: automatic ? input.capturedAt : null };
  }
}
