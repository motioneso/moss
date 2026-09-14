import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";

import { DayPlanRepository } from "@moss/calendar";
import { createAiSecretCipher, type AiRepository } from "@moss/ai";
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
const BLOCK_TITLE = "Write the draft";
const CORRECTION_NOTE = "moved to Friday, ask Sam";

describe("briefing plan prose boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: BriefingsTestHarness["dataContext"];
  let repository: BriefingsTestHarness["repository"];
  let plans: DayPlanRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: BriefingsTestHarness["server"];

  beforeAll(async () => {
    const harness = await setupBriefingsHarness();
    appDb = harness.appDb;
    workerDb = harness.workerDb;
    dataContext = harness.dataContext;
    repository = harness.repository;
    appBoss = harness.appBoss;
    workerBoss = harness.workerBoss;
    server = harness.server;
    const tasksForPlans = new TasksRepository();
    plans = new DayPlanRepository({
      findTask: async (scopedDb, taskId) => {
        const task = await tasksForPlans.getById(scopedDb, taskId);
        return task ? { id: task.id, ownerUserId: task.owner_user_id } : undefined;
      }
    });
  });

  afterAll(async () => {
    await teardownBriefingsHarness({ server, appBoss, workerBoss, appDb, workerDb });
  });

  function promptDepsForCapture(seen: string[], reply: string) {
    const cipher = createAiSecretCipher();
    return {
      ...makeComposeDeps(async (input) => {
        seen.push(input.messages.map((m) => m.content).join("\n"));
        return { text: reply };
      }),
      cipher,
      aiRepository: {
        selectModelForCapability: async () => ({
          id: "plan-prose-model",
          provider_config_id: "pc-plan-prose",
          provider_kind: "anthropic",
          provider_model_id: "plan-prose",
          display_name: "Plan prose",
          tier: "economy"
        }),
        selectProviderWithCredential: async () => ({
          id: "pc-plan-prose",
          base_url: null,
          encrypted_credential: cipher.encryptJson({ apiKey: "plan-prose-key" })
        })
      } as unknown as AiRepository
    };
  }

  let seeded: { task: { id: string }; planId: string } | undefined;
  async function seedPlan() {
    if (seeded) return seeded;
    const now = new Date();
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      new TasksRepository().create(scopedDb, { title: "File the quarterly report" })
    );
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      plans.createForDay(scopedDb, {
        localDay: localDay(now, ZONE),
        timeZone: ZONE,
        eveningIntent: {
          priorityTaskIds: [task.id],
          capacity: "light",
          notes: null,
          corrections: [{ taskId: task.id, note: CORRECTION_NOTE, source: "actor" }],
          commitments: []
        }
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      plans.saveDraft(scopedDb, {
        planId: created.id,
        localDay: localDay(new Date(), ZONE),
        timeZone: ZONE,
        expectedRevision: created.revision,
        blocks: [
          { taskId: null, kind: "meeting", title: "Maybe later" },
          {
            taskId: task.id,
            kind: "focus",
            title: "Shifted",
            pendingChange: {
              kind: "move",
              startsAt: "2026-09-12T17:00:00.000Z",
              durationMinutes: 60
            }
          }
        ]
      })
    );
    const committedId = randomUUID();
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.day_plan_blocks
          (id, plan_id, owner_user_id, task_id, kind, title, actual_placement, position)
        VALUES ($1, $2, $3, $4, 'focus', $5, $6::jsonb, 2)`,
        [
          committedId,
          created.id,
          ids.userA,
          task.id,
          BLOCK_TITLE,
          JSON.stringify({
            startsAt: "2026-09-12T16:00:00.000Z",
            durationMinutes: 60,
            calendarEventRef: null
          })
        ]
      );
    } finally {
      await client.end();
    }
    seeded = { task, planId: created.id };
    return seeded;
  }

  function dayPlanBlock(prompt: string): string {
    const match = prompt.match(
      /<external_source type="day_plan">\n([\s\S]*?)\n<\/external_source>/
    );
    expect(match, "day_plan block must be present").not.toBeNull();
    return match![1]!;
  }

  it("morning prompt carries the three block states and the correction, never in trusted text", async () => {
    await seedPlan();
    const manifests = getBuiltInModuleManifests();
    const seen: string[] = [];
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Plan prose briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: ZONE },
        selectedToolNames: ["tasks.list"]
      })
    );
    const outcome = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: {
          ...promptDepsForCapture(seen, "synth narrative"),
          moduleManifests: manifests,
          dayPlanRead: plans
        }
      })
    );
    expect(outcome?.run?.status).toBe("succeeded");
    const prompt = seen.join("\n");
    const block = dayPlanBlock(prompt);
    expect(block).toContain("committed 2026-09-12T16:00:00.000Z-2026-09-12T17:00:00.000Z");
    expect(block).toContain("proposed, not on the calendar yet");
    expect(block).toContain("pending change: move");
    expect(block).toContain(`Correction (actor): ${CORRECTION_NOTE}`);
    expect(block).toContain("Priority (saved last evening): File the quarterly report");
    const trusted = prompt.match(/<trusted_instructions>([\s\S]*?)<\/trusted_instructions>/);
    expect(trusted, "trusted block must be present").not.toBeNull();
    expect(trusted![1]).not.toContain(BLOCK_TITLE);
    expect(trusted![1]).not.toContain(CORRECTION_NOTE);
  });

  it("no-model morning run lists the plan and keeps the snapshot", async () => {
    const { planId } = await seedPlan();
    const manifests = getBuiltInModuleManifests();
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Plan prose degraded briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: ZONE },
        selectedToolNames: ["tasks.list"]
      })
    );
    const outcome = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: {
          ...makeComposeDeps(async () => {
            throw new Error("synthesis must not be called when there is no model");
          }),
          moduleManifests: manifests,
          dayPlanRead: plans
        }
      })
    );
    expect(outcome?.run?.status).toBe("succeeded");
    const meta = outcome?.run?.source_metadata as {
      degraded: boolean;
      planSnapshot?: { planId: string };
    };
    expect(meta.degraded).toBe(true);
    expect(outcome?.run?.summary_text).toContain("SAVED DAY PLAN");
    expect(meta.planSnapshot?.planId).toBe(planId);
  });

  it("evening prompt carries the block after morning_plan, and B reads none today", async () => {
    const manifests = getBuiltInModuleManifests();
    const seen: string[] = [];
    const evening = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Plan prose evening",
        briefingType: "evening",
        scheduleMetadata: { targetTime: "21:00", timezone: ZONE },
        selectedToolNames: []
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, evening.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: {
          ...promptDepsForCapture(seen, "evening narrative"),
          moduleManifests: manifests,
          dayPlanRead: plans
        }
      })
    );
    const prompt = seen.join("\n");
    const dayIdx = prompt.indexOf('<external_source type="day_plan">');
    expect(dayIdx).toBeGreaterThan(-1);
    const morningIdx = prompt.indexOf('<external_source type="morning_plan">');
    if (morningIdx !== -1) expect(dayIdx).toBeGreaterThan(morningIdx);

    const bSeen: string[] = [];
    const bEvening = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "B plan prose evening",
        briefingType: "evening",
        scheduleMetadata: { targetTime: "21:00", timezone: ZONE },
        selectedToolNames: []
      })
    );
    await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.generateRun(scopedDb, bEvening.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: {
          ...promptDepsForCapture(bSeen, "evening narrative"),
          moduleManifests: manifests,
          dayPlanRead: plans
        }
      })
    );
    expect(bSeen.join("\n")).toContain(
      '<external_source type="day_plan">\n(none today)\n</external_source>'
    );
  });
});
