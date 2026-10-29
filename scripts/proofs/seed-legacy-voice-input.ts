/** Pre-upgrade receipt fixture, only in the disposable live-proof database. */
import { randomUUID } from "node:crypto";
import {
  assertGateRunDatabaseAccess,
  createDatabase,
  DataContextRunner,
  getMossDatabaseUrls
} from "@moss/db";
assertGateRunDatabaseAccess(process.env);
const [owner, thread] = process.argv.slice(2);
if (!owner || !thread) throw new Error("Disposable owner and Main required");
const db = createDatabase({ connectionString: getMossDatabaseUrls().app });
try {
  const context = new DataContextRunner(db);
  const row = await context.withDataContext({ actorUserId: owner }, async (ctx) => {
    await ctx.db
      .selectFrom("app.chat_threads")
      .select("id")
      .where("id", "=", thread)
      .where("is_main", "=", true)
      .where("owner_user_id", "=", owner)
      .executeTakeFirstOrThrow();
    return ctx.db
      .insertInto("app.chat_voice_requests")
      .values({
        id: randomUUID(),
        owner_user_id: owner,
        thread_id: thread,
        source_device_id: "legacy-proof-ring",
        recording_id: randomUUID(),
        fingerprint: "a".repeat(64),
        transcript_revision: 1,
        transcript: "Legacy retained input proof",
        captured_at: null,
        automatic: false,
        turn_id: randomUUID(),
        user_message_id: randomUUID(),
        assistant_message_id: randomUUID(),
        state: "ready-to-send",
        confirmed_at: null,
        dispatch_boot_id: null,
        dispatched_at: null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  });
  console.log(row.id);
} finally {
  await db.destroy();
}
