import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { RecordingVoiceEnablementRepository, listVoiceEnabledUserIds } from "@moss/meetings";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let db: Kysely<MossDatabase>, context: DataContextRunner;
const repo = new RecordingVoiceEnablementRepository();
const snapshot = () => ({
  version: 2,
  sourceDeviceId: randomUUID(),
  requestKey: randomUUID(),
  recordingIds: []
});

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  context = new DataContextRunner(db);
});
afterAll(async () => {
  await db.destroy();
});

describe("listVoiceEnabledUserIds", () => {
  it("lists only users whose hold-to-talk is on, across owners", async () => {
    const enabled = await context.withDataContext({ actorUserId: ids.userA }, (scoped) =>
      repo.enable(scoped, snapshot())
    );
    await context.withDataContext({ actorUserId: ids.userB }, async (scoped) => {
      const row = await repo.enable(scoped, snapshot());
      await repo.disable(scoped, row.id);
    });

    expect([...(await listVoiceEnabledUserIds(db))]).toEqual([ids.userA]);

    await context.withDataContext({ actorUserId: ids.userA }, (scoped) =>
      repo.disable(scoped, enabled.id)
    );
    expect((await listVoiceEnabledUserIds(db)).size).toBe(0);
  });
});
