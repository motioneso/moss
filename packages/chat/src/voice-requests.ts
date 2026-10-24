import { createHash, randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { assertDataContextDb, type DataContextDb, type MossDatabase } from "@moss/db";

export const VOICE_AUTOMATIC_MAX_AGE_MS = 15 * 60_000;

import type { ChatVoiceRequestCursor, VoiceRequestInput } from "@moss/shared";
export type { VoiceRequestInput } from "@moss/shared";

function parseVoiceRequest(value: VoiceRequestInput): VoiceRequestInput {
  const fields = [
    "version",
    "intent",
    "sourceDeviceId",
    "recordingId",
    "sourceFingerprint",
    "transcriptRevision",
    "transcript",
    "capturedAt",
    "automatic"
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !(key in value)) ||
    value.version !== 2 ||
    value.intent !== "voice-request" ||
    ![value.sourceDeviceId, value.recordingId].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 200
    ) ||
    typeof value.sourceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) ||
    !Number.isInteger(value.transcriptRevision) ||
    value.transcriptRevision < 1 ||
    value.transcriptRevision > 2_147_483_647 ||
    typeof value.transcript !== "string" ||
    value.transcript.length > 32768 ||
    typeof value.automatic !== "boolean" ||
    (value.capturedAt !== null &&
      (typeof value.capturedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value.capturedAt
        ) ||
        !Number.isFinite(Date.parse(value.capturedAt))))
  )
    throw new Error("Invalid versioned voice request");
  // Canonical key order and timestamp make equality independent of caller object construction.
  return {
    version: 2,
    intent: "voice-request",
    sourceDeviceId: value.sourceDeviceId,
    recordingId: value.recordingId,
    sourceFingerprint: value.sourceFingerprint,
    transcriptRevision: value.transcriptRevision,
    transcript: value.transcript.trim(),
    capturedAt: value.capturedAt === null ? null : new Date(value.capturedAt).toISOString(),
    automatic: value.automatic
  };
}
export type VoiceRequest = Selectable<MossDatabase["app.chat_voice_requests"]>;

export class VoiceRequestConflictError extends Error {
  constructor() {
    super("Voice request source or transcript changed");
  }
}

export function voiceNeedsConfirmation(
  request: Pick<VoiceRequest, "auto_send" | "automatic" | "captured_at" | "confirmed_at">,
  now: Date
): boolean {
  if (request.auto_send || request.confirmed_at) return false;
  const age = request.captured_at ? now.getTime() - request.captured_at.getTime() : -1;
  return !request.automatic || age < 0 || age > VOICE_AUTOMATIC_MAX_AGE_MS;
}

export class VoiceRequestRepository {
  async list(db: DataContextDb, before?: ChatVoiceRequestCursor): Promise<VoiceRequest[]> {
    assertDataContextDb(db);
    let query = db.db.selectFrom("app.chat_voice_requests").selectAll();
    if (before) {
      query = query.where(
        sql<boolean>`(created_at, id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`
      );
    }
    return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(100).execute();
  }

  async get(db: DataContextDb, id: string, lock = false): Promise<VoiceRequest | undefined> {
    assertDataContextDb(db);
    const query = db.db.selectFrom("app.chat_voice_requests").selectAll().where("id", "=", id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  async admit(db: DataContextDb, threadId: string, value: VoiceRequestInput, now: Date) {
    assertDataContextDb(db);
    const input = parseVoiceRequest(value);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const timing = {
      auto_send: true,
      automatic: input.automatic,
      captured_at: input.capturedAt ? new Date(input.capturedAt) : null,
      confirmed_at: null
    };
    const state = !input.transcript.trim()
      ? "no-speech"
      : voiceNeedsConfirmation(timing, now)
        ? "ready-to-send"
        : "queued";
    const inserted = await db.db
      .insertInto("app.chat_voice_requests")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        thread_id: threadId,
        source_device_id: input.sourceDeviceId,
        recording_id: input.recordingId,
        fingerprint,
        transcript_revision: input.transcriptRevision,
        transcript: input.transcript,
        ...timing,
        turn_id: randomUUID(),
        user_message_id: randomUUID(),
        assistant_message_id: randomUUID(),
        state,
        dispatch_boot_id: null,
        dispatched_at: null,
        created_at: now,
        updated_at: now
      })
      .onConflict((c) =>
        c.columns(["owner_user_id", "source_device_id", "recording_id"]).doNothing()
      )
      .returningAll()
      .executeTakeFirst();
    const row =
      inserted ??
      (await db.db
        .selectFrom("app.chat_voice_requests")
        .selectAll()
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .where("source_device_id", "=", input.sourceDeviceId)
        .where("recording_id", "=", input.recordingId)
        .executeTakeFirstOrThrow());
    if (row.fingerprint !== fingerprint) throw new VoiceRequestConflictError();
    return { request: row, created: inserted !== undefined };
  }

  async confirm(db: DataContextDb, id: string, now: Date) {
    const row = await this.get(db, id, true);
    if (!row || (row.state !== "ready-to-send" && row.state !== "queued")) return row;
    return db.db
      .updateTable("app.chat_voice_requests")
      .set({ state: "queued", confirmed_at: row.confirmed_at ?? now, updated_at: now })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Must commit under the manager's drawer guard BEFORE any pre-model/model effects. */
  async claim(db: DataContextDb, id: string, bootId: string, now: Date) {
    const row = await this.get(db, id, true);
    if (!row || row.state !== "queued") return undefined;
    if (voiceNeedsConfirmation(row, now)) {
      await db.db
        .updateTable("app.chat_voice_requests")
        .set({ state: "ready-to-send", updated_at: now })
        .where("id", "=", id)
        .execute();
      return undefined;
    }
    return db.db
      .updateTable("app.chat_voice_requests")
      .set({ state: "dispatching", dispatch_boot_id: bootId, dispatched_at: now, updated_at: now })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** No automatic replay of ambiguous work, including pre-model actions with no saved reply. */
  async interrupt(db: DataContextDb, id: string, now: Date) {
    assertDataContextDb(db);
    await db.db
      .updateTable("app.chat_voice_requests")
      .set({ state: "interrupted", updated_at: now })
      .where("id", "=", id)
      .where("state", "=", "dispatching")
      .execute();
  }
}

/** Used by ALL canonical completed-turn writers, not just the model path. */
export async function reservedVoiceMessages(db: DataContextDb, threadId: string, turnId?: string) {
  assertDataContextDb(db);
  if (!turnId) return undefined;
  return db.db
    .selectFrom("app.chat_voice_requests")
    .selectAll()
    .where("thread_id", "=", threadId)
    .where("turn_id", "=", turnId)
    .forUpdate()
    .executeTakeFirst();
}
