import { type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { WellnessRepository } from "@moss/wellness";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000061";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let repo: WellnessRepository;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-export-range@example.test', false)`,
      [userId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  repo = new WellnessRepository();

  // Seed a med (definitions are timeless; logs anchor to it).
  const med = await dataContext.withDataContext(
    { actorUserId: userId, requestId: "req:range-seed" },
    (scopedDb) =>
      repo.createMedication(
        scopedDb,
        {
          name: "Testosterone",
          frequencyType: "as_needed"
        },
        "UTC"
      )
  );

  // Window under test: [2026-02-01, 2026-02-28].
  const inWindowEarly = new Date("2026-02-05T10:00:00Z");
  const inWindowLate = new Date("2026-02-25T10:00:00Z");
  const beforeWindow = new Date("2026-01-10T10:00:00Z");
  const afterWindow = new Date("2026-03-15T10:00:00Z");

  await dataContext.withDataContext(
    { actorUserId: userId, requestId: "req:range-seed" },
    async (scopedDb) => {
      // Check-ins: in, in, before, after
      for (const ts of [beforeWindow, inWindowEarly, inWindowLate, afterWindow]) {
        await scopedDb.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: userId,
            feeling_core: "happy",
            checked_in_at: ts
          })
          .execute();
      }

      // Therapy notes: in, before
      await scopedDb.db
        .insertInto("app.wellness_therapy_notes")
        .values({ owner_user_id: userId, body: "in-window note", created_at: inWindowEarly })
        .execute();
      await scopedDb.db
        .insertInto("app.wellness_therapy_notes")
        .values({ owner_user_id: userId, body: "out-window note", created_at: beforeWindow })
        .execute();

      // Med logs (PRN: scheduled_for IS NULL, anchored by logged_at): in, before
      await scopedDb.db
        .insertInto("app.medication_logs")
        .values({
          medication_id: med.id,
          owner_user_id: userId,
          status: "prn",
          logged_at: inWindowLate,
          prn_reason: "in-window"
        })
        .execute();
      await scopedDb.db
        .insertInto("app.medication_logs")
        .values({
          medication_id: med.id,
          owner_user_id: userId,
          status: "prn",
          logged_at: beforeWindow,
          prn_reason: "out-window"
        })
        .execute();
    }
  );
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("Wellness repository range-filtered reads (#484)", () => {
  const from = new Date("2026-02-01T00:00:00Z");
  const to = new Date("2026-02-28T23:59:59Z");

  it("listCheckinsForRange returns only in-window check-ins, ordered ascending", async () => {
    const checkins = await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:range-test" },
      (scopedDb) => repo.listCheckinsForRange(scopedDb, from, to)
    );
    expect(checkins).toHaveLength(2);
    const ts = checkins.map((c) => new Date(c.checked_in_at as string | Date).getTime());
    expect(ts[0] ?? 0).toBeLessThanOrEqual(ts[1] ?? 0);
    for (const t of ts) {
      expect(t).toBeGreaterThanOrEqual(from.getTime());
      expect(t).toBeLessThanOrEqual(to.getTime());
    }
  });

  it("listTherapyNotesForRange returns only in-window notes", async () => {
    const notes = await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:range-test" },
      (scopedDb) => repo.listTherapyNotesForRange(scopedDb, from, to)
    );
    expect(notes).toHaveLength(1);
    expect((notes[0] as { body: string }).body).toBe("in-window note");
  });

  it("listLogsForRange returns only in-window logs (PRN anchored by logged_at)", async () => {
    const logs = await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:range-test" },
      (scopedDb) => repo.listLogsForRange(scopedDb, from, to)
    );
    expect(logs).toHaveLength(1);
    expect((logs[0] as { prn_reason: string }).prn_reason).toBe("in-window");
  });
});
