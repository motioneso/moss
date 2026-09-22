import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import { CardRepository } from "@moss/proactive-monitoring";
import { defaultProactiveMonitoringPreference } from "@moss/shared";
import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

const USER_C_ID = "00000000-0000-4000-8000-000000000099";
const SESSION_C_ID = "40000000-0000-4000-8000-000000000099";

const { Client } = pg;

const PROBE_CARD_BASE = {
  source: "tasks",
  stableKey: "probe:test",
  sourceRefHash: "aabbccdd11223344",
  title: "Test card",
  summary: "Test summary",
  signalType: "overdue_high_priority",
  priorityBand: "high" as const,
  priorityReasons: ["test"],
  occurredAt: null,
  targetAt: null,
  expiresAt: null,
  deferredUntil: null
};

describe("Proactive Monitoring — integration", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let cardRepo: CardRepository;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app });
    workerDb = createDatabase({ connectionString: connectionStrings.worker });
    dataContext = new DataContextRunner(workerDb);
    cardRepo = new CardRepository();

    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, $2, false), ($3, $4, false), ($5, $6, false)
         ON CONFLICT (id) DO NOTHING`,
        [
          ids.userA,
          "user-a@example.test",
          ids.userB,
          "user-b@example.test",
          USER_C_ID,
          "user-c@example.test"
        ]
      );
      await bootstrap.query(
        `INSERT INTO app.auth_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour'), ($3, $4, now() + interval '1 hour'), ($5, $6, now() + interval '1 hour')
         ON CONFLICT (id) DO NOTHING`,
        [ids.sessionA, ids.userA, ids.sessionB, ids.userB, SESSION_C_ID, USER_C_ID]
      );
    } finally {
      await bootstrap.end();
    }
  });

  afterAll(async () => {
    await appDb.destroy();
    await workerDb.destroy();
  });

  describe("RLS isolation", () => {
    it("userA cannot read userB proactive cards", async () => {
      const ctxA = { actorUserId: ids.userA, requestId: "test:rls-isolation" };
      const ctxB = { actorUserId: ids.userB, requestId: "test:rls-isolation" };

      // userB inserts a card via their context
      await dataContext.withDataContext(ctxB, async (scopedDb) => {
        await cardRepo.upsertCard(scopedDb, {
          ...PROBE_CARD_BASE,
          ownerUserId: ids.userB,
          stableKey: "rls:probe:b",
          title: "UserB private card"
        });
      });

      // userA sees zero cards
      const cardsSeenByA = await dataContext.withDataContext(ctxA, (scopedDb) =>
        cardRepo.listActive(scopedDb, ids.userA)
      );
      expect(cardsSeenByA).toHaveLength(0);

      // userB sees their own card
      const cardsSeenByB = await dataContext.withDataContext(ctxB, (scopedDb) =>
        cardRepo.listActive(scopedDb, ids.userB)
      );
      expect(cardsSeenByB.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("CardRepository lifecycle", () => {
    it("upsert, listActive, markDismissed, reactivate", async () => {
      const ctx = { actorUserId: ids.userA, requestId: "test:lifecycle" };

      const card = await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.upsertCard(scopedDb, {
          ...PROBE_CARD_BASE,
          ownerUserId: ids.userA,
          stableKey: "lifecycle:test"
        })
      );

      expect(card.status).toBe("active");

      // listActive returns the card
      const active = await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.listActive(scopedDb, ids.userA)
      );
      expect(active.some((c) => c.id === card.id)).toBe(true);

      // dismiss → no longer in active list
      await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.markDismissed(scopedDb, ids.userA, card.id)
      );
      const afterDismiss = await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.listActive(scopedDb, ids.userA)
      );
      expect(afterDismiss.some((c) => c.id === card.id)).toBe(false);

      // reactivate → back in active list
      await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.reactivate(scopedDb, ids.userA, card.id)
      );
      const afterReactivate = await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.listActive(scopedDb, ids.userA)
      );
      expect(afterReactivate.some((c) => c.id === card.id)).toBe(true);
    });

    it("idempotent upsert updates title and summary", async () => {
      const ctx = { actorUserId: ids.userA, requestId: "test:upsert-idempotent" };
      const stableKey = "upsert-idempotent:test";

      await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.upsertCard(scopedDb, {
          ...PROBE_CARD_BASE,
          ownerUserId: ids.userA,
          stableKey,
          title: "Old title"
        })
      );

      await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.upsertCard(scopedDb, {
          ...PROBE_CARD_BASE,
          ownerUserId: ids.userA,
          stableKey,
          title: "New title"
        })
      );

      const found = await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.findByStableKey(scopedDb, ids.userA, "tasks", stableKey)
      );
      expect(found?.title).toBe("New title");
    });
  });

  describe("Anti-spam: daily owner cap", () => {
    it("inserts up to 8 active cards; a 9th stable key returns suppressed verdict", async () => {
      const { AntiSpamPolicy } = await import("@moss/proactive-monitoring");
      // Use userC so no cards from other tests interfere with the global daily cap
      const ctx = { actorUserId: USER_C_ID, requestId: "test:antispam-day-cap" };
      const source = "email" as const;
      const now = new Date().toISOString();

      // Insert exactly 8 email cards for userC
      for (let i = 0; i < 8; i++) {
        await dataContext.withDataContext(ctx, (scopedDb) =>
          cardRepo.upsertCard(scopedDb, {
            ownerUserId: USER_C_ID,
            source,
            stableKey: `antispam:cap-test:${i}`,
            sourceRefHash: `hash${i}`,
            title: `Card ${i}`,
            summary: `Summary ${i}`,
            signalType: "time_sensitive_follow_up",
            priorityBand: "high",
            priorityReasons: [],
            occurredAt: null,
            targetAt: null,
            expiresAt: null,
            deferredUntil: null
          })
        );
      }

      // 9th card: anti-spam should suppress due to 8/owner/day cap
      const pref = {
        ...defaultProactiveMonitoringPreference(),
        enabled: true,
        dailyCardCap: 8,
        sources: {
          ...defaultProactiveMonitoringPreference().sources,
          email: { enabled: true, dailyCardCap: 100 } // won't hit source cap
        }
      };
      const antiSpam = new AntiSpamPolicy(cardRepo);
      const verdict = await dataContext.withDataContext(ctx, (scopedDb) =>
        antiSpam.check(scopedDb, USER_C_ID, source, "antispam:cap-test:new", pref, now, "UTC")
      );

      expect(verdict.allow).toBe(false);
    });
  });

  describe("Anti-spam: per-source hourly cap", () => {
    it("1/source/hour cap suppresses second card for same source within an hour", async () => {
      const { AntiSpamPolicy } = await import("@moss/proactive-monitoring");
      // Use userC with calendar (userC has no calendar cards yet)
      const ctx = { actorUserId: USER_C_ID, requestId: "test:antispam-hour-cap" };
      const source = "calendar" as const;
      const now = new Date().toISOString();

      // Insert one calendar card for userC within this hour
      await dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepo.upsertCard(scopedDb, {
          ownerUserId: USER_C_ID,
          source,
          stableKey: "hour-cap:first",
          sourceRefHash: "hfirst",
          title: "First calendar card",
          summary: "Summary",
          signalType: "dense_schedule",
          priorityBand: "high",
          priorityReasons: [],
          occurredAt: null,
          targetAt: null,
          expiresAt: null,
          deferredUntil: null
        })
      );

      // Second calendar card within the same hour → hourly cap suppresses
      const pref = {
        ...defaultProactiveMonitoringPreference(),
        enabled: true,
        dailyCardCap: 100, // high so global cap won't fire
        sources: {
          ...defaultProactiveMonitoringPreference().sources,
          calendar: { enabled: true, dailyCardCap: 100 } // high so source daily cap won't fire
        }
      };
      const antiSpam = new AntiSpamPolicy(cardRepo);
      const verdict = await dataContext.withDataContext(ctx, (scopedDb) =>
        antiSpam.check(scopedDb, USER_C_ID, source, "hour-cap:second", pref, now, "UTC")
      );

      // 1 calendar card inserted this hour → hourly cap fires
      expect(verdict.allow).toBe(false);
      if (!verdict.allow) {
        expect(verdict.reason).toBe("source_hourly_cap");
      }
    });
  });

  describe("findById ownership check", () => {
    it("findById returns undefined for wrong owner", async () => {
      const ctxA = { actorUserId: ids.userA, requestId: "test:find-ownership" };
      const ctxB = { actorUserId: ids.userB, requestId: "test:find-ownership" };

      const card = await dataContext.withDataContext(ctxA, (scopedDb) =>
        cardRepo.upsertCard(scopedDb, {
          ...PROBE_CARD_BASE,
          ownerUserId: ids.userA,
          stableKey: "find-ownership:probe"
        })
      );

      // userB cannot find userA's card by id
      const found = await dataContext.withDataContext(ctxB, (scopedDb) =>
        cardRepo.findById(scopedDb, ids.userB, card.id)
      );
      expect(found).toBeUndefined();
    });
  });

  describe("Scanner cross-user isolation", () => {
    const NOW = new Date("2026-09-15T12:00:00.000Z");
    const PAST = "2026-09-01T10:00:00.000Z";

    function notesSignal(stableKey: string, title: string) {
      return {
        source: "notes",
        stableKey,
        sourceRefHash: `hash-${stableKey}`,
        signalType: "decision_changed",
        title,
        summary: `${title} summary`,
        occurredAt: PAST,
        priorityCandidate: { explicitPriority: 5, dueAt: PAST, effort: "large" }
      };
    }

    function capturingProvider(signals: ReturnType<typeof notesSignal>[]) {
      const seen: { ownerUserId: string; priorityAnchors: unknown }[] = [];
      const provider = {
        source: "notes",
        moduleId: "notes",
        collectSignals: vi.fn(async (_db: unknown, input: never) => {
          const typed = input as unknown as {
            ownerUserId: string;
            priorityAnchors: unknown;
          };
          seen.push({ ownerUserId: typed.ownerUserId, priorityAnchors: typed.priorityAnchors });
          return { signals, nextCursor: {} };
        })
      } as unknown as ProactiveMonitorProvider;
      return { provider, seen };
    }

    function priorityModel(label: string) {
      return {
        version: 1,
        mode: "balanced",
        anchors: [
          {
            id: `anchor-${label}`,
            kind: "project",
            label,
            aliases: [],
            weight: 2,
            enabled: true,
            createdAt: PAST,
            updatedAt: PAST
          }
        ],
        mutedSources: [],
        updatedAt: PAST
      };
    }

    it("one user's scan never writes or leaks to another user", async () => {
      const {
        ProactiveScanner,
        ProactiveMonitoringPreferencesRepository,
        MonitorStateRepository,
        AntiSpamPolicy
      } = await import("@moss/proactive-monitoring");
      const { PriorityPreferencesRepository } = await import("@moss/priority");

      const ctxA = { actorUserId: ids.userA, requestId: "test:scanner-isolation-a" };
      const ctxB = { actorUserId: ids.userB, requestId: "test:scanner-isolation-b" };

      // Each user enables only notes, with quiet hours off for determinism.
      const prefsRepo = new ProactiveMonitoringPreferencesRepository();
      for (const ctx of [ctxA, ctxB]) {
        const base = defaultProactiveMonitoringPreference();
        await dataContext.withDataContext(ctx, (scopedDb) =>
          prefsRepo.upsert(scopedDb, {
            ...base,
            enabled: true,
            dailyCardCap: 20,
            sources: {
              tasks: { enabled: false, dailyCardCap: 3 },
              calendar: { enabled: false, dailyCardCap: 3 },
              email: { enabled: false, dailyCardCap: 3 },
              notes: { enabled: true, dailyCardCap: 5 }
            },
            quietHours: { enabled: false, startLocalTime: "22:00", endLocalTime: "08:00" },
            updatedAt: new Date().toISOString()
          })
        );
      }

      // Each user gets a different priority model. The scanner reads the model
      // with no owner filter, so row-level security is the only thing keeping
      // one user's anchors out of the other user's scan.
      const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
      await bootstrap.connect();
      try {
        for (const [userId, model] of [
          [ids.userA, priorityModel("HarborLight")],
          [ids.userB, priorityModel("CinderPeak")]
        ] as const) {
          await bootstrap.query(
            `INSERT INTO app.preferences (owner_user_id, key, value_json, updated_at)
             VALUES ($1, 'priority.model.v1', $2::jsonb, now())
             ON CONFLICT (owner_user_id, key) DO UPDATE
             SET value_json = EXCLUDED.value_json, updated_at = now()`,
            [userId, JSON.stringify(model)]
          );
        }
      } finally {
        await bootstrap.end();
      }

      const scanner = new ProactiveScanner({
        preferencesRepository: prefsRepo,
        priorityPreferencesRepository: new PriorityPreferencesRepository(),
        monitorStateRepository: new MonitorStateRepository(),
        cardRepository: cardRepo,
        antiSpamPolicy: new AntiSpamPolicy(cardRepo),
        getLocalePreference: async () => ({ timezone: "UTC" })
      });

      const { provider: providerA, seen: seenA } = capturingProvider([
        notesSignal("iso-scan:a:1", "Harbor bill")
      ]);
      const { provider: providerB, seen: seenB } = capturingProvider([
        notesSignal("iso-scan:b:1", "Cinder bill")
      ]);

      const resultA = await dataContext.withDataContext(ctxA, (scopedDb) =>
        scanner.scan(scopedDb, ids.userA, "notes", providerA, "source-sync", NOW)
      );
      const resultB = await dataContext.withDataContext(ctxB, (scopedDb) =>
        scanner.scan(scopedDb, ids.userB, "notes", providerB, "source-sync", NOW)
      );
      expect(resultA.cardsCreated).toBe(1);
      expect(resultB.cardsCreated).toBe(1);

      // Each provider receives its own user's anchors, never the other's.
      expect(seenA).toHaveLength(1);
      expect(seenA[0]).toMatchObject({
        ownerUserId: ids.userA,
        priorityAnchors: [{ label: "HarborLight", aliases: [] }]
      });
      expect(seenB).toHaveLength(1);
      expect(seenB[0]).toMatchObject({
        ownerUserId: ids.userB,
        priorityAnchors: [{ label: "CinderPeak", aliases: [] }]
      });

      // Each user's active list holds only their own card.
      const cardsA = await dataContext.withDataContext(ctxA, (scopedDb) =>
        cardRepo.listActive(scopedDb, ids.userA, 50)
      );
      const cardsB = await dataContext.withDataContext(ctxB, (scopedDb) =>
        cardRepo.listActive(scopedDb, ids.userB, 50)
      );
      const titlesA = cardsA.map((c) => c.title);
      const titlesB = cardsB.map((c) => c.title);
      expect(titlesA).toContain("Harbor bill");
      expect(titlesA).not.toContain("Cinder bill");
      expect(titlesB).toContain("Cinder bill");
      expect(titlesB).not.toContain("Harbor bill");

      // A scan run inside B's context but handed A's id must not write for A:
      // the card write violates the owner policy, so the scan fails loudly.
      const { provider: providerCross } = capturingProvider([
        notesSignal("iso-cross:1", "Cross bill")
      ]);
      await expect(
        dataContext.withDataContext(ctxB, (scopedDb) =>
          scanner.scan(scopedDb, ids.userA, "notes", providerCross, "source-sync", NOW)
        )
      ).rejects.toThrow();
      const cross = await dataContext.withDataContext(ctxA, (scopedDb) =>
        cardRepo.findByStableKey(scopedDb, ids.userA, "notes", "iso-cross:1")
      );
      expect(cross).toBeUndefined();
    });
  });
});
