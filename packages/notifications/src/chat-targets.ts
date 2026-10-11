import { assertDataContextDb, isUuid } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";
import { DEFAULT_LOCALE_SETTINGS, formatLocaleDate } from "@moss/shared";

/**
 * #3065: labels the device a chat-issued DELETE /api/notifications/push/subscriptions/:id would
 * stop. RLS scopes the read to the actor's own devices. Reads only the label column, never the
 * credential envelope.
 */
export const pushDeviceTarget: RouteChatTargetResolver = async (db, params, ctx) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const row = await db.db
    .selectFrom("app.push_subscriptions")
    .select(["user_agent_label", "created_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return (
    row.user_agent_label ??
    `Device added ${formatLocaleDate(row.created_at, ctx?.locale ?? DEFAULT_LOCALE_SETTINGS)}`
  );
};
