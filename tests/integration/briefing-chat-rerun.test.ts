import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  BRIEFINGS_RUN_QUEUE,
  buildManualBriefingRunJob,
  briefingsGetRunStatusExecute,
  briefingsRerunExecute,
  createBriefingRunJobReadService,
  createBriefingRunQueueService,
  defaultToolNamesFor,
  type BriefingRunJobReadService,
  type BriefingRunQueueService
} from "@moss/briefings";
import type { AccessContext, BriefingDefinition } from "@moss/db";
import { sendJob } from "@moss/jobs";
import type { ToolInput } from "@moss/module-sdk";

import { connectionStrings } from "./test-database.js";
import {
  briefingIds,
  handleNextBriefingJob,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  userBContext,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

// Real database, real RLS and real pg-boss: the chat re-run tool queues through the
// briefings module's own queue service, honours the in-flight rule, and never reaches
// another user's briefing or run.
describe("briefings chat re-run tools", () => {
  let harness: BriefingsTestHarness;
  let queue: BriefingRunQueueService;
  let jobs: BriefingRunJobReadService;
  let evening: BriefingDefinition;

  beforeAll(async () => {
    harness = await setupBriefingsHarness();
    queue = createBriefingRunQueueService(harness.appBoss);
    jobs = createBriefingRunJobReadService(harness.appBoss);
    evening = await harness.dataContext.withDataContext(userAContext(), (db) =>
      harness.repository.createDefinition(db, {
        title: "Evening",
        briefingType: "evening",
        cadence: "manual",
        selectedToolNames: defaultToolNamesFor("evening")
      })
    );
  }, 60_000);

  afterAll(async () => {
    await teardownBriefingsHarness(harness);
  });

  function toolCtx(access: AccessContext) {
    return {
      actorUserId: access.actorUserId,
      requestId: access.requestId ?? "briefing-chat-rerun",
      chatSessionId: "c"
    };
  }

  function rerun(access: AccessContext, input: ToolInput) {
    return harness.dataContext.withDataContext(access, (db) =>
      briefingsRerunExecute(db, input, toolCtx(access), { briefingRunQueue: queue })
    );
  }

  function status(access: AccessContext, input: ToolInput) {
    return harness.dataContext.withDataContext(access, (db) =>
      briefingsGetRunStatusExecute(db, input, toolCtx(access), { briefingRunJobs: jobs })
    );
  }

  async function openJobCount(definitionId: string): Promise<number> {
    const client = new pg.Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const result = await client.query<{ count: string }>(
        `SELECT count(*) FROM pgboss.job
          WHERE name = $1 AND data->>'definitionId' = $2
            AND state IN ('created', 'retry', 'active')`,
        [BRIEFINGS_RUN_QUEUE, definitionId]
      );
      return Number(result.rows[0]?.count ?? 0);
    } finally {
      await client.end();
    }
  }

  it("queues one run, refuses a duplicate while it is in flight, then reports it ready", async () => {
    const first = await rerun(userAContext(), { briefingType: "evening" });
    expect(first.data).toMatchObject({
      status: "queued",
      definitionId: evening.id,
      briefingType: "evening"
    });
    const runId = first.data.runId as string;
    const jobId = first.data.jobId as string;

    const repeat = await rerun(userAContext(), { briefingType: "evening" });
    expect(repeat.data).toMatchObject({ status: "already_running", runId, jobId });
    expect(await openJobCount(evening.id)).toBe(1);

    expect((await status(userAContext(), { runId, jobId })).data.state).toBe("pending");

    const result = await handleNextBriefingJob(harness.workerBoss);
    expect(result.runId).toBe(runId);

    const ready = await status(userAContext(), { runId, jobId });
    expect(ready.data).toMatchObject({ state: "ready", runId, briefingType: "evening" });
    expect(typeof ready.data.summaryText).toBe("string");

    // Once the run finished, a new request starts a fresh run.
    const next = await rerun(userAContext(), { definitionId: evening.id });
    expect(next.data.status).toBe("queued");
    expect(next.data.runId).not.toBe(runId);
    await handleNextBriefingJob(harness.workerBoss);
  }, 60_000);

  it("follows a scheduled run already going, which has no run id until the worker starts it", async () => {
    const scheduledJobId = await sendJob(harness.appBoss, BRIEFINGS_RUN_QUEUE, {
      actorUserId: evening.owner_user_id,
      definitionId: evening.id,
      runKind: "scheduled",
      briefingType: "evening"
    });

    const repeat = await rerun(userAContext(), { briefingType: "evening" });
    expect(repeat.data).toMatchObject({
      status: "already_running",
      runId: null,
      jobId: scheduledJobId
    });
    expect(await openJobCount(evening.id)).toBe(1);

    const input = { jobId: scheduledJobId as string, definitionId: evening.id };
    expect((await status(userAContext(), input)).data).toMatchObject({ state: "pending" });
    expect((await status(userBContext(), input)).data.state).toBe("not_found");

    const result = await handleNextBriefingJob(harness.workerBoss);
    const ready = await status(userAContext(), input);
    expect(ready.data).toMatchObject({ state: "ready", runId: result.runId });
  }, 60_000);

  it("withdraws its own job when the Today button queued one in the same moment", async () => {
    // Inject a Today-style run (its own idempotency key) between the chat check and its send.
    const racing: BriefingRunQueueService = {
      ...queue,
      async send(job) {
        const today = buildManualBriefingRunJob(evening.owner_user_id, evening, "today-click");
        await queue.send(today);
        return queue.send(job);
      }
    };
    const result = await harness.dataContext.withDataContext(userAContext(), (db) =>
      briefingsRerunExecute(db, { briefingType: "evening" }, toolCtx(userAContext()), {
        briefingRunQueue: racing
      })
    );

    expect(result.data.status).toBe("already_running");
    expect(await openJobCount(evening.id)).toBe(1);
    await handleNextBriefingJob(harness.workerBoss);
  }, 60_000);

  it("never re-runs or reads another user's briefing", async () => {
    const byId = await rerun(userBContext(), { definitionId: evening.id });
    expect(byId.data.status).toBe("no_briefing");

    // User B has only morning-type definitions, so asking for evening finds nothing of A's.
    const byType = await rerun(userBContext(), { briefingType: "evening" });
    expect(byType.data.status).toBe("no_briefing");

    const aRun = await rerun(userAContext(), { briefingType: "evening" });
    const input = { runId: aRun.data.runId as string, jobId: aRun.data.jobId as string };
    expect((await status(userBContext(), input)).data.state).toBe("not_found");
    expect(await openJobCount(evening.id)).toBe(1);

    // And A cannot re-run B's private briefing.
    const intoB = await rerun(userAContext(), { definitionId: briefingIds.userBPrivate });
    expect(intoB.data.status).toBe("no_briefing");
    expect(await openJobCount(briefingIds.userBPrivate)).toBe(0);

    await handleNextBriefingJob(harness.workerBoss);
  }, 60_000);
});
