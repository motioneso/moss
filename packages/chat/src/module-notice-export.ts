import { sql } from "kysely";
import { assertDataContextDb } from "@moss/db";
import type { ModuleLifecycleContext } from "@moss/module-sdk";

/** The ordinary Chat message export carries notice text; this retains its source and action context. */
export async function collectModuleNoticeExport(scopedDb: unknown, ctx: ModuleLifecycleContext) {
  assertDataContextDb(scopedDb);
  const result = await sql<Record<string, unknown>>`
    SELECT id::text, thread_id::text AS "threadId", message_id::text AS "messageId",
      module_id AS "moduleId", source_id::text AS "sourceId", source_version AS "sourceVersion",
      notice_kind AS "noticeKind", actions, created_at AS "createdAt", 'stored' AS state
    FROM app.chat_module_notices WHERE owner_user_id = ${ctx.actorUserId}::uuid
    UNION ALL
    SELECT NULL AS id, NULL AS "threadId", NULL AS "messageId", module_id AS "moduleId",
      source_id::text AS "sourceId",source_version AS "sourceVersion",notice_kind AS "noticeKind",
      '[]'::jsonb AS actions,created_at AS "createdAt",'pending' AS state
    FROM app.chat_module_notice_intents WHERE owner_user_id=${ctx.actorUserId}::uuid
    ORDER BY "createdAt", id
  `.execute(scopedDb.db);
  return result.rows.map(
    (row) => JSON.parse(JSON.stringify(row)) as Record<string, string | number | boolean | null>
  );
}
