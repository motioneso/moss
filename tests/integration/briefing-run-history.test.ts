import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import { DayPlanRepository } from "@moss/calendar";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { BRIEFINGS_RUN_QUEUE, registerBriefingsJobWorkers } from "@moss/briefings";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { localDay, type GetBriefingRunResponse } from "@moss/shared";

import {
  handleNextBriefingJob,
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  userAHeaders,
  type BriefingsTestHarness
} from "./briefings.helpers.js";
import { connectionStrings, ids } from "./test-database.js";

const ZONE = "Pacific/Auckland";
const NOT_AVAILABLE = {
  error: "Briefing run is missing or owned by someone else",
  code: "briefing_run_not_available"
};

function userBHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ids.sessionB}` };
}

describe("briefing refresh and history read", () => {
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
    plans = new DayPlanRepository({ findTask: async () => undefined });
  });

  afterAll(async () => {
    await teardownBriefingsHarness({ server, appBoss, workerBoss, appDb, workerDb });
  });

  // Same worker path as handleNextBriefingJob, but the fake-adapter compose deps
  // also read the seeded day plan so the stored run carries plan context.
  async function handleNextJobWithPlan() {
    const scopedWorkerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    const workerDataContext = new DataContextRunner(scopedWorkerDb);
    let workIds: string[] = [];
    try {
      const resultPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for Briefings worker"));
        }, 10_000);
        registerBriefingsJobWorkers(workerBoss, workerDataContext, {
          moduleManifests: getBuiltInModuleManifests(),
          composeDeps: {
            ...makeComposeDeps(async () => ({ text: "synth narrative" })),
            dayPlanRead: plans
          },
          workOptions: { pollingIntervalSeconds: 0.5 },
          onResult: (_job, result) => {
            clearTimeout(timeout);
            resolve(result);
          }
        })
          .then((registeredWorkIds) => {
            workIds = registeredWorkIds;
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
      });
      return await resultPromise;
    } finally {
      await Promise.all(
        workIds.map((workId) => workerBoss.offWork(BRIEFINGS_RUN_QUEUE, { id: workId, wait: true }))
      );
      await scopedWorkerDb.destroy();
    }
  }

  it("follows a refresh from pending to ready, then reports the plan change", async () => {
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
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "History briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: ZONE },
        selectedToolNames: []
      })
    );

    const queued = await server.inject({
      method: "POST",
      url: `/api/briefings/definitions/${definition.id}/run`,
      headers: userAHeaders(),
      payload: { idempotencyKey: "history-refresh-1" }
    });
    expect(queued.statusCode).toBe(202);
    const { jobId, runId } = queued.json<{ jobId: string; runId: string }>();

    const pendingResponse = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs/${runId}?jobId=${jobId}`,
      headers: userAHeaders()
    });
    expect(pendingResponse.statusCode).toBe(200);
    expect(pendingResponse.json()).toEqual({
      state: "pending",
      run: null,
      latest: false,
      plan: null
    });

    const duplicate = await server.inject({
      method: "POST",
      url: `/api/briefings/definitions/${definition.id}/run`,
      headers: userAHeaders(),
      payload: { idempotencyKey: "history-refresh-1" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "briefing_run_in_flight" });

    await handleNextJobWithPlan();

    const readyResponse = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs/${runId}`,
      headers: userAHeaders()
    });
    expect(readyResponse.statusCode).toBe(200);
    const ready = readyResponse.json<GetBriefingRunResponse>();
    expect(ready.state).toBe("ready");
    expect(ready.run?.id).toBe(runId);
    expect(ready.latest).toBe(true);
    expect(ready.plan?.status).toBe("current");
    expect(ready.plan?.storedRevision).toBe(created.revision);
    expect(ready.plan?.currentRevision).toBe(created.revision);
    expect(ready.plan?.current?.planId).toBe(created.id);

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

    const changedResponse = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs/${runId}`,
      headers: userAHeaders()
    });
    const changed = changedResponse.json<GetBriefingRunResponse>();
    expect(changed.state).toBe("ready");
    expect(changed.plan?.status).toBe("changed");
    expect(changed.plan?.storedRevision).toBe(created.revision);
    expect(changed.plan?.currentRevision).toBe(saved.revision);
    expect(changed.plan?.current?.planId).toBe(created.id);

    const second = await server.inject({
      method: "POST",
      url: `/api/briefings/definitions/${definition.id}/run`,
      headers: userAHeaders(),
      payload: { idempotencyKey: "history-refresh-2" }
    });
    expect(second.statusCode).toBe(202);
    expect(second.json<{ runId: string }>().runId).not.toBe(runId);
    await handleNextBriefingJob(workerBoss);

    const rereadResponse = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs/${runId}`,
      headers: userAHeaders()
    });
    const reread = rereadResponse.json<GetBriefingRunResponse>();
    expect(reread.state).toBe("ready");
    expect(reread.latest).toBe(false);
    expect(reread.run?.summaryText).toEqual(ready.run?.summaryText);
    expect(reread.run?.sourceMetadata).toEqual(ready.run?.sourceMetadata);
    expect(reread.run?.createdAt).toBe(ready.run?.createdAt);

    const foreign = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs/${runId}?jobId=${jobId}`,
      headers: userBHeaders()
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(NOT_AVAILABLE);

    const missing = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs/00000000-0000-4000-8000-000000000099`,
      headers: userAHeaders()
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(NOT_AVAILABLE);
  });
});
