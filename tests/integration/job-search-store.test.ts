// tests/integration/job-search-store.test.ts
// Task 13 (#1297): real-DB store tests; sweep cursors use the worker-KV fixture below.
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { installModule } from "../../scripts/module-install.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { getMossDatabaseUrls } from "../../packages/db/src/urls.js";
import { JOB_SEARCH_TABLES } from "../../external-modules/job-search/src/db/tables.js";
import { createSqlStore } from "../../external-modules/job-search/src/worker/store-sql.js";
import { BODY_MAX_CHARS } from "../../external-modules/job-search/src/domain/records.js";
import type {
  FailureCause,
  Match,
  Posting,
  SearchCriteria
} from "../../external-modules/job-search/src/domain/records.js";
import { dropModuleRolesAtTeardown, resetEmptyFoundationDatabase } from "./test-database.js";

const urls = getMossDatabaseUrls();
const moduleId = "job-search";
const runtimeRole = moduleRuntimeRoleName(moduleId);
const ownedTables = JOB_SEARCH_TABLES.map((table) => `app.${table}`);

// Fixed rather than random, same rationale as job-search-tables-install.test.ts: readable in
// failures, safe to reuse across `it`s because afterEach deletes it (CASCADE clears every owned
// row) after every test.
const ownerA = "50000000-0000-4000-8000-000000000011";
// A second actor, used only where a case has to prove a read is behind the RLS boundary
// rather than merely filtered in SQL. Torn down alongside ownerA below.
const ownerB = "50000000-0000-4000-8000-000000000012";

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
});

afterEach(async () => {
  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  for (const table of ownedTables) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  // Same ordering as job-search-tables-install.test.ts's afterEach — see its comments for why
  // CASCADE and this exact revoke order are both required.
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${moduleInstallRoleName(moduleId)} CASCADE`
  );
  await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${moduleInstallRoleName(moduleId)}`);
  await client.query(`REVOKE REFERENCES (id) ON app.users FROM ${moduleInstallRoleName(moduleId)}`);
  await client.query(
    `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ` +
      `${moduleInstallRoleName(moduleId)} CASCADE`
  );
  // Cluster-global: locked, and fail-closed apart from the one documented 2BP01 case (#1013).
  await dropModuleRolesAtTeardown([moduleInstallRoleName(moduleId), runtimeRole]);
  await client.query("DELETE FROM app.module_installs WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = $1", [moduleId]);
  // Cases 7-8's fixtures. The bootstrap connection is a superuser role for test setup/teardown
  // only (not a runtime app/worker role) — it bypasses RLS on both tables the way DROP ROLE and
  // the REVOKEs above already do.
  await client.query("DELETE FROM app.module_kv WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.external_modules WHERE id = $1", [moduleId]);
  await client.query("DELETE FROM app.users WHERE id = ANY($1)", [[ownerA, ownerB]]);
  await client.end();
});

async function install(): Promise<void> {
  await installModule({
    moduleId,
    manifest: { database: { ownedTables } },
    bootstrapConnectionString: urls.bootstrap,
    migrationConnectionString: urls.migration,
    migrationsDirectory: "external-modules/job-search/sql"
  });
}

async function seedUser(id: string): Promise<void> {
  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, $2, false)",
      [id, `job-search-store-${id}@example.test`]
    );
  } finally {
    await client.end();
  }
}

// Cases 7-8 need `app.external_modules` to carry an enabled row for job-search — the
// module_kv_worker_* policies (0157) require `EXISTS (... module.status = 'enabled')` before any
// jarvis_worker_runtime read/write is allowed, and `installModule()` never touches this table (it
// only journals to app.module_installs, a different bookkeeping table entirely — confirmed by
// reading scripts/module-install.ts's journalUpsert). Real enablement is an admin-only write path
// (packages/settings/sql/0152); a test seeds it directly via the bootstrap superuser instead.
async function seedExternalModuleRow(): Promise<void> {
  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash)
       VALUES ($1, 'enabled', 'test-hash', 'test-hash')
       ON CONFLICT (id) DO UPDATE SET status = 'enabled'`,
      [moduleId]
    );
  } finally {
    await client.end();
  }
}

// The runtime role is NOLOGIN — connect as the parent role that has it granted WITH INHERIT
// FALSE (jarvis_worker_runtime, i.e. urls.worker), assume it for one transaction with SET LOCAL
// ROLE, and set the actor GUC the same way data-context.ts does in production. Every call opens
// its OWN connection/transaction — this is deliberate, not incidental: it mirrors one ctx.db.query
// call being one RPC round-trip in production (packages/module-sdk/src/worker.ts has no BEGIN),
// and it is what gives case 5's concurrent setResume calls two genuinely separate snapshots.
async function asRuntime<T>(actorUserId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urls.worker });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${runtimeRole}`);
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

// app.module_kv is a CORE platform table, not a job-search-owned one — the per-module runtime
// role above has no grant on it at all (only jarvis_worker_runtime does, per migration 0157), so
// this does NOT do `SET LOCAL ROLE`. urls.worker already connects AS jarvis_worker_runtime
// (packages/db/src/urls.ts), which is exactly the role the real worker-rpc-host.ts's RPC-parent
// DataContext uses, and 0157's worker policies additionally require `app.current_module_id()` to
// match — the second GUC the real host also sets before every RPC (see 0157's own docstring).
async function asWorkerKv<T>(actorUserId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urls.worker });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
    await client.query("SELECT set_config('app.current_module_id', $1, true)", [moduleId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

// createSqlStore's `db`/`kv` parameter types are structural (SqlDb/SqlKv in store-sql.ts are not
// exported — deliberately: nothing outside that file should hand-roll a third implementation).
// TypeScript still checks these object literals against them at the createSqlStore(...) call
// site below, so a shape mismatch here is still a compile error, not a silent runtime gap.
function dbFor(actorUserId: string) {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const result = await asRuntime(actorUserId, (client) =>
        client.query(text, params ? [...params] : undefined)
      );
      // Mirrors the real RPC boundary: ctx.db.query's rows cross a JSON-serialized channel to
      // the module's child process, so a timestamptz column arrives as an ISO string, never a
      // JS Date — node-postgres's raw Client does not do this by itself, and store-sql.ts's row
      // types (e.g. ProfileRow.created_at: string) assume it already has.
      return { rows: JSON.parse(JSON.stringify(result.rows)) as T[] };
    }
  };
}

function kvFor(actorUserId: string) {
  return {
    async get(
      scope: "instance" | "user",
      namespace: string,
      key: string
    ): Promise<Record<string, unknown> | null> {
      const result = await asWorkerKv(actorUserId, (client) =>
        client.query(
          `SELECT value FROM app.module_kv
             WHERE module_id = $1 AND namespace = $2 AND scope = $3
               AND owner_user_id IS NOT DISTINCT FROM $4 AND key = $5`,
          [moduleId, namespace, scope, scope === "user" ? actorUserId : null, key]
        )
      );
      const row = result.rows[0] as { value: Record<string, unknown> } | undefined;
      return row ? row.value : null;
    },
    async set(
      scope: "instance" | "user",
      namespace: string,
      key: string,
      value: Record<string, unknown>
    ): Promise<void> {
      await asWorkerKv(actorUserId, (client) =>
        client.query(
          // Matches module_kv_user_uq's exact column list/predicate (0154) — an ON CONFLICT
          // arbiter must match a real index verbatim, and this test only ever writes scope
          // 'user' (the only scope job-search declares for job-search.meta).
          `INSERT INTO app.module_kv (module_id, namespace, scope, owner_user_id, key, value)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (module_id, namespace, owner_user_id, key) WHERE scope = 'user' DO UPDATE
             SET value = excluded.value, updated_at = now()`,
          [
            moduleId,
            namespace,
            scope,
            scope === "user" ? actorUserId : null,
            key,
            JSON.stringify(value)
          ]
        )
      );
    }
  };
}

function storeFor(actorUserId: string) {
  return createSqlStore(dbFor(actorUserId), kvFor(actorUserId));
}

function posting(overrides: { sourceId: string; externalId: string } & Partial<Posting>): Posting {
  return {
    id: randomUUID(),
    title: "Staff Engineer",
    company: "Acme",
    location: "Remote",
    url: "https://www.linkedin.com/jobs/1",
    body: "Job body text",
    postedAt: null,
    ...overrides
  };
}

describe("job-search store (#1297)", () => {
  it("orders listProfiles by created_at then id, even when created_at ties (case 1)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);

    // A fast install (or a fast test) can create several profiles inside the same millisecond —
    // created_at is NOT unique, so `id ASC` is the tiebreak Task 15's sweep cursor relies on.
    // Forcing a real tie needs a raw insert; store.createProfile() always uses now().
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const tiedAt = "2026-01-01T00:00:00.000Z";
    for (const id of ids) {
      await asRuntime(ownerA, (client) =>
        client.query(
          `INSERT INTO app.job_search_profiles (id, owner_user_id, name, state, created_at)
           VALUES ($1, $2, 'Same-millisecond profile', 'active', $3)`,
          [id, ownerA, tiedAt]
        )
      );
    }

    const profiles = await store.listProfiles();
    expect(profiles.map((profile) => profile.id)).toEqual([...ids].sort());
  });

  it("upserts a posting twice on the same natural key: one row, updated fields, unchanged first_seen_at (case 2)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    const [created] = await store.upsertPostings(profile.id, [
      posting({
        sourceId: "linkedin",
        externalId: "ext-1",
        title: "Old Title",
        body: "Full description fetched from the detail page."
      })
    ]);
    expect(created).toBeDefined();

    const before = await asRuntime(ownerA, (client) =>
      client.query("SELECT first_seen_at FROM app.job_search_postings WHERE id = $1", [created!.id])
    );

    const [updated] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-1", title: "New Title", body: "" })
    ]);

    const after = await asRuntime(ownerA, (client) =>
      client.query("SELECT first_seen_at FROM app.job_search_postings WHERE id = $1", [created!.id])
    );
    const rows = await asRuntime(ownerA, (client) =>
      client.query("SELECT id FROM app.job_search_postings WHERE profile_id = $1", [profile.id])
    );

    expect(rows.rows).toHaveLength(1);
    expect(updated!.id).toBe(created!.id);
    expect(updated!.title).toBe("New Title");
    expect(updated!.body).toBe("Full description fetched from the detail page.");
    expect(after.rows[0]!.first_seen_at).toEqual(before.rows[0]!.first_seen_at);
  });

  it("caps posting bodies at the shared storage boundary", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    const [created] = await store.upsertPostings(profile.id, [
      posting({
        sourceId: "linkedin",
        externalId: "body-cap",
        body: "x".repeat(BODY_MAX_CHARS + 200)
      })
    ]);

    expect(created!.body).toHaveLength(BODY_MAX_CHARS);
    const stored = await store.getPostings([created!.id]);
    expect(stored.get(created!.id)!.body).toHaveLength(BODY_MAX_CHARS);
  });

  it("round-trips a 768-dimension embedding through setEmbedding/listUnscoredPostingsWithEmbeddings (case 3)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");
    const [created] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-1" })
    ]);

    const vector = Array.from({ length: 768 }, (_, index) => index / 1000);
    await store.setEmbedding(created!.id, vector);

    const unscored = await store.listUnscoredPostingsWithEmbeddings(profile.id, 10);
    expect(unscored).toHaveLength(1);
    expect(unscored[0]!.embedding).toHaveLength(768);
    expect(unscored[0]!.embedding[0]).toBeCloseTo(vector[0]!);
    expect(unscored[0]!.embedding[767]).toBeCloseTo(vector[767]!);

    const dims = await asRuntime(ownerA, (client) =>
      client.query(
        "SELECT vector_dims(embedding) AS dims FROM app.job_search_postings WHERE id = $1",
        [created!.id]
      )
    );
    expect(dims.rows[0]!.dims).toBe(768);
  });

  it("re-offers an invalidated match for scoring while excluding a scored match (case 4)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    const [invalidated] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-scored" })
    ]);
    const [scored] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-still-scored" })
    ]);
    const [withoutMatch] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-unscored" })
    ]);
    const vector = Array.from({ length: 768 }, () => 0.001);
    await store.setEmbedding(invalidated!.id, vector);
    await store.setEmbedding(scored!.id, vector);
    await store.setEmbedding(withoutMatch!.id, vector);

    await asRuntime(ownerA, (client) =>
      client.query(
        `INSERT INTO app.job_search_matches (owner_user_id, profile_id, posting_id, state)
         VALUES ($1, $2, $3, 'unscored')`,
        [ownerA, profile.id, invalidated!.id]
      )
    );
    await store.upsertMatch(profile.id, {
      profileId: profile.id,
      postingId: scored!.id,
      fit: 80,
      want: 70,
      fitReason: "Current fit reason",
      wantReason: "Current want reason",
      outsideFrame: false,
      state: "new",
      scoredAt: null
    });

    const unscored = await store.listUnscoredPostingsWithEmbeddings(profile.id, 10);
    expect(new Set(unscored.map((row) => row.id))).toEqual(
      new Set([invalidated!.id, withoutMatch!.id])
    );
  });

  it("invalidates both axes when criteria change so stale prose and scores cannot remain", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");
    const [created] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "criteria-stale" })
    ]);
    const vector = Array.from({ length: 768 }, () => 0.001);
    await store.setEmbedding(created!.id, vector);
    await store.upsertMatch(profile.id, {
      profileId: profile.id,
      postingId: created!.id,
      fit: 91,
      want: 88,
      fitReason: "Old fit reason",
      wantReason: "Old want reason",
      outsideFrame: false,
      state: "new",
      scoredAt: null
    });

    await store.updateCriteria(profile.id, {
      titles: ["ServiceNow Architect"],
      seniority: [],
      locations: ["San Diego"],
      remote: "no-preference",
      compFloorCents: null,
      excludeCompanies: [],
      mustHave: ["ServiceNow"],
      niceToHave: [],
      dealbreakers: ["No ServiceNow involvement"],
      wantNarrative: "Hands-on platform architecture"
    });

    const [match] = await store.listMatches(profile.id, 10, 0);
    expect(match).toMatchObject({ fit: null, want: null, state: "unscored" });
    expect(await store.listUnscoredPostingsWithEmbeddings(profile.id, 10)).toHaveLength(1);
  });

  it("applies match writes only while their criteria snapshot is current", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");
    const oldCriteria: SearchCriteria = {
      titles: ["Staff Engineer"],
      seniority: ["staff"],
      locations: ["Remote"],
      remote: "preferred",
      compFloorCents: null,
      excludeCompanies: [],
      mustHave: ["TypeScript"],
      niceToHave: [],
      dealbreakers: [],
      wantNarrative: "Small team with ownership"
    };
    const currentCriteria: SearchCriteria = {
      ...oldCriteria,
      titles: ["Platform Architect"],
      mustHave: ["Postgres"],
      wantNarrative: "Platform strategy and mentoring"
    };
    await store.updateCriteria(profile.id, oldCriteria);
    const [existingPosting, newPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "snapshot-existing" }),
      posting({ sourceId: "linkedin", externalId: "snapshot-new" })
    ]);
    const scoredMatch = (
      postingId: string,
      fit: number,
      want: number,
      reason: string
    ): Omit<Match, "id"> => ({
      profileId: profile.id,
      postingId,
      fit,
      want,
      fitReason: reason,
      wantReason: reason,
      outsideFrame: false,
      state: "new",
      scoredAt: null
    });
    await store.upsertMatch(profile.id, scoredMatch(existingPosting!.id, 40, 30, "Old score"));

    await store.updateCriteria(profile.id, currentCriteria);
    const staleUpdate = await store.upsertMatch(
      profile.id,
      scoredMatch(existingPosting!.id, 99, 98, "Stale update"),
      { criteriaSnapshot: oldCriteria }
    );
    const staleInsert = await store.upsertMatch(
      profile.id,
      scoredMatch(newPosting!.id, 97, 96, "Stale insert"),
      {
        criteriaSnapshot: oldCriteria
      }
    );
    expect([staleUpdate, staleInsert]).toEqual([false, false]);

    const staleRows = await store.listMatches(profile.id, 10, 0);
    expect(staleRows.find((row) => row.postingId === existingPosting!.id)).toMatchObject({
      fit: null,
      want: null,
      state: "unscored"
    });
    expect(staleRows.find((row) => row.postingId === newPosting!.id)).toMatchObject({
      fit: null,
      want: null,
      state: "unscored"
    });

    const currentUpdate = await store.upsertMatch(
      profile.id,
      scoredMatch(existingPosting!.id, 81, 61, "Current update"),
      { criteriaSnapshot: currentCriteria }
    );
    const currentInsert = await store.upsertMatch(
      profile.id,
      scoredMatch(newPosting!.id, 72, 52, "Current insert"),
      {
        criteriaSnapshot: currentCriteria
      }
    );
    expect([currentUpdate, currentInsert]).toEqual([true, true]);

    const currentRows = await store.listMatches(profile.id, 10, 0);
    expect(currentRows.find((row) => row.postingId === existingPosting!.id)).toMatchObject({
      fit: 81,
      want: 61,
      state: "new"
    });
    expect(currentRows.find((row) => row.postingId === newPosting!.id)).toMatchObject({
      fit: 72,
      want: 52,
      state: "new"
    });

    const currentMatch = currentRows.find((row) => row.postingId === existingPosting!.id)!;
    await store.setMatchState(currentMatch.id, "dismissed");
    const lateScore = scoredMatch(existingPosting!.id, 100, 100, "Late score");
    expect(
      await store.upsertMatch(profile.id, lateScore, { criteriaSnapshot: currentCriteria })
    ).toBe(false);
    const entry = (criteria: SearchCriteria) => [{ profileId: profile.id, criteria }];
    expect(await store.claimCriteriaRescore("lease-a")).toEqual(entry(currentCriteria));
    expect(await store.claimCriteriaRescore("lease-b")).toBeNull();
    await store.updateCriteria(profile.id, oldCriteria);
    await store.finishCriteriaRescore("lease-a", entry(currentCriteria));
    expect(await store.claimCriteriaRescore("lease-b")).toEqual(entry(oldCriteria));
    await store.finishCriteriaRescore("lease-b", entry(oldCriteria));
    expect(await store.claimCriteriaRescore("lease-c")).toEqual([]);
    await store.finishCriteriaRescore("lease-c", []);
  });

  it("allocates versions 1 and 2 for two concurrent setResume calls, and fails fast for a nonexistent profile (case 5)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    // Not awaited individually — Promise.all races two real, separate connections against the
    // same profile. Whichever order the DB actually resolves the lock/retry in, the two versions
    // allocated must be exactly {1, 2}, never a duplicate and never a thrown unique-violation.
    const [first, second] = await Promise.all([
      store.setResume(profile.id, "content-1"),
      store.setResume(profile.id, "content-2")
    ]);
    expect(new Set([first.version, second.version])).toEqual(new Set([1, 2]));

    // Zero rows from the allocation statement has two causes that must not be conflated (see
    // store-sql.ts's setResume comment) — a nonexistent profile must fail on the FIRST attempt's
    // ownership probe, with a message that says so, not "could not allocate ... after 5 attempts".
    await expect(store.setResume(randomUUID(), "orphan")).rejects.toThrow("no such profile");
  });

  it("preserves last_ok_at across a failure write via COALESCE (case 6)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    const lastOkAt = "2026-07-01T00:00:00.000Z";
    await store.setPortalState(profile.id, {
      sourceId: "linkedin",
      enabled: true,
      lastOkAt,
      cause: null
    });

    const failureCause: FailureCause = {
      kind: "network",
      sourceId: "linkedin",
      summary: "LinkedIn could not be reached.",
      retrieved: 0,
      expected: null,
      lastOkAt,
      nextAction: "Retrying on the next scheduled crawl.",
      retryAt: null,
      disabled: false
    };
    await store.setPortalState(profile.id, {
      sourceId: "linkedin",
      enabled: true,
      lastOkAt: null,
      cause: failureCause
    });

    const portals = await store.listPortals(profile.id);
    expect(portals).toHaveLength(1);
    // The failure write passed lastOkAt: null — COALESCE in the SQL must keep the previous
    // success timestamp rather than let a failure erase it.
    expect(portals[0]!.lastOkAt).toBe(lastOkAt);
    expect(portals[0]!.cause).toEqual(failureCause);
  });

  it("defaults the sweep cursor to 0 and survives setSweepCursor across a profile delete (case 7)", async () => {
    await install();
    await seedUser(ownerA);
    await seedExternalModuleRow();
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    expect(await store.getSweepCursor()).toBe(0);

    await store.setSweepCursor(3);

    // The raw payload is an object, {index: 3}, never a bare number — ctx.kv is typed
    // Record<string, unknown> in both directions, so a bare 3 would not even be storable
    // against the real SDK even though it would pass a same-store round-trip test.
    const raw = await asWorkerKv(ownerA, (client) =>
      client.query(
        "SELECT value FROM app.module_kv WHERE module_id = $1 AND namespace = $2 AND key = $3",
        [moduleId, "job-search.meta", "sweep-cursor"]
      )
    );
    expect(raw.rows[0]!.value).toEqual({ index: 3 });

    // The cursor belongs to the sweep, not to whichever profile it happened to be pointing at —
    // deleting that profile must not reset or delete it.
    await asRuntime(ownerA, (client) =>
      client.query("DELETE FROM app.job_search_profiles WHERE id = $1", [profile.id])
    );
    expect(await store.getSweepCursor()).toBe(3);
  });

  it("degrades a corrupt cursor to 0, never NaN (case 8)", async () => {
    await install();
    await seedUser(ownerA);
    await seedExternalModuleRow();
    const store = storeFor(ownerA);

    // Written directly, bypassing setSweepCursor, to simulate a hand-edited or half-written
    // record a real deploy could still carry.
    await asWorkerKv(ownerA, (client) =>
      client.query(
        `INSERT INTO app.module_kv (module_id, namespace, scope, owner_user_id, key, value)
         VALUES ($1, $2, 'user', $3, $4, $5::jsonb)`,
        [moduleId, "job-search.meta", ownerA, "sweep-cursor", JSON.stringify({ index: "seven" })]
      )
    );

    expect(await store.getSweepCursor()).toBe(0);
  });

  it("listMatches synthesizes state: unscored for a posting the scorer hasn't reached, without dropping a scored one (case 9, #1329)", async () => {
    // Real pipeline, not a fixture-built Match: both postings go through upsertPostings, and
    // the only match row comes from upsertMatch — exactly the path the crawl/score passes take
    // in production. #1329's bug was that a posting past the AI-call budget (or otherwise never
    // scored) had no row here at all; this proves listMatches now returns it anyway.
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    const [scoredPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-scored" })
    ]);
    const [unscoredPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-unscored" })
    ]);
    await store.upsertMatch(profile.id, {
      profileId: profile.id,
      postingId: scoredPosting!.id,
      fit: 80,
      want: 60,
      fitReason: "Good fit.",
      wantReason: "Wants it.",
      outsideFrame: false,
      state: "new",
      scoredAt: null
    });

    const matches = await store.listMatches(profile.id, 10, 0);
    expect(matches).toHaveLength(2);

    const scored = matches.find((match) => match.postingId === scoredPosting!.id);
    const unscored = matches.find((match) => match.postingId === unscoredPosting!.id);

    expect(scored).toBeDefined();
    expect(scored!.fit).toBe(80);
    expect(scored!.want).toBe(60);
    expect(scored!.state).toBe("new");

    // Both axes null, never coerced to 0 — and the synthetic id is the posting's own id, not a
    // real job_search_matches id.
    expect(unscored).toBeDefined();
    expect(unscored!.id).toBe(unscoredPosting!.id);
    expect(unscored!.fit).toBeNull();
    expect(unscored!.want).toBeNull();
    expect(unscored!.state).toBe("unscored");

    // The trap this fix deliberately avoids: a placeholder row written for the unscored posting
    // would permanently exclude it from listUnscoredPostingsWithEmbeddings's own NOT EXISTS
    // candidate pool. Only the one real, scored row may ever exist.
    const rawMatchRows = await asRuntime(ownerA, (client) =>
      client.query("SELECT id FROM app.job_search_matches WHERE profile_id = $1", [profile.id])
    );
    expect(rawMatchRows.rows).toHaveLength(1);
  });

  it("prioritizes a scored match over an unscored posting when limit truncates the list (case 10, #1329)", async () => {
    // The N5 render-cap clamp must not silently drop a real, scored match in favor of an
    // unscored one just because the unscored posting happens to be newer — ORDER BY
    // scored_at DESC NULLS LAST is what listMatches relies on for that.
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    const [scoredPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-scored" })
    ]);
    const [unscoredPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-unscored" })
    ]);
    expect(unscoredPosting).toBeDefined();
    await store.upsertMatch(profile.id, {
      profileId: profile.id,
      postingId: scoredPosting!.id,
      fit: 50,
      want: 50,
      fitReason: "ok",
      wantReason: "ok",
      outsideFrame: false,
      state: "new",
      scoredAt: null
    });

    const matches = await store.listMatches(profile.id, 1, 0);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.postingId).toBe(scoredPosting!.id);
    expect(matches[0]!.state).toBe("new");
  });

  it("pages every row exactly once with offset, never repeating or skipping one", async () => {
    // The board's page size is not the board's size: a browser read can only carry ~25 rows past
    // the assistant render cap, so a profile with more matches than that is read a page at a time.
    // What has to hold is that walking the offsets visits every row once — the risk is a
    // non-unique ORDER BY key letting a row appear on two pages while another appears on none,
    // which is why the query's last sort key is the unique `p.id`.
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    // Scored in one statement each, so several rows share a `scored_at` to the microsecond and the
    // tiebreaker is the only thing keeping the order stable across pages.
    const created = await store.upsertPostings(
      profile.id,
      Array.from({ length: 7 }, (_unused, index) =>
        posting({ sourceId: "linkedin", externalId: `ext-page-${index}` })
      )
    );
    expect(created).toHaveLength(7);
    for (const item of created) {
      await store.upsertMatch(profile.id, {
        profileId: profile.id,
        postingId: item.id,
        fit: 50,
        want: 50,
        fitReason: "ok",
        wantReason: "ok",
        outsideFrame: false,
        state: "new",
        scoredAt: null
      });
    }

    const seen: string[] = [];
    for (let offset = 0; offset < 12; offset += 3) {
      const page = await store.listMatches(profile.id, 3, offset);
      seen.push(...page.map((match) => match.postingId));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(created.map((item) => item.id)));

    // And an offset past the end is empty rather than an error or a wrapped first page.
    await expect(store.listMatches(profile.id, 3, 99)).resolves.toEqual([]);
  });

  it("countMatches agrees with what listMatches would page, at one query and one round trip", async () => {
    // The board's search poll asks "is anything still arriving?" ten times a minute, and every
    // module read tool in the app shares one host budget of sixty requests a minute. Answering it
    // by walking the pages cost one request per 25 rows — ~80 a minute on a 167-row board, which
    // earned 429s mid-crawl. This is the same question at a fixed cost, so the only thing that can
    // go wrong is the two disagreeing: a count that drifted from the rows would make the poll
    // either miss a finished search or never call one finished. Only real SQL proves the FILTER
    // clauses, which is why this is here and not in a fake.
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    // Five postings: two scored and left alone, one scored then dismissed, one scored with a null
    // Fit (the board-with-no-résumé case), and one the scorer never reached at all — which has no
    // match row, so a count over the matches table alone would miss it entirely.
    const created = await store.upsertPostings(
      profile.id,
      Array.from({ length: 5 }, (_unused, index) =>
        posting({ sourceId: "linkedin", externalId: `ext-count-${index}` })
      )
    );
    expect(created).toHaveLength(5);
    const score = async (postingId: string, overrides: { fit?: number | null } = {}) => {
      await store.upsertMatch(profile.id, {
        profileId: profile.id,
        postingId,
        fit: overrides.fit === undefined ? 50 : overrides.fit,
        want: 50,
        fitReason: "ok",
        wantReason: "ok",
        outsideFrame: false,
        state: "new",
        scoredAt: null
      });
    };
    await score(created[0]!.id);
    await score(created[1]!.id);
    await score(created[2]!.id);
    // A match scored before any résumé existed: a real Want, an empty Fit. It still counts as
    // scored, because `isScored` in web/board-types.ts is keyed on Want alone.
    await score(created[3]!.id, { fit: null });
    // Dismiss by posting rather than by page position: every row here has a null `scored_at`, so
    // the ordering between them is not something this test should depend on — and the row that
    // happened to sort first might be the synthetic unscored one, which has no match id to set.
    const rows = await store.listMatches(profile.id, 10, 0);
    const toDismiss = rows.find((match) => match.postingId === created[2]!.id);
    expect(toDismiss).toBeDefined();
    await store.setMatchState(toDismiss!.id, "dismissed");

    const counts = await store.countMatches(profile.id);

    // Four active (five postings less the dismissed one) and three of those scored — the fifth
    // posting has no match row at all, so it is active and unscored.
    expect(counts).toEqual({ active: 4, scored: 3 });
    // Integers, not the bigint strings `count(*)` arrives as: the browser compares this against the
    // previous tick's value, and "167" !== 167 would make every tick look like a change.
    expect(Number.isInteger(counts.active)).toBe(true);
    expect(Number.isInteger(counts.scored)).toBe(true);

    // The agreement that matters: `active` is exactly the rows the board would render.
    const paged = await store.listMatches(profile.id, 10, 0);
    expect(paged.filter((match) => match.state !== "dismissed")).toHaveLength(counts.active);

    // Another actor's count of the same profile id is zero, not four: this read is behind the same
    // RLS boundary as every other, and a count is exactly the kind of aggregate that leaks a
    // board's size across owners if it is written against the table instead of the policy.
    await seedUser(ownerB);
    await expect(storeFor(ownerB).countMatches(profile.id)).resolves.toEqual({
      active: 0,
      scored: 0
    });
  });

  it("getMatch returns the untruncated row by real id, and null for a synthetic or unknown id (case 11, #1330)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");
    const [scoredPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-scored" })
    ]);
    await store.upsertMatch(profile.id, {
      profileId: profile.id,
      postingId: scoredPosting!.id,
      fit: 90,
      want: 40,
      fitReason: "Excellent fit for this role and level.",
      wantReason: "Strong alignment with stated preferences.",
      outsideFrame: true,
      state: "new",
      scoredAt: null
    });

    const [realMatch] = await store.listMatches(profile.id, 10, 0);
    expect(await store.getMatch(realMatch!.id)).toEqual(realMatch);

    // A synthetic id (the bare posting id an unscored row is keyed by) has no job_search_matches
    // row to find — correctly resolves to null, same as any other id with no match behind it.
    const [otherPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-unscored" })
    ]);
    expect(await store.getMatch(otherPosting!.id)).toBeNull();
    expect(await store.getMatch(randomUUID())).toBeNull();
  });

  it("updates only Fit during an unfitted repair", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");
    const [scoredPosting] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-preserve-want" })
    ]);

    await store.upsertMatch(profile.id, {
      profileId: profile.id,
      postingId: scoredPosting!.id,
      fit: null,
      want: 58,
      fitReason: "Legacy Fit reason.",
      wantReason: "Original Want synopsis.",
      outsideFrame: false,
      state: "new",
      scoredAt: null
    });
    await store.upsertMatch(
      profile.id,
      {
        profileId: profile.id,
        postingId: scoredPosting!.id,
        fit: 39,
        want: 20,
        fitReason: "Different profession.",
        wantReason: "Regenerated Want synopsis.",
        outsideFrame: false,
        state: "new",
        scoredAt: null
      },
      { preserveWant: true }
    );

    const [repaired] = await store.listMatches(profile.id, 10, 0);
    expect(repaired).toMatchObject({
      fit: 39,
      want: 58,
      fitReason: "Different profession.",
      wantReason: "Original Want synopsis."
    });
  });

  // A Fit is a judgment of a posting AGAINST a résumé, so replacing the résumé invalidates every
  // score already on the board. This query is the only thing that notices: while it tested
  // `fit IS NULL` alone it returned nothing once a board was fully scored, so a replaced résumé
  // rescored NOTHING and every row silently kept the Fit it earned against the previous résumé.
  // Measured live before the fix — 158 fully-scored rows, résumé replaced end to end, and the
  // save handler reported `scored: 0, aiCallsUsed: 0`.
  it("re-offers a scored posting once the résumé it was scored against is replaced (case 12)", async () => {
    await install();
    await seedUser(ownerA);
    const store = storeFor(ownerA);
    const profile = await store.createProfile("Staff Engineer search");

    const [scored] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-scored" })
    ]);
    const [acted] = await store.upsertPostings(profile.id, [
      posting({ sourceId: "linkedin", externalId: "ext-dismissed" })
    ]);
    const vector = Array.from({ length: 768 }, () => 0.001);
    await store.setEmbedding(scored!.id, vector);
    await store.setEmbedding(acted!.id, vector);

    await store.setResume(profile.id, "first résumé");

    // Both rows carry a real Fit scored AFTER that résumé landed, which is the state a healthy
    // board sits in: nothing to repair.
    await asRuntime(ownerA, (client) =>
      client.query(
        `INSERT INTO app.job_search_matches
           (owner_user_id, profile_id, posting_id, fit, state, scored_at)
         VALUES ($1, $2, $3, 70, 'new', now()), ($1, $2, $4, 65, 'dismissed', now())`,
        [ownerA, profile.id, scored!.id, acted!.id]
      )
    );
    expect(await store.listUnfittedPostingsWithEmbeddings(profile.id, 10)).toEqual([]);

    // Replacing the résumé makes every score on the board stale by definition.
    await store.setResume(profile.id, "second résumé, materially different");

    const stale = await store.listUnfittedPostingsWithEmbeddings(profile.id, 10);
    // Only the untouched row comes back. The dismissed one stays out no matter how stale its Fit
    // is — `upsertMatch` returns a row to 'new', which would drag a role the user already
    // dismissed back onto the board.
    expect(stale.map((row) => row.id)).toEqual([scored!.id]);
  });
});
