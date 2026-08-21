import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMossAuthRuntime, type MossAuthRuntime } from "@moss/auth";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { Kysely } from "kysely";
import { createApiServer } from "../../apps/api/src/server.js";
import { SportsFollowsRepository } from "../../packages/sports/src/repository.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

// Owner-only RLS for app.sports_follows (migration 0133). Mirrors the multi-user-isolation
// harness: a real API server for sign-up, then the repository exercised directly under each
// actor's DataContext GUC so RLS is the thing under test (not the route layer).
describe("sports follows repository RLS", () => {
  let appDb: Kysely<MossDatabase>;
  let authRuntime: MossAuthRuntime;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataCtx: DataContextRunner;
  const repo = new SportsFollowsRepository();

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "password12345" }
    });
    return res.json<{ user: { id: string } }>().user.id;
  }

  async function disableApproval() {
    await setInstanceSetting("registration.requires_approval", { value: false });
  }

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    // 2, not 1: the concurrent-create test below needs two overlapping transactions to hold a
    // connection each at once (precedent: tests/integration/commitments.test.ts).
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    authRuntime = createMossAuthRuntime({ appDb, runner: new DataContextRunner(appDb) });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, authRuntime, boss, logger: false });
    await server.ready();
    dataCtx = new DataContextRunner(appDb);
  });

  afterEach(async () => {
    await Promise.allSettled([
      server?.close(),
      authRuntime?.close(),
      appDb?.destroy(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("owner create then list round-trips (owner sees own follow)", async () => {
    const admin = await signUp("Admin", "sports-admin@example.com");
    void admin;
    await disableApproval();
    const alice = await signUp("Alice", "sports-alice@example.com");

    const created = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-1a" },
      (scopedDb) => repo.create(scopedDb, { competitionKey: "nfl", teamKey: "min" })
    );
    expect(created.competitionKey).toBe("nfl");
    expect(created.teamKey).toBe("min");

    const listed = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-1b" },
      (scopedDb) => repo.list(scopedDb)
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
  });

  it("a second actor's list does NOT see the first actor's follow (owner-only isolation)", async () => {
    const admin = await signUp("Admin", "sports2-admin@example.com");
    void admin;
    await disableApproval();
    const alice = await signUp("Alice", "sports2-alice@example.com");
    const bob = await signUp("Bob", "sports2-bob@example.com");

    await dataCtx.withDataContext({ actorUserId: alice, requestId: "sports-2a" }, (scopedDb) =>
      repo.create(scopedDb, { competitionKey: "nfl", teamKey: "min" })
    );

    const bobList = await dataCtx.withDataContext(
      { actorUserId: bob, requestId: "sports-2b" },
      (scopedDb) => repo.list(scopedDb)
    );
    expect(bobList).toEqual([]);
  });

  it("duplicate whole-competition follow (teamKey null twice) does not create a second row", async () => {
    const admin = await signUp("Admin", "sports3-admin@example.com");
    void admin;
    await disableApproval();
    const alice = await signUp("Alice", "sports3-alice@example.com");

    const first = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-3a" },
      (scopedDb) => repo.create(scopedDb, { competitionKey: "nfl", teamKey: null })
    );
    const second = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-3b" },
      (scopedDb) => repo.create(scopedDb, { competitionKey: "nfl", teamKey: null })
    );
    // The repository guards whole-competition (null-team) duplicates with an explicit
    // existence check, so the second create returns the existing row, not a new one.
    expect(second.id).toBe(first.id);

    const listed = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-3c" },
      (scopedDb) => repo.list(scopedDb)
    );
    expect(listed).toHaveLength(1);
  });

  it("resolves two concurrent whole-league creates by the same actor to one row with no 23505", async () => {
    const admin = await signUp("Admin", "sports4-admin@example.com");
    void admin;
    await disableApproval();
    const alice = await signUp("Alice", "sports4-alice@example.com");

    // Forced-overlap barrier (precedent: tests/integration/commitments.test.ts "resolves two
    // concurrent upserts... to one row with no 23505"): naive Promise.all does not reliably make
    // two withDataContext transactions overlap on fast local Postgres, so each side signals
    // "ready" only once its transaction is BEGUN and its actor context is set, and both are
    // released together so neither side's read can observe the other's write.
    let resolveAReady: () => void;
    const aReady = new Promise<void>((resolve) => {
      resolveAReady = resolve;
    });
    let resolveBReady: () => void;
    const bReady = new Promise<void>((resolve) => {
      resolveBReady = resolve;
    });
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sideA = dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-4a" },
      async (scopedDb) => {
        resolveAReady();
        await gate;
        return repo.create(scopedDb, { competitionKey: "nfl", teamKey: null });
      }
    );
    const sideB = dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-4b" },
      async (scopedDb) => {
        resolveBReady();
        await gate;
        return repo.create(scopedDb, { competitionKey: "nfl", teamKey: null });
      }
    );

    await Promise.all([aReady, bReady]);
    release!();

    const [first, second] = await Promise.all([sideA, sideB]);
    expect(first.id).toBe(second.id);

    const listed = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-4c" },
      (scopedDb) => repo.list(scopedDb)
    );
    expect(listed).toHaveLength(1);
  });

  it("lets two different owners each follow the same whole league independently", async () => {
    const admin = await signUp("Admin", "sports5-admin@example.com");
    void admin;
    await disableApproval();
    const alice = await signUp("Alice", "sports5-alice@example.com");
    const bob = await signUp("Bob", "sports5-bob@example.com");

    const aliceFollow = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-5a" },
      (scopedDb) => repo.create(scopedDb, { competitionKey: "nfl", teamKey: null })
    );
    const bobFollow = await dataCtx.withDataContext(
      { actorUserId: bob, requestId: "sports-5b" },
      (scopedDb) => repo.create(scopedDb, { competitionKey: "nfl", teamKey: null })
    );

    expect(aliceFollow.id).not.toBe(bobFollow.id);

    const aliceListed = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-5c" },
      (scopedDb) => repo.list(scopedDb)
    );
    expect(aliceListed).toHaveLength(1);
    expect(aliceListed[0]?.id).toBe(aliceFollow.id);

    const bobListed = await dataCtx.withDataContext(
      { actorUserId: bob, requestId: "sports-5d" },
      (scopedDb) => repo.list(scopedDb)
    );
    expect(bobListed).toHaveLength(1);
    expect(bobListed[0]?.id).toBe(bobFollow.id);
  });
});
