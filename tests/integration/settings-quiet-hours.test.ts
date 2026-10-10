import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { GetQuietHoursSettingsResponse, MeResponse } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const QUIET_HOURS_KEY = "quiet-hours";

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("settings quiet-hours preferences", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataContext: DataContextRunner;
  const preferences = new PreferencesRepository();
  let ownerCookie: string;
  let memberCookie: string;
  let recreateCookie: string;
  let legacyCookie: string;
  let ownerId: string;
  let memberId: string;
  let recreateId: string;
  let legacyId: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    dataContext = new DataContextRunner(appDb);

    ownerCookie = await signUp("Owner", "owner.qh@example.test");
    memberCookie = await signUp("Member", "member.qh@example.test");
    recreateCookie = await signUp("Recreate", "recreate.qh@example.test");
    legacyCookie = await signUp("Legacy", "legacy.qh@example.test");
    ownerId = await userId(ownerCookie);
    memberId = await userId(memberCookie);
    recreateId = await userId(recreateCookie);
    legacyId = await userId(legacyCookie);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("returns disabled defaults and no version when the quiet-hours preference is unset", async () => {
    const res = await getQuietHours(ownerCookie);

    expect(res.statusCode).toBe(200);
    expect(res.json<GetQuietHoursSettingsResponse>()).toEqual({
      quietHours: {
        enabled: false,
        start: "22:00",
        end: "07:00",
        timezone: null
      },
      authority: { status: "default", alerts: null },
      version: null
    });
  });

  it("does not create a row when reading", async () => {
    await getQuietHours(ownerCookie);
    expect(await rawRow(ownerId)).toBeNull();
  });

  it("persists an overnight window and returns it with a version on the next read", async () => {
    const put = await putQuietHours(ownerCookie, {
      quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "America/Chicago" },
      expectedVersion: null
    });

    expect(put.statusCode).toBe(200);
    const saved = put.json<GetQuietHoursSettingsResponse>();
    expect(saved.quietHours).toEqual({
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "America/Chicago"
    });
    expect(saved.version).toMatch(/^1:\d+$/);

    const get = await getQuietHours(ownerCookie);
    expect(get.statusCode).toBe(200);
    expect(get.json<GetQuietHoursSettingsResponse>()).toEqual(saved);
  });

  it("does not bump the revision when a read follows a save", async () => {
    const before = await rawRow(ownerId);
    await getQuietHours(ownerCookie);
    const after = await rawRow(ownerId);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });

  it("accepts a null timezone (uses locale tz fallback at deferral time)", async () => {
    const put = await putQuietHours(ownerCookie, {
      quietHours: { enabled: true, start: "21:00", end: "08:00", timezone: null },
      expectedVersion: await currentVersion(ownerCookie)
    });

    expect(put.statusCode).toBe(200);
    expect(put.json<GetQuietHoursSettingsResponse>().quietHours.timezone).toBeNull();
  });

  it("refuses a save built from an older version and leaves the stored schedule intact", async () => {
    const loaded = await currentVersion(ownerCookie);
    const first = await putQuietHours(ownerCookie, {
      quietHours: { enabled: true, start: "23:00", end: "06:00", timezone: "America/Chicago" },
      expectedVersion: loaded
    });
    expect(first.statusCode).toBe(200);
    const stored = await rawRow(ownerId);

    const stale = await putQuietHours(ownerCookie, {
      quietHours: { enabled: false, start: "20:00", end: "05:00", timezone: null },
      expectedVersion: loaded
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toBe(
      "Quiet hours changed somewhere else. Reload to see the latest schedule, then try again."
    );
    expect(await rawRow(ownerId)).toEqual(stored);
  });

  it("refuses a first-save expectation once a schedule exists", async () => {
    const stored = await rawRow(ownerId);
    const res = await putQuietHours(ownerCookie, {
      quietHours: { enabled: false, start: "20:00", end: "05:00", timezone: null },
      expectedVersion: null
    });

    expect(res.statusCode).toBe(409);
    expect(await rawRow(ownerId)).toEqual(stored);
  });

  it("refuses a save whose version predates a delete and recreate at the same revision", async () => {
    const stale = await currentVersion(recreateCookie, true);
    expect(stale).toMatch(/^1:/);
    await asUser(recreateId, async (scopedDb) => {
      const row = await preferences.getVersioned(scopedDb, QUIET_HOURS_KEY);
      await preferences.deleteWithRevision(scopedDb, QUIET_HOURS_KEY, row!.revision);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const recreated = await putQuietHours(recreateCookie, {
      quietHours: { enabled: true, start: "01:00", end: "02:00", timezone: null },
      expectedVersion: null
    });
    expect(recreated.statusCode).toBe(200);
    expect(recreated.json<GetQuietHoursSettingsResponse>().version).toMatch(/^1:/);
    const stored = await rawRow(recreateId);

    const res = await putQuietHours(recreateCookie, {
      quietHours: { enabled: false, start: "20:00", end: "05:00", timezone: null },
      expectedVersion: stale
    });

    expect(res.statusCode).toBe(409);
    expect(await rawRow(recreateId)).toEqual(stored);
  });

  it("requires an expected version on every save", async () => {
    const res = await putQuietHours(ownerCookie, {
      quietHours: { enabled: false, start: "20:00", end: "05:00", timezone: null }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown timezone without changing the stored schedule", async () => {
    const stored = await rawRow(ownerId);
    const res = await putQuietHours(ownerCookie, {
      quietHours: { enabled: true, start: "23:00", end: "06:00", timezone: "Mars/Olympus_Mons" },
      expectedVersion: await currentVersion(ownerCookie)
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("timezone must be a valid IANA time zone");
    expect(await rawRow(ownerId)).toEqual(stored);
  });

  it("rejects a window that starts and ends at the same time without changing it", async () => {
    const stored = await rawRow(ownerId);
    const res = await putQuietHours(ownerCookie, {
      quietHours: { enabled: true, start: "06:00", end: "06:00", timezone: "America/Chicago" },
      expectedVersion: await currentVersion(ownerCookie)
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe(
      "Quiet hours must start and end at different times"
    );
    expect(await rawRow(ownerId)).toEqual(stored);
  });

  it("rejects invalid HH:MM start and end times", async () => {
    const stored = await rawRow(ownerId);
    for (const quietHours of [
      { enabled: true, start: "25:00", end: "07:00", timezone: null },
      { enabled: true, start: "22:00", end: "7pm", timezone: null }
    ]) {
      const res = await putQuietHours(ownerCookie, {
        quietHours,
        expectedVersion: await currentVersion(ownerCookie)
      });
      expect(res.statusCode).toBe(400);
    }
    expect(await rawRow(ownerId)).toEqual(stored);
  });

  it("keeps a saved legacy equal-time window when only the switch changes", async () => {
    await asUser(legacyId, (scopedDb) =>
      preferences.upsert(scopedDb, QUIET_HOURS_KEY, {
        enabled: false,
        start: "22:00",
        end: "22:00",
        timezone: "Legacy/Zone"
      })
    );
    const loaded = (await getQuietHours(legacyCookie)).json<GetQuietHoursSettingsResponse>();

    const res = await putQuietHours(legacyCookie, {
      quietHours: { ...loaded.quietHours, enabled: true },
      expectedVersion: loaded.version
    });

    expect(res.statusCode).toBe(200);
    expect((await rawRow(legacyId))?.value).toEqual({
      enabled: true,
      start: "22:00",
      end: "22:00",
      timezone: "Legacy/Zone"
    });
  });

  it("keeps a saved legacy malformed time when only the switch changes", async () => {
    await asUser(legacyId, (scopedDb) =>
      preferences.upsert(scopedDb, QUIET_HOURS_KEY, { enabled: true, start: "7pm" })
    );
    const loaded = (await getQuietHours(legacyCookie)).json<GetQuietHoursSettingsResponse>();
    expect(loaded.quietHours).toEqual({
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: null
    });

    const res = await putQuietHours(legacyCookie, {
      quietHours: { ...loaded.quietHours, enabled: false },
      expectedVersion: loaded.version
    });

    expect(res.statusCode).toBe(200);
    expect((await rawRow(legacyId))?.value).toEqual({ enabled: false, start: "7pm" });
  });

  it("keeps quiet-hours preferences isolated per user", async () => {
    const ownerStored = await rawRow(ownerId);
    const res = await getQuietHours(memberCookie);

    expect(res.statusCode).toBe(200);
    expect(res.json<GetQuietHoursSettingsResponse>()).toEqual({
      quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: null },
      authority: { status: "default", alerts: null },
      version: null
    });

    const foreign = await putQuietHours(memberCookie, {
      quietHours: { enabled: true, start: "01:00", end: "02:00", timezone: null },
      expectedVersion: await currentVersion(ownerCookie)
    });
    expect(foreign.statusCode).toBe(409);
    expect(await rawRow(memberId)).toBeNull();
    expect(await rawRow(ownerId)).toEqual(ownerStored);
  });

  it("requires authentication for reads and saves", async () => {
    const get = await server.inject({ method: "GET", url: "/api/me/quiet-hours" });
    expect(get.statusCode).toBe(401);

    const ownerStored = await rawRow(ownerId);
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/quiet-hours",
      headers: { "content-type": "application/json" },
      payload: {
        quietHours: { enabled: false, start: "20:00", end: "05:00", timezone: null },
        expectedVersion: null
      }
    });
    expect(put.statusCode).toBe(401);
    expect(await rawRow(ownerId)).toEqual(ownerStored);
  });

  function getQuietHours(cookie: string) {
    return server.inject({ method: "GET", url: "/api/me/quiet-hours", headers: { cookie } });
  }

  function putQuietHours(cookie: string, payload: Record<string, unknown>) {
    return server.inject({
      method: "PUT",
      url: "/api/me/quiet-hours",
      headers: { cookie, "content-type": "application/json" },
      payload
    });
  }

  // Seeds a first schedule when asked so a test can start from a saved version.
  async function currentVersion(cookie: string, seed = false): Promise<string | null> {
    const version = (await getQuietHours(cookie)).json<GetQuietHoursSettingsResponse>().version;
    if (version !== null || !seed) return version;
    const put = await putQuietHours(cookie, {
      quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: null },
      expectedVersion: null
    });
    return put.json<GetQuietHoursSettingsResponse>().version;
  }

  function asUser<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return dataContext.withDataContext({ actorUserId, requestId: "req:quiet-hours-it" }, work);
  }

  function rawRow(actorUserId: string) {
    return asUser(actorUserId, (scopedDb) => preferences.getVersioned(scopedDb, QUIET_HOURS_KEY));
  }

  async function userId(cookie: string): Promise<string> {
    const me = await server.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    return me.json<MeResponse>().user.id;
  }

  async function signUp(name: string, email: string): Promise<string> {
    const signUp = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        name,
        email,
        password: "correct horse battery staple"
      }
    });
    expect(signUp.statusCode).toBe(200);
    return cookieHeader(signUp.headers);
  }
});
