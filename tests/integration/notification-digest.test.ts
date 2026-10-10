import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  NotificationsRepository,
  digestPreferenceToRaw,
  digestScheduleData,
  runNotificationDigestCompose
} from "@moss/notifications";
import type {
  GetNotificationDigestPreferenceResponse,
  PutNotificationDigestPreferenceResponse
} from "@moss/shared";
import { assertMetadataOnlyPayload } from "@moss/jobs";
import { PreferencesRepository } from "@moss/structured-state";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("notification digest settings", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let server: ReturnType<typeof createApiServer>;
  let schedules: unknown[][];
  let unschedules: unknown[][];
  let originalSecretKey: string | undefined;

  beforeEach(async () => {
    originalSecretKey = process.env.JARVIS_CONNECTOR_SECRET_KEY;
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    schedules = [];
    unschedules = [];
    server = createApiServer({
      appDb,
      logger: false,
      boss: {
        schedule: async (...args: unknown[]) => {
          schedules.push(args);
        },
        unschedule: async (...args: unknown[]) => {
          unschedules.push(args);
        },
        isInstalled: async () => true
      } as never
    });
    await server.ready();
  });

  it("skips empty digests and keeps the pg-boss payload metadata-only", async () => {
    await setDigestPreference({ enabled: true, lastDigestSentAt: null });
    const sent: string[] = [];

    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:empty" },
      (scopedDb) =>
        runNotificationDigestCompose(scopedDb, {
          baseUrl: "https://jarvis.example.test",
          notificationsRepository: new NotificationsRepository(),
          preferencesRepository: new PreferencesRepository(),
          sender: {
            sendDigest: async (_scopedDb, input) => {
              sent.push(input.text);
              return { ok: true };
            }
          }
        })
    );

    expect(() => assertMetadataOnlyPayload(digestScheduleData(ids.userA))).not.toThrow();
    expect(digestScheduleData(ids.userA)).toEqual({
      actorUserId: ids.userA,
      reason: "scheduled-digest",
      idempotencyKey: `digest:${ids.userA}`
    });
    expect(result).toEqual({ status: "skipped", reason: "empty" });
    expect(sent).toHaveLength(0);
  });

  it("sends only unread enabled-module notifications and advances the watermark once", async () => {
    await setDigestPreference({ enabled: true, lastDigestSentAt: null });
    const repository = new NotificationsRepository();
    const sent: string[] = [];

    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:seed" },
      async (scopedDb) => {
        await repository.create(scopedDb, { moduleId: "briefings", title: "Briefing ready" });
        const read = await repository.create(scopedDb, {
          moduleId: "settings",
          title: "Already read"
        });
        if (read) await repository.markRead(scopedDb, read.id);
        await repository.create(scopedDb, { moduleId: "settings", title: "Muted settings" });
      }
    );
    await putModule("settings", false);

    const first = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:first" },
      (scopedDb) =>
        runNotificationDigestCompose(scopedDb, {
          baseUrl: "https://jarvis.example.test",
          notificationsRepository: repository,
          preferencesRepository: new PreferencesRepository(),
          notificationPreferencePort: {
            isModuleEnabled: async (db, moduleId) =>
              moduleId !== "settings" &&
              (await new PreferencesRepository().get(db, `notifications:${moduleId}`)) !== false
          },
          sender: {
            sendDigest: async (_scopedDb, input) => {
              sent.push(input.text);
              return { ok: true };
            }
          }
        })
    );
    const second = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:second" },
      (scopedDb) =>
        runNotificationDigestCompose(scopedDb, {
          baseUrl: "https://jarvis.example.test",
          notificationsRepository: repository,
          preferencesRepository: new PreferencesRepository(),
          sender: { sendDigest: async () => ({ ok: true }) }
        })
    );

    expect(first).toEqual({ status: "sent", count: 1 });
    expect(sent.join("\n")).toContain("Briefing ready");
    expect(sent.join("\n")).not.toContain("Already read");
    expect(sent.join("\n")).not.toContain("Muted settings");
    expect(second).toEqual({ status: "skipped", reason: "empty" });
  });

  it("does not advance watermark on failed send and never renders secrets or raw payloads", async () => {
    await setDigestPreference({ enabled: true, lastDigestSentAt: null });
    const repository = new NotificationsRepository();
    const sent: string[] = [];
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:secret-seed" },
      (scopedDb) =>
        repository.create(scopedDb, {
          moduleId: "briefings",
          title: "Safe title",
          body: "Safe summary",
          metadata: {
            accessToken: "SECRET-ACCESS-TOKEN",
            refreshToken: "SECRET-REFRESH-TOKEN",
            password: "SECRET-PASSWORD",
            rawEmailBody: "RAW-PRIVATE-PAYLOAD"
          }
        })
    );

    const failed = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:failed" },
      (scopedDb) =>
        runNotificationDigestCompose(scopedDb, {
          baseUrl: "https://jarvis.example.test",
          notificationsRepository: repository,
          preferencesRepository: new PreferencesRepository(),
          sender: { sendDigest: async () => ({ ok: false }) }
        })
    );
    const retried = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:retried" },
      (scopedDb) =>
        runNotificationDigestCompose(scopedDb, {
          baseUrl: "https://jarvis.example.test",
          notificationsRepository: repository,
          preferencesRepository: new PreferencesRepository(),
          sender: {
            sendDigest: async (_scopedDb, input) => {
              sent.push(`${input.text}\n${input.html}`);
              return { ok: true };
            }
          }
        })
    );

    expect(failed).toEqual({ status: "failed" });
    expect(retried).toEqual({ status: "sent", count: 1 });
    expect(sent.join("\n")).toContain("Safe title");
    expect(sent.join("\n")).not.toContain("SECRET-ACCESS-TOKEN");
    expect(sent.join("\n")).not.toContain("SECRET-REFRESH-TOKEN");
    expect(sent.join("\n")).not.toContain("SECRET-PASSWORD");
    expect(sent.join("\n")).not.toContain("RAW-PRIVATE-PAYLOAD");
  });

  afterEach(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_CONNECTOR_SECRET_KEY;
    } else {
      process.env.JARVIS_CONNECTOR_SECRET_KEY = originalSecretKey;
    }
  });

  it("defaults disabled and unavailable without an active email connector", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/notification-digest-preference",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<GetNotificationDigestPreferenceResponse>()).toEqual({
      digest: {
        enabled: false,
        cadence: "daily",
        scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
        available: false,
        unavailableReason: "no_email_connector"
      }
    });
  });

  it("is available with an active Google connector", async () => {
    await seedGoogleAccount();

    const res = await server.inject({
      method: "GET",
      url: "/api/me/notification-digest-preference",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<GetNotificationDigestPreferenceResponse>().digest.available).toBe(true);
    expect(res.json<GetNotificationDigestPreferenceResponse>().digest.unavailableReason).toBeNull();
  });

  it("rejects enabling when no notification modules are enabled", async () => {
    await seedGoogleAccount();
    await putModule("briefings", false);
    await putModule("settings", false);

    const res = await server.inject({
      method: "PUT",
      url: "/api/me/notification-digest-preference",
      headers: {
        authorization: `Bearer ${ids.sessionA}`,
        "content-type": "application/json"
      },
      payload: {
        digest: {
          enabled: true,
          cadence: "daily",
          scheduleMetadata: { targetTime: "08:00", timezone: "UTC" }
        }
      }
    });

    expect(res.statusCode).toBe(422);
    expect(schedules).toHaveLength(0);
  });

  it("persists enabled digest settings and reconciles the schedule", async () => {
    await seedGoogleAccount();

    const res = await server.inject({
      method: "PUT",
      url: "/api/me/notification-digest-preference",
      headers: {
        authorization: `Bearer ${ids.sessionA}`,
        "content-type": "application/json"
      },
      payload: {
        digest: {
          enabled: true,
          cadence: "weekly",
          scheduleMetadata: { targetTime: "09:30", timezone: "America/New_York", dayOfWeek: 2 }
        }
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<PutNotificationDigestPreferenceResponse>().digest).toMatchObject({
      enabled: true,
      cadence: "weekly",
      scheduleMetadata: { targetTime: "09:30", timezone: "America/New_York", dayOfWeek: 2 },
      available: true,
      unavailableReason: null
    });
    expect(schedules).toEqual([
      [
        "notifications.digest.compose",
        "30 9 * * 2",
        {
          actorUserId: ids.userA,
          reason: "scheduled-digest",
          idempotencyKey: `digest:${ids.userA}`
        },
        { tz: "America/New_York", key: `digest:${ids.userA}` }
      ]
    ]);
  });

  it("carries unread notifications beyond the first 50 into the next digest", async () => {
    await setDigestPreference({ enabled: true, lastDigestSentAt: null });
    const repository = new NotificationsRepository();

    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "digest:seed-many" },
      async (scopedDb) => {
        for (let i = 0; i < 55; i += 1) {
          await repository.create(scopedDb, { moduleId: "briefings", title: `Item ${i}` });
        }
      }
    );

    const first = await runDigest(repository);
    const second = await runDigest(repository);
    const third = await runDigest(repository);

    expect(first).toEqual({ status: "sent", count: 50 });
    expect(second).toEqual({ status: "sent", count: 5 });
    expect(third).toEqual({ status: "skipped", reason: "empty" });
  });

  it("includes a notification that was still deferred when an earlier digest was sent", async () => {
    await setDigestPreference({ enabled: true, lastDigestSentAt: null });
    const repository = new NotificationsRepository();
    const ctx = { actorUserId: ids.userA, requestId: "digest:seed-deferred" };

    const [visible, deferred] = await dataContext.withDataContext(ctx, async (scopedDb) => [
      await repository.create(scopedDb, { moduleId: "briefings", title: "Visible now" }),
      await repository.create(scopedDb, { moduleId: "briefings", title: "Held back" })
    ]);
    expect(visible).not.toBeNull();
    const bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        "UPDATE app.notifications SET deferred_until = now() + interval '1500 milliseconds' WHERE id = $1",
        [deferred?.id]
      );
    } finally {
      await bootstrap.end();
    }

    const sent: string[] = [];
    const first = await runDigest(repository, sent);
    expect(first).toEqual({ status: "sent", count: 1 });

    await new Promise((resolve) => setTimeout(resolve, 1700));
    const second = await runDigest(repository, sent);

    expect(second).toEqual({ status: "sent", count: 1 });
    expect(sent[1]).toContain("Held back");
  });

  async function runDigest(
    repository: NotificationsRepository,
    sent: string[] = []
  ): Promise<unknown> {
    return dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: `digest:run:${sent.length}` },
      (scopedDb) =>
        runNotificationDigestCompose(scopedDb, {
          baseUrl: "https://jarvis.example.test",
          notificationsRepository: repository,
          preferencesRepository: new PreferencesRepository(),
          sender: {
            sendDigest: async (_scopedDb, input) => {
              sent.push(input.text);
              return { ok: true };
            }
          }
        })
    );
  }

  async function seedGoogleAccount(): Promise<void> {
    const cipher = createConnectorSecretCipher();
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed:digest-google" },
      (scopedDb) =>
        new ConnectorsRepository().upsertGoogleAccount(scopedDb, {
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
          encryptedSecret: cipher.encryptJson({
            kind: "google-oauth",
            clientId: "client-id",
            clientSecret: "client-secret",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
            grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"]
          })
        })
    );
  }

  async function putModule(moduleId: string, enabled: boolean): Promise<void> {
    const res = await server.inject({
      method: "PUT",
      url: `/api/me/notification-preferences/${moduleId}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`,
        "content-type": "application/json"
      },
      payload: { enabled }
    });
    expect(res.statusCode).toBe(200);
  }

  async function setDigestPreference(input: {
    enabled: boolean;
    lastDigestSentAt: Date | null;
  }): Promise<void> {
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed:digest-pref" },
      (scopedDb) =>
        new PreferencesRepository().upsert(
          scopedDb,
          "notifications:digest",
          digestPreferenceToRaw({
            enabled: input.enabled,
            cadence: "daily",
            scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
            lastDigestSentAt: input.lastDigestSentAt
          })
        )
    );
  }
});
