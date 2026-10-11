import { assertDataContextDb, isUuid } from "@moss/db";
import { presentApprovalFields, type RouteApprovalPresentation } from "@moss/module-sdk";

export const notificationReadPresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  if (
    Object.keys(input.params).length !== 1 ||
    !input.params.id ||
    !isUuid(input.params.id) ||
    (input.query && Object.keys(input.query).length)
  )
    return null;
  if (!presentApprovalFields(input.body, {})) return null;
  const row = await db.db
    .selectFrom("app.notifications")
    .select(["id", "title", "created_at"])
    .where("id", "=", input.params.id)
    .executeTakeFirst();
  return row
    ? {
        target: row.title,
        fields: [{ label: "Received", value: row.created_at.toISOString() }],
        version: JSON.stringify(row)
      }
    : null;
};

export const notificationsReadAllPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  const fields = presentApprovalFields(input.body, {});
  return fields ? { content: "user_authored", target: "All your notifications", fields } : null;
};

export const pushDeviceRemovalPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (
    Object.keys(input.params).length !== 1 ||
    !input.params.id ||
    !isUuid(input.params.id) ||
    !input.target ||
    (input.query && Object.keys(input.query).length)
  )
    return null;
  const fields = presentApprovalFields(input.body, {});
  return fields ? { target: input.target, fields, version: input.params.id } : null;
};
