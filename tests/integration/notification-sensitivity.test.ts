import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { createNotificationPreferencePort } from "@moss/module-registry";
import { NotificationsRepository, type PushQueuePort } from "@moss/notifications";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("notification sensitivity", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let boss: ReturnType<typeof createPgBossClient>;
  let server: Awaited<ReturnType<typeof createApiServer>>;
  const delivered: string[] = [];
  const summaries: Date[] = [];

  const pushQueue: PushQueuePort = {
    enqueueDeliver: async (_db, notificationId) => {
      delivered.push(notificationId);
    },
    enqueueSummary: async (_db, _userId, releaseAt) => {
      summaries.push(releaseAt);
    }
  };

  // A window with equal start and end covers the whole day, so every non-urgent item is deferred.
  const alwaysQuiet = {
    getSettings: async () => ({ enabled: true, start: "00:00", end: "00:00", timezone: "UTC" }),
    getLocaleTimezone: async () => "UTC"
  };

  async function summariesFor(urgency: "normal" | "low") {
    const repository = new NotificationsRepository(
      alwaysQuiet,
      createNotificationPreferencePort(),
      pushQueue
    );
    summaries.length = 0;
    delivered.length = 0;
    const row = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: `request:sensitivity-quiet-hours-${urgency}` },
      (scopedDb) =>
        repository.create(scopedDb, {
          moduleId: "briefings",
          title: `Deferred ${urgency}`,
          urgency
        })
    );
    expect(row).not.toBeNull();
    expect(delivered).toHaveLength(0);
    return summaries.length;
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = await createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server.close(), appDb.destroy(), boss.stop({ graceful: false })]);
  });

  const headers = { authorization: `Bearer ${ids.sessionA}` };

  async function putSensitivity(sensitivity: string) {
    return server.inject({
      method: "PUT",
      url: "/api/me/notification-sensitivity",
      headers,
      payload: { sensitivity }
    });
  }

  async function pushedFor(urgency: "urgent" | "normal" | "low") {
    const repository = new NotificationsRepository(
      undefined,
      createNotificationPreferencePort(),
      pushQueue
    );
    delivered.length = 0;
    const row = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: `request:sensitivity-${urgency}` },
      (scopedDb) =>
        repository.create(scopedDb, {
          moduleId: "briefings",
          title: `Sensitivity ${urgency}`,
          urgency
        })
    );
    return { row, pushed: delivered.length === 1 && delivered[0] === row?.id };
  }

  it("defaults to balanced", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/notification-sensitivity",
      headers
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sensitivity: "balanced" });
  });

  it("rejects an unknown level", async () => {
    expect((await putSensitivity("loud")).statusCode).toBe(400);
  });

  it("saves the choice and returns it on the next read", async () => {
    const put = await putSensitivity("quiet");
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ sensitivity: "quiet" });
    const res = await server.inject({
      method: "GET",
      url: "/api/me/notification-sensitivity",
      headers
    });
    expect(res.json()).toEqual({ sensitivity: "quiet" });
  });

  it("quiet pushes only urgent notifications but still stores all of them", async () => {
    await putSensitivity("quiet");
    const normal = await pushedFor("normal");
    expect(normal.row).not.toBeNull();
    expect(normal.pushed).toBe(false);
    expect((await pushedFor("urgent")).pushed).toBe(true);
  });

  it("balanced skips low, proactive pushes low", async () => {
    await putSensitivity("balanced");
    expect((await pushedFor("normal")).pushed).toBe(true);
    expect((await pushedFor("low")).pushed).toBe(false);
    await putSensitivity("proactive");
    expect((await pushedFor("low")).pushed).toBe(true);
  });

  it("end-of-quiet-hours summary follows the level", async () => {
    await putSensitivity("quiet");
    expect(await summariesFor("normal")).toBe(0);
    await putSensitivity("balanced");
    expect(await summariesFor("normal")).toBe(1);
    expect(await summariesFor("low")).toBe(0);
    await putSensitivity("proactive");
    expect(await summariesFor("low")).toBe(1);
  });
});
