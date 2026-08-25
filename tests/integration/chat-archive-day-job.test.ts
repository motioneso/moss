import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { ChatRepository, handleArchiveDayJob } from "@moss/chat";
import { PreferencesRepository } from "@moss/structured-state";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const CHAT_ARCHIVE_ENABLED_PREF_KEY = "chat-archive.enabled";

describe("chat archive-day job (real DB, worker function called directly)", () => {
  const prefs = new PreferencesRepository();
  const chatRepo = new ChatRepository();
  let db: Kysely<MossDatabase>;
  let bootstrapDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let notesRoot: string;

  function userAContext(): AccessContext {
    return { actorUserId: ids.userA, requestId: `request:${randomUUID()}` };
  }

  // Each turn is recorded in its own committed transaction, then backdated by a
  // separate query on the bootstrap superuser connection (the only role that can
  // bypass chat_messages's FORCE ROW LEVEL SECURITY — the table owner alone
  // cannot, even with row_security off). The chat_messages_prevent_identity_change
  // trigger still rejects any change to created_at regardless of role, so the
  // backdate also disables that trigger, makes both updates, and re-enables it,
  // all inside one transaction (rollback on any failure restores it; the whole
  // database is reset before every test anyway, so the brief window is not
  // shared with anything else).
  async function createTurnOnDay(input: {
    readonly title: string;
    readonly user: string;
    readonly userAt: string;
    readonly assistantAt: string;
  }) {
    const recorded = await runner.withDataContext(userAContext(), async (scopedDb) => {
      const thread = await chatRepo.openNewThread(scopedDb, { title: input.title });
      const result = await chatRepo.recordCompletedTurn(scopedDb, thread.id, input.user, "Noted.", {
        provider: "anthropic",
        model: "claude-economy"
      });
      if (!result) throw new Error("turn not recorded");
      return { threadId: thread.id, ...result };
    });

    await bootstrapDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL row_security = off`.execute(trx);
      await sql`ALTER TABLE app.chat_messages DISABLE TRIGGER chat_messages_prevent_identity_change`.execute(
        trx
      );
      await sql`UPDATE app.chat_messages SET created_at = ${new Date(input.userAt)} WHERE id = ${recorded.userMessage.id}::uuid`.execute(
        trx
      );
      await sql`UPDATE app.chat_messages SET created_at = ${new Date(input.assistantAt)} WHERE id = ${recorded.assistantMessage.id}::uuid`.execute(
        trx
      );
      await sql`ALTER TABLE app.chat_messages ENABLE TRIGGER chat_messages_prevent_identity_change`.execute(
        trx
      );
    });

    return recorded;
  }

  async function setArchivePrefs(enabled: boolean, timezone?: string): Promise<void> {
    await runner.withDataContext(userAContext(), async (scopedDb) => {
      await prefs.upsert(scopedDb, CHAT_ARCHIVE_ENABLED_PREF_KEY, enabled);
      if (timezone) {
        await prefs.upsert(scopedDb, "locale", { timezone });
      }
    });
  }

  async function runArchiveDayJob(localDate: string): Promise<void> {
    await runner.withDataContext(userAContext(), (scopedDb) =>
      handleArchiveDayJob(scopedDb, ids.userA, localDate, {
        preferencesPort: prefs,
        chatRepo,
        boss: { send: async () => "job-id" } as never
      })
    );
  }

  async function readArchiveFile(relativePath: string): Promise<string | null> {
    try {
      return await readFile(join(notesRoot, relativePath), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  beforeEach(async () => {
    await resetFoundationDatabase();
    db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    bootstrapDb = createDatabase({
      connectionString: connectionStrings.bootstrap,
      maxConnections: 1
    });
    runner = new DataContextRunner(db);
    notesRoot = await mkdtemp(join(tmpdir(), `jarv1s-chat-archive-${randomUUID()}-`));
    process.env["JARVIS_NOTES_ROOTS"] = notesRoot;
    await runner.withDataContext(userAContext(), (scopedDb) =>
      prefs.upsert(scopedDb, NOTES_SOURCE_PREFERENCE_KEY, notesRoot)
    );
  });

  afterEach(async () => {
    delete process.env["JARVIS_NOTES_ROOTS"];
    await db.destroy();
    await bootstrapDb.destroy();
    await rm(notesRoot, { recursive: true, force: true });
  });

  it("groups two same-day threads into separate sessions in thread-start order", async () => {
    await setArchivePrefs(true, "UTC");

    await createTurnOnDay({
      title: "First",
      user: "First thread message",
      userAt: "2026-08-24T09:00:00.000Z",
      assistantAt: "2026-08-24T09:00:05.000Z"
    });
    await createTurnOnDay({
      title: "Second",
      user: "Second thread message",
      userAt: "2026-08-24T10:00:00.000Z",
      assistantAt: "2026-08-24T10:00:05.000Z"
    });

    await runArchiveDayJob("2026-08-24");

    const content = await readArchiveFile("Moss/Chats/2026-08-24.md");
    expect(content).not.toBeNull();
    expect(content).toContain("<!-- moss-chat-archive:v1 -->");
    expect(content).toContain("First thread message");
    expect(content).toContain("Second thread message");
    expect(content!.indexOf("First thread message")).toBeLessThan(
      content!.indexOf("Second thread message")
    );
  });

  it("never stores (and so never archives) an incognito thread's messages", async () => {
    await setArchivePrefs(true, "UTC");

    await createTurnOnDay({
      title: "Visible",
      user: "Visible message",
      userAt: "2026-08-24T09:00:00.000Z",
      assistantAt: "2026-08-24T09:00:05.000Z"
    });

    // recordCompletedTurn is a structural no-op for an incognito thread: it returns
    // undefined and inserts nothing. That's the actual privacy guarantee under test —
    // there is no "secret" row for the archive job to filter out, because it never
    // reaches the database at all, and the incognito flag can't be flipped after the
    // fact (the database rejects that as an immutable-column change).
    const secretResult = await runner.withDataContext(userAContext(), async (scopedDb) => {
      const secretThread = await chatRepo.openNewThread(scopedDb, {
        title: "Secret",
        incognito: true
      });
      return chatRepo.recordCompletedTurn(
        scopedDb,
        secretThread.id,
        "Secret incognito message",
        "Noted.",
        { provider: "anthropic", model: "claude-economy" }
      );
    });
    expect(secretResult).toBeUndefined();

    await runArchiveDayJob("2026-08-24");

    const content = await readArchiveFile("Moss/Chats/2026-08-24.md");
    expect(content).not.toBeNull();
    expect(content).toContain("Visible message");
    expect(content).not.toContain("Secret incognito message");
  });

  it("excludes messages outside the local day window at a real timezone boundary", async () => {
    await setArchivePrefs(true, "America/Los_Angeles");

    // Local midnight 2026-08-24 in America/Los_Angeles (PDT, UTC-7) is 2026-08-24T07:00:00Z.
    await createTurnOnDay({
      title: "In window",
      user: "Message inside the local day",
      userAt: "2026-08-24T08:00:00.000Z",
      assistantAt: "2026-08-24T08:00:05.000Z"
    });

    // 2026-08-24T06:00:00Z is 2026-08-23T23:00:00 PDT — the previous local day.
    await createTurnOnDay({
      title: "Out of window",
      user: "Message from the previous local day",
      userAt: "2026-08-24T06:00:00.000Z",
      assistantAt: "2026-08-24T06:00:05.000Z"
    });

    await runArchiveDayJob("2026-08-24");

    const content = await readArchiveFile("Moss/Chats/2026-08-24.md");
    expect(content).not.toBeNull();
    expect(content).toContain("Message inside the local day");
    expect(content).not.toContain("Message from the previous local day");
  });

  it("no-ops without writing a file when archiving is disabled", async () => {
    await setArchivePrefs(false);

    await createTurnOnDay({
      title: "Off",
      user: "Should not be archived",
      userAt: "2026-08-24T09:00:00.000Z",
      assistantAt: "2026-08-24T09:00:05.000Z"
    });

    await runArchiveDayJob("2026-08-24");

    const content = await readArchiveFile("Moss/Chats/2026-08-24.md");
    expect(content).toBeNull();
  });
});
