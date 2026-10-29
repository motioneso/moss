import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { CommitmentsRepository } from "@moss/commitments";
import { TasksRepository } from "@moss/tasks";
import type { HeartbeatSourceRead } from "@moss/shared";

import { calendarHeartbeatWindowExecute } from "../../packages/calendar/src/heartbeat.js";
import { commitmentsHeartbeatOpenExecute } from "../../packages/commitments/src/heartbeat.js";
import { tasksHeartbeatWindowExecute } from "../../packages/tasks/src/heartbeat.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { seedCalendarApprovalEvent } from "./fixtures/calendar-approval.js";

let appDb: Kysely<MossDatabase>;
let runner: DataContextRunner;
const tasksRepo = new TasksRepository();
const commitments = new CommitmentsRepository();

function as(actorUserId: string) {
  return { actorUserId, requestId: `req:${randomUUID()}` };
}
const ctx = (actorUserId: string) => ({ actorUserId, requestId: "r", chatSessionId: "" });

async function read(
  execute: typeof tasksHeartbeatWindowExecute,
  actorUserId: string,
  input: Record<string, unknown> = {}
): Promise<HeartbeatSourceRead> {
  const result = await runner.withDataContext(as(actorUserId), (db) =>
    execute(db, input, { ...ctx(actorUserId), localTimezone: "UTC" }, {} as never)
  );
  return (result as { data: HeartbeatSourceRead }).data;
}

beforeAll(async () => {
  process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("tasks heartbeat read", () => {
  it("holds a stable revision, changes it on a material edit, and never shows another owner's task", async () => {
    const soon = new Date(Date.now() + 3 * 3_600_000);
    const mine = await runner.withDataContext(as(ids.userA), (db) =>
      tasksRepo.create(db, { title: "Send the timecard", dueAt: soon })
    );
    await runner.withDataContext(as(ids.userB), (db) =>
      tasksRepo.create(db, { title: "Private B task", dueAt: soon })
    );
    const first = await read(tasksHeartbeatWindowExecute, ids.userA);
    const again = await read(tasksHeartbeatWindowExecute, ids.userA);
    expect(first.source).toBe("tasks");
    expect(first.items.map((i) => i.title)).toEqual(["Send the timecard"]);
    expect(first.revision).toBe(again.revision);
    expect(first.freshness).toBe("fresh");

    await runner.withDataContext(as(ids.userA), (db) =>
      tasksRepo.update(db, mine.id, { dueAt: new Date(soon.getTime() + 3_600_000) })
    );
    const moved = await read(tasksHeartbeatWindowExecute, ids.userA);
    expect(moved.revision).not.toBe(first.revision);
    expect(moved.items[0]?.episodeKey).not.toBe(first.items[0]?.episodeKey);
    expect(moved.items[0]?.entityKey).toBe(first.items[0]?.entityKey);
  });

  it("caps at twenty items and marks the cut", async () => {
    const soon = new Date(Date.now() + 2 * 3_600_000);
    await runner.withDataContext(as(ids.userA), async (db) => {
      for (let i = 0; i < 25; i += 1)
        await tasksRepo.create(db, { title: `Bulk ${i}`, dueAt: new Date(soon.getTime() + i) });
    });
    const capped = await read(tasksHeartbeatWindowExecute, ids.userA);
    expect(capped.items).toHaveLength(20);
    expect(capped.truncated).toBe(true);
    const small = await read(tasksHeartbeatWindowExecute, ids.userA, { limit: 3 });
    expect(small.items).toHaveLength(3);
  });
});

describe("commitments heartbeat read", () => {
  it("returns only the owner's accepted, dated, unresolved commitments", async () => {
    const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const make = async (owner: string, title: string, accept: boolean, due: string | null) =>
      runner.withDataContext(as(owner), async (db) => {
        const c = await commitments.upsertCandidate(db, {
          ownerUserId: owner,
          candidateSignature: `sig-${randomUUID()}`,
          kind: "deadline",
          title,
          dueLocalDate: due,
          confidence: "high",
          counterpartyLabel: null,
          suggestedHandling: null,
          occurredAt: new Date().toISOString()
        });
        if (accept) await commitments.updateStatus(db, owner, c.id, "accepted");
        return c;
      });
    await make(ids.userA, "Send the timecard to Pat", true, day);
    await make(ids.userA, "Not accepted yet", false, day);
    await make(ids.userA, "No due date", true, null);
    await make(ids.userB, "B's private commitment", true, day);

    const first = await read(commitmentsHeartbeatOpenExecute, ids.userA);
    expect(first.source).toBe("memory");
    expect(first.items.map((i) => i.title)).toEqual(["Send the timecard to Pat"]);
    expect(first.items[0]?.kind).toBe("commitment_due");
    expect((await read(commitmentsHeartbeatOpenExecute, ids.userA)).revision).toBe(first.revision);

    await make(ids.userA, "Second dated item", true, day);
    expect((await read(commitmentsHeartbeatOpenExecute, ids.userA)).revision).not.toBe(
      first.revision
    );
  });
});

describe("calendar heartbeat read", () => {
  it("reads only the owner's cached events and keeps the revision steady across a re-sync", async () => {
    const calendar = await import("@moss/calendar");
    const repo = new calendar.CalendarRepository();
    const start = new Date(Date.now() + 2 * 3_600_000);
    const seeded = await seedCalendarApprovalEvent(runner, ids.userA, `evt-${randomUUID()}`);
    await runner.withDataContext(as(ids.userA), (db) =>
      repo.upsertCachedEvent(db, {
        connectorAccountId: seeded.connector_account_id,
        externalId: seeded.external_id,
        title: "Dentist",
        startsAt: start,
        endsAt: new Date(start.getTime() + 3_600_000)
      })
    );
    await seedCalendarApprovalEvent(runner, ids.userB, `evt-${randomUUID()}`);

    const first = await read(calendarHeartbeatWindowExecute, ids.userA);
    expect(first.items.map((i) => i.title)).toEqual(["Dentist"]);
    expect(first.freshness).toBe("fresh");

    // A re-sync with identical content moves updated_at but must not move the revision.
    await runner.withDataContext(as(ids.userA), (db) =>
      repo.upsertCachedEvent(db, {
        connectorAccountId: seeded.connector_account_id,
        externalId: seeded.external_id,
        title: "Dentist",
        startsAt: start,
        endsAt: new Date(start.getTime() + 3_600_000)
      })
    );
    expect((await read(calendarHeartbeatWindowExecute, ids.userA)).revision).toBe(first.revision);

    await runner.withDataContext(as(ids.userA), (db) =>
      repo.upsertCachedEvent(db, {
        connectorAccountId: seeded.connector_account_id,
        externalId: seeded.external_id,
        title: "Dentist (moved)",
        startsAt: new Date(start.getTime() + 1_800_000),
        endsAt: new Date(start.getTime() + 5_400_000)
      })
    );
    const moved = await read(calendarHeartbeatWindowExecute, ids.userA);
    expect(moved.revision).not.toBe(first.revision);
    expect(moved.items[0]?.episodeKey).not.toBe(first.items[0]?.episodeKey);
  });
});
