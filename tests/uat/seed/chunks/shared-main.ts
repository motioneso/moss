import { SharesRepository, type DataContextRunner } from "@moss/db";
import { UAT_SEED_BASE_TIMESTAMP } from "../timestamps.js";

export const UAT_SHARED_MAIN_TITLE = "UAT-3192 owner two Main";
export const UAT_SHARED_MAIN_MESSAGE = "UAT-3192 owner two private note";

const SHARED_MAIN_THREAD_ID = "00000000-0000-4000-8000-000000319201";
const SHARED_MAIN_MESSAGE_ID = "00000000-0000-4000-8000-000000319202";

/**
 * #3192: the second owner's Main, granted read-only to the admin through the real shares path.
 * Its activity is dated far ahead so the admin's thread list always shows it before the admin's
 * own Main, however late the run happens.
 */
export async function seedSharedForeignMainChunk(
  runner: DataContextRunner,
  ownerUserId: string,
  granteeUserId: string
): Promise<void> {
  const activeAt = new Date("2099-01-15T12:00:00.000Z");
  await runner.withDataContext({ actorUserId: ownerUserId }, async (scopedDb) => {
    const thread = await scopedDb.db
      .insertInto("app.chat_threads")
      .values({
        id: SHARED_MAIN_THREAD_ID,
        owner_user_id: ownerUserId,
        title: UAT_SHARED_MAIN_TITLE,
        surface: "drawer",
        incognito: false,
        is_main: true,
        created_at: UAT_SEED_BASE_TIMESTAMP,
        updated_at: activeAt,
        last_active_at: activeAt
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await scopedDb.db
      .insertInto("app.chat_messages")
      .values({
        id: SHARED_MAIN_MESSAGE_ID,
        thread_id: thread.id,
        owner_user_id: ownerUserId,
        role: "user",
        status: "stored",
        body: UAT_SHARED_MAIN_MESSAGE,
        created_at: UAT_SEED_BASE_TIMESTAMP,
        updated_at: UAT_SEED_BASE_TIMESTAMP
      })
      .execute();

    // SECURITY: granted under the owner's own context; the shares policy rejects forged owners.
    await new SharesRepository().grant(scopedDb, {
      resourceType: "chat_thread",
      resourceId: thread.id,
      ownerUserId,
      granteeUserId,
      level: "view",
      now: UAT_SEED_BASE_TIMESTAMP
    });
  });
}
