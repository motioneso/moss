import { sql } from "kysely";
import { assertDataContextDb } from "@moss/db";
import type { ModuleLifecycleContext } from "@moss/module-sdk";

/** Source/transcript and receipt metadata only; no runtime token or engine configuration. */
export async function collectVoiceRequestExport(scopedDb: unknown, ctx: ModuleLifecycleContext) {
  assertDataContextDb(scopedDb);
  const result = await sql<Record<string, unknown>>`
    SELECT id::text, thread_id::text AS "threadId", source_device_id AS "sourceDeviceId",
      recording_id AS "recordingId", fingerprint, transcript_revision AS "transcriptRevision",
      transcript, captured_at AS "capturedAt", automatic, auto_send AS "autoSend", turn_id::text AS "turnId",
      user_message_id::text AS "userMessageId", assistant_message_id::text AS "assistantMessageId",
      state, confirmed_at AS "confirmedAt", dispatched_at AS "dispatchedAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM app.chat_voice_requests WHERE owner_user_id = ${ctx.actorUserId}::uuid
    ORDER BY created_at, id
  `.execute(scopedDb.db);
  return result.rows.map(
    (row) => JSON.parse(JSON.stringify(row)) as Record<string, string | number | boolean | null>
  );
}
