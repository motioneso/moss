import {
  outlookBindingFingerprint,
  outlookBindingKey
} from "../../packages/connectors/src/outlook-calendar-config.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import { CalendarRepository, importCalendarMirror, type CalendarMirrorBatch } from "@moss/calendar";
import {
  ConnectorsRepository,
  createConnectorSecretCipher,
  featureGrantsPrefKey
} from "@moss/connectors";
import { PreferencesRepository } from "@moss/structured-state";
import { registerOutlookCalendarRoutes } from "../../packages/connectors/src/outlook-calendar-routes.js";
import {
  runOutlookCalendarSync,
  outlookHealthKey,
  readOutlookHealth
} from "../../packages/connectors/src/outlook-calendar-jobs.js";
import type { OutlookCalendarScan } from "../../packages/connectors/src/outlook-calendar-browser.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const batch: CalendarMirrorBatch = {
  calendarKey: "primary",
  timeZone: "America/Los_Angeles",
  observedAt: "2026-10-21T18:00:00.000Z",
  windowStart: "2026-10-21",
  windowEnd: "2026-10-22",
  complete: true,
  events: [
    {
      occurrenceKey: "invented-one",
      title: "Invented appointment",
      startsAt: "2026-10-22T05:30:00.000Z",
      endsAt: "2026-10-22T06:00:00.000Z",
      allDay: false,
      timeZone: "America/Los_Angeles"
    }
  ]
};

describe("Outlook calendar owner boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let app: DataContextRunner;
  let worker: DataContextRunner;
  let accountId: string;
  const repo = new CalendarRepository();
  const connectors = new ConnectorsRepository();
  const prefs = new PreferencesRepository();
  const original = { ...process.env };

  beforeAll(async () => {
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "invented-connector-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    app = new DataContextRunner(appDb);
    worker = new DataContextRunner(workerDb);
    accountId = (
      await app.withDataContext({ actorUserId: ids.userA }, (db) =>
        connectors.createAccount(db, {
          providerId: "outlook-browser-calendar",
          scopes: ["calendar.readonly"],
          encryptedSecret: createConnectorSecretCipher().encryptJson({ kind: "browser-binding" })
        })
      )
    ).id;
    await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      prefs.upsert(
        db,
        outlookBindingKey(accountId),
        outlookBindingFingerprint({
          ownerUserId: ids.userA,
          endpoint: "http://127.0.0.1:5188",
          accountAddress: "invented@example.invalid"
        })
      )
    );
  });
  afterAll(async () => {
    process.env = original;
    await appDb.destroy();
    await workerDb.destroy();
  });

  it("imports as the owner worker, updates once, and reconciles source-zone window edges", async () => {
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      importCalendarMirror(db, accountId, batch)
    );
    const rows = await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      repo.listVisible(db)
    );
    expect(rows.filter((r) => r.connector_account_id === accountId)).toHaveLength(1);
    const missing = { ...batch, events: [], observedAt: "2026-10-21T18:05:00.000Z" };
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      importCalendarMirror(db, accountId, missing)
    );
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      importCalendarMirror(db, accountId, missing)
    );
    const once = await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      repo.getById(db, rows.find((r) => r.connector_account_id === accountId)!.id)
    );
    expect(once?.external_metadata.mirrorMissingCount).toBe(1);
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      importCalendarMirror(db, accountId, { ...missing, observedAt: "2026-10-21T18:10:00.000Z" })
    );
    const twice = await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      repo.getById(db, rows.find((r) => r.connector_account_id === accountId)!.id)
    );
    expect(twice?.external_metadata.mirrorUnconfirmed).toBe(true);
  });

  it("rejects cross-owner insertion and hides both the account and cached events", async () => {
    await expect(
      worker.withDataContext({ actorUserId: ids.userB }, (db) =>
        importCalendarMirror(db, accountId, {
          ...batch,
          events: batch.events.map((e) => ({ ...e, occurrenceKey: "other-owner" }))
        })
      )
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      await worker.withDataContext({ actorUserId: ids.userB }, (db) =>
        repo.listMirrorWindow(db, accountId, batch.windowStart, batch.windowEnd, batch.timeZone)
      )
    ).toEqual([]);
    expect(
      (
        await app.withDataContext({ actorUserId: ids.userB }, (db) => connectors.listAccounts(db))
      ).some((a) => a.id === accountId)
    ).toBe(false);
  });

  it("does not collect after the owner disables the calendar feature grant", async () => {
    await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      prefs.upsert(db, featureGrantsPrefKey(accountId), { calendar: false, email: false })
    );
    const collect = vi.fn();
    await runOutlookCalendarSync(
      worker,
      {
        ownerUserId: ids.userA,
        endpoint: "http://127.0.0.1:5188",
        accountAddress: "invented@example.invalid"
      },
      collect
    );
    expect(collect).not.toHaveBeenCalled();
    await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      prefs.upsert(db, featureGrantsPrefKey(accountId), { calendar: true, email: false })
    );
  });

  it("keeps the last complete checkpoint after collection fails", async () => {
    await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      prefs.upsert(db, outlookHealthKey(accountId), {
        state: "current",
        lastCompleteAt: batch.observedAt,
        windowStart: batch.windowStart,
        windowEnd: batch.windowEnd
      })
    );
    await runOutlookCalendarSync(
      worker,
      {
        ownerUserId: ids.userA,
        endpoint: "http://127.0.0.1:5188",
        accountAddress: "invented@example.invalid"
      },
      async () => {
        throw new Error("invented failure");
      }
    );
    const health = await app.withDataContext({ actorUserId: ids.userA }, async (db) =>
      readOutlookHealth(await prefs.get(db, outlookHealthKey(accountId)))
    );
    expect(health).toMatchObject({
      state: "partial",
      lastCompleteAt: batch.observedAt,
      windowStart: batch.windowStart,
      windowEnd: batch.windowEnd
    });
  });

  it("pauses repeated partial scans and retains the last complete checkpoint", async () => {
    await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      prefs.upsert(db, outlookHealthKey(accountId), {
        state: "current",
        lastCompleteAt: batch.observedAt,
        unconfirmed: 1
      })
    );
    const collect = vi.fn(
      async (): Promise<OutlookCalendarScan> => ({
        ...batch,
        calendarKey: "primary",
        complete: false,
        views: 1,
        events: []
      })
    );
    const binding = {
      ownerUserId: ids.userA,
      endpoint: "http://127.0.0.1:5188",
      accountAddress: "invented@example.invalid"
    };
    for (let n = 0; n < 4; n++) await runOutlookCalendarSync(worker, binding, collect);
    expect(collect).toHaveBeenCalledTimes(3);
    const health = await app.withDataContext({ actorUserId: ids.userA }, async (db) =>
      readOutlookHealth(await prefs.get(db, outlookHealthKey(accountId)))
    );
    expect(health).toMatchObject({
      state: "partial",
      failures: 3,
      lastCompleteAt: batch.observedAt,
      unconfirmed: 1
    });
  });

  it("refuses collection when the operator changes the pinned source account", async () => {
    await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      prefs.upsert(db, outlookHealthKey(accountId), { state: "current", failures: 0 })
    );
    const collect = vi.fn(
      async (): Promise<OutlookCalendarScan> => ({ ...batch, calendarKey: "primary", views: 1 })
    );
    await runOutlookCalendarSync(
      worker,
      {
        ownerUserId: ids.userA,
        endpoint: "http://127.0.0.1:5188",
        accountAddress: "changed@example.invalid"
      },
      collect
    );
    expect(collect).not.toHaveBeenCalled();
    const health = await app.withDataContext({ actorUserId: ids.userA }, async (db) =>
      readOutlookHealth(await prefs.get(db, outlookHealthKey(accountId)))
    );
    expect(health.state).toBe("source-changed");
  });

  it("refuses a nonbound owner even when a dedicated browser is configured", async () => {
    process.env.MOSS_OUTLOOK_BROWSER_ENDPOINT = "http://127.0.0.1:5188";
    process.env.MOSS_OUTLOOK_BROWSER_OWNER = ids.userA;
    process.env.MOSS_OUTLOOK_BROWSER_ACCOUNT = "invented@example.invalid";
    const server = Fastify();
    registerOutlookCalendarRoutes(server, {
      dataContext: app,
      boss: {} as PgBoss,
      resolveAccessContext: async () => ({ actorUserId: ids.userB })
    });
    try {
      const result = await server.inject({
        method: "POST",
        url: "/api/connectors/outlook-calendar/connect",
        payload: {}
      });
      expect(result.statusCode).toBe(403);
      expect(result.body).not.toContain("invented@example.invalid");
      expect(result.body).not.toContain("5188");
    } finally {
      await server.close();
    }
  });
});
