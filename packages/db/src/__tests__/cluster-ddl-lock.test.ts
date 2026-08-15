import { describe, expect, test, vi } from "vitest";

import {
  ClusterDdlLockAcquisitionError,
  ClusterDdlLockCleanupError,
  ClusterDdlLockLivenessLostError,
  ClusterDdlLockReentrancyError,
  DEFAULT_CLUSTER_LOCK_DATABASE,
  getClusterLockDatabaseUrl,
  withClusterDdlLock,
  type ClusterDdlLockClient
} from "../cluster-ddl-lock.js";

interface FakeClientOptions {
  readonly connect?: () => Promise<void>;
  readonly query?: (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
}

class FakeClient implements ClusterDdlLockClient {
  readonly queryCalls: Array<{ text: string; params?: readonly unknown[] }> = [];
  endCalls = 0;
  private readonly connectImpl: () => Promise<void>;
  private readonly queryImpl: (
    text: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: unknown[] }>;
  private readonly listeners = new Map<string, Set<(error: Error) => void>>();

  constructor(options: FakeClientOptions = {}) {
    this.connectImpl = options.connect ?? (async () => {});
    this.queryImpl = options.query ?? (async () => ({ rows: [] }));
  }

  connect(): Promise<void> {
    return this.connectImpl();
  }

  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }> {
    this.queryCalls.push({ text, params });
    return this.queryImpl(text, params) as Promise<{ rows: T[] }>;
  }

  end(): Promise<void> {
    this.endCalls++;
    return Promise.resolve();
  }

  on(event: "error", listener: (error: Error) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  removeListener(event: "error", listener: (error: Error) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener(error);
    }
  }
}

const OWNER_PID = 4242;

/** A working owner client: acquires the lock and reports OWNER_PID, idle until told otherwise. */
function createWorkingOwner(overrides: Partial<FakeClientOptions> = {}): FakeClient {
  return new FakeClient({
    query: async (text) => {
      if (text.includes("pg_backend_pid")) {
        return { rows: [{ pid: OWNER_PID }] };
      }
      return { rows: [{}] };
    },
    ...overrides
  });
}

/** A probe client that reports the owner alive until `markGone()` is called. */
function createProbe(): {
  probe: FakeClient;
  markGone: () => void;
  failNextQuery: (error: Error) => void;
} {
  let gone = false;
  let pendingFailure: Error | undefined;
  const probe = new FakeClient({
    query: async (text) => {
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = undefined;
        throw error;
      }
      if (text.includes("pg_stat_activity")) {
        return { rows: gone ? [] : [{ pid: OWNER_PID }] };
      }
      return { rows: [] };
    }
  });
  return {
    probe,
    markGone: () => {
      gone = true;
    },
    failNextQuery: (error: Error) => {
      pendingFailure = error;
    }
  };
}

describe("withClusterDdlLock", () => {
  test("owner session connects to the caller's real database, not the maintenance-DB swap", async () => {
    const bootstrapUrl = "postgres://u:p@h:5432/jarv1s";
    const owner = createWorkingOwner();
    const { probe } = createProbe();
    const ownerConnectionStrings: string[] = [];
    const probeConnectionStrings: string[] = [];

    await withClusterDdlLock(bootstrapUrl, async () => "ok", {
      createOwnerClient: (connectionString) => {
        ownerConnectionStrings.push(connectionString);
        return owner;
      },
      createProbeClient: (connectionString) => {
        probeConnectionStrings.push(connectionString);
        return probe;
      }
    });

    // The owner session executes fn's DDL directly (single-owner-session design), so it must
    // stay on the caller's real target database, never the maintenance-DB swap — only the probe
    // (heartbeat-only, never DDL) uses the swap. Regression pin for the bug that broke #1633's
    // CI: the owner previously inherited the probe's maintenance-DB connection string, so all
    // wrapped DDL silently ran against the wrong database.
    expect(ownerConnectionStrings).toEqual([bootstrapUrl]);
    expect(probeConnectionStrings).toEqual([getClusterLockDatabaseUrl(bootstrapUrl)]);
  });

  test("acquisition failure prevents the callback from ever running", async () => {
    const owner = new FakeClient({
      connect: async () => {
        throw new Error("ECONNREFUSED");
      }
    });
    const fn = vi.fn(async () => "unreachable");

    await expect(
      withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
        createOwnerClient: () => owner,
        createProbeClient: () => createProbe().probe
      })
    ).rejects.toBeInstanceOf(ClusterDdlLockAcquisitionError);

    expect(fn).not.toHaveBeenCalled();
  });

  test("identity-query failure after connect is a typed acquisition error, callback never runs", async () => {
    const owner = new FakeClient({
      query: async (text) => {
        if (text.includes("pg_backend_pid")) {
          throw new Error("identity query failed");
        }
        return { rows: [{}] };
      }
    });
    const fn = vi.fn(async () => "unreachable");

    await expect(
      withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
        createOwnerClient: () => owner,
        createProbeClient: () => createProbe().probe
      })
    ).rejects.toBeInstanceOf(ClusterDdlLockAcquisitionError);

    expect(fn).not.toHaveBeenCalled();
    expect(owner.endCalls).toBe(1);
  });

  test("successful acquisition invokes the callback exactly once with the owner client", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();
    const fn = vi.fn(async (client: ClusterDdlLockClient) => {
      expect(client).toBe(owner);
      return "ok";
    });

    const result = await withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
      createOwnerClient: () => owner,
      createProbeClient: () => probe
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("owner connection error while the callback is in flight yields a liveness-lost error", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();

    const fn = () =>
      new Promise<string>((_resolve, reject) => {
        setTimeout(() => {
          owner.emitError(new Error("connection terminated unexpectedly"));
        }, 5);
        // fn never settles on its own — only the connection-error path should resolve this call.
        setTimeout(() => reject(new Error("test callback should not out-race liveness")), 500);
      });

    const promise = withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
      createOwnerClient: () => owner,
      createProbeClient: () => probe,
      livenessIntervalMs: 1000
    });

    await expect(promise).rejects.toBeInstanceOf(ClusterDdlLockLivenessLostError);
  });

  test("heartbeat probe losing the owner during an idle callback is detected within one interval", async () => {
    const owner = createWorkingOwner();
    const { probe, markGone } = createProbe();

    const fn = () => new Promise<string>(() => {}); // idle forever; only the probe can end this

    const promise = withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
      createOwnerClient: () => owner,
      createProbeClient: () => probe,
      livenessIntervalMs: 50
    });

    setTimeout(markGone, 5);

    const start = Date.now();
    await expect(promise).rejects.toBeInstanceOf(ClusterDdlLockLivenessLostError);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("heartbeat probe query failure (e.g. restart) is classified as liveness loss", async () => {
    const owner = createWorkingOwner();
    const { probe, failNextQuery } = createProbe();

    const fn = () => new Promise<string>(() => {});

    const promise = withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
      createOwnerClient: () => owner,
      createProbeClient: () => probe,
      livenessIntervalMs: 50
    });

    setTimeout(
      () => failNextQuery(new Error("terminating connection due to administrator command")),
      5
    );

    await expect(promise).rejects.toBeInstanceOf(ClusterDdlLockLivenessLostError);
  });

  test("synchronous callback throw propagates un-wrapped and cleanup still runs", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();
    const fn = () => {
      throw new Error("boom");
    };

    await expect(
      withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
        createOwnerClient: () => owner,
        createProbeClient: () => probe
      })
    ).rejects.toThrow("boom");

    expect(owner.queryCalls.some((c) => c.text.includes("pg_advisory_unlock"))).toBe(true);
    expect(owner.endCalls).toBe(1);
  });

  test("callback rejection concurrent with connection loss combines into an AggregateError", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();

    const fn = () =>
      new Promise<string>((_resolve, reject) => {
        owner.emitError(new Error("connection terminated unexpectedly"));
        reject(new Error("callback also failed"));
      });

    const outcome = await withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
      createOwnerClient: () => owner,
      createProbeClient: () => probe,
      livenessIntervalMs: 1000
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(AggregateError);
    const errors = (outcome as AggregateError).errors;
    expect(errors.some((e) => e instanceof ClusterDdlLockLivenessLostError)).toBe(true);
    expect(errors.some((e) => e instanceof Error && e.message === "callback also failed")).toBe(
      true
    );
  });

  test("cleanup failure after a successful callback is reported, not swallowed", async () => {
    const owner = createWorkingOwner({
      query: async (text) => {
        if (text.includes("pg_backend_pid")) {
          return { rows: [{ pid: OWNER_PID }] };
        }
        if (text.includes("pg_advisory_unlock")) {
          throw new Error("unlock failed");
        }
        return { rows: [{}] };
      }
    });
    const { probe } = createProbe();

    await expect(
      withClusterDdlLock("postgres://u:p@h:5432/jarv1s", async () => "ok", {
        createOwnerClient: () => owner,
        createProbeClient: () => probe
      })
    ).rejects.toBeInstanceOf(ClusterDdlLockCleanupError);
  });

  test("callback rejection plus cleanup failure combines into an AggregateError", async () => {
    const owner = createWorkingOwner({
      query: async (text) => {
        if (text.includes("pg_backend_pid")) {
          return { rows: [{ pid: OWNER_PID }] };
        }
        if (text.includes("pg_advisory_unlock")) {
          throw new Error("unlock failed");
        }
        return { rows: [{}] };
      }
    });
    const { probe } = createProbe();

    const outcome = await withClusterDdlLock(
      "postgres://u:p@h:5432/jarv1s",
      async () => {
        throw new Error("callback failed");
      },
      { createOwnerClient: () => owner, createProbeClient: () => probe }
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(AggregateError);
    const errors = (outcome as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e instanceof Error && e.message === "callback failed")).toBe(true);
    expect(errors.some((e) => e instanceof ClusterDdlLockCleanupError)).toBe(true);
  });

  test("normal success releases the advisory lock exactly once and ends the connection", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();

    await withClusterDdlLock("postgres://u:p@h:5432/jarv1s", async () => "ok", {
      createOwnerClient: () => owner,
      createProbeClient: () => probe
    });

    const unlockCalls = owner.queryCalls.filter((c) => c.text.includes("pg_advisory_unlock"));
    expect(unlockCalls).toHaveLength(1);
    expect(owner.endCalls).toBe(1);
  });

  test("liveness-lost cleanup does not attempt pg_advisory_unlock on the dead connection", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();

    const fn = () =>
      new Promise<string>(() => {
        owner.emitError(new Error("connection terminated unexpectedly"));
      });

    await withClusterDdlLock("postgres://u:p@h:5432/jarv1s", fn, {
      createOwnerClient: () => owner,
      createProbeClient: () => probe,
      livenessIntervalMs: 1000
    }).catch(() => {});

    expect(owner.queryCalls.some((c) => c.text.includes("pg_advisory_unlock"))).toBe(false);
    expect(owner.endCalls).toBe(1);
  });

  test("a nested/reentrant call from the same process is refused before any connect()", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();
    const connectSpy = vi.fn(async () => {});
    const nestedConnectSpy = vi.fn(async () => {});

    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const outer = withClusterDdlLock(
      "postgres://u:p@h:5432/jarv1s",
      async () => {
        await gate;
        return "outer-done";
      },
      {
        createOwnerClient: () => Object.assign(owner, { connect: connectSpy }),
        createProbeClient: () => probe
      }
    );

    const nestedOwner = createWorkingOwner();
    await expect(
      withClusterDdlLock("postgres://u:p@h:5432/jarv1s", async () => "nested", {
        createOwnerClient: () => Object.assign(nestedOwner, { connect: nestedConnectSpy }),
        createProbeClient: () => createProbe().probe
      })
    ).rejects.toBeInstanceOf(ClusterDdlLockReentrancyError);

    expect(nestedConnectSpy).not.toHaveBeenCalled();

    releaseFirst();
    await expect(outer).resolves.toBe("outer-done");
  });

  test("a diagnostic sink that throws never alters the outcome", async () => {
    const owner = createWorkingOwner();
    const { probe } = createProbe();

    const result = await withClusterDdlLock("postgres://u:p@h:5432/jarv1s", async () => "ok", {
      createOwnerClient: () => owner,
      createProbeClient: () => probe,
      onDiagnostic: () => {
        throw new Error("sink exploded");
      }
    });

    expect(result).toBe("ok");
  });

  test("livenessIntervalMs outside [50, 5000] is rejected before any connection is attempted", async () => {
    const connectSpy = vi.fn(async () => {});
    const owner = new FakeClient({ connect: connectSpy });

    await expect(
      withClusterDdlLock("postgres://u:p@h:5432/jarv1s", async () => "unreachable", {
        createOwnerClient: () => owner,
        createProbeClient: () => createProbe().probe,
        livenessIntervalMs: 10
      })
    ).rejects.toThrow(/livenessIntervalMs/);
    expect(connectSpy).not.toHaveBeenCalled();

    await expect(
      withClusterDdlLock("postgres://u:p@h:5432/jarv1s", async () => "unreachable", {
        createOwnerClient: () => owner,
        createProbeClient: () => createProbe().probe,
        livenessIntervalMs: 10_000
      })
    ).rejects.toThrow(/livenessIntervalMs/);
    expect(connectSpy).not.toHaveBeenCalled();
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
