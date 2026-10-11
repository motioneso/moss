import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createDatabase, DataContextRunner, runSqlMigrations, type MossDatabase } from "@moss/db";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import {
  AntiSpamPolicy,
  CardRepository,
  EmailFindingPolicy,
  MonitorStateRepository,
  ProactiveMonitoringPreferencesRepository,
  ProactiveScanner,
  proactiveMonitoringSqlMigrationDirectory
} from "@moss/proactive-monitoring";
import { PriorityPreferencesRepository } from "@moss/priority";
import { PROACTIVE_MONITORING_PREFERENCE_KEY, type ProactiveSource } from "@moss/shared";

import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

// #3146: unsolicited email findings are charged once, durably, at the scanner boundary.

const DAY = "2026-09-15";
const at = (hour: number) => new Date(`${DAY}T${String(hour).padStart(2, "0")}:00:00.000Z`);
const PAST = "2026-09-01T10:00:00.000Z";

let workerDb: Kysely<MossDatabase>;
let context: DataContextRunner;
let bootstrap: pg.Client;
const cards = new CardRepository();
const actor = { actorUserId: ids.userA, requestId: "test:3146" };

function signal(source: ProactiveSource, stableKey: string) {
  return {
    source,
    stableKey,
    sourceRefHash: `hash-${stableKey}`,
    signalType: source === "email" ? "needs_reply_soon" : "decision_changed",
    title: `Finding ${stableKey}`,
    summary: `Summary ${stableKey}`,
    occurredAt: PAST,
    priorityCandidate: { explicitPriority: 5, dueAt: PAST, effort: "large" }
  };
}

function provider(source: ProactiveSource, keys: readonly string[]) {
  const cursors: unknown[] = [];
  const monitor = {
    source,
    moduleId: source,
    collectSignals: async (_db: unknown, input: { sinceCursor: unknown; now: string }) => {
      cursors.push(input.sinceCursor);
      return { signals: keys.map((key) => signal(source, key)), nextCursor: { at: input.now } };
    }
  } as unknown as ProactiveMonitorProvider;
  return { monitor, cursors };
}

function scanner(quietHoursEnabled = false) {
  return new ProactiveScanner({
    preferencesRepository: new ProactiveMonitoringPreferencesRepository(),
    priorityPreferencesRepository: new PriorityPreferencesRepository(),
    monitorStateRepository: new MonitorStateRepository(),
    cardRepository: cards,
    antiSpamPolicy: new AntiSpamPolicy(cards),
    getLocalePreference: async () => ({ timezone: "UTC" }),
    resolveQuietHours: async () => ({
      enabled: quietHoursEnabled,
      startLocalTime: "22:00",
      endLocalTime: "07:00",
      timeZone: "UTC"
    })
  });
}

function scan(
  source: ProactiveSource,
  keys: readonly string[],
  now: Date,
  quietHoursEnabled = false
) {
  const { monitor } = provider(source, keys);
  return context.withDataContext(actor, (scopedDb) =>
    scanner(quietHoursEnabled).scan(scopedDb, ids.userA, source, monitor, "source-sync", now)
  );
}

async function savePreference(value: Record<string, unknown>) {
  await bootstrap.query(
    `INSERT INTO app.preferences (owner_user_id, key, value_json, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (owner_user_id, key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    [ids.userA, PROACTIVE_MONITORING_PREFERENCE_KEY, JSON.stringify(value)]
  );
}

function legacyRecord(overrides: { email?: number; notes?: number; global?: number } = {}) {
  return {
    version: 1,
    enabled: true,
    sources: {
      tasks: { enabled: false, dailyCardCap: 3 },
      calendar: { enabled: false, dailyCardCap: 3 },
      email: { enabled: true, dailyCardCap: overrides.email ?? 3 },
      notes: { enabled: true, dailyCardCap: overrides.notes ?? 3 }
    },
    dailyCardCap: overrides.global ?? 8,
    quietHours: { enabled: false, startLocalTime: "22:00", endLocalTime: "07:00" },
    updatedAt: PAST
  };
}

async function charges(): Promise<string[]> {
  const result = await bootstrap.query<{ stable_key: string }>(
    `SELECT stable_key FROM app.proactive_email_finding_charges
     WHERE owner_user_id = $1 ORDER BY stable_key`,
    [ids.userA]
  );
  return result.rows.map((row) => row.stable_key);
}

async function emailCards(): Promise<{ stable_key: string; status: string }[]> {
  const result = await bootstrap.query<{ stable_key: string; status: string }>(
    `SELECT stable_key, status FROM app.proactive_cards
     WHERE owner_user_id = $1 AND source = 'email' ORDER BY stable_key, created_at`,
    [ids.userA]
  );
  return result.rows;
}

async function dismiss(source: ProactiveSource, stableKey: string) {
  await bootstrap.query(
    `UPDATE app.proactive_cards SET status = 'dismissed', dismissed_at = now()
     WHERE owner_user_id = $1 AND source = $2 AND stable_key = $3 AND status = 'active'`,
    [ids.userA, source, stableKey]
  );
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  await bootstrap.query(
    `INSERT INTO app.users (id, email) VALUES ($1, 'budget-a@example.test'), ($2, 'budget-b@example.test')`,
    [ids.userA, ids.userB]
  );
  workerDb = createDatabase({ connectionString: connectionStrings.worker });
  context = new DataContextRunner(workerDb);
});

beforeEach(async () => {
  await bootstrap.query(`DELETE FROM app.proactive_email_finding_charges`);
  await bootstrap.query(`DELETE FROM app.proactive_cards`);
  await bootstrap.query(`DELETE FROM app.proactive_monitor_state`);
  await bootstrap.query(`DELETE FROM app.preferences WHERE key = $1`, [
    PROACTIVE_MONITORING_PREFERENCE_KEY
  ]);
});

afterAll(async () => {
  await bootstrap.end();
  await workerDb.destroy();
});

describe("unsolicited email budget (#3146)", () => {
  it("dismissing an email card does not refill the saved email cap", async () => {
    await savePreference(legacyRecord({ email: 2 }));

    expect((await scan("email", ["e1"], at(1))).cardsCreated).toBe(1);
    await dismiss("email", "e1");
    const second = await scan("email", ["e1", "e2"], at(3));
    expect(second.cardsCreated).toBe(1);
    await dismiss("email", "e2");
    const third = await scan("email", ["e3"], at(5));

    expect(third.cardsCreated).toBe(0);
    expect(third.cardsSuppressed).toBe(1);
    expect(await charges()).toEqual(["e1", "e2"]);
    expect(await emailCards()).toEqual([
      { stable_key: "e1", status: "dismissed" },
      { stable_key: "e2", status: "dismissed" }
    ]);
  });

  it("charges a finding once across duplicates in one scan and later scans", async () => {
    await savePreference(legacyRecord());

    const first = await scan("email", ["e1", "e1"], at(1));
    const again = await scan("email", ["e1"], at(3));

    expect(first.cardsCreated).toBe(1);
    expect(again.cardsCreated).toBe(0);
    expect(again.cardsUpdated).toBe(1);
    expect(await charges()).toEqual(["e1"]);
    expect(await emailCards()).toEqual([{ stable_key: "e1", status: "active" }]);
  });

  it("never re-surfaces a dismissed finding, even after the old 30-day window", async () => {
    await savePreference(legacyRecord());
    await scan("email", ["e1"], at(1));
    await bootstrap.query(
      `UPDATE app.proactive_cards SET status = 'dismissed', dismissed_at = now() - interval '40 days'
       WHERE owner_user_id = $1 AND stable_key = 'e1'`,
      [ids.userA]
    );

    const result = await scan("email", ["e1"], at(3));

    expect(result.cardsCreated).toBe(0);
    expect(await emailCards()).toEqual([{ stable_key: "e1", status: "dismissed" }]);
  });

  it("serialises concurrent scans so the cap holds and each finding is charged once", async () => {
    await savePreference(legacyRecord({ email: 1 }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstScanned!: () => void;
    const scanned = new Promise<void>((resolve) => (firstScanned = resolve));

    const first = context.withDataContext(actor, async (scopedDb) => {
      const result = await scanner().scan(
        scopedDb,
        ids.userA,
        "email",
        provider("email", ["e1"]).monitor,
        "source-sync",
        at(1)
      );
      firstScanned();
      await held;
      return result;
    });
    await scanned;
    let secondSettled = false;
    const second = context
      .withDataContext(actor, (scopedDb) =>
        scanner().scan(
          scopedDb,
          ids.userA,
          "email",
          provider("email", ["e2"]).monitor,
          "source-sync",
          at(4)
        )
      )
      .finally(() => (secondSettled = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const waitedForFirst = !secondSettled;
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(waitedForFirst).toBe(true);
    expect(a.cardsCreated).toBe(1);
    expect(b.cardsCreated).toBe(0);
    expect(await charges()).toEqual(["e1"]);
  });

  it("keeps saved global and source caps from a legacy whole-record save", async () => {
    await savePreference(legacyRecord({ email: 1, global: 8 }));
    expect((await scan("email", ["e1"], at(1))).cardsCreated).toBe(1);
    const sourceCapped = await scan("email", ["e2"], at(3));
    expect(sourceCapped.cardsCreated).toBe(0);

    await bootstrap.query(`DELETE FROM app.proactive_email_finding_charges`);
    await bootstrap.query(`DELETE FROM app.proactive_cards`);
    await savePreference(legacyRecord({ email: 3, notes: 3, global: 2 }));
    expect((await scan("notes", ["n1"], at(1))).cardsCreated).toBe(1);
    expect((await scan("email", ["e1"], at(2))).cardsCreated).toBe(1);
    const globalCapped = await scan("email", ["e2"], at(4));

    expect(globalCapped.cardsCreated).toBe(0);
    expect(globalCapped.cardsSuppressed).toBe(1);
    expect(await charges()).toEqual(["e1"]);
  });

  it("counts a dismissed email toward the global cap", async () => {
    await savePreference(legacyRecord({ email: 3, notes: 3, global: 2 }));
    expect((await scan("email", ["e1"], at(1))).cardsCreated).toBe(1);
    await dismiss("email", "e1");
    expect((await scan("notes", ["n1"], at(2))).cardsCreated).toBe(1);

    const capped = await scan("email", ["e2"], at(4));

    expect(capped.cardsCreated).toBe(0);
    expect(await charges()).toEqual(["e1"]);
  });

  it("holds the next email until an hour after a quiet-hours release", async () => {
    await savePreference(legacyRecord());
    // Quiet hours run 22:00-07:00 UTC, so e1 is held until 07:00.
    expect((await scan("email", ["e1"], at(1), true)).cardsDeferred).toBe(1);

    for (const time of ["03:00", "07:30"]) {
      const held = await scan("email", ["e2"], new Date(`${DAY}T${time}:00.000Z`), true);
      expect(held.cardsCreated + held.cardsDeferred).toBe(0);
    }
    expect(await charges()).toEqual(["e1"]);

    const released = await scan("email", ["e2"], new Date(`${DAY}T08:30:00.000Z`), true);
    expect(released.cardsCreated).toBe(1);
    expect(await charges()).toEqual(["e1", "e2"]);
  });

  it("charges nothing while automatic email alerts are saved off", async () => {
    await savePreference({ ...legacyRecord(), automaticEmailAlerts: false });

    const result = await scan("email", ["e1"], at(1));

    expect(result.skipReason).toBe("source_disabled");
    expect(await charges()).toEqual([]);
  });

  it("leaves non-email caps on the legacy active-card count", async () => {
    await savePreference(legacyRecord({ notes: 1 }));

    expect((await scan("notes", ["n1"], at(1))).cardsCreated).toBe(1);
    expect((await scan("notes", ["n2"], at(3))).cardsCreated).toBe(0);
    await dismiss("notes", "n1");
    expect((await scan("notes", ["n2"], at(5))).cardsCreated).toBe(1);
    expect(await charges()).toEqual([]);
  });
});

describe("unsaved limits and the owner's day (#3146)", () => {
  const policy = new EmailFindingPolicy();

  async function selectAt(stableKey: string, now: Date, timeZone = "UTC") {
    return context.withDataContext(actor, async (scopedDb) =>
      policy.select(scopedDb, {
        kind: "unsolicited",
        ownerUserId: ids.userA,
        stableKey,
        saved: await new ProactiveMonitoringPreferencesRepository().getSaved(scopedDb),
        nowIso: now.toISOString(),
        timeZone
      })
    );
  }

  it("selects at most one email finding per hour", async () => {
    expect(await selectAt("u1", at(1))).toEqual({ selected: true, charged: true });
    expect(await selectAt("u2", new Date(`${DAY}T01:30:00.000Z`))).toEqual({
      selected: false,
      reason: "source_hourly_cap"
    });
    expect(await selectAt("u3", new Date(`${DAY}T02:30:00.000Z`))).toEqual({
      selected: true,
      charged: true
    });
  });

  it("applies the unsaved email cap of 3 per day with no saved record", async () => {
    for (const [key, hour] of [
      ["u1", 1],
      ["u2", 3],
      ["u3", 5]
    ] as const) {
      expect(await selectAt(key, at(hour))).toEqual({ selected: true, charged: true });
    }
    expect(await selectAt("u4", at(7))).toEqual({ selected: false, reason: "source_daily_cap" });
    expect(await charges()).toEqual(["u1", "u2", "u3"]);
  });

  it("counts each charge on its selection day in the owner's time zone", async () => {
    await savePreference(legacyRecord({ email: 1 }));
    const zone = "America/New_York";

    // 03:00 UTC is 23:00 the previous evening in New York.
    expect(await selectAt("u1", at(3), zone)).toEqual({ selected: true, charged: true });
    expect(await selectAt("u2", at(13), zone)).toEqual({ selected: true, charged: true });
    expect(await selectAt("u3", at(20), zone)).toEqual({
      selected: false,
      reason: "source_daily_cap"
    });
  });
});

describe("requested email responsibilities (#3146)", () => {
  const policy = new EmailFindingPolicy();

  it("spend none of the unsolicited budget and ignore a saved master-off", async () => {
    await savePreference({ ...legacyRecord({ email: 1 }), enabled: false });

    const requested = await context.withDataContext(actor, async (scopedDb) => {
      const saved = await new ProactiveMonitoringPreferencesRepository().getSaved(scopedDb);
      return [
        await policy.select(scopedDb, {
          kind: "requested",
          ownerUserId: ids.userA,
          stableKey: "r1",
          saved,
          nowIso: at(1).toISOString(),
          timeZone: "UTC"
        }),
        await policy.select(scopedDb, {
          kind: "unsolicited",
          ownerUserId: ids.userA,
          stableKey: "u1",
          saved,
          nowIso: at(1).toISOString(),
          timeZone: "UTC"
        })
      ];
    });

    expect(requested).toEqual([
      { selected: true, charged: false, reason: "requested" },
      { selected: false, reason: "automatic_email_alerts_off" }
    ]);
    expect(await charges()).toEqual([]);
  });

  it("leave the full unsolicited budget for automatic alerts", async () => {
    await savePreference(legacyRecord({ email: 1 }));

    const outcomes = await context.withDataContext(actor, async (scopedDb) => {
      const saved = await new ProactiveMonitoringPreferencesRepository().getSaved(scopedDb);
      const base = { ownerUserId: ids.userA, saved, nowIso: at(1).toISOString(), timeZone: "UTC" };
      return [
        await policy.select(scopedDb, { ...base, kind: "requested", stableKey: "r1" }),
        await policy.select(scopedDb, { ...base, kind: "requested", stableKey: "r2" }),
        await policy.select(scopedDb, { ...base, kind: "unsolicited", stableKey: "u1" }),
        await policy.select(scopedDb, { ...base, kind: "unsolicited", stableKey: "u1" })
      ];
    });

    expect(outcomes).toEqual([
      { selected: true, charged: false, reason: "requested" },
      { selected: true, charged: false, reason: "requested" },
      { selected: true, charged: true },
      { selected: true, charged: false, reason: "already_selected" }
    ]);
    expect(await charges()).toEqual(["u1"]);
  });
});

describe("migration carry-forward (#3146)", () => {
  it("keeps legacy finding identity and the saved cursor across migration and restart", async () => {
    await savePreference(legacyRecord());
    await bootstrap.query(
      `INSERT INTO app.proactive_cards
         (owner_user_id, source, stable_key, source_ref_hash, title, summary, signal_type,
          priority_band, status, dismissed_at, created_at)
       VALUES ($1, 'email', 'legacy-active', 'h1', 't', 's', 'needs_reply_soon', 'high', 'active', NULL, $2),
              ($1, 'email', 'legacy-dismissed', 'h2', 't', 's', 'needs_reply_soon', 'high', 'dismissed', now(), $2),
              ($1, 'notes', 'legacy-note', 'h3', 't', 's', 'decision_changed', 'high', 'active', NULL, $2)`,
      [ids.userA, at(0).toISOString()]
    );
    await bootstrap.query(
      `INSERT INTO app.proactive_monitor_state (owner_user_id, source, cursor_json, last_checked_at)
       VALUES ($1, 'email', '{"checkedAt":"legacy-cursor"}', $2)`,
      [ids.userA, at(0).toISOString()]
    );
    // Return the database to its pre-0312 shape, then upgrade through the real runner and the
    // non-bypass migration owner, as an existing install would.
    await bootstrap.query(`DROP TABLE app.proactive_email_finding_charges;
      DELETE FROM app.schema_migrations WHERE version = '0312'`);
    const upgrade = () =>
      runSqlMigrations({
        connectionString: connectionStrings.migration,
        migrationsDirectory: proactiveMonitoringSqlMigrationDirectory
      });
    expect((await upgrade()).applied.map((item) => item.version)).toEqual(["0312"]);
    expect((await upgrade()).applied).toEqual([]);

    expect(await charges()).toEqual(["legacy-active", "legacy-dismissed"]);

    // A fresh scanner stands in for a worker restart.
    const { monitor, cursors } = provider("email", ["legacy-active", "legacy-dismissed"]);
    const result = await context.withDataContext(actor, (scopedDb) =>
      scanner().scan(scopedDb, ids.userA, "email", monitor, "source-sync", at(2))
    );

    expect(cursors).toEqual([{ checkedAt: "legacy-cursor" }]);
    expect(result.cardsCreated).toBe(0);
    expect(result.cardsUpdated).toBe(1);
    expect(await emailCards()).toEqual([
      { stable_key: "legacy-active", status: "active" },
      { stable_key: "legacy-dismissed", status: "dismissed" }
    ]);
  });
});
