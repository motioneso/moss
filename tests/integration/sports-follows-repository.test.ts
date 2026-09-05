import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMossAuthRuntime, type MossAuthRuntime } from "@moss/auth";
import { createDatabase, DataContextRunner, runSqlMigrations, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { createApiServer } from "../../apps/api/src/server.js";
import { sportsModuleSqlMigrationDirectory } from "../../packages/sports/src/manifest.js";
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
      (scopedDb) =>
        repo.create(scopedDb, { competitionKey: "nfl", teamKey: "min", sourceTeamId: "16" })
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
      repo.create(scopedDb, { competitionKey: "nfl", teamKey: "min", sourceTeamId: "16" })
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
      (scopedDb) =>
        repo.create(scopedDb, { competitionKey: "nfl", teamKey: null, sourceTeamId: null })
    );
    const second = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-3b" },
      (scopedDb) =>
        repo.create(scopedDb, { competitionKey: "nfl", teamKey: null, sourceTeamId: null })
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
        return repo.create(scopedDb, { competitionKey: "nfl", teamKey: null, sourceTeamId: null });
      }
    );
    const sideB = dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-4b" },
      async (scopedDb) => {
        resolveBReady();
        await gate;
        return repo.create(scopedDb, { competitionKey: "nfl", teamKey: null, sourceTeamId: null });
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
      (scopedDb) =>
        repo.create(scopedDb, { competitionKey: "nfl", teamKey: null, sourceTeamId: null })
    );
    const bobFollow = await dataCtx.withDataContext(
      { actorUserId: bob, requestId: "sports-5b" },
      (scopedDb) =>
        repo.create(scopedDb, { competitionKey: "nfl", teamKey: null, sourceTeamId: null })
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

  // Review finding S1, round 5: two teams in one competition can answer to the same short name
  // (two schools both called "PAC"). Before this round the table allowed only one row per short
  // name, so the second follow silently collapsed onto the first. Identity is now the provider's
  // permanent team id, and both follows must survive.
  it("keeps two follows that share a short name but have different permanent team ids", async () => {
    const admin = await signUp("Admin", "sports6-admin@example.com");
    void admin;
    await disableApproval();
    const alice = await signUp("Alice", "sports6-alice@example.com");

    const lutes = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-6a" },
      (scopedDb) =>
        repo.create(scopedDb, {
          competitionKey: "ncaa-baseball",
          teamKey: "pac",
          sourceTeamId: "129700"
        })
    );
    const tigers = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-6b" },
      (scopedDb) =>
        repo.create(scopedDb, {
          competitionKey: "ncaa-baseball",
          teamKey: "pac",
          sourceTeamId: "413"
        })
    );
    expect(lutes.id).not.toBe(tigers.id);

    // Saving the same permanent id again returns the row that already exists.
    const again = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-6c" },
      (scopedDb) =>
        repo.create(scopedDb, {
          competitionKey: "ncaa-baseball",
          teamKey: "pac",
          sourceTeamId: "413"
        })
    );
    expect(again.id).toBe(tigers.id);

    const listed = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-6d" },
      (scopedDb) => repo.list(scopedDb)
    );
    expect(listed).toHaveLength(2);
  });

  // The recovery path for a follow saved before round 5: answering "which team did you mean?"
  // writes the permanent id onto that row. A whole-competition follow must never be turned into
  // a team follow this way.
  it("writes a permanent team id onto an older follow, and refuses to do it to a whole-league follow", async () => {
    const admin = await signUp("Admin", "sports7-admin@example.com");
    void admin;
    await disableApproval();
    const alice = await signUp("Alice", "sports7-alice@example.com");
    const bob = await signUp("Bob", "sports7-bob@example.com");

    const old = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-7a" },
      (scopedDb) =>
        repo.create(scopedDb, {
          competitionKey: "ncaa-baseball",
          teamKey: "pac",
          sourceTeamId: null
        })
    );
    const wholeLeague = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-7b" },
      (scopedDb) =>
        repo.create(scopedDb, { competitionKey: "nfl", teamKey: null, sourceTeamId: null })
    );

    const chosen = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-7c" },
      (scopedDb) => repo.setSourceTeamId(scopedDb, old.id, "129700", "pac")
    );
    expect(chosen?.sourceTeamId).toBe("129700");
    expect(chosen?.teamKey).toBe("pac");

    const refusedWholeLeague = await dataCtx.withDataContext(
      { actorUserId: alice, requestId: "sports-7d" },
      (scopedDb) => repo.setSourceTeamId(scopedDb, wholeLeague.id, "129700", "pac")
    );
    expect(refusedWholeLeague).toBeUndefined();

    // Another person cannot answer the question on Alice's behalf.
    const refusedOtherOwner = await dataCtx.withDataContext(
      { actorUserId: bob, requestId: "sports-7e" },
      (scopedDb) => repo.setSourceTeamId(scopedDb, old.id, "413", "pac")
    );
    expect(refusedOtherOwner).toBeUndefined();
  });
});

// Proves the upgrade path for an existing install that already has duplicate whole-league rows:
// 0185 (dedupe DELETE) and 0186 (partial unique index) must both still apply cleanly and leave
// exactly the older duplicate standing. Sports is a built-in module (runSqlMigrations against
// app.schema_migrations), not an external module (installModule/app.module_schema_migrations) —
// this harness targets the built-in ledger directly.
describe("sports whole-league dedupe migration upgrade path", () => {
  const ownerId = "60000000-0000-4000-8000-000000000001";
  const olderId = "70000000-0000-4000-8000-000000000001";
  const newerId = "70000000-0000-4000-8000-000000000002";

  it("collapses a pre-existing whole-league duplicate to the older row and restores the ledger/index", async () => {
    await resetEmptyFoundationDatabase();

    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(`DELETE FROM app.schema_migrations WHERE version IN ('0185', '0186')`);
      await bootstrap.query(`DROP INDEX IF EXISTS app.sports_follows_whole_league_unique_idx`);

      await bootstrap.query(
        `INSERT INTO app.users (id, email, name, is_instance_admin)
         VALUES ($1, 'sports-upgrade-owner@example.com', 'Upgrade Owner', false)`,
        [ownerId]
      );
      // Older row first, older created_at — the dedupe migration keeps the oldest by
      // created_at ASC, id ASC, so this one must survive.
      await bootstrap.query(
        `INSERT INTO app.sports_follows (id, owner_user_id, competition_key, team_key, created_at)
         VALUES ($1, $2, 'nfl', NULL, now() - interval '1 day')`,
        [olderId, ownerId]
      );
      await bootstrap.query(
        `INSERT INTO app.sports_follows (id, owner_user_id, competition_key, team_key, created_at)
         VALUES ($1, $2, 'nfl', NULL, now())`,
        [newerId, ownerId]
      );

      const result = await runSqlMigrations({
        connectionString: connectionStrings.migration,
        migrationsDirectory: sportsModuleSqlMigrationDirectory
      });
      const appliedVersions = result.applied.map((m) => m.version);
      expect(appliedVersions).toEqual(["0185", "0186"]);

      const rows = await bootstrap.query<{ id: string }>(
        `SELECT id FROM app.sports_follows WHERE owner_user_id = $1 AND competition_key = 'nfl' AND team_key IS NULL`,
        [ownerId]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.id).toBe(olderId);

      const ledger = await bootstrap.query<{ version: string }>(
        `SELECT version FROM app.schema_migrations WHERE version IN ('0185', '0186') ORDER BY version`
      );
      expect(ledger.rows.map((r) => r.version)).toEqual(["0185", "0186"]);

      const index = await bootstrap.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'sports_follows_whole_league_unique_idx'`
      );
      expect(index.rows).toHaveLength(1);
    } finally {
      await bootstrap.end();
    }
  });
});
