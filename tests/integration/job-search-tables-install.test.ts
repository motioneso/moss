// tests/integration/job-search-tables-install.test.ts
// Task 4 (#1288): proves the REAL external-modules/job-search/sql directory installs cleanly
// through the installModule pipeline — DDL, platform-generated FORCE RLS, and the owner-bound
// composite foreign keys that stand in for an RLS boundary on every child table. Mirrors
// tests/integration/finance-tables-install.test.ts's afterEach teardown discipline (REVOKE-before-
// DROP-CASCADE ordering; see its comment for why CASCADE is required), but — unlike finance's
// single schema-shape case — each `it` below reinstalls the module fresh and asserts through it,
// because most of these cases need real rows under real RLS, not just a shape check.
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
import { dropModuleRolesAtTeardown, resetEmptyFoundationDatabase } from "./test-database.js";

const urls = getMossDatabaseUrls();
const moduleId = "job-search";
const runtimeRole = moduleRuntimeRoleName(moduleId);
const ownedTables = JOB_SEARCH_TABLES.map((table) => `app.${table}`);

// Fixed rather than random: readable in failures, and safe to reuse across `it`s because
// afterEach deletes both rows (and CASCADE takes every owned-table row with them) after every
// test — no test observes another test's data.
const ownerA = "50000000-0000-4000-8000-000000000001";
const ownerB = "50000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
});

afterEach(async () => {
  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  for (const table of ownedTables) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  // Same ordering as finance-tables-install.test.ts: ensureModuleRoles grants schema/table ACLs
  // to the install role WITH GRANT OPTION, and Phase B re-grants onward to the runtime role from
  // that grant option — revoking the install role's own grant needs CASCADE to also strip the
  // runtime role's dependent grant, or Postgres refuses both the revoke and the later DROP ROLE.
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${moduleInstallRoleName(moduleId)} CASCADE`
  );
  await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${moduleInstallRoleName(moduleId)}`);
  // Column-level ACLs live in pg_attribute.attacl, a separate store from the table-level
  // pg_class.relacl the REVOKE above clears — table-level REVOKE ALL does not reach a
  // column-scoped grant. ensureModuleRoles (module-role-broker.ts) grants exactly this one
  // (REFERENCES (id), so the module's own owner FK can compile) with WITH GRANT OPTION omitted,
  // so it must be revoked explicitly or DROP ROLE below fails with "some objects depend on it" —
  // discovered here because this file installs/tears down 7 times in one run; finance's single-
  // install test never surfaces it.
  await client.query(`REVOKE REFERENCES (id) ON app.users FROM ${moduleInstallRoleName(moduleId)}`);
  await client.query(
    `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ` +
      `${moduleInstallRoleName(moduleId)} CASCADE`
  );
  // DROP ROLE is cluster-wide, and this shared dev Postgres instance carries ~40 other agents'
  // gate/UAT databases. If the role was ever installed against one of those (outside this file's
  // control), it still holds grants there and DROP ROLE fails with "some objects depend on it"
  // even though this database's own grants were just fully revoked above. Losing the role drop
  // only leaks a harmless NOLOGIN role in the cluster — ensureModuleRoles (module-role-broker.ts)
  // treats an already-existing role as fully idempotent on the next install(), so it can't break
  // this suite. What MUST survive a role-drop failure is the ledger cleanup below: without it, the
  // next `it`'s install() sees migrations already recorded, skips reapplying them, and then fails
  // emitting RLS SQL against tables this afterEach already dropped.
  //
  // That tolerance now lives in dropModuleRolesAtTeardown, narrowed to SQLSTATE 2BP01 — the
  // blanket `.catch(() => {})` this replaces also swallowed permission and syntax failures. The
  // drops additionally run under the cluster-DDL lock, since pg_authid is shared by every gate
  // database on the host (#1013).
  await dropModuleRolesAtTeardown([moduleInstallRoleName(moduleId), runtimeRole]);
  await client.query("DELETE FROM app.module_installs WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.users WHERE id = ANY($1::uuid[])", [[ownerA, ownerB]]);
  await client.end();
});

async function install(): Promise<{ installed: string[] }> {
  return installModule({
    moduleId,
    manifest: { database: { ownedTables } },
    bootstrapConnectionString: urls.bootstrap,
    migrationConnectionString: urls.migration,
    migrationsDirectory: "external-modules/job-search/sql"
  });
}

// seedUser runs as bootstrap, outside the runtime role (A5/A note in the task spec): app.users is
// not a module-owned table and the runtime role has no grant on it.
async function seedUser(id: string): Promise<void> {
  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, $2, false)",
      [id, `job-search-${id}@example.test`]
    );
  } finally {
    await client.end();
  }
}

// The runtime role is NOLOGIN (module-role-broker.ts) — a test cannot connect as it directly.
// Instead: connect as a parent role that has it granted WITH INHERIT FALSE (jarvis_worker_runtime,
// per module-role-broker.test.ts's membership assertion), assume it for one transaction with
// SET LOCAL ROLE, and set the actor GUC the same way data-context.ts does in production. Both die
// with the transaction, so no test can leak privilege or actor identity into another.
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

async function seedProfile(ownerUserId: string, profileId: string): Promise<void> {
  await asRuntime(ownerUserId, (client) =>
    client.query(
      `INSERT INTO app.job_search_profiles (id, owner_user_id, name, state)
       VALUES ($1, $2, 'Staff Engineer search', 'active')`,
      [profileId, ownerUserId]
    )
  );
}

async function seedPosting(
  ownerUserId: string,
  profileId: string,
  postingId: string
): Promise<void> {
  await asRuntime(ownerUserId, (client) =>
    client.query(
      `INSERT INTO app.job_search_postings
         (id, owner_user_id, profile_id, source_id, external_id, title, company, location, url, body)
       VALUES ($1, $2, $3, 'linkedin', $4, 'Staff Engineer', 'Acme', 'Remote',
               'https://www.linkedin.com/jobs/1', 'Job body text')`,
      [postingId, ownerUserId, profileId, postingId]
    )
  );
}

async function insertMatch(
  actorUserId: string,
  profileId: string,
  postingId: string
): Promise<void> {
  await asRuntime(actorUserId, (client) =>
    client.query(
      `INSERT INTO app.job_search_matches (owner_user_id, profile_id, posting_id, state)
       VALUES ($1, $2, $3, 'unscored')`,
      [actorUserId, profileId, postingId]
    )
  );
}

describe("job-search module table install (#1288)", () => {
  it("installs all eleven migrations, FORCE RLS on every table, and re-runs idempotently", async () => {
    const result = await install();
    expect(result.installed).toHaveLength(11);

    const client = new Client({ connectionString: urls.bootstrap });
    await client.connect();

    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = 'app' AND table_name = ANY($1::text[])",
      [ownedTables.map((table) => table.replace(/^app\./, ""))]
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(
      ownedTables.map((table) => table.replace(/^app\./, "")).sort()
    );

    const forceRls = await client.query(
      "SELECT relname FROM pg_class WHERE relname LIKE 'job_search_%' AND relforcerowsecurity"
    );
    expect(forceRls.rows.map((row) => row.relname).sort()).toEqual(
      ownedTables.map((table) => table.replace(/^app\./, "")).sort()
    );

    const ledger = await client.query(
      "SELECT version FROM app.module_schema_migrations WHERE module_id = $1",
      [moduleId]
    );
    expect(ledger.rows).toHaveLength(11);

    await client.end();

    const second = await install();
    expect(second.installed).toHaveLength(0);
  });

  it("invalidates legacy Fit through the real installer without changing the other match data", async () => {
    await install();
    await seedUser(ownerA);
    const profileId = randomUUID();
    const postingId = randomUUID();
    const matchId = randomUUID();
    await seedProfile(ownerA, profileId);
    await seedPosting(ownerA, profileId, postingId);
    await asRuntime(ownerA, (client) =>
      client.query(
        `INSERT INTO app.job_search_matches
           (id, owner_user_id, profile_id, posting_id, fit, want, fit_reason, want_reason, state)
         VALUES ($1, $2, $3, $4, 96, 73, 'Different profession.', 'Wanted work.', 'new')`,
        [matchId, ownerA, profileId, postingId]
      )
    );

    const migration = new Client({ connectionString: urls.bootstrap });
    await migration.connect();
    await migration.query(
      "DELETE FROM app.module_schema_migrations WHERE module_id = $1 AND version = '0010'",
      [moduleId]
    );
    await migration.end();

    const retry = await install();
    expect(retry.installed).toEqual(["0010_retry_legacy_fit_invalidation.sql"]);

    const result = await asRuntime(ownerA, (client) =>
      client.query(
        `SELECT m.fit, m.want, m.fit_reason, m.want_reason, m.state, p.title
           FROM app.job_search_matches m
           JOIN app.job_search_postings p ON p.id = m.posting_id
          WHERE m.id = $1`,
        [matchId]
      )
    );
    expect(result.rows[0]).toEqual({
      fit: null,
      want: 73,
      fit_reason: "Different profession.",
      want_reason: "Wanted work.",
      state: "new",
      title: "Staff Engineer"
    });

    expect((await install()).installed).toEqual([]);
  });

  it("stores and reads back a 768-dimension posting embedding", async () => {
    await install();
    await seedUser(ownerA);
    const profileId = randomUUID();
    // profile_id is NOT NULL with an owner-bound FK — seed the parent first, or the insert dies
    // on the FK rather than proving anything about the vector type (task spec, test 2).
    await seedProfile(ownerA, profileId);

    const postingId = randomUUID();
    const vectorLiteral = `[${Array(768).fill(0.001).join(",")}]`;
    await asRuntime(ownerA, (client) =>
      client.query(
        `INSERT INTO app.job_search_postings
           (id, owner_user_id, profile_id, source_id, external_id, title, company, location, url,
            body, embedding)
         VALUES ($1, $2, $3, 'linkedin', $4, 'Staff Engineer', 'Acme', 'Remote',
                 'https://www.linkedin.com/jobs/1', 'Job body text', $5::vector)`,
        [postingId, ownerA, profileId, postingId, vectorLiteral]
      )
    );

    const read = await asRuntime(ownerA, (client) =>
      client.query(
        "SELECT vector_dims(embedding) AS dims FROM app.job_search_postings WHERE id = $1",
        [postingId]
      )
    );
    expect(read.rows[0]?.dims).toBe(768);
  });

  it("makes another owner's profile invisible, not merely absent from the viewer's own set", async () => {
    await install();
    await seedUser(ownerA);
    await seedUser(ownerB);
    await seedProfile(ownerA, randomUUID());

    // B has zero profiles of its own AND cannot see A's — the assertion is total row count, not
    // "B has none of its own" (task spec, test 3).
    const seenByB = await asRuntime(ownerB, (client) =>
      client.query("SELECT id FROM app.job_search_profiles")
    );
    expect(seenByB.rows).toHaveLength(0);
  });

  it("refuses an insert claiming another owner's user id", async () => {
    await install();
    await seedUser(ownerA);
    await seedUser(ownerB);

    // B connects (actor = B) but the row it tries to insert claims owner_user_id = A. This
    // exercises the WITH CHECK half of the generated policy, which a read-only test never reaches
    // (task spec, test 4).
    await expect(
      asRuntime(ownerB, (client) =>
        client.query(
          `INSERT INTO app.job_search_profiles (id, owner_user_id, name, state)
           VALUES ($1, $2, 'Borrowed profile', 'active')`,
          [randomUUID(), ownerA]
        )
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a child row pointing at another owner's parent, on every child and both match parents", async () => {
    await install();
    await seedUser(ownerA);
    await seedUser(ownerB);
    const profileA = randomUUID();
    const profileB = randomUUID();
    await seedProfile(ownerA, profileA);
    await seedProfile(ownerB, profileB);
    const postingA = randomUUID();
    const postingB = randomUUID();
    await seedPosting(ownerA, profileA, postingA);
    await seedPosting(ownerB, profileB, postingB);

    // RLS alone cannot catch any of these: B inserting a B-owned row is legal as far as the
    // owner_user_id policy is concerned. Only the owner-bound composite FK notices the parent is
    // A's (task spec, test 5). Each case is its own transaction/connection via asRuntime.
    await expect(
      asRuntime(ownerB, (client) =>
        client.query(
          `INSERT INTO app.job_search_postings
             (id, owner_user_id, profile_id, source_id, external_id, title, company, location,
              url, body)
           VALUES ($1, $2, $3, 'linkedin', $4, 'Title', 'Co', 'Remote',
                   'https://www.linkedin.com/jobs/2', 'body')`,
          [randomUUID(), ownerB, profileA, randomUUID()]
        )
      ),
      "postings: B's row under A's profile"
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      asRuntime(ownerB, (client) =>
        client.query(
          `INSERT INTO app.job_search_portals (owner_user_id, profile_id, source_id)
           VALUES ($1, $2, 'linkedin')`,
          [ownerB, profileA]
        )
      ),
      "portals: B's row under A's profile"
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      asRuntime(ownerB, (client) =>
        client.query(
          `INSERT INTO app.job_search_resumes (owner_user_id, profile_id, version, content)
           VALUES ($1, $2, 1, 'resume text')`,
          [ownerB, profileA]
        )
      ),
      "resumes: B's row under A's profile"
    ).rejects.toMatchObject({ code: "23503" });

    // Match's two parents, tested independently: B's own posting hung off A's profile, ...
    await expect(
      insertMatch(ownerB, profileA, postingB),
      "matches: B's posting under A's profile"
    ).rejects.toMatchObject({ code: "23503" });

    // ...and B's own profile hung off A's posting. A schema binding only profile_id on this table
    // passes the first of these and fails the second, which is exactly why both are asserted.
    await expect(
      insertMatch(ownerB, profileB, postingA),
      "matches: B's profile with A's posting"
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a fit score outside 0..100", async () => {
    await install();
    await seedUser(ownerA);
    const profileId = randomUUID();
    const postingId = randomUUID();
    await seedProfile(ownerA, profileId);
    await seedPosting(ownerA, profileId, postingId);

    await expect(
      asRuntime(ownerA, (client) =>
        client.query(
          `INSERT INTO app.job_search_matches (owner_user_id, profile_id, posting_id, fit, state)
           VALUES ($1, $2, $3, 101, 'unscored')`,
          [ownerA, profileId, postingId]
        )
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("defaults briefing_detail to count and rejects a value outside the union", async () => {
    await install();
    await seedUser(ownerA);
    const profileId = randomUUID();
    await seedProfile(ownerA, profileId);

    // The quiet default matters (task spec, test 7): a profile the user never opened settings for
    // still contributes a one-line count to the briefing rather than vanishing from it.
    const read = await asRuntime(ownerA, (client) =>
      client.query("SELECT briefing_detail FROM app.job_search_profiles WHERE id = $1", [profileId])
    );
    expect(read.rows[0]?.briefing_detail).toBe("count");

    // A separate call/transaction from the read above (A6): a check-constraint violation aborts
    // the transaction it happens in, so a following assertion in the same one would fail with
    // "current transaction is aborted" instead of checking what it meant to.
    await expect(
      asRuntime(ownerA, (client) =>
        client.query(
          "UPDATE app.job_search_profiles SET briefing_detail = 'verbose' WHERE id = $1",
          [profileId]
        )
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
