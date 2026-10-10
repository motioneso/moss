import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import { sql, type Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { GetQuietHoursSettingsResponse, MeResponse } from "@moss/shared";
import { isActorInQuietHours } from "@moss/notifications";
import { PreferencesRepository } from "@moss/structured-state";
import { quietHoursPortImpl } from "../../packages/module-registry/src/built-in-module-helpers.js";
import { quietHoursSetExecute } from "../../packages/settings/src/quiet-hours-tool.js";
import { settingsUndoLastExecute } from "../../packages/settings/src/undo-apply-tool.js";
import { settingsUndoStack } from "../../packages/settings/src/undo-stack.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const PROFILE_KEY = "quiet-hours";
const ALERTS_KEY = "proactive.monitoring.v1";
const LOCALE_KEY = "locale";
const SETTINGS_URL = "/api/me/proactive-monitoring-settings";

type NestedQuiet = { enabled: boolean; startLocalTime: string; endLocalTime: string };
type ProfileQuiet = Record<string, unknown>;

// Whole legacy alerts record, as saved before quiet hours moved to Profile.
function alertsRecord(quietHours?: NestedQuiet): Record<string, unknown> {
  return {
    version: 1,
    automaticEmailAlerts: true,
    enabled: true,
    dailyCardCap: 7,
    sources: {
      tasks: { enabled: false, dailyCardCap: 2 },
      notes: { enabled: true, dailyCardCap: 4 }
    },
    ...(quietHours === undefined ? {} : { quietHours }),
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

// What the alerts writer creates when only email alerts were ever touched.
const SPARSE_EMAIL_ONLY = {
  version: 1,
  automaticEmailAlerts: false,
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const LONDON_LOCALE = { timezone: "Europe/London", region: "en-GB", dateFormat: "24" };

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("quiet hours carry forward into Profile", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataContext: DataContextRunner;
  const preferences = new PreferencesRepository();
  let userCount = 0;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  describe("classification on read", () => {
    const cases: ReadonlyArray<{
      name: string;
      profile?: ProfileQuiet;
      alerts?: Record<string, unknown>;
      locale?: Record<string, unknown>;
      status: GetQuietHoursSettingsResponse["authority"]["status"];
      shown: GetQuietHoursSettingsResponse["quietHours"];
      alertsShown?: GetQuietHoursSettingsResponse["authority"]["alerts"];
    }> = [
      {
        name: "nothing saved shows the default, off",
        status: "default",
        shown: { enabled: false, start: "22:00", end: "07:00", timezone: null }
      },
      {
        name: "a sparse email-only alerts record is not a saved quiet-hours choice",
        alerts: SPARSE_EMAIL_ONLY,
        status: "default",
        shown: { enabled: false, start: "22:00", end: "07:00", timezone: null }
      },
      {
        name: "a whole legacy alerts record with nested quiet hours carries forward",
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" }),
        status: "carried",
        shown: { enabled: true, start: "21:30", end: "06:15", timezone: null }
      },
      {
        name: "a sole Profile schedule carries forward",
        profile: { enabled: true, start: "23:00", end: "06:00", timezone: "Europe/London" },
        status: "carried",
        shown: { enabled: true, start: "23:00", end: "06:00", timezone: "Europe/London" }
      },
      {
        name: "identical schedules with no Profile zone carry forward",
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        status: "carried",
        shown: { enabled: true, start: "22:00", end: "07:00", timezone: null }
      },
      {
        name: "identical schedules whose Profile zone matches the owner zone carry forward",
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        locale: LONDON_LOCALE,
        status: "carried",
        shown: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" }
      },
      {
        name: "different windows stay unresolved",
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "20:00", endLocalTime: "08:00" }),
        status: "conflict",
        shown: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alertsShown: { enabled: true, start: "20:00", end: "08:00" }
      },
      {
        name: "an enabled and an off schedule stay unresolved",
        profile: { enabled: false, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        status: "conflict",
        shown: { enabled: false, start: "22:00", end: "07:00", timezone: null },
        alertsShown: { enabled: true, start: "22:00", end: "07:00" }
      },
      {
        name: "a Profile zone different from the owner zone stays unresolved",
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/Paris" },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        locale: LONDON_LOCALE,
        status: "conflict",
        shown: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/Paris" },
        alertsShown: { enabled: true, start: "22:00", end: "07:00" }
      },
      {
        name: "a malformed nested schedule is reported, not repaired",
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "24:30", endLocalTime: "24:30" }),
        status: "malformed",
        shown: { enabled: true, start: "22:00", end: "07:00", timezone: null }
      },
      {
        name: "a malformed Profile schedule is reported, not repaired",
        profile: { enabled: "yes", start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        status: "malformed",
        shown: { enabled: false, start: "22:00", end: "07:00", timezone: null }
      }
    ];

    it.each(cases)("$name", async (testCase) => {
      const user = await newUser();
      await seed(user.id, testCase);
      const before = await rawRows(user.id);

      for (let read = 0; read < 3; read += 1) {
        const response = await getQuietHours(user.cookie);
        expect(response.statusCode).toBe(200);
        const body = response.json<GetQuietHoursSettingsResponse>();
        expect(body.authority.status).toBe(testCase.status);
        expect(body.quietHours).toEqual(testCase.shown);
        expect(body.authority.alerts).toEqual(testCase.alertsShown ?? null);
      }

      // Reading never creates, repairs or stamps anything.
      expect(await rawRows(user.id)).toEqual(before);
    });

    it("classifies under a read-only transaction, which refuses any write", async () => {
      const { readQuietHoursAuthority } = await authorityModule();
      const user = await newUser();
      await seed(user.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" })
      });

      const read = await asUser(user.id, async (scopedDb) => {
        await sql`set transaction read only`.execute(scopedDb.db);
        return readQuietHoursAuthority(scopedDb);
      });
      expect(read.authority.status).toBe("carried");

      // Control: the same read-only transaction rejects a write, so the read above wrote nothing.
      await expect(
        asUser(user.id, async (scopedDb) => {
          await sql`set transaction read only`.execute(scopedDb.db);
          await preferences.upsert(scopedDb, PROFILE_KEY, { enabled: true });
        })
      ).rejects.toThrow(/read-only transaction/);
    });

    it("keeps each owner's classification to their own rows", async () => {
      const carried = await newUser();
      const other = await newUser();
      await seed(carried.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" })
      });

      const { readQuietHoursAuthority } = await authorityModule();
      const body = (await getQuietHours(other.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("default");
      expect(await asUser(other.id, (db) => readQuietHoursAuthority(db))).toMatchObject({
        input: { profile: undefined, proactive: undefined, locale: undefined }
      });
    });
  });

  describe("writes under the one authority", () => {
    it("materializes a carried schedule as canonical Profile on save, leaving alerts intact", async () => {
      const user = await newUser();
      const nested = alertsRecord({
        enabled: true,
        startLocalTime: "21:30",
        endLocalTime: "06:15"
      });
      await seed(user.id, { alerts: nested });
      const read = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(read.version).not.toBeNull();

      const put = await putQuietHours(user.cookie, {
        quietHours: { enabled: true, start: "22:15", end: "06:45", timezone: null },
        expectedVersion: read.version
      });
      expect(put.statusCode).toBe(200);
      expect(put.json<GetQuietHoursSettingsResponse>().authority.status).toBe("canonical");

      expect((await rawRow(user.id, PROFILE_KEY))?.value).toEqual({
        enabled: true,
        start: "22:15",
        end: "06:45",
        timezone: null,
        authority: "canonical"
      });
      expect((await rawRow(user.id, ALERTS_KEY))?.value).toEqual(nested);
    });

    it("refuses a save built from a version older than a nested quiet-hours change", async () => {
      const user = await newUser();
      await seed(user.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" })
      });
      const stale = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();

      await seed(user.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "20:00", endLocalTime: "05:00" })
      });
      const before = await rawRows(user.id);

      const put = await putQuietHours(user.cookie, {
        quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: null },
        expectedVersion: stale.version
      });
      expect(put.statusCode).toBe(409);
      expect(await rawRows(user.id)).toEqual(before);
    });

    it("keeps the read version valid across an unrelated email-only alerts save", async () => {
      const user = await newUser();
      await seed(user.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" })
      });
      const read = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();

      expect((await patchAlerts(user.cookie, { automaticEmailAlerts: false })).statusCode).toBe(
        200
      );

      const put = await putQuietHours(user.cookie, {
        quietHours: { enabled: true, start: "22:00", end: "06:00", timezone: null },
        expectedVersion: read.version
      });
      expect(put.statusCode).toBe(200);
    });

    it("stamps a conflict unresolved on a Profile save, so the save cannot settle it", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "20:00", endLocalTime: "08:00" })
      });
      const read = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();

      const put = await putQuietHours(user.cookie, {
        quietHours: { enabled: true, start: "20:00", end: "08:00", timezone: null },
        expectedVersion: read.version
      });
      expect(put.statusCode).toBe(200);
      const body = put.json<GetQuietHoursSettingsResponse>();
      expect(body.authority).toEqual({
        status: "conflict",
        alerts: { enabled: true, start: "20:00", end: "08:00" }
      });
      expect((await rawRow(user.id, PROFILE_KEY))?.value).toMatchObject({
        start: "20:00",
        authority: "unresolved"
      });

      // Identical windows now, but the frozen verdict holds until the explicit choice (#3131).
      const again = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(again.authority.status).toBe("conflict");
    });

    it("keeps a conflict through an unrelated email save and a repeated read", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: false, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" })
      });
      const profileBefore = await rawRow(user.id, PROFILE_KEY);

      expect((await patchAlerts(user.cookie, { automaticEmailAlerts: false })).statusCode).toBe(
        200
      );

      const body = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("conflict");
      expect(await rawRow(user.id, PROFILE_KEY)).toEqual(profileBefore);
      expect((await rawRow(user.id, ALERTS_KEY))?.value).toMatchObject({
        automaticEmailAlerts: false,
        dailyCardCap: 7,
        sources: { tasks: { enabled: false, dailyCardCap: 2 } },
        quietHours: { enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }
      });
    });
  });

  describe("racing saves", () => {
    it("lets exactly one of two saves from the same carried read land", async () => {
      const user = await newUser();
      await seed(user.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" })
      });
      const read = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();

      const [first, second] = await Promise.all([
        putQuietHours(user.cookie, {
          quietHours: { enabled: true, start: "22:00", end: "06:00", timezone: null },
          expectedVersion: read.version
        }),
        putQuietHours(user.cookie, {
          quietHours: { enabled: false, start: "23:00", end: "05:00", timezone: null },
          expectedVersion: read.version
        })
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const winner = first.statusCode === 200 ? first : second;
      const profile = await rawRow(user.id, PROFILE_KEY);
      expect(profile?.value).toMatchObject({
        ...winner.json<GetQuietHoursSettingsResponse>().quietHours,
        authority: "canonical"
      });
    });
  });

  describe("notifications and focus read the one schedule through the public port", () => {
    // 21:45 UTC is 22:45 in London in July; 11:00 UTC is 12:00 there.
    const LONDON_EVENING = new Date("2026-07-01T21:45:00.000Z");
    const LONDON_NOON = new Date("2026-07-01T11:00:00.000Z");

    function inQuietHours(actorUserId: string, now: Date) {
      return asUser(actorUserId, (scopedDb) =>
        isActorInQuietHours(scopedDb, quietHoursPortImpl, now)
      );
    }

    it("follows a sole alert schedule in the owner zone, without writing it", async () => {
      const user = await newUser();
      await seed(user.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" }),
        locale: LONDON_LOCALE
      });
      const before = await rawRows(user.id);

      expect(await inQuietHours(user.id, LONDON_EVENING)).toBe(true);
      expect(await inQuietHours(user.id, LONDON_NOON)).toBe(false);
      expect(await rawRows(user.id)).toEqual(before);
    });

    it("stays off when nothing is saved and the alert record is email-only", async () => {
      const user = await newUser();
      await seed(user.id, { alerts: SPARSE_EMAIL_ONLY, locale: LONDON_LOCALE });

      expect(await inQuietHours(user.id, LONDON_EVENING)).toBe(false);
    });

    it("keeps following Profile while an older alert schedule differs", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: false, startLocalTime: "22:00", endLocalTime: "07:00" }),
        locale: LONDON_LOCALE
      });

      expect(await inQuietHours(user.id, LONDON_EVENING)).toBe(true);
    });

    it("reads only the asking owner's schedule", async () => {
      const carried = await newUser();
      const other = await newUser();
      await seed(carried.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" }),
        locale: LONDON_LOCALE
      });
      await seed(other.id, { locale: LONDON_LOCALE });

      expect(await inQuietHours(other.id, LONDON_EVENING)).toBe(false);
    });
  });

  describe("legacy alerts PATCH", () => {
    it("routes a quiet-hours edit for an unambiguous owner into Profile", async () => {
      const user = await newUser();
      const nested = alertsRecord({
        enabled: true,
        startLocalTime: "21:30",
        endLocalTime: "06:15"
      });
      await seed(user.id, { alerts: nested });

      const response = await patchAlerts(user.cookie, {
        quietHours: { enabled: true, startLocalTime: "23:00", endLocalTime: "06:15" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        settings: { quietHours: { enabled: true, startLocalTime: "23:00", endLocalTime: "06:15" } }
      });

      expect((await rawRow(user.id, PROFILE_KEY))?.value).toEqual({
        enabled: true,
        start: "23:00",
        end: "06:15",
        timezone: null,
        authority: "canonical"
      });
      expect((await rawRow(user.id, ALERTS_KEY))?.value).toMatchObject({
        quietHours: nested.quietHours,
        dailyCardCap: 7
      });
    });

    it("keeps a conflicted owner's edit on the alerts record and freezes Profile unresolved", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "20:00", endLocalTime: "08:00" })
      });

      const response = await patchAlerts(user.cookie, {
        quietHours: { enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }
      });
      expect(response.statusCode).toBe(200);

      expect((await rawRow(user.id, PROFILE_KEY))?.value).toEqual({
        enabled: true,
        start: "22:00",
        end: "07:00",
        timezone: null,
        authority: "unresolved"
      });
      expect((await rawRow(user.id, ALERTS_KEY))?.value).toMatchObject({
        quietHours: { enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }
      });
      const body = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("conflict");
    });
  });

  describe("chat tool and undo", () => {
    it("materializes a carried schedule, and undo restores the absent Profile row", async () => {
      const user = await newUser();
      await seed(user.id, {
        alerts: alertsRecord({ enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" })
      });
      const chatSessionId = `chat-${user.id}`;
      const ctx = { actorUserId: user.id, requestId: "req:carry-tool", chatSessionId };

      const result = await asUser(user.id, (scopedDb) =>
        quietHoursSetExecute(scopedDb, { enabled: true, start: "22:00", end: "06:00" }, ctx)
      );
      expect(result.data).toEqual({ enabled: true, start: "22:00", end: "06:00", timezone: null });
      expect((await rawRow(user.id, PROFILE_KEY))?.value).toMatchObject({ authority: "canonical" });

      const undo = await asUser(user.id, (scopedDb) => settingsUndoLastExecute(scopedDb, {}, ctx));
      expect(undo.data).toMatchObject({ status: "undone", key: PROFILE_KEY });
      expect(await rawRow(user.id, PROFILE_KEY)).toBeNull();

      const body = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("carried");
      expect(body.quietHours).toEqual({
        enabled: true,
        start: "21:30",
        end: "06:15",
        timezone: null
      });
    });

    it("undo restores a frozen unresolved conflict, not a settled schedule", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        alerts: alertsRecord({ enabled: true, startLocalTime: "20:00", endLocalTime: "08:00" })
      });
      const before = await rawRow(user.id, PROFILE_KEY);
      const ctx = { actorUserId: user.id, requestId: "req:carry-undo", chatSessionId: "undo" };

      await asUser(user.id, (scopedDb) =>
        quietHoursSetExecute(scopedDb, { enabled: true, start: "20:00", end: "08:00" }, ctx)
      );
      await asUser(user.id, (scopedDb) => settingsUndoLastExecute(scopedDb, {}, ctx));

      expect((await rawRow(user.id, PROFILE_KEY))?.value).toEqual(before?.value);
      const body = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("conflict");
    });
    it("undoing a time-zone change settles the classification under the old zone first", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        locale: LONDON_LOCALE
      });
      const locale = await rawRow(user.id, LOCALE_KEY);
      if (!locale) throw new Error("locale row missing");
      const ctx = { actorUserId: user.id, requestId: "req:locale-undo", chatSessionId: "tz-undo" };
      settingsUndoStack.push(user.id, ctx.chatSessionId, {
        mutationId: `locale-undo-${user.id}`,
        key: LOCALE_KEY,
        previousValue: { timezone: "Europe/Paris", region: "en-GB", dateFormat: "24" },
        previousRevision: null,
        resultingRevision: locale.revision,
        appliedAt: Date.now()
      });

      const undo = await asUser(user.id, (scopedDb) => settingsUndoLastExecute(scopedDb, {}, ctx));
      expect(undo.data).toMatchObject({ status: "undone", key: LOCALE_KEY });

      const body = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("canonical");
      expect((await rawRow(user.id, PROFILE_KEY))?.value).toMatchObject({ authority: "canonical" });
    });
  });

  describe("time-zone changes", () => {
    it("keeps an identical schedule carried when the owner moves zone", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        locale: LONDON_LOCALE
      });

      const moved = await putLocale(user.cookie, {
        timezone: "Europe/Paris",
        region: "en-GB",
        dateFormat: "24"
      });
      expect(moved.statusCode).toBe(200);

      const body = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("canonical");
      expect(body.quietHours.timezone).toBe("Europe/London");
      expect((await rawRow(user.id, PROFILE_KEY))?.value).toMatchObject({ authority: "canonical" });
    });

    it("keeps a zone conflict unresolved when the owner moves into the Profile zone", async () => {
      const user = await newUser();
      await seed(user.id, {
        profile: { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/Paris" },
        alerts: alertsRecord({ enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" }),
        locale: LONDON_LOCALE
      });

      const moved = await putLocale(user.cookie, {
        timezone: "Europe/Paris",
        region: "en-GB",
        dateFormat: "24"
      });
      expect(moved.statusCode).toBe(200);

      const body = (await getQuietHours(user.cookie)).json<GetQuietHoursSettingsResponse>();
      expect(body.authority.status).toBe("conflict");
      expect((await rawRow(user.id, PROFILE_KEY))?.value).toMatchObject({
        authority: "unresolved"
      });
    });
  });

  // Loaded per test so the file still runs, and fails case by case, against code without it.
  function authorityModule() {
    return import("../../packages/settings/src/quiet-hours-authority.js");
  }

  async function newUser(): Promise<{ id: string; cookie: string }> {
    userCount += 1;
    const cookie = await signUp(
      `Carry ${userCount}`,
      `carry.${userCount}.qh@example.test`,
      `10.31.65.${userCount}`
    );
    return { id: await userId(cookie), cookie };
  }

  async function seed(
    actorUserId: string,
    rows: {
      profile?: ProfileQuiet;
      alerts?: Record<string, unknown>;
      locale?: Record<string, unknown>;
    }
  ): Promise<void> {
    // Raw store writes: these rows model data saved before this change.
    await asUser(actorUserId, async (scopedDb) => {
      if (rows.profile) await preferences.upsert(scopedDb, PROFILE_KEY, rows.profile);
      if (rows.alerts) await preferences.upsert(scopedDb, ALERTS_KEY, rows.alerts);
      if (rows.locale) await preferences.upsert(scopedDb, LOCALE_KEY, rows.locale);
    });
  }

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

  function patchAlerts(cookie: string, payload: Record<string, unknown>) {
    return server.inject({ method: "PATCH", url: SETTINGS_URL, headers: { cookie }, payload });
  }

  function putLocale(cookie: string, locale: Record<string, unknown>) {
    return server.inject({
      method: "PUT",
      url: "/api/me/locale",
      headers: { cookie, "content-type": "application/json" },
      payload: { locale }
    });
  }

  function asUser<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return dataContext.withDataContext({ actorUserId, requestId: "req:carry-forward-it" }, work);
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
