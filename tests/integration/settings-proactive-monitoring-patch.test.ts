import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { PreferencesRepository } from "@moss/structured-state";
import type { MeResponse } from "@moss/shared";
import { PROACTIVE_MONITORING_PREFERENCE_KEY } from "@moss/shared";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const SETTINGS_URL = "/api/me/proactive-monitoring-settings";
const PROFILE_QUIET_HOURS_KEY = "quiet-hours";

// Legacy saved record: out-of-range, equal quiet times. The stored-record reader accepts any
// NN:NN, so these load; strict validation only rejects them as newly supplied values.
const LEGACY_RECORD = {
  version: 1,
  automaticEmailAlerts: true,
  enabled: true,
  dailyCardCap: 7,
  sources: {
    tasks: { enabled: false, dailyCardCap: 2 },
    notes: { enabled: true, dailyCardCap: 4 }
  },
  quietHours: { enabled: true, startLocalTime: "24:30", endLocalTime: "24:30" },
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("proactive monitoring settings PATCH", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let ownerCookie: string;
  let otherCookie: string;
  let ownerId: string;
  let otherId: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    // More than one connection so concurrent PATCHes actually contend for the row lock.
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    dataContext = new DataContextRunner(appDb);
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    ownerCookie = await signUp("Owner", "owner.pm@example.test");
    otherCookie = await signUp("Other", "other.pm@example.test");
    ownerId = await userId(ownerCookie);
    otherId = await userId(otherCookie);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("keeps saved legacy quiet times, sources and cap on an email-only save", async () => {
    await seedRecord(ownerId, LEGACY_RECORD);

    const res = await patch(ownerCookie, { automaticEmailAlerts: false });

    expect(res.statusCode).toBe(200);
    const row = await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY);
    expect(row?.revision).toBe(2);
    expect(row?.value).toMatchObject({
      automaticEmailAlerts: false,
      enabled: true,
      dailyCardCap: 7,
      sources: LEGACY_RECORD.sources,
      quietHours: LEGACY_RECORD.quietHours
    });
  });

  it("refuses an invalid new quiet window and leaves the saved record untouched", async () => {
    const before = await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY);

    const equal = await patch(ownerCookie, {
      quietHours: { enabled: true, startLocalTime: "23:00", endLocalTime: "23:00" }
    });
    const loose = await patch(ownerCookie, {
      quietHours: { enabled: true, startLocalTime: "7:30", endLocalTime: "08:00" }
    });

    expect(equal.statusCode).toBe(400);
    expect(equal.json()).toMatchObject({
      error: "Quiet hours must start and end at different times"
    });
    expect(loose.statusCode).toBe(400);
    expect(await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY)).toEqual(before);
    expect(await rawRow(ownerId, PROFILE_QUIET_HOURS_KEY)).toBeNull();
  });

  it("applies both of two concurrent saves without losing either", async () => {
    const before = await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY);

    const [cap, quiet] = await Promise.all([
      patch(ownerCookie, { dailyCardCap: 11 }),
      patch(ownerCookie, {
        quietHours: { enabled: true, startLocalTime: "22:30", endLocalTime: "06:15" }
      })
    ]);

    expect(cap.statusCode).toBe(200);
    expect(quiet.statusCode).toBe(200);
    const row = await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY);
    expect(row?.revision).toBe((before?.revision ?? 0) + 2);
    expect(row?.value).toMatchObject({
      dailyCardCap: 11,
      automaticEmailAlerts: false,
      sources: LEGACY_RECORD.sources,
      quietHours: { enabled: true, startLocalTime: "22:30", endLocalTime: "06:15" }
    });
  });

  it("lands a legacy quiet-hours save on the one Profile record once the schedule is clear", async () => {
    // The alert record now holds a valid 22:30-06:15 window and Profile has none, so that window
    // is the owner's carried schedule and the next quiet-hours save belongs on Profile.
    const alertsBefore = await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY);

    const legacy = await patch(ownerCookie, {
      quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "05:00" }
    });

    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().settings.quietHours).toEqual({
      enabled: true,
      startLocalTime: "21:00",
      endLocalTime: "05:00"
    });
    expect((await rawRow(ownerId, PROFILE_QUIET_HOURS_KEY))?.value).toEqual({
      enabled: true,
      start: "21:00",
      end: "05:00",
      timezone: null,
      authority: "canonical"
    });
    expect(await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY)).toEqual(alertsBefore);

    const read = await server.inject({
      method: "GET",
      url: "/api/me/quiet-hours",
      headers: { cookie: ownerCookie }
    });
    const profile = await server.inject({
      method: "PUT",
      url: "/api/me/quiet-hours",
      headers: { cookie: ownerCookie },
      payload: {
        quietHours: { enabled: true, start: "23:00", end: "07:00", timezone: "Europe/London" },
        expectedVersion: read.json().version
      }
    });

    expect(profile.statusCode).toBe(200);
    expect(await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY)).toEqual(alertsBefore);
    const alerts = await server.inject({
      method: "GET",
      url: SETTINGS_URL,
      headers: { cookie: ownerCookie }
    });
    expect(alerts.json().settings.quietHours).toEqual({
      enabled: true,
      startLocalTime: "23:00",
      endLocalTime: "07:00"
    });
  });

  it("starts a new user's record with automatic email alerts on and keeps a saved choice", async () => {
    const first = await server.inject({
      method: "GET",
      url: SETTINGS_URL,
      headers: { cookie: otherCookie }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ settings: { automaticEmailAlerts: true } });

    await patch(otherCookie, { automaticEmailAlerts: false });
    const again = await server.inject({
      method: "GET",
      url: SETTINGS_URL,
      headers: { cookie: otherCookie }
    });
    expect(again.json()).toMatchObject({ settings: { automaticEmailAlerts: false } });
  });

  it("writes only the signed-in user's record and needs a session", async () => {
    const ownerBefore = await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY);

    await patch(otherCookie, { dailyCardCap: 3 });
    const anonymous = await server.inject({
      method: "PATCH",
      url: SETTINGS_URL,
      payload: { dailyCardCap: 1 }
    });

    expect(anonymous.statusCode).toBe(401);
    expect(await rawRow(ownerId, PROACTIVE_MONITORING_PREFERENCE_KEY)).toEqual(ownerBefore);
    expect((await rawRow(otherId, PROACTIVE_MONITORING_PREFERENCE_KEY))?.value).toMatchObject({
      dailyCardCap: 3
    });
  });

  function patch(cookie: string, payload: Record<string, unknown>) {
    return server.inject({ method: "PATCH", url: SETTINGS_URL, headers: { cookie }, payload });
  }

  function asUser<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return dataContext.withDataContext({ actorUserId, requestId: "req:proactive-patch-it" }, work);
  }

  async function seedRecord(owner: string, value: Record<string, unknown>): Promise<void> {
    // Raw store write: the alerts writer validates whole records, and legacy rows predate that.
    const saved = await asUser(owner, (scopedDb) =>
      new PreferencesRepository().upsertWithRevision(
        scopedDb,
        PROACTIVE_MONITORING_PREFERENCE_KEY,
        value,
        null
      )
    );
    expect(saved.revision).toBe(1);
  }

  async function rawRow(
    owner: string,
    key: string
  ): Promise<{ value: unknown; revision: number } | null> {
    const row = await asUser(owner, (scopedDb) =>
      new PreferencesRepository().getVersioned(scopedDb, key)
    );
    return row ? { value: row.value, revision: row.revision } : null;
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
