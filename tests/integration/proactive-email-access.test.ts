import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { EmailRepository, createEmailMonitorProvider, emailModuleManifest } from "@moss/email";
import { PreferencesRepository } from "@moss/structured-state";
import {
  buildFeatureGrantService,
  ConnectorsRepository,
  createConnectorSecretCipher,
  featureGrantsPrefKey
} from "@moss/connectors";
import { createActiveModulesResolver, getBuiltInModuleManifests } from "@moss/module-registry";
import {
  AntiSpamPolicy,
  CardRepository,
  MonitorStateRepository,
  ProactiveScanner,
  ProactiveMonitoringPreferencesRepository,
  resolveAutomaticEmailAlertsEnabled
} from "@moss/proactive-monitoring";
import { PriorityPreferencesRepository } from "@moss/priority";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import { resolveAlertsQuietPolicy } from "@moss/settings";
import {
  defaultProactiveMonitoringPreference,
  PROACTIVE_MONITORING_PREFERENCE_KEY
} from "@moss/shared";
import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

const ALLOWED = "70000000-0000-4000-8000-000000003155";
const REVOKED = "70000000-0000-4000-8000-000000003156";
let db: Kysely<MossDatabase>;
let context: DataContextRunner;
let appDb: Kysely<MossDatabase>;
let appContext: DataContextRunner;
const preferences = new PreferencesRepository();
const connectors = new ConnectorsRepository();

function provider(manifests = getBuiltInModuleManifests) {
  const resolveActiveModules = createActiveModulesResolver({
    dataContext: context,
    manifests
  });
  return createEmailMonitorProvider({
    grantedAccountIds: buildFeatureGrantService({
      connectorsRepository: connectors,
      preferencesRepository: preferences
    }).grantedAccountIds,
    isModuleActive: async (actorUserId) =>
      (await resolveActiveModules(actorUserId)).some((manifest) => manifest.id === "email")
  });
}

function collect(actorUserId: string = ids.userA, monitor = provider()) {
  return context.withDataContext({ actorUserId }, (scopedDb) =>
    monitor.collectSignals(scopedDb, {
      ownerUserId: actorUserId,
      now: new Date().toISOString(),
      sinceCursor: {},
      timeZone: "UTC",
      maxSignals: 20,
      priorityAnchors: []
    })
  );
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  try {
    await bootstrap.query(
      `INSERT INTO app.users (id, email) VALUES ($1, 'access-a@example.test'), ($2, 'access-b@example.test')`,
      [ids.userA, ids.userB]
    );
    await bootstrap.query(
      `INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
      VALUES ($1, 'google', $3, ARRAY['https://www.googleapis.com/auth/gmail.modify'], 'active', '{}'),
             ($2, 'google', $3, ARRAY['https://www.googleapis.com/auth/gmail.modify'], 'active', '{}')`,
      [ALLOWED, REVOKED, ids.userA]
    );
  } finally {
    await bootstrap.end();
  }
  db = createDatabase({ connectionString: connectionStrings.worker });
  context = new DataContextRunner(db);
  appDb = createDatabase({ connectionString: connectionStrings.app });
  appContext = new DataContextRunner(appDb);
  await context.withDataContext({ actorUserId: ids.userA }, async (scopedDb) => {
    const email = new EmailRepository();
    for (const [account, subject] of [
      [ALLOWED, "Please reply: permitted"],
      [REVOKED, "Please reply: revoked"]
    ] as const) {
      await email.createCachedMessageForTest(scopedDb, {
        connectorAccountId: account,
        sender: "sender@example.test",
        subject,
        receivedAt: new Date().toISOString(),
        externalId: account
      });
    }
    await new PreferencesRepository().upsert(scopedDb, featureGrantsPrefKey(REVOKED), {
      email: false
    });
  });
});

afterAll(async () => {
  await db?.destroy();
  await appDb?.destroy();
});

beforeEach(async () => {
  const bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  try {
    await bootstrap.query(
      `UPDATE app.connector_accounts SET status = 'active', revoked_at = NULL, scopes = ARRAY['https://www.googleapis.com/auth/gmail.modify'] WHERE id = ANY($1::uuid[])`,
      [[ALLOWED, REVOKED]]
    );
  } finally {
    await bootstrap.end();
  }
  await appContext.withDataContext({ actorUserId: ids.userA }, async (scopedDb) => {
    await scopedDb.db
      .deleteFrom("app.preferences")
      .where("key", "=", PROACTIVE_MONITORING_PREFERENCE_KEY)
      .execute();
    await preferences.upsert(scopedDb, featureGrantsPrefKey(REVOKED), { email: false });
  });
});

it("does not overwrite an already saved-off email choice with unrelated preferences", async () => {
  const preferencesRepository = new ProactiveMonitoringPreferencesRepository();
  const savedOff = {
    ...defaultProactiveMonitoringPreference(),
    automaticEmailAlerts: false,
    sources: {
      ...defaultProactiveMonitoringPreference().sources,
      calendar: { enabled: true, dailyCardCap: 2 }
    },
    quietHours: { enabled: false, startLocalTime: "09:00", endLocalTime: "17:00" },
    updatedAt: "2026-10-08T00:00:00.000Z"
  };

  await appContext.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    preferencesRepository.upsertWithRevision(scopedDb, savedOff, null)
  );
  await context.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    preferencesRepository.initializeAutomaticEmailAlerts(scopedDb)
  );

  const saved = await context.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    preferencesRepository.getSaved(scopedDb)
  );

  expect(saved?.raw).toEqual(savedOff);
  expect(resolveAutomaticEmailAlertsEnabled(saved)).toBe(false);
});

it("a permitted account cannot admit a sibling's grant-revoked cached mail", async () => {
  const monitor = provider();
  await appContext.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    preferences.upsert(scopedDb, featureGrantsPrefKey(REVOKED), { email: true })
  );
  expect((await collect(ids.userA, monitor)).signals).toHaveLength(2);
  await appContext.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    preferences.upsert(scopedDb, featureGrantsPrefKey(REVOKED), { email: false })
  );
  expect((await collect(ids.userA, monitor)).signals.map((signal) => signal.title)).toEqual([
    "Please reply: permitted"
  ]);
});

it("an already constructed provider rechecks active modules at collection time", async () => {
  let manifests = getBuiltInModuleManifests();
  const monitor = provider(() => manifests);
  expect((await collect(ids.userA, monitor)).signals).toHaveLength(1);
  manifests = manifests.filter((manifest) => manifest.id !== "email");
  expect((await collect(ids.userA, monitor)).signals).toEqual([]);
});

it("an active account cannot admit a disconnected sibling's cached messages", async () => {
  await appContext.withDataContext({ actorUserId: ids.userA }, async (scopedDb) => {
    await preferences.upsert(scopedDb, featureGrantsPrefKey(REVOKED), { email: true });
    await connectors.revokeAccount(
      scopedDb,
      REVOKED,
      createConnectorSecretCipher().encryptJson({ revoked: true })
    );
  });
  expect((await collect()).signals.map((signal) => signal.title)).toEqual([
    "Please reply: permitted"
  ]);
});

it("an account in error or missing email scope cannot produce signals", async () => {
  await appContext.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    connectors.updateAccount(scopedDb, ALLOWED, { status: "error" })
  );
  expect((await collect()).signals).toEqual([]);
  await appContext.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    connectors.updateAccount(scopedDb, ALLOWED, { status: "active", scopes: [] })
  );
  expect((await collect()).signals).toEqual([]);
});

it("another owner cannot collect the first owner's cached mail", async () => {
  expect((await collect(ids.userB)).signals).toEqual([]);
});

it("the uncomposed manifest cannot collect cached mail without authority", async () => {
  expect((await collect(ids.userA, emailModuleManifest.proactiveMonitor)).signals).toEqual([]);
});

it("scheduled and manual scans collect only currently permitted mail through the same provider", async () => {
  const cards = new CardRepository();
  const scanner = new ProactiveScanner({
    preferencesRepository: new ProactiveMonitoringPreferencesRepository(),
    priorityPreferencesRepository: new PriorityPreferencesRepository(),
    monitorStateRepository: new MonitorStateRepository(),
    cardRepository: cards,
    antiSpamPolicy: new AntiSpamPolicy(cards),
    getLocalePreference: async () => null,
    resolveQuietHours: async () => null
  });
  await appContext.withDataContext({ actorUserId: ids.userA }, async (scopedDb) => {
    const pref = defaultProactiveMonitoringPreference();
    await preferences.upsert(scopedDb, PROACTIVE_MONITORING_PREFERENCE_KEY, {
      ...pref,
      enabled: true,
      sources: { ...pref.sources, email: { enabled: true, dailyCardCap: 3 } }
    });
  });
  let manifests = getBuiltInModuleManifests();
  const monitor = provider(() => manifests);
  const now = new Date();
  for (const [index, reason] of (["scheduled-check", "manual-refresh"] as const).entries()) {
    const result = await context.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      scanner.scan(
        scopedDb,
        ids.userA,
        "email",
        monitor,
        reason,
        new Date(now.getTime() + index * 16 * 60_000)
      )
    );
    expect(result).toMatchObject({ signalsReceived: 1, cardsCreated: 0, skipped: false });
  }
  manifests = manifests.filter((manifest) => manifest.id !== "email");
  const unavailable = await context.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
    scanner.scan(scopedDb, ids.userA, "email", monitor, "source-sync")
  );
  expect(unavailable).toMatchObject({ signalsReceived: 0, cardsCreated: 0, skipped: false });
});

describe("quiet hours through the real authority", () => {
  const now = new Date();

  function windowAround(timeZone: string): { start: string; end: string } {
    const at = (offsetMinutes: number) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(new Date(now.getTime() + offsetMinutes * 60_000));
    return { start: at(-60), end: at(60) };
  }

  function nested(enabled: boolean, window: { start: string; end: string }) {
    return { enabled, startLocalTime: window.start, endLocalTime: window.end };
  }

  /** Seeds the owner's stored rows, scans one critical signal, and returns its deferral. */
  async function deferralFor(
    key: string,
    rows: {
      alerts: ReturnType<typeof nested>;
      profile?: Record<string, unknown>;
      locale?: Record<string, unknown>;
    }
  ): Promise<Date | null> {
    const bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(`DELETE FROM app.proactive_cards WHERE owner_user_id = $1`, [
        ids.userA
      ]);
    } finally {
      await bootstrap.end();
    }
    await appContext.withDataContext({ actorUserId: ids.userA }, async (scopedDb) => {
      await scopedDb.db
        .deleteFrom("app.preferences")
        .where("key", "in", ["quiet-hours", "locale"])
        .execute();
      const pref = defaultProactiveMonitoringPreference();
      await preferences.upsert(scopedDb, PROACTIVE_MONITORING_PREFERENCE_KEY, {
        ...pref,
        enabled: true,
        sources: { ...pref.sources, email: { enabled: true, dailyCardCap: 3 } },
        quietHours: rows.alerts
      });
      if (rows.profile) await preferences.upsert(scopedDb, "quiet-hours", rows.profile);
      if (rows.locale) await preferences.upsert(scopedDb, "locale", rows.locale);
    });

    const cards = new CardRepository();
    const scanner = new ProactiveScanner({
      preferencesRepository: new ProactiveMonitoringPreferencesRepository(),
      priorityPreferencesRepository: new PriorityPreferencesRepository(),
      monitorStateRepository: new MonitorStateRepository(),
      cardRepository: cards,
      antiSpamPolicy: new AntiSpamPolicy(cards),
      getLocalePreference: async (scopedDb) =>
        ((await preferences.get(scopedDb, "locale")) as { timezone?: string } | null) ?? null,
      resolveQuietHours: resolveAlertsQuietPolicy
    });
    const monitor: ProactiveMonitorProvider = {
      source: "email",
      moduleId: "email",
      collectSignals: async () => ({
        signals: [
          {
            source: "email",
            stableKey: key,
            sourceRefHash: `hash:${key}`,
            signalType: "time_sensitive_follow_up",
            title: `Quiet hours ${key}`,
            summary: "Signature required",
            occurredAt: now.toISOString(),
            priorityCandidate: { explicitPriority: 5, dueAt: "2020-01-01T00:00:00Z" }
          }
        ],
        nextCursor: {}
      })
    };
    const result = await context.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      scanner.scan(scopedDb, ids.userA, "email", monitor, "source-sync", now)
    );
    expect(result.cardsCreated + result.cardsDeferred).toBe(1);

    const card = await context.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      scopedDb.db
        .selectFrom("app.proactive_cards")
        .select("deferred_until")
        .where("stable_key", "=", key)
        .executeTakeFirstOrThrow()
    );
    return card.deferred_until === null ? null : new Date(card.deferred_until);
  }

  it("a carried alerts schedule defers in the owner zone", async () => {
    const deferral = await deferralFor("quiet:carried", {
      alerts: nested(true, windowAround("Asia/Tokyo")),
      locale: { timezone: "Asia/Tokyo" }
    });
    expect(deferral).not.toBeNull();
  });

  it("a canonical Profile schedule governs over the alerts schedule, in its own zone", async () => {
    const tokyo = windowAround("Asia/Tokyo");
    const deferral = await deferralFor("quiet:canonical-zone", {
      alerts: nested(false, tokyo),
      profile: { enabled: true, ...tokyo, timezone: "Asia/Tokyo", authority: "canonical" }
    });
    expect(deferral).not.toBeNull();

    const off = await deferralFor("quiet:canonical-off", {
      alerts: nested(true, windowAround("UTC")),
      profile: {
        enabled: false,
        start: "22:00",
        end: "07:00",
        timezone: null,
        authority: "canonical"
      }
    });
    expect(off).toBeNull();
  });

  it("a conflicted pair keeps the alert workers on the alerts schedule", async () => {
    const utc = windowAround("UTC");
    const deferral = await deferralFor("quiet:conflict", {
      alerts: nested(false, utc),
      profile: { enabled: true, ...utc, timezone: null }
    });
    expect(deferral).toBeNull();
  });
});
