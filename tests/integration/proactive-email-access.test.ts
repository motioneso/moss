import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
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
