import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { MeetingRecordsRepository, MeetingRecordConflictError } from "@moss/meetings";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let context: DataContextRunner;
const repo = new MeetingRecordsRepository();
const owner = ids.userA;
const input = () => ({ requestKey: randomUUID(), title: "Private meeting" });

beforeAll(async () => {
  // Only invoke this suite through the isolated verify-gate workflow.
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy()]);
});

describe("Meeting draft records", () => {
  it("replays concurrent creates and rejects key reuse with changed input", async () => {
    const request = input();
    const results = await Promise.all(
      [1, 2].map(() =>
        context.withDataContext({ actorUserId: owner }, (db) => repo.create(db, request))
      )
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]!.meeting).toEqual(results[1]!.meeting);
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        repo.create(db, { ...request, title: "Changed" })
      )
    ).rejects.toBeInstanceOf(MeetingRecordConflictError);
  });

  it.each([ids.userB, ids.adminUser])(
    "isolates records and receipts from actor %s",
    async (actor) => {
      const request = input();
      const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
        repo.create(db, request)
      );
      await context.withDataContext({ actorUserId: owner }, (db) =>
        repo.putNotes(db, {
          meetingId: meeting.id,
          requestKey: randomUUID(),
          expectedRevision: 0,
          personalNotes: "Private notes"
        })
      );
      const ownOther = await context.withDataContext({ actorUserId: actor }, (db) =>
        repo.create(db, request)
      );
      expect(ownOther.meeting.id).not.toBe(meeting.id);
      await context.withDataContext({ actorUserId: actor }, async (db) => {
        expect(await repo.get(db, meeting.id)).toBeNull();
        expect((await repo.list(db)).map((row) => row.id)).not.toContain(meeting.id);
        expect(
          await repo.putNotes(db, {
            meetingId: meeting.id,
            requestKey: randomUUID(),
            expectedRevision: 1,
            personalNotes: "Forged update"
          })
        ).toEqual({ status: "not-found" });
        expect(
          await db.db
            .selectFrom("app.meeting_records")
            .selectAll()
            .where("id", "=", meeting.id)
            .execute()
        ).toEqual([]);
        expect(
          await db.db
            .selectFrom("app.meeting_note_writes")
            .selectAll()
            .where("meeting_id", "=", meeting.id)
            .execute()
        ).toEqual([]);
        expect(
          (
            await db.db
              .updateTable("app.meeting_records")
              .set({ personal_notes: "Forged" })
              .where("id", "=", meeting.id)
              .executeTakeFirst()
          ).numUpdatedRows
        ).toBe(0n);
      });
      await expect(
        context.withDataContext({ actorUserId: actor }, (db) =>
          db.db
            .insertInto("app.meeting_records")
            .values({ owner_user_id: owner, request_key: randomUUID(), title: "Forged" })
            .execute()
        )
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        context.withDataContext({ actorUserId: actor }, (db) =>
          db.db
            .insertInto("app.meeting_note_writes")
            .values({
              meeting_id: meeting.id,
              owner_user_id: actor,
              request_key: randomUUID(),
              expected_revision: 0,
              personal_notes: "Forged",
              saved_at: new Date()
            })
            .execute()
        )
      ).rejects.toMatchObject({ code: "23503" });
    }
  );

  it("allows one concurrent revision writer and reports the winning notes on conflict", async () => {
    const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.create(db, input())
    );
    const results = await Promise.all(
      ["First", "Second"].map((personalNotes) =>
        context.withDataContext({ actorUserId: owner }, (db) =>
          repo.putNotes(db, {
            meetingId: meeting.id,
            requestKey: randomUUID(),
            expectedRevision: 0,
            personalNotes
          })
        )
      )
    );
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const winner = results.find((result) => result.status === "saved")!;
    const conflict = results.find((result) => result.status === "conflict")!;
    if (winner.status !== "saved" || conflict.status !== "conflict")
      throw new Error("Unexpected result");
    expect(conflict.meeting).toEqual(winner.meeting);
    expect(winner.meeting.notesRevision).toBe(1);
  });

  it("replays original note receipts after later edits without overwriting them", async () => {
    const create = input();
    const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.create(db, create)
    );
    const request = {
      meetingId: meeting.id,
      requestKey: randomUUID(),
      expectedRevision: 0,
      personalNotes: "Original"
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        context.withDataContext({ actorUserId: owner }, (db) => repo.putNotes(db, request))
      )
    );
    const saved = results.find((result) => result.status === "saved" && !result.replayed)!;
    expect(results.filter((result) => result.status === "saved" && result.replayed)).toHaveLength(
      1
    );
    if (saved.status !== "saved") throw new Error("No saved notes");
    const changed = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.putNotes(db, {
        ...request,
        requestKey: randomUUID(),
        expectedRevision: 1,
        personalNotes: "Manual edit"
      })
    );
    expect(changed.status).toBe("saved");
    const replay = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.putNotes(db, request)
    );
    expect(replay).toEqual({ ...saved, replayed: true });
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        repo.putNotes(db, {
          ...request,
          personalNotes: "Changed collision"
        })
      )
    ).rejects.toBeInstanceOf(MeetingRecordConflictError);
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        repo.putNotes(db, {
          ...request,
          expectedRevision: 2
        })
      )
    ).rejects.toBeInstanceOf(MeetingRecordConflictError);
    const current = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.get(db, meeting.id)
    );
    expect(current?.personalNotes).toBe("Manual edit");
    expect(current?.notesRevision).toBe(2);
    const creationReplay = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.create(db, create)
    );
    expect(creationReplay.created).toBe(false);
    expect(creationReplay.meeting).toEqual(meeting);
    expect(creationReplay.meeting.personalNotes).toBe("");
    expect(creationReplay.meeting.notesRevision).toBe(0);
  });

  it("paginates equal timestamps without duplicates or omissions", async () => {
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      for (let i = 0; i < 4; i++) await repo.create(db, input());
      const all = await repo.list(db, { limit: 100 });
      const seen: string[] = [];
      let before: { id: string; createdAt: string } | undefined;
      for (let page = 0; page < 30; page++) {
        const rows = await repo.list(db, { limit: 2, before });
        if (!rows.length) break;
        seen.push(...rows.map((row) => row.id));
        before = rows.at(-1)!;
      }
      expect(seen).toEqual(all.map((row) => row.id));
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  it("bounds text bytes and revisions in both repository and database", async () => {
    const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.create(db, input())
    );
    for (const title of [" ", "é".repeat(121), "bad\0title"]) {
      await expect(
        context.withDataContext({ actorUserId: owner }, (db) =>
          repo.create(db, { ...input(), title })
        )
      ).rejects.toThrow("Invalid meeting");
    }
    for (const expectedRevision of [-1, 1.5, NaN, Infinity, 2147483647]) {
      await expect(
        context.withDataContext({ actorUserId: owner }, (db) =>
          repo.putNotes(db, {
            meetingId: meeting.id,
            requestKey: randomUUID(),
            personalNotes: "",
            expectedRevision
          })
        )
      ).rejects.toThrow("revision");
    }
    for (const personalNotes of ["é".repeat(32001), "bad\0notes"]) {
      await expect(
        context.withDataContext({ actorUserId: owner }, (db) =>
          repo.putNotes(db, {
            meetingId: meeting.id,
            requestKey: randomUUID(),
            personalNotes,
            expectedRevision: 0
          })
        )
      ).rejects.toThrow("Invalid meeting");
    }
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        db.db
          .updateTable("app.meeting_records")
          .set({ personal_notes: "é".repeat(32001) })
          .where("id", "=", meeting.id)
          .execute()
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) => repo.list(db, { limit: 101 }))
    ).rejects.toThrow("page size");
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        repo.list(db, { before: { id: randomUUID(), createdAt: "invalid" } })
      )
    ).rejects.toThrow("timestamp");
  });

  it("rolls back notes and receipts together when the enclosing transaction fails", async () => {
    const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.create(db, input())
    );
    const request = {
      meetingId: meeting.id,
      requestKey: randomUUID(),
      expectedRevision: 0,
      personalNotes: "Unsaved"
    };
    await expect(
      context.withDataContext({ actorUserId: owner }, async (db) => {
        await repo.putNotes(db, request);
        throw new Error("rollback probe");
      })
    ).rejects.toThrow("rollback probe");
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      expect((await repo.get(db, meeting.id))?.notesRevision).toBe(0);
      expect(
        await db.db
          .selectFrom("app.meeting_note_writes")
          .selectAll()
          .where("meeting_id", "=", meeting.id)
          .execute()
      ).toEqual([]);
      expect(await repo.putNotes(db, request)).toMatchObject({ status: "saved", replayed: false });
    });
  });

  it("deletes only the owner's draft and its receipts, with idempotent retries", async () => {
    const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.create(db, input())
    );
    await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.putNotes(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 0,
        personalNotes: "Disposable notes"
      })
    );
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      await context.withDataContext({ actorUserId }, (db) => repo.remove(db, meeting.id));
      expect(
        await context.withDataContext({ actorUserId: owner }, (db) => repo.get(db, meeting.id))
      ).not.toBeNull();
    }
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      await repo.remove(db, meeting.id);
      await repo.remove(db, meeting.id);
      expect(await repo.get(db, meeting.id)).toBeNull();
      expect(
        await db.db
          .selectFrom("app.meeting_note_writes")
          .selectAll()
          .where("meeting_id", "=", meeting.id)
          .execute()
      ).toEqual([]);
    });
  });

  it("cascades note receipts with the owning record", async () => {
    const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.create(db, input())
    );
    await context.withDataContext({ actorUserId: owner }, (db) =>
      repo.putNotes(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 0,
        personalNotes: "Temporary receipt"
      })
    );
    // Privileged fixture cleanup exercises the FK; no runtime delete API is provided here.
    await bootstrap.deleteFrom("app.meeting_records").where("id", "=", meeting.id).execute();
    expect(
      await bootstrap
        .selectFrom("app.meeting_note_writes")
        .selectAll()
        .where("meeting_id", "=", meeting.id)
        .execute()
    ).toEqual([]);
  });

  it("declares forced RLS on both tables with no runtime bypass", async () => {
    const flags = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('app.meeting_records'::regclass, 'app.meeting_note_writes'::regclass)
      ORDER BY relname`.execute(bootstrap);
    expect(flags.rows).toEqual([
      { relname: "meeting_note_writes", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "meeting_records", relrowsecurity: true, relforcerowsecurity: true }
    ]);
    const roles = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('jarvis_app_runtime','jarvis_worker_runtime')`.execute(
      bootstrap
    );
    expect(roles.rows).toHaveLength(2);
    expect(roles.rows.every((role) => !role.rolbypassrls && !role.rolsuper)).toBe(true);
  });
});
