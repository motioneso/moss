import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { GetQuietHoursSettingsResponse, MeResponse } from "@moss/shared";
import { isActorInQuietHours } from "@moss/notifications";
import { PreferencesRepository } from "@moss/structured-state";
import { quietHoursPortImpl } from "../../packages/module-registry/src/built-in-module-helpers.js";
import { resolveAlertsQuietPolicy } from "../../packages/settings/src/quiet-hours-authority.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const PROFILE_KEY = "quiet-hours";
const ALERTS_KEY = "proactive.monitoring.v1";
const LOCALE_KEY = "locale";
const RESOLUTION_URL = "/api/me/quiet-hours/resolution";
const LA_LOCALE = { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "12" };

// 04:00 UTC on 2 July is 21:00 the evening before in Los Angeles; 23:00 there is 06:00 UTC.
const LA_NINE_PM = new Date("2026-07-02T04:00:00.000Z");
const LA_ELEVEN_PM = new Date("2026-07-02T06:00:00.000Z");

const PROFILE_ON = { enabled: true, start: "22:00", end: "07:00", timezone: null };
const PROFILE_OFF = { enabled: false, start: "22:00", end: "07:00", timezone: null };
const ALERTS_EARLY = { enabled: true, start: "20:00", end: "08:00", timezone: null };

function alertsRecord(enabled: boolean, start: string, end: string): Record<string, unknown> {
  return {
    version: 1,
    automaticEmailAlerts: true,
    enabled: true,
    dailyCardCap: 7,
    quietHours: { enabled, startLocalTime: start, endLocalTime: end },
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("owner resolves differing saved quiet hours", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataContext: DataContextRunner;
  const preferences = new PreferencesRepository();
  let userCount = 0;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  describe("different windows", () => {
    it("keeps each old policy until the choice saves, then every consumer follows it", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      expect(read.authority).toEqual({
        status: "conflict",
        alerts: { enabled: true, start: "20:00", end: "08:00" }
      });

      // Before: notifications follow Profile (22:00), alert cards keep the older 20:00 schedule.
      expect(await notificationsQuiet(user.id, LA_NINE_PM)).toBe(false);
      expect(await alertsPolicy(user.id)).toBeNull();

      const response = await resolve(user.cookie, {
        choice: "alerts",
        quietHours: ALERTS_EARLY,
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<GetQuietHoursSettingsResponse>();
      expect(body.authority).toEqual({ status: "canonical", alerts: null });
      expect(body.quietHours).toEqual(ALERTS_EARLY);
      expect((await rawRow(user.id, PROFILE_KEY))?.value).toEqual({
        ...ALERTS_EARLY,
        authority: "canonical"
      });

      expect(await notificationsQuiet(user.id, LA_NINE_PM)).toBe(true);
      expect(await alertsPolicy(user.id)).toEqual({
        enabled: true,
        startLocalTime: "20:00",
        endLocalTime: "08:00",
        timeZone: "America/Los_Angeles"
      });
    });

    it("keeps the alert record itself untouched", async () => {
      const alerts = alertsRecord(true, "20:00", "08:00");
      const user = await conflictedOwner(PROFILE_ON, alerts);
      const read = await getQuietHours(user.cookie);
      const before = await rawRow(user.id, ALERTS_KEY);

      const response = await resolve(user.cookie, {
        choice: "profile",
        quietHours: PROFILE_ON,
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(200);
      expect(await rawRow(user.id, ALERTS_KEY)).toEqual(before);
      expect(await alertsPolicy(user.id)).toMatchObject({
        startLocalTime: "22:00",
        endLocalTime: "07:00"
      });
    });
  });

  describe("on and off disagree", () => {
    it("keeps quiet hours off everywhere when the owner keeps the saved off choice", async () => {
      const user = await conflictedOwner(PROFILE_OFF, alertsRecord(true, "22:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      expect(read.authority.status).toBe("conflict");

      const response = await resolve(user.cookie, {
        choice: "profile",
        quietHours: PROFILE_OFF,
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<GetQuietHoursSettingsResponse>().quietHours).toEqual(PROFILE_OFF);
      expect(await notificationsQuiet(user.id, LA_ELEVEN_PM)).toBe(false);
      expect(await alertsPolicy(user.id)).toMatchObject({ enabled: false });
    });

    it("turns quiet hours on everywhere when the owner picks the saved on schedule", async () => {
      const user = await conflictedOwner(PROFILE_OFF, alertsRecord(true, "22:00", "08:00"));
      const read = await getQuietHours(user.cookie);

      const response = await resolve(user.cookie, {
        choice: "alerts",
        quietHours: { enabled: true, start: "22:00", end: "08:00", timezone: null },
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(200);
      expect(await notificationsQuiet(user.id, LA_ELEVEN_PM)).toBe(true);
      expect(await alertsPolicy(user.id)).toMatchObject({ enabled: true, endLocalTime: "08:00" });
    });
  });

  describe("a failed choice leaves the old behavior", () => {
    it("refuses a choice from an older version and changes nothing", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      await seed(user.id, { alerts: alertsRecord(true, "19:00", "08:00") });
      const before = await rawRows(user.id);

      const response = await resolve(user.cookie, {
        choice: "alerts",
        quietHours: ALERTS_EARLY,
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(409);
      expect(await rawRows(user.id)).toEqual(before);
      expect((await getQuietHours(user.cookie)).authority.status).toBe("conflict");
      expect(await notificationsQuiet(user.id, LA_NINE_PM)).toBe(false);
      expect(await alertsPolicy(user.id)).toBeNull();
    });

    it("refuses a malformed choice with 400 and changes nothing", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      const before = await rawRows(user.id);

      const response = await resolve(user.cookie, {
        choice: "newest",
        quietHours: ALERTS_EARLY,
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(400);
      expect(await rawRows(user.id)).toEqual(before);
    });

    it("refuses a choice for an owner with nothing to resolve", async () => {
      const user = await newUser();
      await seed(user.id, { alerts: alertsRecord(true, "20:00", "08:00"), locale: LA_LOCALE });
      const read = await getQuietHours(user.cookie);
      expect(read.authority.status).toBe("carried");
      const before = await rawRows(user.id);

      const response = await resolve(user.cookie, {
        choice: "alerts",
        quietHours: ALERTS_EARLY,
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(409);
      expect(await rawRows(user.id)).toEqual(before);
    });
  });

  describe("repeats", () => {
    it("writes nothing when the same choice is sent again", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      const choice = { choice: "alerts", quietHours: ALERTS_EARLY, expectedVersion: read.version };

      expect((await resolve(user.cookie, choice)).statusCode).toBe(200);
      const settled = await rawRows(user.id);
      const again = await resolve(user.cookie, choice);

      expect(again.statusCode).toBe(200);
      expect(again.json<GetQuietHoursSettingsResponse>().quietHours).toEqual(ALERTS_EARLY);
      expect(await rawRows(user.id)).toEqual(settled);
    });

    it("refuses the other choice once the conflict is settled", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      await resolve(user.cookie, {
        choice: "alerts",
        quietHours: ALERTS_EARLY,
        expectedVersion: read.version
      });
      const settled = await rawRows(user.id);

      const other = await resolve(user.cookie, {
        choice: "profile",
        quietHours: PROFILE_ON,
        expectedVersion: read.version
      });

      expect(other.statusCode).toBe(409);
      expect(await rawRows(user.id)).toEqual(settled);
    });

    it("reads a settled owner without writing, however often", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      await resolve(user.cookie, {
        choice: "profile",
        quietHours: PROFILE_ON,
        expectedVersion: read.version
      });
      const settled = await rawRows(user.id);

      await getQuietHours(user.cookie);
      await getQuietHours(user.cookie);

      expect(await rawRows(user.id)).toEqual(settled);
    });
  });

  describe("racing choices", () => {
    it("lets exactly one of two different choices from the same read land", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);

      const [first, second] = await Promise.all([
        resolve(user.cookie, {
          choice: "profile",
          quietHours: PROFILE_ON,
          expectedVersion: read.version
        }),
        resolve(user.cookie, {
          choice: "alerts",
          quietHours: ALERTS_EARLY,
          expectedVersion: read.version
        })
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const winner = first.statusCode === 200 ? first : second;
      expect((await rawRow(user.id, PROFILE_KEY))?.value).toEqual({
        ...winner.json<GetQuietHoursSettingsResponse>().quietHours,
        authority: "canonical"
      });
    });

    it("refuses a choice after a Profile save landed in between", async () => {
      const user = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(user.cookie);
      const saved = await server.inject({
        method: "PUT",
        url: "/api/me/quiet-hours",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        payload: {
          quietHours: { ...PROFILE_ON, start: "23:00" },
          expectedVersion: read.version
        }
      });
      expect(saved.statusCode).toBe(200);
      const before = await rawRows(user.id);

      const response = await resolve(user.cookie, {
        choice: "profile",
        quietHours: PROFILE_ON,
        expectedVersion: read.version
      });

      expect(response.statusCode).toBe(409);
      expect(await rawRows(user.id)).toEqual(before);
    });
  });

  describe("only the owner settles their own conflict", () => {
    it("cannot be settled by another signed-in user replaying the owner's choice", async () => {
      const owner = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const ownerRead = await getQuietHours(owner.cookie);
      const intruder = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const ownerBefore = await rawRows(owner.id);

      const response = await resolve(intruder.cookie, {
        choice: "alerts",
        quietHours: ALERTS_EARLY,
        expectedVersion: ownerRead.version
      });

      expect(response.statusCode).toBe(409);
      expect(await rawRows(owner.id)).toEqual(ownerBefore);
      expect((await getQuietHours(owner.cookie)).authority.status).toBe("conflict");
    });

    it("refuses a caller who is not signed in", async () => {
      const owner = await conflictedOwner(PROFILE_ON, alertsRecord(true, "20:00", "08:00"));
      const read = await getQuietHours(owner.cookie);
      const before = await rawRows(owner.id);

      const response = await server.inject({
        method: "POST",
        url: RESOLUTION_URL,
        headers: { "content-type": "application/json" },
        payload: { choice: "alerts", quietHours: ALERTS_EARLY, expectedVersion: read.version }
      });

      expect(response.statusCode).toBe(401);
      expect(await rawRows(owner.id)).toEqual(before);
    });
  });

  async function conflictedOwner(
    profile: Record<string, unknown>,
    alerts: Record<string, unknown>
  ): Promise<{ id: string; cookie: string }> {
    const user = await newUser();
    await seed(user.id, { profile, alerts, locale: LA_LOCALE });
    return user;
  }

  async function newUser(): Promise<{ id: string; cookie: string }> {
    userCount += 1;
    const cookie = await signUp(
      `Resolve ${userCount}`,
      `resolve.${userCount}.qh@example.test`,
      `10.31.31.${userCount}`
    );
    return { id: await userId(cookie), cookie };
  }

  async function seed(
    actorUserId: string,
    rows: {
      profile?: Record<string, unknown>;
      alerts?: Record<string, unknown>;
      locale?: Record<string, unknown>;
    }
  ): Promise<void> {
    // Raw store writes: these rows model schedules saved before quiet hours had one home.
    await asUser(actorUserId, async (scopedDb) => {
      if (rows.profile) await preferences.upsert(scopedDb, PROFILE_KEY, rows.profile);
      if (rows.alerts) await preferences.upsert(scopedDb, ALERTS_KEY, rows.alerts);
      if (rows.locale) await preferences.upsert(scopedDb, LOCALE_KEY, rows.locale);
    });
  }

  async function getQuietHours(cookie: string): Promise<GetQuietHoursSettingsResponse> {
    const response = await server.inject({
      method: "GET",
      url: "/api/me/quiet-hours",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    return response.json<GetQuietHoursSettingsResponse>();
  }

  function resolve(cookie: string, payload: Record<string, unknown>) {
    return server.inject({
      method: "POST",
      url: RESOLUTION_URL,
      headers: { cookie, "content-type": "application/json" },
      payload
    });
  }

  function notificationsQuiet(actorUserId: string, now: Date) {
    return asUser(actorUserId, (scopedDb) =>
      isActorInQuietHours(scopedDb, quietHoursPortImpl, now)
    );
  }

  function alertsPolicy(actorUserId: string) {
    return asUser(actorUserId, (scopedDb) => resolveAlertsQuietPolicy(scopedDb));
  }

  function asUser<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return dataContext.withDataContext({ actorUserId, requestId: "req:resolution-it" }, work);
  }

  function rawRow(actorUserId: string, key: string) {
    return asUser(actorUserId, (scopedDb) => preferences.getVersioned(scopedDb, key));
  }

  async function rawRows(actorUserId: string) {
    return {
      profile: await rawRow(actorUserId, PROFILE_KEY),
      alerts: await rawRow(actorUserId, ALERTS_KEY),
      locale: await rawRow(actorUserId, LOCALE_KEY)
    };
  }

  async function userId(cookie: string): Promise<string> {
    const me = await server.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    return me.json<MeResponse>().user.id;
  }

  // Each sign-up comes from its own address so the per-address sign-up limit never trips.
  async function signUp(name: string, email: string, remoteAddress: string): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      remoteAddress,
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "correct horse battery staple" }
    });
    expect(response.statusCode).toBe(200);
    return cookieHeader(response.headers);
  }
});
