// #1754: proves a module build survives a job-queue restart mid-step. The build job
// (packages/jobs/src/module-build-jobs.ts) and the resume logic
// (packages/ai/src/module-build/run-build-step.ts) are both real; only the piece that would
// launch a real paid coding agent (launchLiveAgent) is faked. The queue connection is stopped
// and a fresh one started against the same database to simulate a worker-process restart.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  createPgBossClient,
  createModuleBuildWorker,
  sendJob,
  MODULE_BUILD_QUEUE,
  type ModuleBuildPayload,
  type ModuleBuildStepResult,
  type PgBoss
} from "@moss/jobs";
import { createModuleBuild, getModuleBuild, updateModuleBuildStatus } from "@moss/settings";
import { runModuleBuildStep } from "../../packages/ai/src/module-build/run-build-step.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let workerDataContext: DataContextRunner;
let boss: PgBoss;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  workerDataContext = new DataContextRunner(workerDb);
  boss = createPgBossClient(connectionStrings.worker);
  await boss.start();
});

afterAll(async () => {
  await boss.stop();
  await workerDb.destroy();
  await appDb.destroy();
});

describe("module build restart survival (#1754 seam 3)", () => {
  it("a build interrupted mid-step resumes from its persisted step rather than restarting or dying", async () => {
    const realRunModuleBuildStep = async (
      payload: ModuleBuildPayload
    ): Promise<ModuleBuildStepResult> =>
      workerDataContext.withDataContext(
        { actorUserId: payload.actorUserId, requestId: randomUUID() },
        async (scopedDb) => {
          const row = await getModuleBuild(scopedDb, payload.buildId);
          if (!row) throw new Error(`build ${payload.buildId} not found`);
          const result = await runModuleBuildStep(
            {
              launchLiveAgent: async () => ({ wroteFiles: [], testsPassing: true }),
              resolveWorkingDir: () => "/tmp/fake-build-dir",
              recordFetchedUrl: async () => {},
              recordWrittenFile: async () => {}
            },
            row
          );
          if (result.continuation) {
            await updateModuleBuildStatus(scopedDb, result.continuation.buildId, {
              status: "building",
              step: result.continuation.step
            });
          }
          return result;
        }
      );

    const build = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: randomUUID() },
      async (scopedDb) => {
        const created = await createModuleBuild(scopedDb, { ownerUserId: ids.userA });
        await updateModuleBuildStatus(scopedDb, created.id, {
          status: "building",
          step: "writing_tests"
        });
        return created;
      }
    );

    await sendJob(boss, MODULE_BUILD_QUEUE, {
      actorUserId: ids.userA,
      buildId: build.id,
      step: "writing_tests"
    });

    let firstStepRan: () => void = () => {};
    const firstStepDone = new Promise<void>((resolve) => {
      firstStepRan = resolve;
    });
    const worker = createModuleBuildWorker({
      sendJob,
      boss,
      runStep: realRunModuleBuildStep
    });
    await boss.work(MODULE_BUILD_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
      await worker(jobs as unknown as Parameters<typeof worker>[0]);
      firstStepRan();
    });
    await firstStepDone;

    // Simulate a restart: stop this worker process's boss connection, start a fresh one, same DB.
    await boss.stop();
    const restartedBoss = createPgBossClient(connectionStrings.worker);
    await restartedBoss.start();

    let secondStepRan: () => void = () => {};
    const secondStepDone = new Promise<void>((resolve) => {
      secondStepRan = resolve;
    });
    const restartedWorker = createModuleBuildWorker({
      sendJob,
      boss: restartedBoss,
      runStep: realRunModuleBuildStep
    });
    await restartedBoss.work(MODULE_BUILD_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
      await restartedWorker(jobs as unknown as Parameters<typeof restartedWorker>[0]);
      secondStepRan();
    });
    await secondStepDone;
    await restartedBoss.stop();

    const row = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: randomUUID() },
      (scopedDb) => getModuleBuild(scopedDb, build.id)
    );
    // advanced past where it was ("writing_tests"), not restarted from null or stuck
    expect(row?.step).toBe("writing_code");
  });
});
