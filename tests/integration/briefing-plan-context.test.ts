import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";

import { DayPlanRepository } from "@moss/calendar";
import type { MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { localDay } from "@moss/shared";
import { TasksRepository } from "@moss/tasks";

import { connectionStrings, ids } from "./test-database.js";

import {
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  userBContext,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

const ZONE = "Pacific/Auckland";

describe("briefing saved-plan context boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: BriefingsTestHarness["dataContext"];
  let repository: BriefingsTestHarness["repository"];
  let plans: DayPlanRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: BriefingsTestHarness["server"];
  let aPlanId = "";

  beforeAll(async () => {
    const harness = await setupBriefingsHarness();
    appDb = harness.appDb;
    workerDb = harness.workerDb;
    dataContext = harness.dataContext;
    repository = harness.repository;
    appBoss = harness.appBoss;
    workerBoss = harness.workerBoss;
    server = harness.server;
    plans = new DayPlanRepository({ findTask: async () => undefined });
  });

  afterAll(async () => {
    await teardownBriefingsHarness({ server, appBoss, workerBoss, appDb, workerDb });
  });

  async function generateFor(owner: "a" | "b", definitionId: string) {
    const manifests = getBuiltInModuleManifests();
    const ctx = owner === "a" ? userAContext() : userBContext();
    const deps = { ...makeComposeDeps(), moduleManifests: manifests, dayPlanRead: plans };
    return dataContext.withDataContext(ctx, (scopedDb) =>
      repository.generateRun(scopedDb, definitionId, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: deps
      })
    );
  }

  it("loads the zone-day plan and freezes the snapshot across a revision bump", async () => {
    const now = new Date();
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      plans.createForDay(scopedDb, {
        localDay: localDay(now, ZONE),
        timeZone: ZONE,
        eveningIntent: {
          priorityTaskIds: [],
          capacity: "light",
          notes: "keep it small",
          corrections: [],
          commitments: []
        }
      })
    );
    aPlanId = created.id;
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Plan context briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: ZONE },
        selectedToolNames: []
      })
    );
    const outcome = await generateFor("a", definition.id);
    expect(outcome?.created).toBe(true);
    expect(outcome?.run?.status).toBe("succeeded");
    const meta = outcome?.run?.source_metadata as {
      gaps?: { source: string; reason: string }[];
      planSnapshot?: { planId: string; revision: number };
      structuredPayload?: { planContext?: { planId: string; revision: number } | null };
    };
    expect((meta.gaps ?? []).filter((gap) => gap.source === "day_plan")).toEqual([]);
    expect(meta.structuredPayload?.planContext).toMatchObject({
      planId: created.id,
      revision: created.revision
    });
    expect(meta.planSnapshot).toMatchObject({ planId: created.id, revision: created.revision });

    const saved = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      plans.saveDraft(scopedDb, {
        planId: created.id,
        localDay: localDay(new Date(), ZONE),
        timeZone: ZONE,
        expectedRevision: created.revision,
        blocks: [{ kind: "focus", taskId: null, title: "Write the draft" }]
      })
    );
    expect(saved.revision).toBe(created.revision + 1);

    const reread = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getOwnedRunById(scopedDb, outcome!.run.id)
    );
    const rereadMeta = reread?.source_metadata as {
      planSnapshot?: { planId: string; revision: number };
      structuredPayload?: { planContext?: { planId: string; revision: number } | null };
    };
    expect(rereadMeta.planSnapshot?.revision).toBe(created.revision);
    expect(rereadMeta.structuredPayload?.planContext?.revision).toBe(created.revision);
  });

  it("actor B never sees actor A plan data, and no plan yields null without a gap", async () => {
    const berlin = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "No-plan briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: "Europe/Berlin" },
        selectedToolNames: []
      })
    );
    const outcome = await generateFor("a", berlin.id);
    const meta = outcome?.run?.source_metadata as {
      gaps?: { source: string; reason: string }[];
      planSnapshot?: unknown;
      structuredPayload?: { planContext?: unknown };
    };
    expect(outcome?.run?.status).toBe("succeeded");
    expect(meta.structuredPayload?.planContext).toBeNull();
    expect(meta.planSnapshot).toBeUndefined();
    expect((meta.gaps ?? []).filter((gap) => gap.source === "day_plan")).toEqual([]);

    const bDefinition = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "B plan briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: ZONE },
        selectedToolNames: []
      })
    );
    const bOutcome = await generateFor("b", bDefinition.id);
    const bMeta = bOutcome?.run?.source_metadata as {
      structuredPayload?: { planContext?: unknown };
    };
    expect(bMeta.structuredPayload?.planContext).toBeNull();
    expect(JSON.stringify(bOutcome?.run?.source_metadata)).not.toContain(aPlanId);
  });

  it("morning run carries the intent and the overnight line for a vanished event", async () => {
    const ownedPlans = new DayPlanRepository({
      findTask: async (scopedDb, taskId) => {
        const task = await new TasksRepository().getById(scopedDb, taskId);
        return task ? { id: task.id, ownerUserId: task.owner_user_id } : undefined;
      }
    });
    const now = new Date();
    const day = localDay(now, ZONE);
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      new TasksRepository().create(scopedDb, { title: "File the T21 report" })
    );
    // createForDay is idempotent: this zone-day already has a plan from the
    // earlier case, so the intent goes through the draft write instead.
    const bare = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      ownedPlans.createForDay(scopedDb, { localDay: day, timeZone: ZONE })
    );
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      ownedPlans.saveDraft(scopedDb, {
        planId: bare.id,
        localDay: day,
        timeZone: ZONE,
        expectedRevision: bare.revision,
        eveningIntent: {
          priorityTaskIds: [task.id],
          capacity: "light",
          notes: "Leave by four",
          corrections: [],
          commitments: []
        }
      })
    );
    // Committed placement goes straight into storage; drafts never accept it.
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.day_plan_blocks
          (id, plan_id, owner_user_id, task_id, kind, title, actual_placement, position)
        VALUES ($1, $2, $3, $4, 'focus', $5, $6::jsonb, 0)`,
        [
          randomUUID(),
          created.id,
          ids.userA,
          task.id,
          "T21 committed block",
          JSON.stringify({
            startsAt: `${day}T09:00:00.000Z`,
            durationMinutes: 60,
            calendarEventRef: "evt-t21-vanished"
          })
        ]
      );
    } finally {
      await client.end();
    }
    const manifests = getBuiltInModuleManifests();
    const seen: string[] = [];
    // No chat model is configured in this database, so synthesis stays
    // unreachable unless selection succeeds; the generation call itself
    // remains the injected fake, exactly as the compose unit harness does.
    const adapterDeps = makeComposeDeps(async (input) => {
      seen.push(input.messages.map((m) => m.content).join("\n"));
      return { text: "synth narrative" };
    });
    type AdapterDeps = typeof adapterDeps;
    const synthesisDeps: AdapterDeps = {
      ...adapterDeps,
      aiRepository: {
        async selectModelForCapability() {
          return {
            id: "model-t21",
            provider_config_id: "pc-t21",
            provider_kind: "anthropic",
            provider_model_id: "t21-test",
            display_name: "T21",
            tier: "economy"
          };
        },
        async selectProviderWithCredential() {
          return { id: "pc-t21", base_url: null, encrypted_credential: { v: 1 } };
        }
      } as unknown as AdapterDeps["aiRepository"],
      cipher: {
        decryptJson() {
          return { apiKey: "fake-key" };
        }
      } as unknown as AdapterDeps["cipher"]
    };
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Overnight changes briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: ZONE },
        selectedToolNames: ["tasks.list", "calendar.listVisibleEvents"]
      })
    );
    const outcome = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: {
          ...synthesisDeps,
          moduleManifests: manifests,
          dayPlanRead: ownedPlans
        }
      })
    );
    expect(outcome?.run?.status).toBe("succeeded");
    const meta = outcome?.run?.source_metadata as {
      structuredPayload?: {
        planContext?: {
          planId: string;
          eveningIntent?: { priorityTaskIds: string[]; capacity: string | null } | null;
        } | null;
      };
    };
    expect(meta.structuredPayload?.planContext?.planId).toBe(created.id);
    expect(meta.structuredPayload?.planContext?.eveningIntent?.priorityTaskIds).toEqual([task.id]);
    const block = seen
      .join("\n")
      .match(/<external_source type="day_plan">\n([\s\S]*?)\n<\/external_source>/);
    expect(block, "day_plan block must be present").not.toBeNull();
    expect(block![1]).toContain("Overnight change:");
    expect(block![1]).toContain("lost its calendar event");

    const scheduled = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "scheduled",
        composeDeps: {
          ...makeComposeDeps(),
          moduleManifests: manifests,
          dayPlanRead: ownedPlans
        }
      })
    );
    expect(scheduled?.created).toBe(true);
    const repeat = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "scheduled",
        composeDeps: {
          ...makeComposeDeps(),
          moduleManifests: manifests,
          dayPlanRead: ownedPlans
        }
      })
    );
    expect(repeat?.created).toBe(false);

    const bDefinition = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "B overnight briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: ZONE },
        selectedToolNames: ["tasks.list", "calendar.listVisibleEvents"]
      })
    );
    const bOutcome = await generateFor("b", bDefinition.id);
    const bMeta = bOutcome?.run?.source_metadata as {
      structuredPayload?: { planContext?: unknown };
    };
    expect(bMeta.structuredPayload?.planContext).toBeNull();
    expect(JSON.stringify(bOutcome?.run?.source_metadata)).not.toContain(created.id);
  });
});
