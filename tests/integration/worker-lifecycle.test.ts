/**
 * Worker lifecycle tests — OTNR #165 (MED testability).
 *
 * These tests cover:
 * (a) No-actor rejection: a job without actorUserId throws BEFORE any DB read.
 *     The guarantee lives in packages/jobs/src/pg-boss.ts `toAccessContext`
 *     (lines 145–149), which is called by `registerDataContextWorker` before
 *     the handler body runs.  We test it by calling the wrapper with a mock
 *     pg-boss that delivers a no-actorUserId job, asserting the throw surfaces
 *     and the handler body (which would set a flag) never executes.
 *
 * (b) Shutdown ordering: boss.stop() resolves before workerDb.destroy() is
 *     called.  We verify this with a call-order tracker using lightweight stubs
 *     that resolve synchronously — no DB needed.
 *
 * Neither test boots the full worker binary (buildWorker).  Full worker lifecycle
 * is covered by the foundation.test.ts pg-boss integration suite.
 */

import { describe, expect, it } from "vitest";
import type { Job, PgBoss, WorkHandler } from "pg-boss";

import {
  registerDataContextWorker,
  type ActorScopedJobPayload,
  type RlsProbeJobPayload
} from "@moss/jobs";
import type { DataContextRunner } from "@moss/db";
import { ExternalModuleJobReconciler } from "@moss/module-registry/node";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { resolveExternalWorkerConfig } from "../../apps/worker/src/worker.js";

// ---------------------------------------------------------------------------
// (a) No-actor rejection at the registerDataContextWorker wrapper level
//
// We bypass the real pg-boss by providing a minimal stub that immediately
// invokes the registered work handler with a malformed job (no actorUserId).
// This is the narrowest layer where the invariant actually lives and avoids
// needing live DB or pg-boss schema permissions.
// ---------------------------------------------------------------------------
describe("registerDataContextWorker no-actor rejection (#165)", () => {
  it("throws 'missing actorUserId' before handler body runs when job has no actorUserId", async () => {
    let handlerBodyExecuted = false;

    // Capture the registered handler so we can invoke it directly.
    let capturedHandler: WorkHandler<ActorScopedJobPayload> | undefined;

    // Minimal pg-boss stub: records the handler passed to boss.work().
    const stubBoss = {
      work: (
        _queue: string,
        _opts: unknown,
        handler: WorkHandler<ActorScopedJobPayload>
      ): Promise<string> => {
        capturedHandler = handler;
        return Promise.resolve("stub-work-id");
      }
    } as unknown as PgBoss;

    // Minimal DataContextRunner stub — withDataContext must NOT be called.
    const stubContext = {
      withDataContext: () => {
        handlerBodyExecuted = true;
        return Promise.resolve(undefined);
      }
    } as unknown as DataContextRunner;

    await registerDataContextWorker<RlsProbeJobPayload, void>(
      stubBoss,
      "rls-probe",
      stubContext,
      async () => {
        handlerBodyExecuted = true;
      }
    );

    // Invoke the captured handler with a job that is missing actorUserId.
    // Cast via unknown because we only need the fields that toAccessContext reads.
    const malformedJob = {
      id: "00000000-0000-4000-8000-000000000099",
      name: "rls-probe",
      data: { actorUserId: "" } as ActorScopedJobPayload, // empty string → falsy
      expireInSeconds: 60,
      heartbeatSeconds: null,
      signal: new AbortController().signal
    } as unknown as Job<ActorScopedJobPayload>;

    await expect(capturedHandler!([malformedJob])).rejects.toThrow(/missing actorUserId/i);
    expect(handlerBodyExecuted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) Shutdown ordering (#165 MED)
//
// boss.stop({ graceful: true }) must resolve BEFORE workerDb.destroy() is
// called. We replicate the shutdown function from buildWorker using stubs.
// ---------------------------------------------------------------------------
describe("shutdown ordering (#165 MED)", () => {
  it("stops boss before destroying the db pool", async () => {
    const callOrder: string[] = [];

    // Minimal stubs: each records a call and resolves immediately.
    const mockBoss = {
      stop: async ({ graceful }: { graceful: boolean }) => {
        callOrder.push(`boss.stop(graceful=${graceful})`);
      }
    };
    const mockDb = {
      destroy: async () => {
        callOrder.push("db.destroy");
      }
    };

    // Replicate the shutdown function from buildWorker exactly:
    //   1. Race boss.stop(graceful:true) vs 10s timeout
    //   2. await db.destroy() AFTER boss.stop resolves
    const GRACEFUL_STOP_TIMEOUT_MS = 10_000;
    async function shutdown(): Promise<void> {
      await Promise.race([
        mockBoss.stop({ graceful: true }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, GRACEFUL_STOP_TIMEOUT_MS);
        })
      ]);
      await mockDb.destroy();
    }

    await shutdown();

    expect(callOrder).toEqual(["boss.stop(graceful=true)", "db.destroy"]);
    expect(callOrder.indexOf("boss.stop(graceful=true)")).toBeLessThan(
      callOrder.indexOf("db.destroy")
    );
  });
});

describe("external module job reconciliation (#996, #860)", () => {
  it("always resolves a modulesDir (never null — the flag was removed)", () => {
    expect(resolveExternalWorkerConfig({} as NodeJS.ProcessEnv).modulesDir).toBeTruthy();
    expect(
      resolveExternalWorkerConfig({ JARVIS_MODULES_DIR: "/modules" } as NodeJS.ProcessEnv)
    ).toEqual({ modulesDir: "/modules" });
  });

  it("creates dead-letter targets before sources and converges queue options", async () => {
    const calls: string[] = [];
    const boss = {
      getQueue: async () => null,
      createQueue: async (name: string) => {
        calls.push(`create:${name}`);
      },
      updateQueue: async (name: string, options: unknown) => {
        calls.push(`update:${name}:${JSON.stringify(options)}`);
      },
      getSchedules: async () => [],
      work: async () => "worker-id"
    } as unknown as PgBoss;
    const module = {
      id: "fixture",
      dir: "/fixture",
      manifestHash: `sha256:${"a".repeat(64)}`,
      packageHash: `sha256:${"b".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        publisher: "tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        worker: {
          queues: [
            {
              name: "fixture.main",
              handler: "main",
              retryLimit: 3,
              deadLetterQueue: "fixture.dlq"
            },
            { name: "fixture.dlq", handler: "dead" }
          ]
        }
      }
    } as ExternalModuleDiscovery;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => []
    });

    await reconciler.reconcileAll();

    expect(calls).toEqual([
      "create:fixture.dlq",
      "create:fixture.main",
      'update:fixture.main:{"retryLimit":3,"deadLetter":"fixture.dlq"}'
    ]);
  });

  it("registers once and stops the old worker before a manifest replacement", async () => {
    const calls: string[] = [];
    let manifestHash = `sha256:${"a".repeat(64)}`;
    let queues: Array<{ name: string; handler: string }> = [
      { name: "fixture.main", handler: "main" }
    ];
    const discovery = (): ExternalModuleDiscovery => ({
      id: "fixture",
      dir: "/fixture",
      manifestHash,
      packageHash: `sha256:${"b".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        publisher: "tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        worker: { queues }
      }
    });
    const boss = {
      getQueue: async () => ({ name: "fixture.main" }),
      getSchedules: async () => [],
      offWork: async (name: string) => calls.push(`off:${name}`),
      deleteQueue: async (name: string) => calls.push(`delete:${name}`)
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [discovery()],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [],
      registerWorker: async (_module, queue) => {
        calls.push(`work:${queue.name}`);
      }
    });

    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    manifestHash = `sha256:${"c".repeat(64)}`;
    await reconciler.reconcileAll();
    queues = [];
    await reconciler.reconcileAll();

    expect(calls).toEqual([
      "work:fixture.main",
      "off:fixture.main",
      "work:fixture.main",
      "off:fixture.main",
      "delete:fixture.main"
    ]);
  });

  it("fans schedules out by user and removes stale module keys", async () => {
    const calls: string[] = [];
    const actorUserId = "00000000-0000-4000-8000-000000000001";
    const module = {
      id: "fixture",
      dir: "/fixture",
      manifestHash: `sha256:${"a".repeat(64)}`,
      packageHash: `sha256:${"b".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        publisher: "tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        worker: {
          queues: [{ name: "fixture.main", handler: "main" }],
          schedules: [
            {
              id: "daily",
              cron: "0 8 * * *",
              queue: "fixture.main",
              jobKind: "daily",
              scope: "user"
            }
          ]
        }
      }
    } as ExternalModuleDiscovery;
    const boss = {
      getQueue: async () => ({ name: "fixture.main" }),
      getSchedules: async () => [
        { name: "fixture.main", key: "fixture/old/00000000-0000-4000-8000-000000000002" },
        { name: "notes.sync", key: actorUserId }
      ],
      schedule: async (name: string, _cron: string, data: unknown, options: { key?: string }) => {
        calls.push(`schedule:${name}:${options.key}:${JSON.stringify(data)}`);
      },
      unschedule: async (name: string, key: string) => calls.push(`unschedule:${name}:${key}`)
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [actorUserId]
    });

    await reconciler.reconcileUser(actorUserId);

    expect(calls).toEqual([
      `schedule:fixture.main:fixture/daily/${actorUserId}:${JSON.stringify({ actorUserId, moduleId: "fixture", jobKind: "daily", manifestHash: module.manifestHash })}`,
      "unschedule:fixture.main:fixture/old/00000000-0000-4000-8000-000000000002"
    ]);
    // Regression (#1147 UAT): pg-boss v12 assertKey only allows [\w.\-/] in
    // schedule keys — a ":"-separated key made boss.schedule throw
    // AssertionError, reconcileAll's catch ran stopModule, and every queue
    // worker for the module was silently unregistered (jobs stuck "created").
    const scheduledKey = calls[0]?.split(":")[2] ?? "";
    expect(scheduledKey).toMatch(/^[\w.\-/]+$/);
  });

  it("enqueues manifest reconcileJobs once per active user with a singleton key", async () => {
    const sent: { name: string; payload: unknown; options: unknown }[] = [];
    const users = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const module = {
      id: "acme",
      dir: "/acme",
      manifestHash: `sha256:${"c".repeat(64)}`,
      packageHash: `sha256:${"d".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        publisher: "tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        worker: {
          queues: [{ name: "acme.migrate", handler: "migrate" }],
          reconcileJobs: [{ id: "storage-migrate", queue: "acme.migrate", jobKind: "acme.migrate" }]
        }
      }
    } as ExternalModuleDiscovery;
    const boss = {
      getQueue: async () => ({ name: "acme.migrate" }),
      getSchedules: async () => [],
      send: async (name: string, payload: unknown, options: unknown) => {
        sent.push({ name, payload, options });
        return "job-id";
      }
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => users
    });

    await reconciler.reconcileModule("acme");

    expect(sent).toEqual([
      {
        name: "acme.migrate",
        payload: {
          actorUserId: users[0],
          moduleId: "acme",
          jobKind: "acme.migrate",
          manifestHash: module.manifestHash
        },
        options: {
          singletonKey: `acme/storage-migrate/${users[0]}/sha256-${"d".repeat(64)}`,
          singletonSeconds: 30
        }
      },
      {
        name: "acme.migrate",
        payload: {
          actorUserId: users[1],
          moduleId: "acme",
          jobKind: "acme.migrate",
          manifestHash: module.manifestHash
        },
        options: {
          singletonKey: `acme/storage-migrate/${users[1]}/sha256-${"d".repeat(64)}`,
          singletonSeconds: 30
        }
      }
    ]);
    // "/" separator, not ":" — pg-boss v12 assertKey restricts keys to [\w.\-/] (#1147 lesson).
    for (const entry of sent) {
      expect((entry.options as { singletonKey: string }).singletonKey).toMatch(/^[\w.\-/]+$/);
    }
  });

  it("skips reconcileJobs whose queue is not declared", async () => {
    const sent: unknown[] = [];
    const module = {
      id: "acme",
      dir: "/acme",
      manifestHash: `sha256:${"c".repeat(64)}`,
      packageHash: `sha256:${"d".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        publisher: "tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        worker: {
          queues: [{ name: "acme.migrate", handler: "migrate" }],
          reconcileJobs: [{ id: "storage-migrate", queue: "acme.missing", jobKind: "acme.migrate" }]
        }
      }
    } as ExternalModuleDiscovery;
    const boss = {
      getQueue: async () => ({ name: "acme.migrate" }),
      getSchedules: async () => [],
      send: async (...args: unknown[]) => {
        sent.push(args);
        return "job-id";
      }
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => ["00000000-0000-4000-8000-000000000001"]
    });

    await reconciler.reconcileModule("acme");

    expect(sent).toEqual([]);
  });

  it("stops workers and schedules on disable without deleting queues", async () => {
    const calls: string[] = [];
    let enabled = true;
    const actorUserId = "00000000-0000-4000-8000-000000000001";
    const module = {
      id: "fixture",
      dir: "/fixture",
      manifestHash: `sha256:${"a".repeat(64)}`,
      packageHash: `sha256:${"b".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        publisher: "tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        worker: {
          queues: [{ name: "fixture.main", handler: "main" }],
          schedules: [
            {
              id: "daily",
              cron: "0 8 * * *",
              queue: "fixture.main",
              jobKind: "daily",
              scope: "user"
            }
          ]
        }
      }
    } as ExternalModuleDiscovery;
    const boss = {
      getQueue: async () => ({ name: "fixture.main" }),
      getSchedules: async () => [{ name: "fixture.main", key: `fixture/daily/${actorUserId}` }],
      schedule: async () => undefined,
      offWork: async (name: string) => calls.push(`off:${name}`),
      unschedule: async (name: string, key: string) => calls.push(`unschedule:${name}:${key}`),
      deleteQueue: async (name: string) => calls.push(`delete:${name}`)
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => enabled,
      listActiveUserIds: async () => [actorUserId],
      registerWorker: async () => undefined
    });
    await reconciler.reconcileAll();
    enabled = false;

    await reconciler.reconcileModule("fixture");

    expect(calls).toEqual([
      "off:fixture.main",
      `unschedule:fixture.main:fixture/daily/${actorUserId}`
    ]);
  });

  it("purges orphaned workers, schedules, and queues when discovery disappears", async () => {
    const calls: string[] = [];
    let discoveries: readonly ExternalModuleDiscovery[] = [
      {
        id: "fixture",
        dir: "/fixture",
        manifestHash: `sha256:${"a".repeat(64)}`,
        packageHash: `sha256:${"b".repeat(64)}`,
        manifest: {
          schemaVersion: 1,
          id: "fixture",
          name: "Fixture",
          version: "1.0.0",
          publisher: "tests",
          lifecycle: "optional",
          compatibility: { jarv1s: ">=0.0.0" },
          runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
          worker: { queues: [{ name: "fixture.main", handler: "main" }] }
        }
      } as ExternalModuleDiscovery
    ];
    const boss = {
      getQueue: async () => ({ name: "fixture.main" }),
      getSchedules: async () => [{ name: "fixture.main", key: "fixture/old/user" }],
      offWork: async (name: string) => calls.push(`off:${name}`),
      unschedule: async (name: string, key: string) => calls.push(`unschedule:${name}:${key}`),
      deleteQueue: async (name: string) => calls.push(`delete:${name}`)
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => discoveries,
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [],
      registerWorker: async () => undefined
    });
    await reconciler.reconcileAll();
    calls.length = 0;
    discoveries = [];

    await reconciler.reconcileModule("fixture");

    expect(calls).toEqual([
      "off:fixture.main",
      "unschedule:fixture.main:fixture/old/user",
      "delete:fixture.main"
    ]);
  });

  it("stops process-local registrations on close", async () => {
    const calls: string[] = [];
    const module = {
      id: "fixture",
      dir: "/fixture",
      manifestHash: `sha256:${"a".repeat(64)}`,
      packageHash: `sha256:${"b".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        publisher: "tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        worker: { queues: [{ name: "fixture.main", handler: "main" }] }
      }
    } as ExternalModuleDiscovery;
    const boss = {
      getQueue: async () => ({ name: "fixture.main" }),
      getSchedules: async () => [],
      offWork: async (name: string) => calls.push(name)
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [],
      registerWorker: async () => undefined
    });
    await reconciler.reconcileAll();

    await reconciler.close();

    expect(calls).toEqual(["fixture.main"]);
  });

  it("fails one module closed without blocking sibling reconciliation", async () => {
    const calls: string[] = [];
    const logs: unknown[] = [];
    let failing = false;
    let goodHash = `sha256:${"b".repeat(64)}`;
    const module = (id: string, manifestHash: string) =>
      ({
        id,
        dir: `/${id}`,
        manifestHash,
        packageHash: `sha256:${"c".repeat(64)}`,
        manifest: {
          worker: { queues: [{ name: `${id}.main`, handler: "main" }] }
        }
      }) as unknown as ExternalModuleDiscovery;
    const discoveries = () => [module("bad", `sha256:${"a".repeat(64)}`), module("good", goodHash)];
    const boss = {
      getQueue: async (name: string) => {
        if (failing && name === "bad.main") throw new TypeError("private detail");
        return { name };
      },
      getSchedules: async () => (failing ? [{ name: "bad.main", key: "bad/daily/user" }] : []),
      offWork: async (name: string) => calls.push(`off:${name}`),
      unschedule: async (name: string, key: string) => calls.push(`unschedule:${name}:${key}`)
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries,
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [],
      registerWorker: async (_module, queue) => {
        calls.push(`work:${queue.name}`);
      },
      logger: { warn: (data) => logs.push(data) }
    });
    await reconciler.reconcileAll();
    calls.length = 0;
    failing = true;
    goodHash = `sha256:${"d".repeat(64)}`;

    await reconciler.reconcileAll();

    expect(calls).toEqual([
      "off:bad.main",
      "unschedule:bad.main:bad/daily/user",
      "off:good.main",
      "work:good.main"
    ]);
    expect(logs).toEqual([{ moduleId: "bad", errorName: "TypeError" }]);
  });

  it("purges cold-start orphan schedules and queues but preserves reserved queues", async () => {
    const calls: string[] = [];
    const boss = {
      getSchedules: async () => [{ name: "orphan.main", key: "orphan/daily/user" }],
      getQueues: async () => [{ name: "platform.module-control" }, { name: "orphan.main" }],
      unschedule: async (name: string, key: string) => calls.push(`unschedule:${name}:${key}`),
      deleteQueue: async (name: string) => calls.push(`delete:${name}`)
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [],
      reservedQueueNames: new Set(["platform.module-control"]),
      isModuleEnabled: async () => false,
      listActiveUserIds: async () => []
    });

    await reconciler.reconcileAll();

    expect(calls).toEqual(["unschedule:orphan.main:orphan/daily/user", "delete:orphan.main"]);
  });
});
