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

const { createDatabase } = await import("../../packages/db/src/database.js");
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

  it("the auth database pool handles an idle client error and logs it", () => {
    pools.length = 0;
    const warn = vi.fn();
    createMossAuthRuntime({
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
  });
});
