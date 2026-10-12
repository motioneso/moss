import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
import { ChatRepository } from "../repository.js";

export type ReminderDestination =
  | { readonly threadId: string; readonly title: string | null }
  | { readonly reply: string };

/** Names are resolved only in the authenticated owner's drawer conversations. */
export async function resolveReminderDestination(
  scopedDb: DataContextDb,
  actorUserId: string,
  request: string | undefined,
  sourceThreadId?: string
): Promise<ReminderDestination> {
  assertDataContextDb(scopedDb);
  const chat = new ChatRepository();
  const name = request?.trim();
  const mainRequested = !name || /^main(?: chat)?$/i.test(name);
  const here = /^this chat$/i.test(name ?? "");
  const rows = mainRequested
    ? [await chat.getMainThread(scopedDb, actorUserId)]
    : here
      ? [
          sourceThreadId
            ? await chat.getOwnedThreadById(scopedDb, actorUserId, sourceThreadId)
            : undefined
        ]
      : await scopedDb.db
          .selectFrom("app.chat_threads")
          .selectAll()
          .where("owner_user_id", "=", actorUserId)
          .where("surface", "=", DEFAULT_CHAT_SURFACE)
          .where("incognito", "=", false)
          .where(sql<boolean>`lower(title) = lower(${name!})`)
          .execute();
  const matches = rows.filter(
    (row) =>
      row &&
      row.owner_user_id === actorUserId &&
      !row.incognito &&
      row.surface === DEFAULT_CHAT_SURFACE
  );
  const target = matches.length === 1 ? matches[0] : undefined;
  if (!target)
    return {
      reply:
        "I couldn't find one available chat with that name. Nothing changed. Name one of your conversations, use this chat, or choose Main."
    };
  return { threadId: target.id, title: target.is_main ? null : target.title };
}

/** Hold the target through persistence so deletion or ownership changes cannot race delivery. */
export async function lockReminderDestination(
  scopedDb: DataContextDb,
  actorUserId: string,
  threadId: string,
  title: string | null
) {
  assertDataContextDb(scopedDb);
  let query = scopedDb.db
    .selectFrom("app.chat_threads")
    .select("id")
    .where("id", "=", threadId)
    .where("owner_user_id", "=", actorUserId)
    .where("incognito", "=", false)
    .where("surface", "=", DEFAULT_CHAT_SURFACE);
  if (title === null) query = query.where("is_main", "=", true);
  return query.forShare().executeTakeFirst();
}
