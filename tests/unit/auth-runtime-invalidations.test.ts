import { describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({
  query: vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 1 }))
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Pool extends EventEmitter {
    options = {};
    query = query;
    connect = async () => ({ query: this.query, release: () => {} });
    end = async () => {};
  }
  return { default: { Pool }, Pool };
});

const { createMossAuthRuntime } = await import("../../packages/auth/src/index.js");

describe("runtime revocation notification wiring", () => {
  it("admin revocation shares the runtime source and runtime close ends subscribers", async () => {
    query.mockClear();
    const runtime = createMossAuthRuntime({
      appDb: {} as never,
      runner: {} as never,
      connectionString: "postgres://unused@localhost/unused"
    });
    const events = vi.fn();
    runtime.sessionInvalidations.subscribe(events);
    expect(await runtime.revokeUserSessions("synthetic-owner")).toBe(2);
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { actorUserId: "synthetic-owner" },
      { actorUserId: "synthetic-owner" }
    ]);
    expect(query).toHaveBeenCalledWith("DELETE FROM app.better_auth_sessions WHERE user_id = $1", [
      "synthetic-owner"
    ]);
    query.mockRejectedValueOnce(new Error("database failed"));
    events.mockClear();
    await expect(runtime.revokeUserSessions("synthetic-owner")).rejects.toThrow();
    expect(events).toHaveBeenCalledTimes(2);
    await runtime.close();
    expect(events).toHaveBeenLastCalledWith(null);
  });
});
