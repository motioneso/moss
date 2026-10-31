// #3735: disabling a module (or a user losing access) cancels waiting background jobs.
// Real pg-boss on the gate's scratch database. Run only through scripts/run-gate.sh.
import { createHash } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { Job, PgBoss } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MossDatabase } from "@moss/db";
import {
  cancelPendingModuleJobs,
  createPgBossClient,
  listPendingModuleJobActors,
  sendModuleJob,
  withModuleEnqueueLock
} from "@moss/jobs";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { ExternalModuleJobReconciler } from "@moss/module-registry/node";
import type { AccessContext } from "@moss/db";

import {
  createIsModuleDisabledByAdmin,
  createIsModuleEnabled
} from "../../apps/worker/src/worker-module-gate.js";
import {
  connectionStrings,
  ids,
  laneScopedModuleId,
  resetFoundationDatabase
} from "./test-database.js";

const { Client, Pool } = pg;

const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;
const PACKAGE_HASH = `sha256:${"b".repeat(64)}`;
const SECRET_MARKER = "private-note-marker-3735";

let boss: PgBoss;
let db: Kysely<MossDatabase>;
let pool: pg.Pool;
let executedSql: string[];
let logLines: string[];
let followUps: string[];
let gate: { promise: Promise<void>; release: () => void };
let handlerCalls: Array<{ queue: string; jobKind: string; actorUserId: string }>;
let handlerFinished: boolean;

const logger = {
  info: (data: Record<string, unknown>, message?: string) =>
    void logLines.push(JSON.stringify({ data, message })),
  warn: (data: Record<string, unknown>, message?: string) =>
    void logLines.push(JSON.stringify({ data, message }))
};

function newGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bootstrap(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

async function setModuleRow(
  id: string,
  row: { status: "enabled" | "disabled"; reason?: string | null; manifestHash?: string }
): Promise<void> {
  await bootstrap(
    `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, disabled_reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET status = $2, manifest_hash = $3, package_hash = $4,
       disabled_reason = $5, updated_at = now()`,
    [id, row.status, row.manifestHash ?? MANIFEST_HASH, PACKAGE_HASH, row.reason ?? null]
  );
}

function discovery(id: string, withQueues = true): ExternalModuleDiscovery {
  return {
    id,
    dir: `/fixture/${id}`,
    manifestHash: MANIFEST_HASH,
    packageHash: PACKAGE_HASH,
    manifest: {
      schemaVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      publisher: "tests",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" },
      runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
      ...(withQueues
        ? {
            worker: {
              queues: [
                {
                  name: `${id}.main`,
                  handler: "main",
                  retryLimit: 1,
                  deadLetterQueue: `${id}.dlq`,
                  allowManualRun: true
                },
                { name: `${id}.dlq`, handler: "dead" }
              ],
              schedules: [
                {
                  id: "daily",
                  cron: "0 3 * * *",
                  queue: `${id}.main`,
                  jobKind: "tick",
                  scope: "user" as const
                }
              ],
              reconcileJobs: [{ id: "recon", queue: `${id}.main`, jobKind: "recon" }]
            }
          }
        : {})
    }
  } as unknown as ExternalModuleDiscovery;
}

function makeReconciler(
  modules: readonly ExternalModuleDiscovery[],
  options: { withWorker?: boolean } = {}
): ExternalModuleJobReconciler {
  const byId = (id: string) => modules.find((module) => module.id === id);
  return new ExternalModuleJobReconciler({
    boss,
    discoveries: () => modules,
    isModuleEnabled: createIsModuleEnabled({ db, getDiscoveryById: byId }),
    isModuleDisabledByAdmin: createIsModuleDisabledByAdmin({ db }),
    listActiveUserIds: async (moduleId) =>
      (
        await sql<{ user_id: string }>`
          select user_id from app.list_active_external_module_users(${moduleId})
        `.execute(db)
      ).rows.map((row) => row.user_id),
    jobSweep: {
      listPendingActors: (moduleId) => listPendingModuleJobActors(db, moduleId),
      cancel: ({ moduleId, actorUserId }) =>
        cancelPendingModuleJobs(boss, db, {
          moduleId,
          ...(actorUserId === undefined ? {} : { actorUserId }),
          logger
        }),
      scheduleFollowUp: async (moduleId) => void followUps.push(moduleId)
    },
    ...(options.withWorker
      ? {
          registerWorker: async (_module, queue) => {
            await boss.work<{ actorUserId: string; jobKind: string }>(
              queue.name,
              { pollingIntervalSeconds: 0.5, batchSize: 1 },
              async ([job]: Job<{ actorUserId: string; jobKind: string }>[]) => {
                if (!job) return;
                handlerCalls.push({
                  queue: queue.name,
                  jobKind: job.data.jobKind,
                  actorUserId: job.data.actorUserId
                });
                if (job.data.jobKind === "block" || job.data.jobKind === "block-fail") {
                  await gate.promise;
                  handlerFinished = true;
                  if (job.data.jobKind === "block-fail") throw new Error("handler failed");
                }
              }
            );
          }
        }
      : {}),
    logger
  });
}

function envelope(
  moduleId: string,
  actorUserId: string,
  jobKind = "tick",
  params?: Record<string, unknown>
) {
  return {
    actorUserId,
    moduleId,
    jobKind,
    manifestHash: MANIFEST_HASH,
    ...(params ? { params } : {})
  };
}

async function states(queue: string): Promise<Array<{ state: string; actor: string }>> {
  const result = await bootstrap(
    `SELECT state, data->>'actorUserId' AS actor FROM pgboss.job WHERE name = $1 ORDER BY created_on, id`,
    [queue]
  );
  return result.rows as Array<{ state: string; actor: string }>;
}

async function pendingCount(moduleId: string): Promise<number> {
  const result = await bootstrap(
    `SELECT count(*)::int AS n FROM pgboss.job
     WHERE starts_with(name, $1) AND state IN ('created', 'retry')`,
    [`${moduleId}.`]
  );
  return result.rows[0].n as number;
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function deterministicJobId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Stand-in for the module-authored enqueue (#3715). It follows the protocol the sweep depends
 * on: take the per-actor lock, re-read the status row under it, then send.
 */
async function enqueueLive(
  moduleId: string,
  actorUserId: string,
  key: string,
  hooks: { afterLiveCheck?: () => Promise<void> } = {}
): Promise<"sent" | "duplicate" | "module_inactive"> {
  return withModuleEnqueueLock(db, moduleId, actorUserId, async (trx) => {
    const row = await sql<{ status: string }>`
      select status from app.external_modules where id = ${moduleId}
    `.execute(trx);
    if (row.rows[0]?.status !== "enabled") return "module_inactive";
    await hooks.afterLiveCheck?.();
    const id = await boss.send(`${moduleId}.main`, envelope(moduleId, actorUserId, "chain"), {
      id: deterministicJobId(`${moduleId}:${actorUserId}:${key}`)
    });
    return id === null ? "duplicate" : "sent";
  });
}

async function disable(moduleId: string): Promise<void> {
  await setModuleRow(moduleId, { status: "disabled", reason: "disabled by admin" });
}

beforeEach(async () => {
  await resetFoundationDatabase();
  executedSql = [];
  logLines = [];
  followUps = [];
  handlerCalls = [];
  handlerFinished = false;
  gate = newGate();
  pool = new Pool({ connectionString: connectionStrings.worker, max: 6 });
  db = new Kysely<MossDatabase>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => void executedSql.push(event.query.sql)
  });
  boss = createPgBossClient(connectionStrings.worker, { connectionTimeoutMillis: 25_000 });
  await boss.start();
}, 120_000);

afterEach(async () => {
  gate.release();
  await boss.stop({ graceful: false });
  await db.destroy();
}, 60_000);

describe("module disable cancels waiting jobs (#3735)", () => {
  const MOD = laneScopedModuleId("sw-a");
  const MAIN = `${MOD}.main`;

  it("1. cancels created and retry rows from every origin", async () => {
    const mod = discovery(MOD);
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([mod]);
    await reconciler.reconcileAll(); // sends a reconcile row for each active user

    // The cron engine is off in tests, so a due and a delayed schedule row are sent directly.
    await boss.send(MAIN, envelope(MOD, ids.userA, "tick"));
    await boss.send(MAIN, envelope(MOD, ids.userA, "tick"), { startAfter: 3600 });
    await sendModuleJob(
      boss,
      { actorUserId: ids.userA, requestId: "manual-run" } as AccessContext,
      mod,
      mod.manifest.worker!.queues![0]!,
      { jobKind: "manual" }
    );
    expect(await enqueueLive(MOD, ids.userA, "k1")).toBe("sent");
    expect(await enqueueLive(MOD, ids.userB, "k2")).toBe("sent");
    // One row that already failed once and waits for its next attempt.
    await boss.send(MAIN, envelope(MOD, ids.userB, "retrying"));
    await bootstrap(
      `UPDATE pgboss.job SET state = 'retry' WHERE name = $1 AND data->>'jobKind' = 'retrying'`,
      [MAIN]
    );
    const before = await states(MAIN);
    expect(before.length).toBeGreaterThanOrEqual(8);
    expect(before.some((row) => row.state === "retry")).toBe(true);

    await disable(MOD);
    await reconciler.reconcileModule(MOD);

    const after = await states(MAIN);
    expect(after.length).toBe(before.length);
    expect(after.every((row) => row.state === "cancelled")).toBe(true);
    expect(await pendingCount(MOD)).toBe(0);
  }, 60_000);

  it("2. leaves a running job to finish, refuses its follow-on, and sweeps a failed retry", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)], { withWorker: true });
    await reconciler.reconcileAll();
    await waitFor(async () => handlerCalls.some((call) => call.jobKind === "recon"), "reconcile");
    handlerCalls.length = 0;

    await boss.send(MAIN, envelope(MOD, ids.userA, "block-fail"));
    await waitFor(
      async () => handlerCalls.some((call) => call.jobKind.startsWith("block")),
      "the job to start"
    );

    await disable(MOD);
    // Stopping the worker waits for the running job, so the sweep starts when it ends.
    const disabling = reconciler.reconcileModule(MOD);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await states(MAIN)).some((row) => row.state === "active")).toBe(true);
    expect(await enqueueLive(MOD, ids.userA, "late")).toBe("module_inactive");

    gate.release();
    await disabling;

    expect(handlerFinished).toBe(true);
    const rows = await states(MAIN);
    expect(rows.filter((row) => row.state === "active")).toHaveLength(0);
    // It ran to the end (the handler finished), failed, and its retry row was cancelled.
    expect(rows.some((row) => row.state === "cancelled")).toBe(true);
    expect(rows.some((row) => row.state === "retry" || row.state === "created")).toBe(false);
  }, 60_000);

  it("2b. a running job that succeeds ends completed, not cancelled", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)], { withWorker: true });
    await reconciler.reconcileAll();
    await waitFor(async () => handlerCalls.some((call) => call.jobKind === "recon"), "reconcile");
    await boss.send(MAIN, envelope(MOD, ids.userA, "block"));
    await waitFor(
      async () => handlerCalls.some((call) => call.jobKind.startsWith("block")),
      "the job to start"
    );
    await disable(MOD);
    const disabling = reconciler.reconcileModule(MOD);
    gate.release();
    await disabling;
    const blockRow = await bootstrap(
      `SELECT state FROM pgboss.job WHERE name = $1 AND data->>'jobKind' = 'block'`,
      [MAIN]
    );
    expect(blockRow.rows[0].state).toBe("completed");
  }, 60_000);

  it("2c. cancelling a running job's row does not stop its code (spec fact check)", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)], { withWorker: true });
    await reconciler.reconcileAll();
    await waitFor(async () => handlerCalls.some((call) => call.jobKind === "recon"), "reconcile");
    const jobId = await boss.send(MAIN, envelope(MOD, ids.userA, "block"));
    await waitFor(
      async () => handlerCalls.some((call) => call.jobKind.startsWith("block")),
      "the job to start"
    );
    await boss.cancel(MAIN, jobId as string);
    const cancelled = await bootstrap(`SELECT state FROM pgboss.job WHERE id = $1`, [jobId]);
    expect(cancelled.rows[0].state).toBe("cancelled");
    expect(handlerFinished).toBe(false);
    gate.release();
    await waitFor(async () => handlerFinished, "the handler to finish after its row was cancelled");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const finished = await bootstrap(`SELECT state FROM pgboss.job WHERE id = $1`, [jobId]);
    expect(finished.rows[0].state).toBe("cancelled");
  }, 60_000);

  it("3. leaves another module alone, including one that shares a name prefix", async () => {
    const other = `${MOD}-extra`;
    await setModuleRow(MOD, { status: "enabled" });
    await setModuleRow(other, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD), discovery(other)]);
    await reconciler.reconcileAll();
    await boss.send(MAIN, envelope(MOD, ids.userA));
    await boss.send(`${other}.main`, envelope(other, ids.userA));

    await disable(MOD);
    await reconciler.reconcileModule(MOD);

    expect(await pendingCount(MOD)).toBe(0);
    expect((await states(`${other}.main`)).every((row) => row.state === "created")).toBe(true);
    expect((await states(`${other}.main`)).length).toBeGreaterThan(0);
  }, 60_000);

  it("4. leaves a row in the module's queue that carries another module id", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)]);
    await reconciler.reconcileAll();
    await boss.send(MAIN, envelope("someone-else", ids.userA, "foreign"));

    await disable(MOD);
    await reconciler.reconcileModule(MOD);

    const foreign = await bootstrap(
      `SELECT state FROM pgboss.job WHERE name = $1 AND data->>'moduleId' = 'someone-else'`,
      [MAIN]
    );
    expect(foreign.rows).toEqual([{ state: "created" }]);
    expect(logLines.some((line) => line.includes("another module id"))).toBe(true);
  }, 60_000);

  it("5. leaves dead-letter and platform queue rows alone", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)]);
    await reconciler.reconcileAll();
    await boss.send(`${MOD}.dlq`, envelope(MOD, ids.userA, "failed-record"));
    await boss.send("system.upgrade-check", envelope(MOD, ids.userA, "platform"));

    await disable(MOD);
    await reconciler.reconcileModule(MOD);

    expect((await states(`${MOD}.dlq`)).map((row) => row.state)).toEqual(["created"]);
    expect((await states("system.upgrade-check")).map((row) => row.state)).toEqual(["created"]);
  }, 60_000);

  it("6. access loss cancels only that user's rows and schedule", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)]);
    await reconciler.reconcileAll();
    await boss.send(MAIN, envelope(MOD, ids.userA));
    await boss.send(MAIN, envelope(MOD, ids.userA), { startAfter: 3600 });
    await boss.send(MAIN, envelope(MOD, ids.userB));
    const schedulesBefore = (await boss.getSchedules()).filter((s) => s.name === MAIN);
    const keysBefore = schedulesBefore.map((s) => s.key);
    expect(keysBefore).toContain(`${MOD}/daily/${ids.userA}`);
    expect(keysBefore).toContain(`${MOD}/daily/${ids.userB}`);

    await bootstrap(`UPDATE app.users SET status = 'deactivated' WHERE id = $1`, [ids.userA]);
    await reconciler.reconcileModule(MOD);

    const rows = await states(MAIN);
    expect(
      rows.filter((row) => row.actor === ids.userA).every((r) => r.state === "cancelled")
    ).toBe(true);
    const userB = rows.filter((row) => row.actor === ids.userB);
    expect(userB.length).toBeGreaterThan(0);
    expect(userB.every((row) => row.state === "created")).toBe(true);
    const schedulesAfter = (await boss.getSchedules()).filter((s) => s.name === MAIN);
    const keysAfter = schedulesAfter.map((s) => s.key);
    expect(keysAfter).not.toContain(`${MOD}/daily/${ids.userA}`);
    expect(keysAfter).toContain(`${MOD}/daily/${ids.userB}`);
  }, 60_000);

  it("7. a hash mismatch cancels nothing, and the rows run after re-enable", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)], { withWorker: true });
    await reconciler.reconcileAll();
    await waitFor(async () => handlerCalls.some((call) => call.jobKind === "recon"), "reconcile");
    handlerCalls.length = 0;

    await setModuleRow(MOD, { status: "enabled", manifestHash: `sha256:${"c".repeat(64)}` });
    await reconciler.reconcileModule(MOD);
    await boss.send(MAIN, envelope(MOD, ids.userA, "waits-for-reenable"));
    expect(await pendingCount(MOD)).toBeGreaterThan(0);
    await reconciler.reconcileModule(MOD);
    expect((await states(MAIN)).some((row) => row.state === "cancelled")).toBe(false);

    // The automatic package-drift disable also keeps its rows.
    await setModuleRow(MOD, {
      status: "disabled",
      reason: "package changed since it was enabled"
    });
    await reconciler.reconcileModule(MOD);
    expect((await states(MAIN)).some((row) => row.state === "cancelled")).toBe(false);

    await setModuleRow(MOD, { status: "enabled" });
    await reconciler.reconcileModule(MOD);
    await waitFor(
      async () => handlerCalls.some((call) => call.jobKind === "waits-for-reenable"),
      "the waiting row to run"
    );
  }, 60_000);

  it("8. re-enable restarts regular work and resurrects nothing", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)], { withWorker: true });
    await reconciler.reconcileAll();
    await waitFor(async () => handlerCalls.some((call) => call.jobKind === "recon"), "reconcile");
    expect(await enqueueLive(MOD, ids.userA, "plan-1")).toBe("sent");
    await boss.send(MAIN, envelope(MOD, ids.userA, "old-waiting"), { startAfter: 3600 });

    await disable(MOD);
    await reconciler.reconcileModule(MOD);
    expect((await boss.getSchedules()).filter((s) => s.name === MAIN)).toHaveLength(0);
    handlerCalls.length = 0;

    await setModuleRow(MOD, { status: "enabled" });
    await reconciler.reconcileModule(MOD);
    expect(
      (await boss.getSchedules()).filter((s) => s.name === MAIN).length
    ).toBeGreaterThanOrEqual(2);
    await waitFor(async () => handlerCalls.some((call) => call.jobKind === "recon"), "new recon");
    expect(handlerCalls.some((call) => call.jobKind === "old-waiting")).toBe(false);
    expect(handlerCalls.some((call) => call.jobKind === "chain")).toBe(false);

    expect(await enqueueLive(MOD, ids.userA, "plan-1")).toBe("duplicate");
    expect(await enqueueLive(MOD, ids.userA, "plan-1-resume-2")).toBe("sent");
  }, 60_000);

  describe("9. enqueue racing a disable", () => {
    it("a sweep that starts while an enqueue holds the lock still cancels the new row", async () => {
      await setModuleRow(MOD, { status: "enabled" });
      const reconciler = makeReconciler([discovery(MOD)]);
      await reconciler.reconcileAll();
      const checked = newGate();
      const proceed = newGate();

      const enqueue = enqueueLive(MOD, ids.userA, "race", {
        afterLiveCheck: async () => {
          checked.release();
          await proceed.promise;
        }
      });
      await checked.promise;
      await disable(MOD);
      const sweep = reconciler.reconcileModule(MOD);
      await new Promise((resolve) => setTimeout(resolve, 800));
      proceed.release();
      expect(await enqueue).toBe("sent");
      await sweep;

      expect(await pendingCount(MOD)).toBe(0);
    }, 60_000);

    it("an enqueue that starts after the disable commits is refused", async () => {
      await setModuleRow(MOD, { status: "enabled" });
      const reconciler = makeReconciler([discovery(MOD)]);
      await reconciler.reconcileAll();
      await disable(MOD);
      await reconciler.reconcileModule(MOD);
      expect(await enqueueLive(MOD, ids.userA, "after")).toBe("module_inactive");
      expect(await pendingCount(MOD)).toBe(0);
    }, 60_000);
  });

  it("10. a second sweep cancels nothing and does not error", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)]);
    await reconciler.reconcileAll();
    await boss.send(MAIN, envelope(MOD, ids.userA));
    await disable(MOD);
    await reconciler.reconcileModule(MOD);
    const first = await states(MAIN);
    await reconciler.reconcileModule(MOD);
    const direct = await cancelPendingModuleJobs(boss, db, { moduleId: MOD });
    expect(direct).toEqual({ cancelled: 0, leftActive: 0 });
    expect(await states(MAIN)).toEqual(first);
  }, 60_000);

  it("11. the sweep reads no params and logs none", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)]);
    await reconciler.reconcileAll();
    await boss.send(MAIN, envelope(MOD, ids.userA, "tick", { note: SECRET_MARKER }));
    executedSql.length = 0;
    logLines.length = 0;

    await disable(MOD);
    await reconciler.reconcileModule(MOD);

    const sweepSql = executedSql.filter((text) => text.includes("pgboss."));
    expect(sweepSql.length).toBeGreaterThan(0);
    for (const text of sweepSql) {
      expect(text).not.toMatch(/params/i);
      expect(text).not.toMatch(/select\s+\*/i);
      expect(text).not.toMatch(/\bdata\b(?!->>'(moduleId|actorUserId)')/);
    }
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(SECRET_MARKER);
    expect(logLines.join("\n")).not.toMatch(/params/i);
  }, 60_000);

  it("12. an already-disabled module and a module with no queues cancel nothing", async () => {
    await setModuleRow(MOD, { status: "enabled" });
    const reconciler = makeReconciler([discovery(MOD)]);
    await reconciler.reconcileAll();
    await disable(MOD);
    await reconciler.reconcileModule(MOD);
    await expect(reconciler.reconcileModule(MOD)).resolves.toBeUndefined();

    const bare = `${MOD}-bare`;
    await setModuleRow(bare, { status: "enabled" });
    const bareReconciler = makeReconciler([discovery(bare, false)]);
    await bareReconciler.reconcileAll();
    await disable(bare);
    await expect(bareReconciler.reconcileModule(bare)).resolves.toBeUndefined();
    await expect(cancelPendingModuleJobs(boss, db, { moduleId: bare })).resolves.toEqual({
      cancelled: 0,
      leftActive: 0
    });
  }, 60_000);
});
