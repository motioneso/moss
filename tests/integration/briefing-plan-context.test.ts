import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import { DayPlanRepository } from "@moss/calendar";
import type { MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { localDay } from "@moss/shared";

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
});
