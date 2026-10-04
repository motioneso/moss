import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { ChatRepository, deleteMeetingChatThreads } from "@moss/chat";
import {
  MeetingRecordsRepository,
  MeetingTranscriptRepository,
  registerMeetingRecordRoutes
} from "@moss/meetings";
import { meetingChatSurface, normalizeChatSurface } from "@moss/shared";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

let app: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let context: DataContextRunner;
const records = new MeetingRecordsRepository();
const transcripts = new MeetingTranscriptRepository();
const chats = new ChatRepository();
const owner = ids.userA;
beforeAll(async () => {
  // Run only through verify-gate's isolated database workflow.
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy()]);
});

async function fixture() {
  return context.withDataContext({ actorUserId: owner }, async (db) => {
    const { meeting } = await records.create(db, {
      requestKey: randomUUID(),
      title: "Synthetic cleanup fixture"
    });
    await records.putNotes(db, {
      meetingId: meeting.id,
      requestKey: randomUUID(),
      expectedRevision: 0,
      personalNotes: "Synthetic notes"
    });
    await transcripts.ingest(db, {
      meetingId: meeting.id,
      requestKey: randomUUID(),
      expectedVersion: 0,
      stopCutoffMs: 1000,
      sources: [
        {
          sourceId: "mic",
          epoch: 1,
          kind: "microphone",
          label: "Microphone",
          startMs: 0,
          endMs: 1000
        }
      ],
      events: [
        {
          cursor: 1,
          segment: {
            meetingId: meeting.id,
            segmentId: "s",
            sourceId: "mic",
            epoch: 1,
            revision: 1,
            startMs: 0,
            endMs: 1000,
            text: "Synthetic transcript",
            finality: "final",
            provenance: "transcription",
            speakerId: null
          }
        }
      ]
    });
    const surface = meetingChatSurface(meeting.id);
    const threadIds: string[] = [];
    const messageIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const thread = await chats.openNewThread(db, { title: "Meeting questions", surface });
      const saved = await chats.recordCompletedTurn(
        db,
        thread.id,
        "Question",
        "Synthetic answer",
        { provider: "openai-compatible", model: "test-only" },
        undefined,
        surface
      );
      if (!saved) throw new Error("Fixture turn was not saved");
      threadIds.push(thread.id);
      messageIds.push(saved.userMessage.id, saved.assistantMessage.id);
    }
    const unrelated = await chats.openNewThread(db, { title: "Ordinary chat" });
    return { meetingId: meeting.id, surface, threadIds, messageIds, unrelatedId: unrelated.id };
  });
}
async function deleteViaRoute(
  meetingId: string,
  actorUserId: string = owner,
  beforeRemove = deleteMeetingChatThreads
) {
  const server = Fastify();
  registerMeetingRecordRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId }),
    dataContext: context,
    beforeRemove
  });
  try {
    return await server.inject({ method: "DELETE", url: `/api/meetings/records/${meetingId}` });
  } finally {
    await server.close();
  }
}
async function assertPresent(f: Awaited<ReturnType<typeof fixture>>) {
  expect(
    await bootstrap
      .selectFrom("app.meeting_records")
      .select("id")
      .where("id", "=", f.meetingId)
      .execute()
  ).toHaveLength(1);
  expect(
    await bootstrap
      .selectFrom("app.chat_threads")
      .select("id")
      .where("id", "in", f.threadIds)
      .execute()
  ).toHaveLength(2);
  expect(
    await bootstrap
      .selectFrom("app.chat_messages")
      .select("id")
      .where("id", "in", f.messageIds)
      .execute()
  ).toHaveLength(4);
}

describe("owner-approved meeting deletion with real chat runtime permissions", () => {
  it("uses the actual route and public cleanup to delete all derived threads/messages and meeting children atomically", async () => {
    const f = await fixture();
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      const principal = await sql<{
        role: string;
        bypass: boolean;
      }>`SELECT current_user AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`.execute(
        db.db
      );
      expect(principal.rows[0]).toEqual({ role: "jarvis_app_runtime", bypass: false });
    });
    const response = await deleteViaRoute(f.meetingId);
    expect(response.statusCode, response.body).toBe(204);
    expect(
      await bootstrap
        .selectFrom("app.meeting_records")
        .select("id")
        .where("id", "=", f.meetingId)
        .execute()
    ).toEqual([]);
    expect(
      await bootstrap
        .selectFrom("app.meeting_note_writes")
        .select("meeting_id")
        .where("meeting_id", "=", f.meetingId)
        .execute()
    ).toEqual([]);
    expect(
      await bootstrap
        .selectFrom("app.meeting_transcript_batches")
        .select("meeting_id")
        .where("meeting_id", "=", f.meetingId)
        .execute()
    ).toEqual([]);
    expect(
      await bootstrap
        .selectFrom("app.chat_threads")
        .select("id")
        .where("id", "in", f.threadIds)
        .execute()
    ).toEqual([]);
    expect(
      await bootstrap
        .selectFrom("app.chat_messages")
        .select("id")
        .where("id", "in", f.messageIds)
        .execute()
    ).toEqual([]);
    expect(
      await bootstrap
        .selectFrom("app.chat_threads")
        .select("id")
        .where("id", "=", f.unrelatedId)
        .execute()
    ).toHaveLength(1);
    expect((await deleteViaRoute(f.meetingId)).statusCode).toBe(204);
  });
  it.each([ids.userB, ids.adminUser])(
    "does not grant another actor or admin deletion authority (%s)",
    async (actorUserId) => {
      const f = await fixture();
      expect((await deleteViaRoute(f.meetingId, actorUserId)).statusCode).toBe(204);
      await context.withDataContext({ actorUserId }, (db) =>
        deleteMeetingChatThreads(db, f.meetingId)
      );
      await assertPresent(f);
    }
  );
  it("rolls back deleted chat messages when later meeting cleanup fails", async () => {
    const f = await fixture();
    const response = await deleteViaRoute(f.meetingId, owner, async (db, id) => {
      await deleteMeetingChatThreads(db, id);
      throw new Error("Synthetic later cleanup failure");
    });
    expect(response.statusCode).toBe(500);
    await assertPresent(f);
  });
  it.each([
    "drawer",
    "mtg-00",
    "mtg-01",
    "mtg-zzzzzzzzzzzzzzzzzzzzzzzzz",
    "mtg-f5lxx1zz5pnorynqglhzmsp34"
  ])("does not let runtime delete ordinary or noncanonical surface %s", async (rawSurface) => {
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      const thread = await chats.openNewThread(db, {
        title: "Protected thread",
        surface: normalizeChatSurface(rawSurface)
      });
      await sql`SELECT app.delete_meeting_chat_threads_for_cleanup(${rawSurface}::text)`.execute(
        db.db
      );
      expect(
        await chats.getThreadById(db, thread.id, normalizeChatSurface(rawSurface))
      ).toBeDefined();
    });
  });
  it.each(["ordinary-to-meeting", "meeting-to-drawer", "meeting-to-meeting"])(
    "rejects runtime surface retargeting (%s) without changing rows or bindings",
    async (direction) => {
      const f = await fixture();
      const threadId = direction === "ordinary-to-meeting" ? f.unrelatedId : f.threadIds[0]!;
      const originalSurface = direction === "ordinary-to-meeting" ? "drawer" : f.surface;
      const targetSurface =
        direction === "meeting-to-drawer" ? "drawer" : meetingChatSurface(randomUUID());
      await expect(
        context.withDataContext({ actorUserId: owner }, async (db) => {
          const principal = await sql<{ role: string }>`SELECT current_user AS role`.execute(db.db);
          expect(principal.rows[0]?.role).toBe("jarvis_app_runtime");
          await db.db
            .updateTable("app.chat_threads")
            .set({ surface: targetSurface })
            .where("id", "=", threadId)
            .execute();
        })
      ).rejects.toMatchObject({ code: "42501", message: "chat thread surface cannot be changed" });
      await assertPresent(f);
      await context.withDataContext({ actorUserId: owner }, async (db) => {
        expect(
          await db.db
            .selectFrom("app.chat_threads")
            .select(["id", "surface", "owner_user_id", "incognito"])
            .where("id", "=", threadId)
            .executeTakeFirstOrThrow()
        ).toEqual({
          id: threadId,
          surface: originalSurface,
          owner_user_id: owner,
          incognito: false
        });
        // Ordinary updates and no-op surface assignments remain supported.
        await chats.updateThreadTitle(db, threadId, "Updated title");
        await db.db
          .updateTable("app.chat_threads")
          .set({ surface: originalSurface })
          .where("id", "=", threadId)
          .execute();
      });
    }
  );
  it("observes surface retargeting without its trigger and rolls back the security probe", async () => {
    assertIsolatedTestDatabase(connectionStrings.bootstrap);
    const name = new URL(connectionStrings.bootstrap).pathname.slice(1);
    if (!/^(jarvis_gate_|jarvis_test_)/.test(name))
      throw new Error("Probe requires a disposable gate/test database");
    expect(
      (await sql<{ name: string }>`SELECT current_database() AS name`.execute(bootstrap)).rows[0]
        ?.name
    ).toBe(name);
    const f = await fixture();
    class SurfaceProtectionRemoved extends Error {}
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER TABLE app.chat_threads DISABLE TRIGGER chat_threads_prevent_surface_change`.execute(
          transaction
        );
        await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
        await sql`SELECT set_config('app.actor_user_id', ${owner}, true)`.execute(transaction);
        const changed = await transaction
          .updateTable("app.chat_threads")
          .set({ surface: f.surface })
          .where("id", "=", f.unrelatedId)
          .returning(["id", "surface"])
          .execute();
        expect(changed).toEqual([{ id: f.unrelatedId, surface: f.surface }]);
        throw new SurfaceProtectionRemoved(
          "Ordinary chat could be retargeted with its trigger disabled"
        );
      })
    ).rejects.toBeInstanceOf(SurfaceProtectionRemoved);
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        db.db
          .updateTable("app.chat_threads")
          .set({ surface: f.surface })
          .where("id", "=", f.unrelatedId)
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      await bootstrap
        .selectFrom("app.chat_threads")
        .select("surface")
        .where("id", "=", f.unrelatedId)
        .executeTakeFirstOrThrow()
    ).toEqual({ surface: "drawer" });
    await assertPresent(f);
  });
  it("keeps incognito meeting rows outside the meeting cleanup function", async () => {
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      const thread = await chats.openNewThread(db, {
        title: "Private bookkeeping",
        surface: meetingChatSurface(randomUUID()),
        incognito: true
      });
      await sql`SELECT app.delete_meeting_chat_threads_for_cleanup(${thread.surface}::text)`.execute(
        db.db
      );
      expect(
        await chats.getThreadById(db, thread.id, normalizeChatSurface(thread.surface))
      ).toBeDefined();
      await sql`SELECT app.delete_incognito_chat_thread_for_cleanup(${thread.id}::uuid)`.execute(
        db.db
      );
    });
  });
  it("exposes only the bounded cleanup function and keeps its trigger invoker-scoped", async () => {
    const result = await sql<{
      name: string;
      definer: boolean;
      owner: string;
      config: string[] | null;
      public_execute: boolean;
    }>`
      SELECT p.proname AS name, p.prosecdef AS definer,
        pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
        EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname IN ('delete_meeting_chat_threads_for_cleanup', 'prevent_chat_thread_surface_change')
      ORDER BY p.proname`.execute(bootstrap);
    expect(result.rows).toEqual([
      {
        name: "delete_meeting_chat_threads_for_cleanup",
        definer: true,
        owner: "jarvis_migration_owner",
        config: ["search_path=app, pg_temp"],
        public_execute: false
      },
      {
        name: "prevent_chat_thread_surface_change",
        definer: false,
        owner: "jarvis_migration_owner",
        config: null,
        public_execute: false
      }
    ]);
  });
  it("keeps direct runtime deletion forbidden for ordinary and meeting threads", async () => {
    const f = await fixture();
    for (const id of [f.unrelatedId, ...f.threadIds]) {
      await expect(
        context.withDataContext({ actorUserId: owner }, (db) =>
          db.db.deleteFrom("app.chat_threads").where("id", "=", id).execute()
        )
      ).rejects.toMatchObject({ code: "42501" });
    }
    await assertPresent(f);
  });
});
