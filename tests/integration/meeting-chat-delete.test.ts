import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
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
      // DELETE now has a table grant; owner-only surface RLS must still affect zero rows.
      expect(
        await db.db
          .deleteFrom("app.chat_threads")
          .where("id", "=", thread.id)
          .returning("id")
          .execute()
      ).toEqual([]);
      expect(
        await chats.getThreadById(db, thread.id, normalizeChatSurface(rawSurface))
      ).toBeDefined();
    });
  });
  it("keeps direct deletion of incognito meeting surfaces unavailable", async () => {
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      const thread = await chats.openNewThread(db, {
        title: "Private bookkeeping",
        surface: meetingChatSurface(randomUUID()),
        incognito: true
      });
      expect(
        await db.db
          .deleteFrom("app.chat_threads")
          .where("id", "=", thread.id)
          .returning("id")
          .execute()
      ).toEqual([]);
      await sql`SELECT app.delete_incognito_chat_thread_for_cleanup(${thread.id}::uuid)`.execute(
        db.db
      );
    });
  });
  it("observes ordinary-thread protection fail without the surface restriction and rolls back the probe", async () => {
    assertIsolatedTestDatabase(connectionStrings.bootstrap);
    const name = new URL(connectionStrings.bootstrap).pathname.slice(1);
    if (!/^(jarvis_gate_|jarvis_test_)/.test(name))
      throw new Error("Probe requires a disposable gate/test database");
    expect(
      (await sql<{ name: string }>`SELECT current_database() AS name`.execute(bootstrap)).rows[0]
        ?.name
    ).toBe(name);
    const f = await fixture();
    const check = (db: DataContextDb) =>
      db.db
        .deleteFrom("app.chat_threads")
        .where("id", "=", f.unrelatedId)
        .returning("id")
        .execute();
    expect(await context.withDataContext({ actorUserId: owner }, check)).toEqual([]);
    class ScopeProtectionRemoved extends Error {}
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER POLICY chat_threads_meeting_delete ON app.chat_threads USING (owner_user_id = app.current_actor_user_id())`.execute(
          transaction
        );
        await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
        await sql`SELECT set_config('app.actor_user_id', ${owner}, true)`.execute(transaction);
        const deleted = await transaction
          .deleteFrom("app.chat_threads")
          .where("id", "=", f.unrelatedId)
          .returning("id")
          .execute();
        if (deleted.length !== 1)
          throw new Error("Protection-removal probe did not reach its assertion");
        throw new ScopeProtectionRemoved(
          "Ordinary chat became deletable with its restriction removed"
        );
      })
    ).rejects.toBeInstanceOf(ScopeProtectionRemoved);
    expect(await context.withDataContext({ actorUserId: owner }, check)).toEqual([]);
    expect(
      await bootstrap
        .selectFrom("app.chat_threads")
        .select("id")
        .where("id", "=", f.unrelatedId)
        .execute()
    ).toHaveLength(1);
  });
});
