// #1632 dual-session cluster-DDL lock. Every test runs against FakePgCluster, which models
// advisory locks as per-(database, key) exactly like PostgreSQL's locktag — the property that
// makes cross-database mutual exclusion observable in a unit test at all.
import { describe, expect, test, vi } from "vitest";

import type * as ClusterDdlLockModule from "../cluster-ddl-lock.js";

import {
  ClusterDdlLockAcquisitionError,
  ClusterDdlLockCleanupError,
  ClusterDdlLockLivenessLostError,
  ClusterDdlLockReentrancyError,
  DEFAULT_CLUSTER_LOCK_DATABASE,
  DEFAULT_CLUSTER_LOCK_KEY,
  getClusterLockDatabaseUrl,
  withClusterDdlLock,
  type ClusterDdlLockDiagnosticEvent,
  type WithClusterDdlLockOptions
} from "../cluster-ddl-lock.js";
import {
  FakePgCluster,
  MAINTENANCE_DATABASE,
  createFakeClusterHarness
} from "./fake-pg-cluster.js";

const BOOTSTRAP_URL = "postgres://u:p@h:5432/jarv1s";

/** A macrotask boundary — flushes every pending microtask, so acquisition completes. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function laneOptions(cluster: FakePgCluster): WithClusterDdlLockOptions {
  return {
    env: {} as NodeJS.ProcessEnv,
    livenessIntervalMs: 5000,
    createLockClient: (connectionString) => cluster.createClient(connectionString),
    createDdlClient: (connectionString) => cluster.createClient(connectionString)
  };
}

/**
 * A fresh module instance, i.e. an independent process as far as the module-level reentrancy
 * flag is concerned. Two lanes contending on one FakePgCluster is the unit-test twin of two CI
 * lanes contending on one PostgreSQL cluster.
 */
async function loadLane(): Promise<typeof ClusterDdlLockModule> {
  vi.resetModules();
  return import("../cluster-ddl-lock.js");
}

function maintenanceHolder(cluster: FakePgCluster): number | undefined {
  return cluster.advisoryLockHolder(MAINTENANCE_DATABASE, DEFAULT_CLUSTER_LOCK_KEY);
}

describe("session targeting", () => {
  test("the lock session uses the maintenance DB and the DDL session the caller's database", async () => {
    // Pins both axes at once: round 1 put the DDL on the maintenance DB (42501 on schema-scoped
    // GRANTs), round 2 put the lock on the target DB (per-database locktags, no cluster-wide
    // exclusion). Either regression flips one of these two assertions.
    const cluster = new FakePgCluster();
    const lockUrls: string[] = [];
    const ddlUrls: string[] = [];

    await withClusterDdlLock(BOOTSTRAP_URL, async () => "ok", {
      env: {} as NodeJS.ProcessEnv,
      livenessIntervalMs: 5000,
      createLockClient: (connectionString) => {
        lockUrls.push(connectionString);
        return cluster.createClient(connectionString);
      },
      createDdlClient: (connectionString) => {
        ddlUrls.push(connectionString);
        return cluster.createClient(connectionString);
      }
    });

    expect(lockUrls).toEqual([getClusterLockDatabaseUrl(BOOTSTRAP_URL, {})]);
    expect(ddlUrls).toEqual([BOOTSTRAP_URL]);
  });
});

describe("mutual exclusion across lanes", () => {
  test("two lanes on different target databases still serialize", async () => {
    const cluster = new FakePgCluster();
    const laneA = await loadLane();
    const laneB = await loadLane();

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runA = laneA.withClusterDdlLock(
      "postgres://u:p@h:5432/lane_a",
      async (client) => {
        await client.query("DDL A");
        await gate;
        return "a";
      },
      laneOptions(cluster)
    );
    await flush();

    const runB = laneB.withClusterDdlLock(
      "postgres://u:p@h:5432/lane_b",
      async (client) => {
        await client.query("DDL B");
        return "b";
      },
      laneOptions(cluster)
    );
    await flush();

    // B is parked in pg_advisory_lock on the maintenance DB, so none of its DDL has run.
    expect(cluster.log.some((event) => event.text === "DDL B")).toBe(false);
    expect(cluster.log.filter((event) => event.kind === "wait").map((event) => event.db)).toEqual([
      MAINTENANCE_DATABASE
    ]);

    releaseA();
    await expect(runA).resolves.toBe("a");
    await expect(runB).resolves.toBe("b");

    const kinds = cluster.log;
    const ddlA = kinds.findIndex((event) => event.text === "DDL A");
    const ddlB = kinds.findIndex((event) => event.text === "DDL B");
    const unlockA = kinds.findIndex((event) => event.kind === "unlock");
    expect(ddlA).toBeGreaterThanOrEqual(0);
    expect(ddlA).toBeLessThan(unlockA);
    expect(unlockA).toBeLessThan(ddlB);

    // Both lanes contended on the same (maintenance database, key) — the whole point.
    const acquires = kinds.filter((event) => event.kind === "acquire");
    expect(acquires).toHaveLength(2);
    expect(acquires.every((event) => event.db === MAINTENANCE_DATABASE)).toBe(true);
    expect(new Set(acquires.map((event) => event.key)).size).toBe(1);
    // And each lane's DDL landed on its own target database.
    expect(kinds.find((event) => event.text === "DDL A")?.db).toBe("lane_a");
    expect(kinds.find((event) => event.text === "DDL B")?.db).toBe("lane_b");
  });

  test("two lanes on the same target database serialize", async () => {
    const cluster = new FakePgCluster();
    const laneA = await loadLane();
    const laneB = await loadLane();

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runA = laneA.withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        await client.query("DDL A");
        await gate;
        return "a";
      },
      laneOptions(cluster)
    );
    await flush();
    const runB = laneB.withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        await client.query("DDL B");
        return "b";
      },
      laneOptions(cluster)
    );
    await flush();

    expect(cluster.log.some((event) => event.text === "DDL B")).toBe(false);
    releaseA();
    await runA;
    await runB;

    const unlockA = cluster.log.findIndex((event) => event.kind === "unlock");
    expect(cluster.log.findIndex((event) => event.text === "DDL A")).toBeLessThan(unlockA);
    expect(cluster.log.findIndex((event) => event.text === "DDL B")).toBeGreaterThan(unlockA);
  });

  test("a waiter acquires only after the live owner's backend is gone", async () => {
    const cluster = new FakePgCluster();
    const laneA = await loadLane();
    const laneB = await loadLane();

    let lockPidA = 0;
    const runA = laneA.withClusterDdlLock(BOOTSTRAP_URL, () => never<string>(), {
      ...laneOptions(cluster),
      onDiagnostic: (event) => {
        if (event.type === "acquired") lockPidA = event.ownerPid;
      }
    });
    runA.catch(() => {});
    await flush();

    const runB = laneB.withClusterDdlLock(BOOTSTRAP_URL, async () => "b", laneOptions(cluster));
    await flush();

    // While A's backend lives, B must still be waiting — no stealing.
    expect(cluster.log.filter((event) => event.kind === "acquire")).toHaveLength(1);
    expect(maintenanceHolder(cluster)).toBe(lockPidA);

    cluster.killBackend(lockPidA);
    await expect(runA).rejects.toBeInstanceOf(laneA.ClusterDdlLockLivenessLostError);
    await expect(runB).resolves.toBe("b");

    const killIndex = cluster.log.findIndex((event) => event.kind === "kill");
    const acquires = cluster.log
      .map((event, index) => ({ event, index }))
      .filter((entry) => entry.event.kind === "acquire");
    expect(acquires).toHaveLength(2);
    expect(acquires[1]?.index).toBeGreaterThan(killIndex);
  });
});

describe("acquisition failures", () => {
  test("a lock-session connect failure is typed and never creates a DDL session", async () => {
    const cluster = new FakePgCluster();
    const fn = vi.fn(async () => "unreachable");
    let ddlClientsCreated = 0;

    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, fn, {
        env: {} as NodeJS.ProcessEnv,
        createLockClient: (connectionString) =>
          cluster.createClient(connectionString, {
            connect: () => {
              throw new Error("ECONNREFUSED");
            }
          }),
        createDdlClient: (connectionString) => {
          ddlClientsCreated += 1;
          return cluster.createClient(connectionString);
        }
      })
    ).rejects.toBeInstanceOf(ClusterDdlLockAcquisitionError);

    expect(fn).not.toHaveBeenCalled();
    expect(ddlClientsCreated).toBe(0);
  });

  test("a DDL-session connect failure releases the lock and never runs the callback", async () => {
    const cluster = new FakePgCluster();
    const fn = vi.fn(async () => "unreachable");

    const error = await withClusterDdlLock(BOOTSTRAP_URL, fn, {
      env: {} as NodeJS.ProcessEnv,
      createLockClient: (connectionString) => cluster.createClient(connectionString),
      createDdlClient: (connectionString) =>
        cluster.createClient(connectionString, {
          connect: () => {
            throw new Error("ddl connect refused");
          }
        })
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClusterDdlLockAcquisitionError);
    expect((error as ClusterDdlLockAcquisitionError).cause).toMatchObject({
      message: "ddl connect refused"
    });
    expect(fn).not.toHaveBeenCalled();
    expect(maintenanceHolder(cluster)).toBeUndefined();

    // No residue: the next invocation on the same cluster acquires immediately.
    const follower = createFakeClusterHarness({ cluster });
    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "follower", follower.options)
    ).resolves.toBe("follower");
  });

  test("an identity-query failure is an acquisition error and ends every opened session once", async () => {
    const cluster = new FakePgCluster();
    const fn = vi.fn(async () => "unreachable");
    let ddlClientsCreated = 0;
    const lockClient = cluster.createClient(getClusterLockDatabaseUrl(BOOTSTRAP_URL, {}), {
      query: (text) =>
        text.includes("pg_backend_pid")
          ? Promise.reject(new Error("identity query failed"))
          : undefined
    });

    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, fn, {
        env: {} as NodeJS.ProcessEnv,
        createLockClient: () => lockClient,
        createDdlClient: (connectionString) => {
          ddlClientsCreated += 1;
          return cluster.createClient(connectionString);
        }
      })
    ).rejects.toBeInstanceOf(ClusterDdlLockAcquisitionError);

    expect(fn).not.toHaveBeenCalled();
    expect(lockClient.endCalls).toBe(1);
    expect(ddlClientsCreated).toBe(0);
  });
});

describe("the success path", () => {
  test("every callback statement runs on the DDL session while our lock session holds the lock", async () => {
    const harness = createFakeClusterHarness();
    const fn = vi.fn(async (client: { query: (text: string) => Promise<unknown> }) => {
      await client.query("CREATE ROLE demo");
      await client.query("GRANT CREATE ON SCHEMA app TO demo");
      return "ok";
    });

    await expect(withClusterDdlLock(BOOTSTRAP_URL, fn, harness.options)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);

    const { cluster, lock, ddl } = harness;
    const callbackStatements = cluster.log.filter(
      (event) => event.kind === "statement" && event.pid === ddl.pid
    );
    expect(callbackStatements.map((event) => event.text)).toEqual([
      "CREATE ROLE demo",
      "GRANT CREATE ON SCHEMA app TO demo"
    ]);
    expect(callbackStatements.every((event) => event.db === "jarv1s")).toBe(true);
    // The serialization claim itself: our lock session held the maintenance lock for each one.
    expect(callbackStatements.every((event) => event.maintenanceLockHolderPid === lock.pid)).toBe(
      true
    );

    const acquires = cluster.log.filter((event) => event.kind === "acquire");
    const unlocks = cluster.log.filter((event) => event.kind === "unlock");
    expect(acquires.map((event) => event.pid)).toEqual([lock.pid]);
    expect(unlocks.map((event) => event.pid)).toEqual([lock.pid]);

    const acquireIndex = cluster.log.findIndex((event) => event.kind === "acquire");
    const unlockIndex = cluster.log.findIndex((event) => event.kind === "unlock");
    const firstStatement = cluster.log.findIndex(
      (event) => event.kind === "statement" && event.pid === ddl.pid
    );
    const lastStatement = cluster.log.reduce(
      (last, event, index) => (event.kind === "statement" && event.pid === ddl.pid ? index : last),
      -1
    );
    expect(acquireIndex).toBeLessThan(firstStatement);
    expect(lastStatement).toBeLessThan(unlockIndex);
  });

  test("success releases exactly once, ends both sessions, and leaves no lock residue", async () => {
    const harness = createFakeClusterHarness();

    await withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        await client.query("ALTER ROLE demo NOLOGIN");
      },
      harness.options
    );

    expect(harness.lock.texts.filter((text) => text.includes("pg_advisory_unlock"))).toHaveLength(
      1
    );
    expect(harness.lock.endCalls).toBe(1);
    expect(harness.ddl.endCalls).toBe(1);
    expect(maintenanceHolder(harness.cluster)).toBeUndefined();

    const follower = createFakeClusterHarness({ cluster: harness.cluster });
    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "follower", follower.options)
    ).resolves.toBe("follower");
  });
});

describe("liveness detection", () => {
  test("a lock-session 'error' event mid-callback is liveness loss, and never unlocks", async () => {
    const harness = createFakeClusterHarness();
    const promise = withClusterDdlLock(BOOTSTRAP_URL, () => never<string>(), harness.options);
    await flush();

    harness.cluster.killBackend(harness.lock.pid);
    const error = await promise.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect((error as ClusterDdlLockLivenessLostError).signal).toBe("connection-error");
    expect((error as ClusterDdlLockLivenessLostError).ownerPid).toBe(harness.lock.pid);
    expect(harness.lock.texts.some((text) => text.includes("pg_advisory_unlock"))).toBe(false);
    expect(harness.lock.endCalls).toBe(1);
    expect(harness.ddl.endCalls).toBe(1);
  });

  test("the heartbeat detects a silently dead lock backend during an idle callback", async () => {
    const harness = createFakeClusterHarness({ livenessIntervalMs: 50 });
    const promise = withClusterDdlLock(BOOTSTRAP_URL, () => never<string>(), harness.options);
    await flush();

    // emitError: false — the driver pushes nothing, so only the heartbeat can find this.
    const killedAt = Date.now();
    harness.cluster.killBackend(harness.lock.pid, { emitError: false });
    const error = await promise.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect((error as ClusterDdlLockLivenessLostError).signal).toBe("heartbeat");
    // Documented bound: <= 2 x livenessIntervalMs plus scheduler jitter.
    expect(Date.now() - killedAt).toBeLessThan(2 * 50 + 400);
  });

  test("a heartbeat query rejection is liveness loss", async () => {
    let failHeartbeat = false;
    const harness = createFakeClusterHarness({
      livenessIntervalMs: 50,
      lockBehavior: {
        query: (text) =>
          failHeartbeat && text === "SELECT 1"
            ? Promise.reject(new Error("terminating connection due to administrator command"))
            : undefined
      }
    });
    const promise = withClusterDdlLock(BOOTSTRAP_URL, () => never<string>(), harness.options);
    setTimeout(() => {
      failHeartbeat = true;
    }, 5);

    const error = await promise.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect((error as ClusterDdlLockLivenessLostError).signal).toBe("heartbeat");
  });

  test("a heartbeat that never settles before the next tick is liveness loss", async () => {
    // The hang/partition case: nothing rejects, so a rejection-only implementation waits forever.
    const harness = createFakeClusterHarness({
      livenessIntervalMs: 50,
      lockBehavior: {
        query: (text) => (text === "SELECT 1" ? never<{ rows: unknown[] }>() : undefined)
      }
    });

    const startedAt = Date.now();
    const error = await withClusterDdlLock(
      BOOTSTRAP_URL,
      () => never<string>(),
      harness.options
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect((error as ClusterDdlLockLivenessLostError).signal).toBe("heartbeat");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  test("the final check rejects a callback that fulfilled after its lock session died", async () => {
    const harness = createFakeClusterHarness();

    const error = await withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        await client.query("LAST DDL");
        harness.cluster.killBackend(harness.lock.pid, { emitError: false });
        return "must-never-be-reported";
      },
      harness.options
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect((error as ClusterDdlLockLivenessLostError).signal).toBe("final-check");
  });
});

describe("the guarded DDL client", () => {
  test("fails closed: a query issued after recorded loss never reaches the wire", async () => {
    const harness = createFakeClusterHarness();
    let guardRejection: unknown;

    const outcome = await withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        await client.query("BEFORE LOSS");
        harness.cluster.killBackend(harness.lock.pid);
        guardRejection = await client.query("AFTER LOSS").catch((cause: unknown) => cause);
        throw guardRejection;
      },
      harness.options
    ).catch((cause: unknown) => cause);

    expect(guardRejection).toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect(harness.cluster.log.some((event) => event.text === "AFTER LOSS")).toBe(false);
    // The callback rethrew the guard's own liveness error: reported alone, not self-aggregated.
    expect(outcome).toBe(guardRejection);
    expect(outcome).not.toBeInstanceOf(AggregateError);
  });

  test("a statement in flight when the lock dies rejects, and its late result never surfaces", async () => {
    let completeSlow: (result: { rows: unknown[] }) => void = () => {};
    const slow = new Promise<{ rows: unknown[] }>((resolve) => {
      completeSlow = resolve;
    });
    const harness = createFakeClusterHarness({
      ddlBehavior: { query: (text) => (text === "SLOW DDL" ? slow : undefined) }
    });

    let observed: unknown;
    await withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        const pending = client.query("SLOW DDL");
        setTimeout(() => harness.cluster.killBackend(harness.lock.pid), 5);
        setTimeout(() => completeSlow({ rows: [{ late: true }] }), 25);
        observed = await pending.catch((cause: unknown) => cause);
        throw observed;
      },
      harness.options
    ).catch(() => {});

    expect(observed).toBeInstanceOf(ClusterDdlLockLivenessLostError);
  });

  test("DDL-session death is an ordinary callback failure, not liveness loss", async () => {
    const harness = createFakeClusterHarness({
      ddlBehavior: {
        query: (text) => (text === "SLOW DDL" ? never<{ rows: unknown[] }>() : undefined)
      }
    });

    const error = await withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        setTimeout(() => harness.cluster.killBackend(harness.ddl.pid), 5);
        return await client.query("SLOW DDL");
      },
      harness.options
    ).catch((cause: unknown) => cause);

    expect(error).not.toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect((error as Error).message).toBe("Connection terminated unexpectedly");
    // The lock session was never in trouble, so it released cleanly.
    expect(harness.lock.texts.some((text) => text.includes("pg_advisory_unlock"))).toBe(true);
    expect(maintenanceHolder(harness.cluster)).toBeUndefined();

    const follower = createFakeClusterHarness({ cluster: harness.cluster });
    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "follower", follower.options)
    ).resolves.toBe("follower");
  });
});

describe("error combination", () => {
  test("an independent callback failure concurrent with liveness loss aggregates both", async () => {
    const harness = createFakeClusterHarness();

    const outcome = await withClusterDdlLock(
      BOOTSTRAP_URL,
      async () => {
        harness.cluster.killBackend(harness.lock.pid);
        throw new Error("callback also failed");
      },
      harness.options
    ).catch((cause: unknown) => cause);

    expect(outcome).toBeInstanceOf(AggregateError);
    const errors = (outcome as AggregateError).errors;
    expect(errors.some((error) => error instanceof ClusterDdlLockLivenessLostError)).toBe(true);
    expect(
      errors.some((error) => error instanceof Error && error.message === "callback also failed")
    ).toBe(true);
  });

  test("a cleanup failure after a successful callback is reported, not swallowed", async () => {
    const harness = createFakeClusterHarness({
      lockBehavior: {
        query: (text) =>
          text.includes("pg_advisory_unlock")
            ? Promise.reject(new Error("unlock failed"))
            : undefined
      }
    });

    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "ok", harness.options)
    ).rejects.toBeInstanceOf(ClusterDdlLockCleanupError);
  });

  test("a callback failure plus a cleanup failure preserves both members", async () => {
    const harness = createFakeClusterHarness({
      lockBehavior: {
        query: (text) =>
          text.includes("pg_advisory_unlock")
            ? Promise.reject(new Error("unlock failed"))
            : undefined
      }
    });

    const outcome = await withClusterDdlLock(
      BOOTSTRAP_URL,
      async () => {
        throw new Error("callback failed");
      },
      harness.options
    ).catch((cause: unknown) => cause);

    expect(outcome).toBeInstanceOf(AggregateError);
    const errors = (outcome as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(
      errors.some((error) => error instanceof Error && error.message === "callback failed")
    ).toBe(true);
    expect(errors.some((error) => error instanceof ClusterDdlLockCleanupError)).toBe(true);
  });
});

describe("guard rails", () => {
  test("a reentrant call is refused before any connection is attempted", async () => {
    const harness = createFakeClusterHarness();
    let nestedClientsCreated = 0;

    let releaseOuter: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });

    const outer = withClusterDdlLock(
      BOOTSTRAP_URL,
      async () => {
        await gate;
        return "outer-done";
      },
      harness.options
    );
    await flush();

    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "nested", {
        env: {} as NodeJS.ProcessEnv,
        createLockClient: (connectionString) => {
          nestedClientsCreated += 1;
          return harness.cluster.createClient(connectionString);
        },
        createDdlClient: (connectionString) => {
          nestedClientsCreated += 1;
          return harness.cluster.createClient(connectionString);
        }
      })
    ).rejects.toBeInstanceOf(ClusterDdlLockReentrancyError);
    expect(nestedClientsCreated).toBe(0);

    releaseOuter();
    await expect(outer).resolves.toBe("outer-done");
  });

  test("livenessIntervalMs outside [50, 5000] is rejected before any client is created", async () => {
    const cluster = new FakePgCluster();
    let clientsCreated = 0;
    const counting: WithClusterDdlLockOptions = {
      env: {} as NodeJS.ProcessEnv,
      createLockClient: (connectionString) => {
        clientsCreated += 1;
        return cluster.createClient(connectionString);
      },
      createDdlClient: (connectionString) => {
        clientsCreated += 1;
        return cluster.createClient(connectionString);
      }
    };

    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "unreachable", {
        ...counting,
        livenessIntervalMs: 10
      })
    ).rejects.toThrow(/livenessIntervalMs/);
    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "unreachable", {
        ...counting,
        livenessIntervalMs: 10_000
      })
    ).rejects.toThrow(/livenessIntervalMs/);
    expect(clientsCreated).toBe(0);
  });
});

describe("diagnostics", () => {
  test("a sink that throws never alters the outcome", async () => {
    const harness = createFakeClusterHarness();

    await expect(
      withClusterDdlLock(BOOTSTRAP_URL, async () => "ok", {
        ...harness.options,
        onDiagnostic: () => {
          throw new Error("sink exploded");
        }
      })
    ).resolves.toBe("ok");
  });

  test("the success path emits acquired, then any heartbeats, then released", async () => {
    const harness = createFakeClusterHarness({ livenessIntervalMs: 50 });
    const events: ClusterDdlLockDiagnosticEvent[] = [];

    await withClusterDdlLock(
      BOOTSTRAP_URL,
      async (client) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await client.query("DDL");
      },
      { ...harness.options, onDiagnostic: (event) => events.push(event) }
    );

    expect(events[0]).toEqual({ type: "acquired", ownerPid: harness.lock.pid });
    expect(events.at(-1)).toEqual({ type: "released", released: true });
    const heartbeats = events.slice(1, -1);
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.every((event) => event.type === "heartbeat")).toBe(true);
  });

  test("the liveness-loss path never reports a release", async () => {
    const harness = createFakeClusterHarness();
    const events: ClusterDdlLockDiagnosticEvent[] = [];

    const promise = withClusterDdlLock(BOOTSTRAP_URL, () => never<string>(), {
      ...harness.options,
      onDiagnostic: (event) => events.push(event)
    });
    await flush();
    harness.cluster.killBackend(harness.lock.pid);
    await promise.catch(() => {});

    expect(events.some((event) => event.type === "released")).toBe(false);
  });
});

describe("getClusterLockDatabaseUrl", () => {
  test("defaults to the postgres maintenance database and preserves query params", () => {
    const url = getClusterLockDatabaseUrl("postgres://u:p@h:5432/jarv1s?sslmode=require", {});
    expect(url).toBe(`postgres://u:p@h:5432/${DEFAULT_CLUSTER_LOCK_DATABASE}?sslmode=require`);
  });

  test("JARVIS_CLUSTER_LOCK_DATABASE overrides the target database", () => {
    const url = getClusterLockDatabaseUrl("postgres://u:p@h:5432/jarv1s", {
      JARVIS_CLUSTER_LOCK_DATABASE: "cluster_admin"
    });
    expect(url).toBe("postgres://u:p@h:5432/cluster_admin");
  });

  test("MOSS_CLUSTER_LOCK_DATABASE takes precedence over the legacy JARVIS_ name", () => {
    const url = getClusterLockDatabaseUrl("postgres://u:p@h:5432/jarv1s", {
      JARVIS_CLUSTER_LOCK_DATABASE: "legacy_name",
      MOSS_CLUSTER_LOCK_DATABASE: "moss_name"
    });
    expect(url).toBe("postgres://u:p@h:5432/moss_name");
  });
});
