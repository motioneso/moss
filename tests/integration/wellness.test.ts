import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import {
  WELLNESS_EMOTION_CORES,
  createCheckinRequestSchema,
  EMOTIONS,
  BODY_SENSATIONS,
  isValidFeelingPath
} from "@moss/shared";
import {
  WellnessRepository,
  computeSchedule,
  computeInsights,
  wellnessModuleManifest,
  WELLNESS_MODULE_ID,
  wellnessRecentCheckInsExecute,
  wellnessMedicationAdherenceExecute,
  deriveEnergyTrend,
  WellnessRecallContributor,
  wellnessFocusSignal
} from "@moss/wellness";
import type { Medication, MedicationLog } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import {
  aggregateFocusSignals,
  type FocusSignal,
  type FocusSignalContextRunner
} from "@moss/module-sdk";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { TasksRepository, registerTasksRoutes } from "@moss/tasks";
import { BriefingsRepository } from "@moss/briefings";
import { ChatMemoryFactsRepository } from "@moss/memory";
import { PreferencesRepository } from "@moss/structured-state";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";
import { makeComposeDeps } from "./briefings.helpers.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000041";
const otherUserId = "00000000-0000-4000-8000-000000000042";

function ctx(actorUserId: string): AccessContext {
  return { actorUserId, requestId: "req:wellness-test" };
}

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-a@example.test', false), ($2, 'well-b@example.test', false)`,
      [userId, otherUserId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("Wellness module — manifest", () => {
  it("is the first required:false / user-toggleable module", () => {
    expect(WELLNESS_MODULE_ID).toBe("wellness");
    expect(wellnessModuleManifest.lifecycle).toBe("user-toggleable");
    expect(wellnessModuleManifest.availability?.defaultEnabled).toBe(true);
    expect(wellnessModuleManifest.availability?.required).toBe(false);
    expect(wellnessModuleManifest.availability?.supportsUserDisable).toBe(true);
    expect(wellnessModuleManifest.compatibility.jarv1s).toBe(">=0.0.0");
  });
});

describe("wellness_checkins table + RLS", () => {
  it("owner can insert multiple check-ins same day; lists own only; RLS blocks other user", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      for (let i = 0; i < 2; i++) {
        await scopedDb.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            feeling_core: "fear",
            feeling_secondary: "anxious",
            sensations: sql<string[]>`ARRAY['tight chest']::text[]`,
            intensity: 4,
            note: `note-${i.toString()}`
          })
          .execute();
      }
    });

    const ownRows = await dataContext.withDataContext(ctx(userId), (scopedDb) =>
      scopedDb.db.selectFrom("app.wellness_checkins").selectAll().execute()
    );
    expect(ownRows.length).toBe(2);
    expect(ownRows[0]?.wheel_version).toBe("jarvis-emotion-v1");

    const otherRows = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      scopedDb.db.selectFrom("app.wellness_checkins").selectAll().execute()
    );
    expect(otherRows.length).toBe(0);
  });

  it("rejects a feeling_core outside the enum", async () => {
    await expect(
      dataContext.withDataContext(ctx(userId), (scopedDb) =>
        scopedDb.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            feeling_core: "not-a-feeling" as never
          })
          .execute()
      )
    ).rejects.toThrow();
  });
});

describe("medications + medication_logs tables + RLS", () => {
  it("owner can create a med + a log; denormalized owner; RLS blocks other user", async () => {
    let medId = "";
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const med = await scopedDb.db
        .insertInto("app.medications")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          name: "Sertraline",
          dosage: "50 mg",
          frequency_type: "once_daily",
          schedule_times: sql<string[]>`ARRAY['08:00']::time[]`
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      medId = med.id;

      await scopedDb.db
        .insertInto("app.medication_logs")
        .values({
          medication_id: medId,
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          status: "taken",
          dose: "50 mg",
          // Scheduled (non-PRN) logs must carry scheduled_for (DB CHECK).
          scheduled_for: sql<Date>`now()`
        })
        .execute();
    });

    const otherMeds = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      scopedDb.db.selectFrom("app.medications").selectAll().execute()
    );
    expect(otherMeds.length).toBe(0);

    const otherLogs = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      scopedDb.db.selectFrom("app.medication_logs").selectAll().execute()
    );
    expect(otherLogs.length).toBe(0);
  });

  it("rejects a medication_log whose owner differs from the parent medication's owner", async () => {
    let medId = "";
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const med = await scopedDb.db
        .insertInto("app.medications")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          name: "Test Med",
          frequency_type: "as_needed"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      medId = med.id;
    });

    // otherUser attempts to log against userId's medication: RLS INSERT WITH CHECK
    // requires owner_user_id = current actor, and the trigger requires it to equal the
    // parent med owner — so this must fail.
    await expect(
      dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
        scopedDb.db
          .insertInto("app.medication_logs")
          .values({
            medication_id: medId,
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            status: "prn",
            prn_reason: "headache"
          })
          .execute()
      )
    ).rejects.toThrow();
  });
});

describe("wellness shared contract", () => {
  it("exposes the six emotion cores and a create-checkin request schema", () => {
    expect(WELLNESS_EMOTION_CORES).toEqual([
      "happy",
      "sad",
      "fear",
      "anger",
      "disgust",
      "surprise"
    ]);
    expect(createCheckinRequestSchema.required).toContain("feelingCore");
    expect(createCheckinRequestSchema.additionalProperties).toBe(false);
  });
});

describe("WellnessRepository", () => {
  const repo = new WellnessRepository();

  it("createCheckin persists the full wheel path + sensations; listCheckins is owner-scoped", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.createCheckin(scopedDb, {
        feelingCore: "fear",
        feelingSecondary: "Anxious",
        feelingTertiary: null,
        sensations: ["tight chest", "racing heart"],
        intensity: 4,
        note: "deadline",
        identifiedVia: "assisted"
      });
      const list = await repo.listCheckins(scopedDb, { limit: 10 });
      const latest = list[0];
      expect(latest?.feeling_core).toBe("fear");
      expect(latest?.feeling_tertiary).toBeNull();
      expect(latest?.sensations).toEqual(["tight chest", "racing heart"]);
      expect(latest?.identified_via).toBe("assisted");
    });
  });

  it("createMedication + logDose; getSchedule marks a slot taken from a same-day log", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const med = await repo.createMedication(
        scopedDb,
        {
          name: "Levothyroxine",
          frequencyType: "once_daily",
          scheduleTimes: ["08:00"]
        },
        "UTC"
      );
      const today = new Date();
      const scheduledFor = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 0, 0)
      ).toISOString();
      await repo.logDose(scopedDb, med.id, {
        status: "taken",
        scheduledFor
      });
      const log = await repo.listRecentLogs(scopedDb, { sinceDays: 1 });
      expect(log.some((l) => l.medication_id === med.id && l.status === "taken")).toBe(true);
    });
  });

  it("re-logging the same scheduled slot CORRECTS the status (upsert, reversible)", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const med = await repo.createMedication(
        scopedDb,
        {
          name: "Metformin",
          frequencyType: "once_daily",
          scheduleTimes: ["08:00"]
        },
        "UTC"
      );
      const today = new Date();
      const scheduledFor = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 0, 0)
      ).toISOString();

      // First log: accidentally "skipped".
      const skipped = await repo.logDose(scopedDb, med.id, { status: "skipped", scheduledFor });
      expect(skipped.status).toBe("skipped");

      // Correct it to "taken" — must succeed (no unique-violation) and overwrite, not duplicate.
      const taken = await repo.logDose(scopedDb, med.id, { status: "taken", scheduledFor });
      expect(taken.status).toBe("taken");

      // Exactly ONE log row for that (med, slot) — the correction overwrote the prior log.
      const logs = await scopedDb.db
        .selectFrom("app.medication_logs")
        .selectAll()
        .where("medication_id", "=", med.id)
        .where("scheduled_for", "=", new Date(scheduledFor))
        .execute();
      expect(logs.length).toBe(1);
      expect(logs[0]?.status).toBe("taken");
    });
  });

  it("createCheckin throws on an unbranded handle (DataContextDb guard)", async () => {
    await expect(
      repo.createCheckin(appDb as unknown as never, { feelingCore: "happy" })
    ).rejects.toThrow("Repository access requires withDataContext");
  });
});

describe("computeSchedule (pure)", () => {
  const date = new Date("2026-06-15T00:00:00.000Z"); // Monday

  function med(overrides: Partial<Medication>): Medication {
    return {
      id: "m1",
      owner_user_id: userId,
      name: "Med",
      dosage: null,
      form: null,
      frequency_type: "once_daily",
      times_per_day: null,
      interval_hours: null,
      weekdays: null,
      schedule_times: null,
      cycle_days_on: null,
      cycle_days_off: null,
      cycle_anchor_date: null,
      active: true,
      notes: null,
      created_at: date,
      updated_at: date,
      ...overrides
    } as Medication;
  }

  it("once_daily with schedule_times yields a slot per time", () => {
    const slots = computeSchedule([med({ schedule_times: ["08:00", "20:00"] })], [], date);
    expect(slots.filter((s) => !s.asNeeded).length).toBe(2);
    expect(slots[0]?.status).toBe("pending");
  });

  it("specific_weekdays only yields slots on a matching weekday", () => {
    const onMonday = computeSchedule(
      [med({ frequency_type: "specific_weekdays", weekdays: [1], schedule_times: ["09:00"] })],
      [],
      date // Monday = ISO 1
    );
    expect(onMonday.filter((s) => !s.asNeeded).length).toBe(1);
    const onTuesday = computeSchedule(
      [med({ frequency_type: "specific_weekdays", weekdays: [2], schedule_times: ["09:00"] })],
      [],
      date
    );
    expect(onTuesday.filter((s) => !s.asNeeded).length).toBe(0);
  });

  it("as_needed yields a single asNeeded affordance, no fixed slot", () => {
    const slots = computeSchedule([med({ frequency_type: "as_needed" })], [], date);
    expect(slots.length).toBe(1);
    expect(slots[0]?.asNeeded).toBe(true);
  });

  it("every_n_hours generates interval slots across the civil day (anchored at midnight)", () => {
    // interval 6h, no schedule_time anchor → 00:00, 06:00, 12:00, 18:00.
    const slots = computeSchedule(
      [med({ frequency_type: "every_n_hours", interval_hours: 6, schedule_times: null })],
      [],
      date
    );
    const scheduled = slots.filter((s) => !s.asNeeded);
    expect(scheduled.length).toBe(4);
    expect(scheduled.map((s) => s.scheduledFor?.slice(11, 16))).toEqual([
      "00:00",
      "06:00",
      "12:00",
      "18:00"
    ]);
    // Regression guard: an every_n_hours med must NOT be invisible on the schedule.
    expect(scheduled.length).toBeGreaterThan(0);
  });

  it("every_n_hours anchors at the first schedule_time when provided", () => {
    // interval 8h anchored at 06:00 → 06:00, 14:00, 22:00 (next would be 30:00 = past midnight).
    const slots = computeSchedule(
      [med({ frequency_type: "every_n_hours", interval_hours: 8, schedule_times: ["06:00"] })],
      [],
      date
    );
    const scheduled = slots.filter((s) => !s.asNeeded);
    expect(scheduled.map((s) => s.scheduledFor?.slice(11, 16))).toEqual([
      "06:00",
      "14:00",
      "22:00"
    ]);
  });

  it("every_n_hours marks an interval slot taken from a matching same-day log", () => {
    const m = med({
      id: "mi",
      frequency_type: "every_n_hours",
      interval_hours: 12,
      schedule_times: null
    });
    const scheduledFor = new Date("2026-06-15T12:00:00.000Z");
    const log: MedicationLog = {
      id: "li",
      medication_id: "mi",
      owner_user_id: userId,
      status: "taken",
      dose: null,
      prn_reason: null,
      scheduled_for: scheduledFor,
      logged_at: scheduledFor,
      created_at: scheduledFor
    } as MedicationLog;
    const slots = computeSchedule([m], [log], date);
    const noon = slots.find((s) => s.scheduledFor?.slice(11, 16) === "12:00");
    expect(noon?.status).toBe("taken");
  });

  it("a matching same-day log marks the slot taken", () => {
    const m = med({ id: "mx", schedule_times: ["08:00"] });
    const scheduledFor = new Date("2026-06-15T08:00:00.000Z");
    const log: MedicationLog = {
      id: "l1",
      medication_id: "mx",
      owner_user_id: userId,
      status: "taken",
      dose: null,
      prn_reason: null,
      scheduled_for: scheduledFor,
      logged_at: scheduledFor,
      created_at: scheduledFor
    } as MedicationLog;
    const slots = computeSchedule([m], [log], date);
    expect(slots.find((s) => !s.asNeeded)?.status).toBe("taken");
  });
});

describe("wellness AI read tools", () => {
  function toolCtx(actorUserId: string): ToolContext {
    return { actorUserId, requestId: "tool-req", chatSessionId: "" };
  }

  it("wellness.recentCheckIns defaults consent on when pref is unset on active tool path", async () => {
    await dataContext.withDataContext(ctx(userId), (db) =>
      new PreferencesRepository().delete(db, "wellness.ai_consent_granted")
    );
    await dataContext.withDataContext(ctx(userId), (db) =>
      new WellnessRepository().createCheckin(db, { feelingCore: "happy", intensity: 4 })
    );
    const result = await dataContext.withDataContext(ctx(userId), (db) =>
      wellnessRecentCheckInsExecute(db, {}, toolCtx(userId))
    );
    expect(result.data.items).toBeDefined();
  });

  it("wellness.recentCheckIns returns owner-scoped check-ins and is declared read", async () => {
    const tool = wellnessModuleManifest.assistantTools?.find(
      (t) => t.name === "wellness.recentCheckIns"
    );
    expect(tool?.risk).toBe("read");
    expect(tool?.execute).toBeDefined();

    await dataContext.withDataContext(ctx(userId), (db) =>
      new PreferencesRepository().upsert(db, "wellness.ai_consent_granted", true)
    );
    await dataContext.withDataContext(ctx(userId), (db) =>
      new WellnessRepository().createCheckin(db, { feelingCore: "happy", intensity: 4 })
    );
    const result = await dataContext.withDataContext(ctx(userId), (db) =>
      wellnessRecentCheckInsExecute(db, {}, toolCtx(userId))
    );
    const items = result.data.items as Array<{ feelingCore: string }>;
    expect(items.length).toBeGreaterThan(0);
  });

  it("explicit false consent denies both Wellness read tools", async () => {
    await dataContext.withDataContext(ctx(userId), (db) =>
      new PreferencesRepository().upsert(db, "wellness.ai_consent_granted", false)
    );

    await expect(
      dataContext.withDataContext(ctx(userId), (db) =>
        wellnessRecentCheckInsExecute(db, {}, toolCtx(userId))
      )
    ).resolves.toMatchObject({ data: { code: "WELLNESS_CONSENT_REQUIRED" } });
    await expect(
      dataContext.withDataContext(ctx(userId), (db) =>
        wellnessMedicationAdherenceExecute(db, {}, toolCtx(userId))
      )
    ).resolves.toMatchObject({ data: { code: "WELLNESS_CONSENT_REQUIRED" } });
  });

  it("wellness.medicationAdherence returns counts only (no full med list)", async () => {
    await dataContext.withDataContext(ctx(userId), (db) =>
      new PreferencesRepository().upsert(db, "wellness.ai_consent_granted", true)
    );
    const result = await dataContext.withDataContext(ctx(userId), (db) =>
      wellnessMedicationAdherenceExecute(db, {}, toolCtx(userId))
    );
    expect(result.data).toHaveProperty("scheduled");
    expect(result.data).toHaveProperty("taken");
    expect(result.data).not.toHaveProperty("medications");
    expect(result.data).not.toHaveProperty("items");
  });

  it("every manifest route corresponds to a declared permission", () => {
    const permissionIds = new Set((wellnessModuleManifest.permissions ?? []).map((p) => p.id));
    for (const route of wellnessModuleManifest.routes ?? []) {
      if (route.permissionId) expect(permissionIds.has(route.permissionId)).toBe(true);
    }
  });

  it("declares a metadata-only deferred reminder queue but no active queueDefinitions", () => {
    const job = (wellnessModuleManifest.jobs ?? [])[0];
    expect(job?.queueName).toBe("wellness-medication-reminder");
    expect(job?.metadataOnly).toBe(true);
  });
});

describe("wellness registry integration", () => {
  it("wellness is registered exactly once in BUILT_IN_MODULES and is required:false", () => {
    const manifests = getBuiltInModuleManifests();
    const wellness = manifests.filter((m) => m.id === "wellness");
    expect(wellness.length).toBe(1);
    expect(wellness[0]?.availability?.required).toBe(false);

    const optional = manifests.filter((m) => m.availability?.required === false);
    expect(optional.map((m) => m.id)).toContain("wellness");
  });

  it("wellness routes are reachable through registerBuiltInApiRoutes (briefings can resolve its tools)", () => {
    const manifest = getBuiltInModuleManifests().find((m) => m.id === "wellness");
    const toolNames = (manifest?.assistantTools ?? []).map((t) => t.name);
    expect(toolNames).toContain("wellness.recentCheckIns");
  });
});

describe("briefings Wellness section (existing read-tool seam, zero briefings change)", () => {
  // INTEGRATION DESIGN FORK (deferred to Ben — 2026-06-13): p5 surfaced a wellness section in
  // briefings via the OLD seam, where a definition's `selectedToolNames` drove which read tools
  // ran during synthesis. The real-briefings slice (merged before this) deliberately replaced
  // that with a FIXED grounding set in compose.ts (commitments/tasks/calendar/email/chat) and
  // does NOT execute definition.selectedToolNames at all — so wellness.recentCheckIns never runs
  // and no section renders. The wellness MODULE is fully functional; only this briefings-section
  // contribution seam is affected. Resolving it is an architecture decision — should an optional
  // module contribute a briefing section via a generic selectedToolNames gather (module-agnostic,
  // restoring this seam) or some other declared contribution point? — that should not be made
  // unilaterally over real-briefings' Codex-approved fixed-set design. Skipped (honestly, not
  // deleted) until that fork is decided. See the overnight log "Design forks" section.
  it.skip("a briefing definition selecting wellness.recentCheckIns renders a section", async () => {
    const briefings = new BriefingsRepository();

    // Seed a check-in so the tool has data.
    await dataContext.withDataContext(ctx(userId), (db) =>
      new WellnessRepository().createCheckin(db, { feelingCore: "sad", intensity: 2 })
    );

    const definition = await dataContext.withDataContext(ctx(userId), (db) =>
      briefings.createDefinition(db, {
        title: "Daily Wellness",
        cadence: "manual",
        selectedToolNames: ["wellness.recentCheckIns"]
      })
    );

    const result = await dataContext.withDataContext(ctx(userId), (db) =>
      briefings.generateRun(db, definition.id, {
        runKind: "manual",
        // real-briefings made composeDeps required (synthesis + grounding seam) and
        // generateRun now returns { run, created }. moduleManifests (incl. wellness)
        // resolves wellness.recentCheckIns; makeComposeDeps() supplies the synth seam.
        moduleManifests: getBuiltInModuleManifests(),
        composeDeps: makeComposeDeps()
      })
    );

    expect(result?.run.status).toBe("succeeded");
    const tools =
      (result?.run.source_metadata as { tools?: Array<{ name: string; status: string }> }).tools ??
      [];
    expect(tools.some((t) => t.name === "wellness.recentCheckIns" && t.status !== "failed")).toBe(
      true
    );
  });
});

describe("wellness chat recall energy-trend fact", () => {
  it("deriveEnergyTrend produces an abstracted, non-clinical trend string (no raw feelings)", () => {
    const trend = deriveEnergyTrend([
      { energy: 2, feeling_core: "sad" } as never,
      { energy: 1, feeling_core: "fear" } as never,
      { energy: 2, feeling_core: "sad" } as never
    ]);
    expect(trend).not.toBeNull();
    expect(trend?.toLowerCase()).toContain("energy");
    // Must NOT contain a raw emotion word.
    expect(trend?.toLowerCase()).not.toContain("sad");
    expect(trend?.toLowerCase()).not.toContain("fear");
  });

  it("deriveEnergyTrend returns null when there are no recent check-ins", () => {
    expect(deriveEnergyTrend([])).toBeNull();
  });

  it("contributor upserts a profile fact that listActiveFacts picks up", async () => {
    const contributor = new WellnessRecallContributor();
    const facts = new ChatMemoryFactsRepository();

    await dataContext.withDataContext(ctx(userId), async (db) => {
      await new WellnessRepository().createCheckin(db, {
        feelingCore: "sad",
        intensity: 1,
        energy: 1
      });
      await new WellnessRepository().createCheckin(db, {
        feelingCore: "fear",
        intensity: 2,
        energy: 2
      });
      await contributor.refreshEnergyTrendFact(db, userId, true);
      const active = await facts.listActiveFacts(db, userId);
      expect(
        active.some((f) => f.category === "profile" && f.content.toLowerCase().includes("energy"))
      ).toBe(true);
    });
  });

  it("concurrent refreshes leave exactly ONE active energy-trend fact (advisory lock)", async () => {
    // Dedicated owner so this isn't perturbed by other tests' facts.
    const owner = "00000000-0000-4000-8000-000000000044";
    const seed = new Client({ connectionString: connectionStrings.bootstrap });
    await seed.connect();
    try {
      await seed.query(
        `INSERT INTO app.users (id, email, is_instance_admin)
         VALUES ($1,'concurrent@example.test',false) ON CONFLICT (id) DO NOTHING`,
        [owner]
      );
    } finally {
      await seed.end();
    }

    const contributor = new WellnessRecallContributor();
    const facts = new ChatMemoryFactsRepository();

    // Seed an energy-bearing check-in so deriveEnergyTrend returns a non-null trend.
    await dataContext.withDataContext(ctx(owner), (db) =>
      new WellnessRepository().createCheckin(db, { feelingCore: "sad", intensity: 2, energy: 2 })
    );

    // Two refreshes run in PARALLEL transactions. Without the per-owner advisory lock both
    // would read "no active fact" and each insert → two active facts. The lock serializes them.
    await Promise.all([
      dataContext.withDataContext(ctx(owner), (db) =>
        contributor.refreshEnergyTrendFact(db, owner, true)
      ),
      dataContext.withDataContext(ctx(owner), (db) =>
        contributor.refreshEnergyTrendFact(db, owner, true)
      )
    ]);

    const active = await dataContext.withDataContext(ctx(owner), (db) =>
      facts.listActiveFacts(db, owner)
    );
    const energyFacts = active.filter(
      (f) => f.category === "profile" && f.content.includes("[wellness:energy-trend]")
    );
    expect(energyFacts.length).toBe(1);
  });
});

describe("focus-signal contribution point", () => {
  it("wellness provider returns null with no check-ins", async () => {
    const fresh = "00000000-0000-4000-8000-000000000043";
    const client2 = new Client({ connectionString: connectionStrings.bootstrap });
    await client2.connect();
    try {
      await client2.query(
        `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1,'fresh@example.test',false)
         ON CONFLICT (id) DO NOTHING`,
        [fresh]
      );
    } finally {
      await client2.end();
    }
    const signal = await dataContext.withDataContext(ctx(fresh), (db) =>
      wellnessFocusSignal(db, { actorUserId: fresh, requestId: "req:focus" })
    );
    expect(signal).toBeNull();
  });

  it("wellness provider yields low readiness after low-ENERGY check-ins", async () => {
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const repo = new WellnessRepository();
      await repo.createCheckin(db, { feelingCore: "sad", intensity: 1, energy: 1 });
      await repo.createCheckin(db, { feelingCore: "fear", intensity: 1, energy: 1 });
    });
    const signal = await dataContext.withDataContext(ctx(userId), (db) =>
      wellnessFocusSignal(db, { actorUserId: userId, requestId: "req:focus" })
    );
    expect(signal).not.toBeNull();
    expect(signal!.moduleId).toBe("wellness");
    expect(signal!.readiness).toBeLessThan(0.5);
    expect(signal!.summary.toLowerCase()).toContain("energy");
  });

  // Per-provider context runner mirroring the composition root (apps/api/src/server.ts):
  // each provider gets its OWN withDataContext (fresh transaction → fresh pg connection).
  const perProviderContext =
    (actorUserId: string, requestId: string): FocusSignalContextRunner =>
    <T>(work: (scopedDb: unknown) => Promise<T>) =>
      dataContext.withDataContext({ actorUserId, requestId }, (db) => work(db));

  it("aggregateFocusSignals fails soft: a throwing provider is treated as no signal", async () => {
    const throwing = async () => {
      throw new Error("boom");
    };
    const result = await aggregateFocusSignals(
      [
        { moduleId: "wellness", provider: wellnessFocusSignal },
        { moduleId: "broken", provider: throwing as never }
      ],
      perProviderContext(userId, "req:focus"),
      { actorUserId: userId, requestId: "req:focus" }
    );
    expect(result.some((s) => s.moduleId === "wellness")).toBe(true);
    expect(result.some((s) => (s as FocusSignal).moduleId === "broken")).toBe(false);
  });

  it("a provider that ABORTS its transaction (25P02) does not poison the others", async () => {
    // This is the load-bearing per-provider-context property. A bad query aborts the
    // CURRENT transaction in Postgres; every later statement on that SAME connection fails
    // with 25P02 ("current transaction is aborted"). If providers shared one transaction,
    // the poison would cascade and the healthy provider's query would 25P02-fail too — a
    // total focus outage. Because each provider runs in its OWN withDataContext, the abort
    // is contained: the broken provider drops (fail-soft) and the healthy one still returns.
    const poisons = async (scopedDb: unknown) => {
      // Issue a guaranteed-failing statement to abort THIS provider's transaction, then a
      // follow-up read that would 25P02 if the txn were shared with the healthy provider.
      const db = (scopedDb as { db: Kysely<MossDatabase> }).db;
      await sql`select * from definitely_no_such_table_xyz`.execute(db).catch(() => {
        // swallow the original error; the point is the transaction is now aborted.
      });
      // This read runs inside the now-aborted txn → 25P02. Provider throws → dropped.
      await sql`select 1 as ok`.execute(db);
      return { moduleId: "poison", readiness: 1, summary: "should never appear" };
    };
    const result = await aggregateFocusSignals(
      [
        { moduleId: "poison", provider: poisons as never },
        { moduleId: "wellness", provider: wellnessFocusSignal }
      ],
      perProviderContext(userId, "req:focus"),
      { actorUserId: userId, requestId: "req:focus" }
    );
    // The healthy provider survives: its query ran in a SEPARATE, un-poisoned transaction.
    expect(result.some((s) => s.moduleId === "wellness")).toBe(true);
    expect(result.some((s) => s.moduleId === "poison")).toBe(false);
  });
});

describe("focus consumer down-weights when readiness is low (generic)", () => {
  it("caps the focus list when the injected aggregate readiness is low", async () => {
    // Seed many high-priority overdue tasks for the actor.
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const repo = new TasksRepository();
      const past = new Date(Date.now() - 86_400_000);
      for (let i = 0; i < 6; i++) {
        await repo.create(db, {
          title: `urgent-${i.toString()}`,
          status: "todo",
          priority: 5,
          dueAt: past
        });
      }
    });

    const app = Fastify();
    registerTasksRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:focus" }),
      dataContext,
      boss: undefined as never,
      focusSignals: async () => [
        { moduleId: "wellness", readiness: 0.1, summary: "Energy trended low." }
      ]
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/tasks/focus" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tasks.length).toBeLessThanOrEqual(3);
      expect(body.signals[0].readiness).toBe(0.1);
    } finally {
      await app.close();
    }
  });
});

describe("focus providers honor per-user enablement (Phase-2 seam is LANDED)", () => {
  it("focusSignalProvidersFor(active) excludes a module the actor disabled", async () => {
    const { createActiveModulesResolver, focusSignalProvidersFor, getBuiltInModuleManifests } =
      await import("@moss/module-registry");
    const { SettingsRepository } = await import("@moss/settings");

    const resolveActive = createActiveModulesResolver({
      dataContext,
      manifests: () => getBuiltInModuleManifests()
    });

    // Before disabling: wellness is active and contributes a provider.
    const before = focusSignalProvidersFor(await resolveActive(userId));
    expect(before.some((p) => p.moduleId === "wellness")).toBe(true);

    // Disable wellness for this actor via the settings deny-list (the seam's own writer).
    // setUserModuleDisabled writes the deny row for input.actorUserId (the acting user).
    await dataContext.withDataContext(ctx(userId), (db) =>
      new SettingsRepository().setUserModuleDisabled(db, {
        moduleId: "wellness",
        disabled: true,
        actorUserId: userId,
        requestId: "req:wellness-test"
      })
    );

    const after = focusSignalProvidersFor(await resolveActive(userId));
    expect(after.some((p) => p.moduleId === "wellness")).toBe(false);

    // Re-enable so later tests see wellness active again (clean state).
    await dataContext.withDataContext(ctx(userId), (db) =>
      new SettingsRepository().setUserModuleDisabled(db, {
        moduleId: "wellness",
        disabled: false,
        actorUserId: userId,
        requestId: "req:wellness-test"
      })
    );
  });
});

describe("feelings taxonomy (browser-safe, in @moss/shared)", () => {
  it("has the six emotion cores, each with feelings+sensations", () => {
    expect(EMOTIONS.map((e) => e.core)).toEqual([
      "happy",
      "sad",
      "fear",
      "anger",
      "disgust",
      "surprise"
    ]);
    for (const entry of EMOTIONS) {
      expect(entry.feelings.length).toBeGreaterThan(0);
      for (const feeling of entry.feelings) {
        expect(typeof feeling.label).toBe("string");
        expect(Array.isArray(feeling.sensations)).toBe(true);
      }
    }
  });

  it("body-sensations is a non-empty curated list", () => {
    expect(BODY_SENSATIONS.length).toBeGreaterThanOrEqual(8);
    expect(BODY_SENSATIONS).toContain("Tight chest");
  });

  it("isValidFeelingPath accepts valid paths and rejects mismatches (2-level taxonomy)", () => {
    expect(isValidFeelingPath("fear")).toBe(true);
    expect(isValidFeelingPath("fear", "Anxious")).toBe(true);
    // tertiary is disallowed in the 2-level taxonomy
    expect(isValidFeelingPath("fear", "Anxious", "overwhelmed")).toBe(false);
    expect(isValidFeelingPath("fear", "not-a-feeling")).toBe(false);
    // a tertiary without secondary is invalid
    expect(isValidFeelingPath("fear", null, "overwhelmed")).toBe(false);
  });
});

// Phase 2 tests (taxonomy, therapy notes, listLogsRange, insights) live in wellness-phase2.test.ts
// to keep this file under the 1000-line limit.

describe("today visibility — B2 + F3 backend confirmation", () => {
  const repo = new WellnessRepository();

  it("checkin created today appears in listCheckins (backend does not filter by date)", async () => {
    let createdId = "";
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const ck = await repo.createCheckin(scopedDb, {
        feelingCore: "happy",
        feelingSecondary: "Content",
        sensations: [],
        intensity: 3,
        note: null,
        identifiedVia: "wheel"
      });
      createdId = ck.id;
    });
    const list = await dataContext.withDataContext(ctx(userId), (scopedDb) =>
      repo.listCheckins(scopedDb, { limit: 50 })
    );
    expect(list.map((c) => c.id)).toContain(createdId);
  });

  it("two checkins created on the same day both appear in list (F3)", async () => {
    const ids: string[] = [];
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const ck1 = await repo.createCheckin(scopedDb, { feelingCore: "happy", intensity: 3 });
      const ck2 = await repo.createCheckin(scopedDb, { feelingCore: "happy", intensity: 4 });
      ids.push(ck1.id, ck2.id);
    });
    const list = await dataContext.withDataContext(ctx(userId), (scopedDb) =>
      repo.listCheckins(scopedDb, { limit: 50 })
    );
    const listIds = list.map((c) => c.id);
    expect(listIds).toContain(ids[0]);
    expect(listIds).toContain(ids[1]);
  });
});

describe("computeInsights — low-data guard (Q1)", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("returns empty array when fewer than 7 check-ins", () => {
    const checkins = [
      { feeling_core: "happy", intensity: 3, checked_in_at: "2026-06-14T10:00:00Z", note: null }
    ] as unknown as Parameters<typeof computeInsights>[0];
    const result = computeInsights(checkins, [], [], now);
    expect(result).toEqual([]);
  });

  it("returns empty array when 7 check-ins but all within last 6 days", () => {
    const checkins = Array.from({ length: 7 }, (_, i) => ({
      feeling_core: "happy",
      intensity: 3,
      checked_in_at: new Date(now.getTime() - i * 86400000).toISOString(),
      note: null
    })) as unknown as Parameters<typeof computeInsights>[0];
    const result = computeInsights(checkins, [], [], now);
    expect(result).toEqual([]);
  });

  it("returns insights when ≥7 check-ins spanning ≥7 days", () => {
    const checkins = Array.from({ length: 7 }, (_, i) => ({
      feeling_core: "happy",
      intensity: 3,
      checked_in_at: new Date(now.getTime() - (i + 7) * 86400000).toISOString(),
      note: null
    })) as unknown as Parameters<typeof computeInsights>[0];
    const result = computeInsights(checkins, [], [], now);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("module isolation: wellness ⇄ tasks", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it("@moss/wellness package.json does NOT depend on @moss/tasks", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "packages/wellness/package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@moss/tasks");
  });

  it("@moss/tasks package.json does NOT depend on @moss/wellness", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/tasks/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@moss/wellness");
  });

  it("no wellness source file imports @moss/tasks", () => {
    const files = [
      "manifest.ts",
      "repository.ts",
      "routes.ts",
      "tools.ts",
      "focus-signal.ts",
      "recall-context.ts",
      "schedule.ts",
      "serialize.ts",
      "insights.ts"
    ];
    for (const file of files) {
      const src = readFileSync(join(repoRoot, "packages/wellness/src", file), "utf8");
      expect(src.includes("@moss/tasks")).toBe(false);
    }
  });
});
