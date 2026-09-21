import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  buildFocusJudgmentService,
  FocusJudgmentRepository,
  type FocusPorts
} from "@moss/focus-judgment";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2570).
//
// app.focus_judgments is owner-only. What the person was looking at must never be stored, so the
// table has no column for it; these tests are the boundary, not a description of it.

const { Client } = pg;

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let bootstrap: pg.Client;
let worker: pg.Client;
const repository = new FocusJudgmentRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  worker = new Client({ connectionString: connectionStrings.worker });
  await worker.connect();
});

afterAll(async () => {
  await appDb.destroy();
  await bootstrap.end();
  await worker.end();
});

function asUser<T>(
  userId: string,
  work: (scopedDb: Parameters<typeof repository.insert>[0]) => Promise<T>
) {
  return dataContext.withDataContext({ actorUserId: userId, requestId: "focus-test" }, work);
}

async function insertFor(userId: string, overrides: { nudged?: boolean; deviceId?: string } = {}) {
  const id = randomUUID();
  await asUser(userId, (scopedDb) =>
    repository.insert(scopedDb, {
      id,
      ownerUserId: userId,
      deviceId: overrides.deviceId ?? randomUUID(),
      blockRef: "block-1",
      label: "distracted",
      reason: "Sports site, unrelated to studying.",
      nudged: overrides.nudged ?? false
    })
  );
  return id;
}

describe("row-level security (owner-only)", () => {
  it("person B cannot read or correct person A's judgment (fails without the policy)", async () => {
    const id = await insertFor(ids.userA);

    const seenByB = await asUser(ids.userB, (scopedDb) =>
      repository.listRecentForBlock(scopedDb, "block-1", 50)
    );
    expect(seenByB).toEqual([]);

    const bChanged = await asUser(ids.userB, (scopedDb) =>
      repository.setCorrection(scopedDb, id, "wrong")
    );
    expect(bChanged).toBe(false);

    const aChanged = await asUser(ids.userA, (scopedDb) =>
      repository.setCorrection(scopedDb, id, "right")
    );
    expect(aChanged).toBe(true);
  });

  it("refuses to write a row owned by someone else (the policy's check clause)", async () => {
    await expect(
      asUser(ids.userA, (scopedDb) =>
        repository.insert(scopedDb, {
          id: randomUUID(),
          ownerUserId: ids.userB,
          deviceId: null,
          blockRef: "block-1",
          label: "focused",
          reason: "",
          nudged: false
        })
      )
    ).rejects.toThrow();
  });

  it("the background worker role has no access to the table", async () => {
    await expect(worker.query("SELECT count(*) FROM app.focus_judgments")).rejects.toThrow(
      /permission denied/i
    );
  });

  it("the last nudge is the person's newest, from any Mac", async () => {
    await insertFor(ids.userA, { nudged: true, deviceId: randomUUID() });
    const second = await insertFor(ids.userA, { nudged: true, deviceId: randomUUID() });
    expect(second).toBeTruthy();

    const last = await asUser(ids.userA, (scopedDb) => repository.lastNudgeAt(scopedDb));
    const otherPerson = await asUser(ids.userB, (scopedDb) => repository.lastNudgeAt(scopedDb));
    expect(last).toBeInstanceOf(Date);
    expect(otherPerson).toBeNull();
  });
});

describe("what the person was looking at is never stored", () => {
  it("the table has no column for a window title, app name, description or block title", async () => {
    const result = await bootstrap.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'focus_judgments'
        ORDER BY column_name`
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      "block_ref",
      "correction",
      "created_at",
      "device_id",
      "id",
      "label",
      "nudged",
      "owner_user_id",
      "reason"
    ]);
  });

  it("a judgment made with a unique window title leaves it in no column of any row", async () => {
    const marker = "focus-marker-window-3e91c2";
    const logged: string[] = [];
    const ports: FocusPorts = {
      currentBlock: async () => ({
        id: "block-marker",
        title: "Study AI",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000)
      }),
      inQuietHours: async () => false,
      hasJudgeModel: async () => true,
      generate: async () => ({
        ok: true,
        object: { label: "distracted", reason: "Sports site, unrelated to studying." }
      }),
      logger: {
        info: (fields) => logged.push(JSON.stringify(fields)),
        warn: (fields) => logged.push(JSON.stringify(fields))
      }
    };
    const service = buildFocusJudgmentService(ports);

    await asUser(ids.userA, (scopedDb) =>
      service.judge(
        scopedDb,
        {
          ownerUserId: ids.userA,
          deviceId: randomUUID(),
          blockId: "block-marker",
          appName: "Safari",
          windowTitle: marker,
          observedAt: new Date()
        },
        new Date(),
        new AbortController().signal
      )
    );

    const rows = await bootstrap.query("SELECT * FROM app.focus_judgments");
    expect(JSON.stringify(rows.rows)).not.toContain(marker);
    expect(logged.join("\n")).not.toContain(marker);
  });
});
