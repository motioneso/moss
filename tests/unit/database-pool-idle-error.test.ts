import type { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const { pools } = vi.hoisted(() => ({ pools: [] as EventEmitter[] }));

vi.mock("pg", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class Pool extends Emitter {
    constructor() {
      super();
      pools.push(this);
    }

    // Enough of the pg surface for better-auth to recognise a Postgres pool.
    connect = async () => ({ query: this.query, release: () => undefined });
    query = async () => ({ rows: [], rowCount: 0 });
    end = async () => undefined;
  }
  return { default: { Pool }, Pool };
});

const { createDatabase, AbortablePgPool } = await import("../../packages/db/src/index.js");
const { createMossAuthRuntime } = await import("../../packages/auth/src/index.js");

// A database restart terminates idle pooled connections, and pg emits that on the pool.
// An "error" event with no listener throws, which crashes the whole process.
const terminated = () => new Error("terminating connection due to administrator command");

describe("database pools survive a server-side disconnect", () => {
  it("the app database pool handles an idle client error", () => {
    pools.length = 0;
    createDatabase({ connectionString: "postgres://unused@localhost/unused" });

    expect(pools).toHaveLength(1);
    expect(() => pools[0]!.emit("error", terminated())).not.toThrow();
  });

  it("imports db/auth and closes unused maintenance without needing pg.Client", async () => {
    pools.length = 0;
    let maintenance!: InstanceType<typeof AbortablePgPool>;
    expect(() => {
      maintenance = new AbortablePgPool({ connectionString: "postgres://unused@localhost/unused" });
    }, "maintenance-construction-is-lazy").not.toThrow();
    const cancelled = AbortSignal.abort(new Error("cancelled before first use"));
    await expect(maintenance.withClient(cancelled, vi.fn())).rejects.toThrow(
      "cancelled before first use"
    );
    await maintenance.close();
    await maintenance.close();
    await expect(maintenance.withClient(new AbortController().signal, vi.fn())).rejects.toThrow(
      "Cannot use a closed maintenance pool"
    );
    expect(pools, "unused-maintenance-does-not-create-pool").toHaveLength(0);
  });

  it("the auth database pool handles an idle client error and logs it", async () => {
    pools.length = 0;
    const warn = vi.fn();
    const runtime = createMossAuthRuntime({
      appDb: {} as never,
      runner: {} as never,
      connectionString: "postgres://unused@localhost/unused",
      logger: { info: vi.fn(), warn }
    });

    expect(pools).toHaveLength(1);
    expect(() => pools[0]!.emit("error", terminated())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "auth.db_pool_idle_client_error" }),
      expect.any(String)
    );
    await runtime.close();
    expect(pools, "unused-auth-maintenance-stays-lazy").toHaveLength(1);
  });
});
