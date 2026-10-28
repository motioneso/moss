import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { PreferencesRepository } from "@moss/structured-state";
import type { MeResponse } from "@moss/shared";
import { PROACTIVE_MONITORING_PREFERENCE_KEY } from "@moss/shared";
import { handleHeartbeatBeat } from "../../packages/chat/src/heartbeat/beat-job.js";
import { listHeartbeatDueOwners } from "../../packages/chat/src/heartbeat/sweep.js";
import type { HeartbeatBeatPayload } from "../../packages/chat/src/heartbeat/beat-job.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const SETTINGS_URL = "/api/me/heartbeat/settings";
const STATUS_URL = "/api/me/heartbeat/status";
const SOURCES = { calendar: true, tasks: true, memory: true, sports: true, news: true };

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("chat heartbeat settings and enrollment", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let workerContext: DataContextRunner;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let adminCookie: string;
  let ownerCookie: string;
  let otherCookie: string;
  let optedOutCookie: string;
  let ownerId: string;
  let otherId: string;
  let optedOutId: string;
  let adminId: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    workerContext = new DataContextRunner(workerDb);
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    adminCookie = await signUp("Admin", "admin.hb@example.test");
    ownerCookie = await signUp("Owner", "owner.hb@example.test");
    otherCookie = await signUp("Other", "other.hb@example.test");
    optedOutCookie = await signUp("Opted", "opted.hb@example.test");
    adminId = await userId(adminCookie);
    ownerId = await userId(ownerCookie);
    otherId = await userId(otherCookie);
    optedOutId = await userId(optedOutCookie);
    await asUser(optedOutId, (db) =>
      new PreferencesRepository().upsertWithRevision(
        db,
        PROACTIVE_MONITORING_PREFERENCE_KEY,
        { version: 1, enabled: false, automaticEmailAlerts: true },
        null
      )
    );
  });

  afterAll(async () => {
    await Promise.allSettled([
      server?.close(),
      appDb?.destroy(),
      workerDb?.destroy(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("shows on, hourly, all five sources to a new owner without writing a row", async () => {
    const res = await get(ownerCookie, SETTINGS_URL);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      readable: true,
      settings: {
        enabled: true,
        cadenceMinutes: 60,
        sources: SOURCES,
        revision: 0,
        origin: "default"
      }
    });
    expect(await storedRevision(ownerId)).toBeNull();
  });

  it("starts an owner with Proactive alerts off as off, and leaves that choice alone", async () => {
    const res = await get(optedOutCookie, SETTINGS_URL);
    expect(res.json().settings).toMatchObject({ enabled: false, origin: "legacy_off" });
    const legacy = await asUser(optedOutId, (db) =>
      new PreferencesRepository().getVersioned(db, PROACTIVE_MONITORING_PREFERENCE_KEY)
    );
    expect(legacy?.revision).toBe(1);
  });

  it("saves, then refuses a stale revision with the saved settings", async () => {
    const saved = await put(ownerCookie, {
      enabled: true,
      cadenceMinutes: 30,
      sources: { ...SOURCES, news: false },
      expectedRevision: 0
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({ revision: 1, cadenceMinutes: 30 });

    const stale = await put(ownerCookie, {
      enabled: false,
      cadenceMinutes: 60,
      sources: SOURCES,
      expectedRevision: 0
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().settings).toMatchObject({
      revision: 1,
      cadenceMinutes: 30,
      sources: { news: false }
    });
  });

  it("keeps each owner's settings private, including from an admin", async () => {
    const mine = await get(otherCookie, SETTINGS_URL);
    expect(mine.json().settings.revision).toBe(0);
    for (const cookie of [otherCookie, adminCookie]) {
      const res = await get(cookie, SETTINGS_URL);
      expect(res.json().settings.cadenceMinutes).toBe(60);
    }
    const seen = await asUser(otherId, (db) =>
      db.db.selectFrom("app.heartbeat_settings").select("owner_user_id").execute()
    );
    expect(seen).toEqual([]);
    const adminSeen = await asUser(adminId, (db) =>
      db.db.selectFrom("app.heartbeat_settings").select("owner_user_id").execute()
    );
    expect(adminSeen.map((row) => row.owner_user_id)).not.toContain(ownerId);
  });

  it("lists due owners by id and revision, then enrolls and records a quiet check", async () => {
    const due = await listHeartbeatDueOwners(workerDb);
    const ids = due.map((owner) => owner.ownerUserId);
    expect(ids).toContain(otherId);
    expect(ids).not.toContain(optedOutId);
    expect(Object.keys(due[0] ?? {}).sort()).toEqual(["ownerUserId", "settingsRevision"]);

    const payload: HeartbeatBeatPayload = {
      actorUserId: otherId,
      kind: "heartbeat-beat",
      resourceId: "9d1d7b0e-6c1f-4a0e-8b8e-1f5f3a1c0001",
      version: 0,
      idempotencyKey: "heartbeat:test-1"
    };
    const result = await asWorker(otherId, (db) =>
      handleHeartbeatBeat(db, payload, { preferences: new PreferencesRepository() })
    );
    expect(result).toBe("checked");
    const status = await get(otherCookie, STATUS_URL);
    expect(status.json().status).toMatchObject({ outcome: "quiet" });
    expect(await storedRevision(otherId)).toBe(1);
  });

  it("skips a beat whose revision is stale or whose owner turned check-ins off", async () => {
    const stale = await asWorker(otherId, (db) =>
      handleHeartbeatBeat(
        db,
        {
          actorUserId: otherId,
          kind: "heartbeat-beat",
          resourceId: "9d1d7b0e-6c1f-4a0e-8b8e-1f5f3a1c0002",
          version: 0,
          idempotencyKey: "heartbeat:test-2"
        },
        { preferences: new PreferencesRepository() }
      )
    );
    expect(stale).toBe("stale");

    await put(otherCookie, {
      enabled: false,
      cadenceMinutes: 60,
      sources: SOURCES,
      expectedRevision: 1
    });
    const off = await asWorker(otherId, (db) =>
      handleHeartbeatBeat(
        db,
        {
          actorUserId: otherId,
          kind: "heartbeat-beat",
          resourceId: "9d1d7b0e-6c1f-4a0e-8b8e-1f5f3a1c0003",
          version: 2,
          idempotencyKey: "heartbeat:test-3"
        },
        { preferences: new PreferencesRepository() }
      )
    );
    expect(off).toBe("off");
    const due = await listHeartbeatDueOwners(workerDb);
    expect(due.map((owner) => owner.ownerUserId)).not.toContain(otherId);
  });

  function get(cookie: string, url: string) {
    return server.inject({ method: "GET", url, headers: { cookie } });
  }

  function put(cookie: string, payload: Record<string, unknown>) {
    return server.inject({
      method: "PUT",
      url: SETTINGS_URL,
      headers: { cookie, "content-type": "application/json" },
      payload
    });
  }

  function asUser<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return dataContext.withDataContext({ actorUserId, requestId: "req:heartbeat-it" }, work);
  }

  function asWorker<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return workerContext.withDataContext(
      { actorUserId, requestId: "req:heartbeat-it-worker" },
      work
    );
  }

  async function storedRevision(owner: string): Promise<number | null> {
    const row = await asUser(owner, (db) =>
      db.db.selectFrom("app.heartbeat_settings").select("revision").executeTakeFirst()
    );
    return row?.revision ?? null;
  }

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "correct horse battery staple" }
    });
    expect(res.statusCode).toBe(200);
    return cookieHeader(res.headers);
  }

  async function userId(cookie: string): Promise<string> {
    const res = await server.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    return res.json<MeResponse>().user.id;
  }
});
