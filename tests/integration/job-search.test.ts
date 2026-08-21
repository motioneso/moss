// #1282 Task 2: integration coverage for the briefing composer's NEW caller of the shared
// trust gate (apps/worker/src/external-module-invoke.ts). tests/integration/module-worker-queue-ai.test.ts
// already proves the gate against the pre-existing job queue path — passing there proves
// nothing about this second caller, since a briefing-specific wiring bug (e.g. skipping the
// gate, or building invokeExternalBriefing over the wrong deps) would show up only here.
//
// Every case asserts on the COMPOSED OUTPUT of collectExternalBriefingContributions — the
// actual function compose.ts/compose-evening.ts call — never on a thrown error (J3): a
// module that fails a trust check must silently contribute nothing, not fail the briefing.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { PgBoss } from "pg-boss";

import { collectExternalBriefingContributions } from "@moss/briefings";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { StubEmbeddingProvider } from "@moss/memory";
import {
  validateExternalModuleManifest,
  type ExternalModuleDiscovery
} from "@moss/module-registry";
import { ExternalModuleJobReconciler } from "@moss/module-registry/node";
import type { JsonMossModuleManifest } from "@moss/module-sdk";
import { createModuleCredentialSecretCipher } from "@moss/settings";
import type { Kysely } from "kysely";

import {
  createExternalBriefingInvoker,
  createVerifiedExternalModuleInvoker
} from "../../apps/worker/src/external-module-invoke.js";
import { installModule } from "../../scripts/module-install.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { JOB_SEARCH_TABLES } from "../../external-modules/job-search/src/db/tables.js";
import {
  connectionStrings,
  dropModuleRolesAtTeardown,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

const { Client } = pg;

// assertModuleJobPayload elsewhere requires sha256:<64 hex>; reuse the same shape here so a
// row's hash columns look like real discovery hashes.
const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;

let bootstrap: pg.Client;
let workerDb: Kysely<MossDatabase>;

const moduleId = "job-search-briefing";

const manifest: JsonMossModuleManifest = {
  schemaVersion: 1,
  id: moduleId,
  name: "Job Search",
  version: "1.0.0",
  publisher: "Jarvis",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" },
  runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
  briefing: {
    handler: "briefing.contribute",
    sections: ["morning", "evening"],
    toolName: "job-search.briefing"
  }
};

const discovery = {
  id: moduleId,
  dir: "/unused",
  manifest,
  manifestHash: HASH,
  packageHash: HASH
};

beforeAll(async () => {
  await resetFoundationDatabase();
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
});

afterAll(async () => {
  await Promise.allSettled([bootstrap?.end(), workerDb?.destroy()]);
});

/** Inserts (or replaces) the module's app.external_modules row for one test case. */
async function seedModuleRow(overrides: {
  status: "enabled" | "disabled";
  manifestHash?: string;
  packageHash?: string;
}): Promise<void> {
  await bootstrap.query(`DELETE FROM app.external_modules WHERE id = $1`, [moduleId]);
  await bootstrap.query(
    `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, enabled_at, enabled_by)
     VALUES ($1, $2, $3, $4, now(), $5)`,
    [
      moduleId,
      overrides.status,
      overrides.manifestHash ?? HASH,
      overrides.packageHash ?? HASH,
      ids.adminUser
    ]
  );
}

/** Builds the real gate + adapter, exactly as apps/worker/src/worker.ts composes them, with
 * only runtime.invoke stubbed so the test controls what the "module" returns. */
function buildInvoker(runtimeResult: unknown = { headline: "Two new leads", items: [] }) {
  return createExternalBriefingInvoker({
    workerDb,
    getDiscoveryById: (id: string) => (id === moduleId ? discovery : undefined),
    listDiscoveredModuleIds: () => [moduleId],
    dataContext: new DataContextRunner(workerDb),
    cipher: createModuleCredentialSecretCipher(),
    runtime: { invoke: async () => runtimeResult },
    listActiveUserIds: async () => [ids.userA]
  });
}

async function collect(invoke: ReturnType<typeof buildInvoker>) {
  return collectExternalBriefingContributions({
    manifests: [manifest],
    selectedToolNames: [manifest.briefing!.toolName],
    section: "morning",
    actorUserId: ids.userA,
    requestId: "req-job-search-briefing",
    invoke
  });
}

describe("external module briefing contribution — real trust gate (#1282)", () => {
  it("contributes no section when the module row is disabled", async () => {
    await seedModuleRow({ status: "disabled" });
    const result = await collect(buildInvoker());
    expect(result).toEqual([]);
  });

  it("contributes no section when the stored package_hash differs from the discovery", async () => {
    await seedModuleRow({ status: "enabled", packageHash: OTHER_HASH });
    const result = await collect(buildInvoker());
    expect(result).toEqual([]);
  });

  it("contributes no section when the stored manifest_hash differs from the discovery", async () => {
    await seedModuleRow({ status: "enabled", manifestHash: OTHER_HASH });
    const result = await collect(buildInvoker());
    expect(result).toEqual([]);
  });

  it("contributes a section on the happy path", async () => {
    await seedModuleRow({ status: "enabled" });
    const result = await collect(
      buildInvoker({
        headline: "Two new leads",
        items: [{ id: "job-1", title: "Staff Engineer", detail: "Posted today" }]
      })
    );
    expect(result).toEqual([
      {
        moduleId,
        headline: "Two new leads",
        items: [{ id: "job-1", title: "Staff Engineer", detail: "Posted today" }]
      }
    ]);
  });
});

// Task 21 (#1305) hash gate: createVerifiedExternalModuleInvoker's trust gate must decline on
// EITHER hash mismatching independently (F10 requires both are checked, not manifest_hash
// alone) — reuses the synthetic fixtures above rather than standing up a second module row,
// since the gate itself is generic and doesn't care which manifest it's guarding. The
// runtime.invoke stub throws if ever reached: a passing assertion here must mean the gate
// short-circuited BEFORE touching the module process, not that the process happened to also
// return the right shape.
describe("createVerifiedExternalModuleInvoker hash gate (#1305)", () => {
  function buildRawInvoker() {
    return createVerifiedExternalModuleInvoker({
      workerDb,
      getDiscoveryById: (id: string) => (id === moduleId ? discovery : undefined),
      listDiscoveredModuleIds: () => [moduleId],
      dataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      runtime: {
        invoke: async () => {
          throw new Error("gate must not reach runtime.invoke on a hash mismatch");
        }
      },
      listActiveUserIds: async () => [ids.userA]
    });
  }

  const baseArgs = {
    moduleId,
    handler: "briefing.contribute",
    actorUserId: ids.userA,
    requestId: "req-hash-gate",
    jobKind: "test",
    idempotencyKey: "test-hash-gate",
    params: {},
    lane: "briefing" as const,
    toolRisk: "read" as const
  };

  it("declines on a manifest_hash mismatch alone", async () => {
    await seedModuleRow({ status: "enabled", manifestHash: OTHER_HASH });
    const result = await buildRawInvoker()(baseArgs);
    expect(result).toEqual({ ok: false, reason: "hash-mismatch" });
  });

  it("declines on a package_hash mismatch alone", async () => {
    await seedModuleRow({ status: "enabled", packageHash: OTHER_HASH });
    const result = await buildRawInvoker()(baseArgs);
    expect(result).toEqual({ ok: false, reason: "hash-mismatch" });
  });
});

// Task 21 (#1305) test 8: schedule->queue binding survives reconciliation, against the REAL
// ExternalModuleJobReconciler and the REAL on-disk manifest (never retyped) — a typo in either
// the schedule's `queue` field or a queue's `name` would silently orphan the schedule, and only
// asserting against the parsed manifest catches that.
describe("job-search reconciler binds crawl-sweep's schedule to its own queue (#1305, test 8)", () => {
  function loadJobSearchModule(): ExternalModuleDiscovery {
    const manifestPath = fileURLToPath(
      new URL("../../external-modules/job-search/jarvis.module.json", import.meta.url)
    );
    const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const validation = validateExternalModuleManifest(raw, "job-search", "0.1.0");
    if (!validation.ok) {
      throw new Error(`job-search manifest failed validation: ${validation.errors.join(", ")}`);
    }
    return {
      id: "job-search",
      dir: fileURLToPath(new URL("../../external-modules/job-search", import.meta.url)),
      manifest: validation.manifest,
      manifestHash: HASH,
      packageHash: HASH
    };
  }

  it("creates every declared queue and schedules crawl-sweep against the crawl-sweep queue", async () => {
    const module = loadJobSearchModule();
    const calls: string[] = [];
    const schedules: Array<{
      name: string;
      cron: string;
      payload: unknown;
      options: unknown;
    }> = [];
    const boss = {
      getQueue: async () => null,
      createQueue: async (name: string) => {
        calls.push(`create:${name}`);
      },
      updateQueue: async (name: string, options: unknown) => {
        calls.push(`update:${name}:${JSON.stringify(options)}`);
      },
      getSchedules: async () => [],
      schedule: async (name: string, cron: string, payload: unknown, options: unknown) => {
        schedules.push({ name, cron, payload, options });
      }
    } as unknown as PgBoss;

    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [ids.userA]
    });
    await reconciler.reconcileAll();

    expect(calls).toEqual([
      "create:job-search.crawl-run",
      `update:job-search.crawl-run:${JSON.stringify({ retryLimit: 2 })}`,
      "create:job-search.crawl-sweep",
      `update:job-search.crawl-sweep:${JSON.stringify({ retryLimit: 1 })}`,
      "create:job-search.match-state",
      `update:job-search.match-state:${JSON.stringify({ retryLimit: 2 })}`,
      "create:job-search.portal-set-enabled",
      `update:job-search.portal-set-enabled:${JSON.stringify({ retryLimit: 2 })}`,
      "create:job-search.profile-set-briefing-detail",
      `update:job-search.profile-set-briefing-detail:${JSON.stringify({ retryLimit: 2 })}`,
      "create:job-search.criteria-set",
      `update:job-search.criteria-set:${JSON.stringify({ retryLimit: 0 })}`,
      // The list is deliberately exhaustive and in manifest order: it doubles as the guard that
      // catches a queue silently dropped from the manifest, so a new queue means updating this
      // list, never loosening the assertion. resume-set carries retryLimit 0 on purpose — the
      // résumé row commits before scoring runs, so a retry would re-bump the résumé version.
      "create:job-search.resume-set",
      `update:job-search.resume-set:${JSON.stringify({ retryLimit: 0 })}`,
      "create:job-search.profile-bootstrap",
      `update:job-search.profile-bootstrap:${JSON.stringify({ retryLimit: 1 })}`,
      "create:job-search.profile-new",
      `update:job-search.profile-new:${JSON.stringify({ retryLimit: 1 })}`,
      "create:job-search.profile-rename",
      `update:job-search.profile-rename:${JSON.stringify({ retryLimit: 2 })}`
    ]);

    expect(schedules).toEqual([
      {
        name: "job-search.crawl-sweep",
        cron: "17 */6 * * *",
        payload: {
          actorUserId: ids.userA,
          moduleId: "job-search",
          jobKind: "job-search.crawl-sweep",
          manifestHash: module.manifestHash
        },
        options: { tz: "UTC", key: `job-search/job-search.crawl-sweep/${ids.userA}` }
      },
      {
        name: "job-search.crawl-sweep",
        cron: "*/10 * * * *",
        payload: {
          actorUserId: ids.userA,
          moduleId: "job-search",
          jobKind: "job-search.rescore-sweep",
          manifestHash: module.manifestHash
        },
        options: { tz: "UTC", key: `job-search/job-search.rescore-sweep/${ids.userA}` }
      }
    ]);
  });
});

// Task 21 (#1305): the REAL job-search module's tables under real RLS. Distinct from the
// synthetic "job-search-briefing" fixture above, which only exercises the generic trust gate
// with a minimal fake manifest — this uses the real module id, the real DDL
// (external-modules/job-search/sql), and JOB_SEARCH_TABLES imported, never retyped.
//
// Tier A only: DB-level RLS with no worker process. asRuntime() below, not
// createAppRuntimeRunner() — the task spec names the latter, but N20 in the rulings ledger
// settles that createAppRuntimeRunner() (tests/uat/seed/connections.ts) connects as
// jarvis_app_runtime, which has no grant on app.job_search_* at all; those tables require the
// per-module runtime role via SET LOCAL ROLE, which is what asRuntime() does (cloned from
// tests/integration/job-search-tables-install.test.ts).
//
// Tier B (queue payload whitelist, manual-run route, schedule->queue binding, real-gateway tool
// calls, hash gate, briefing round-trip) lives elsewhere: the hash-gate and schedule->queue
// describes above are in this same file (synthetic fixtures suffice for both — the gate is
// generic and the reconciler test only checks binding, not a live process), and the three tests
// that need a real spawned worker (manual-run, matches.list invoke, briefing contribution) are in
// the sibling file tests/integration/job-search-worker-surface.test.ts, split out purely to stay
// under the file-size gate's 1000-line cap. Tier A "must never depend on the worker being up" per
// the task spec, and by the same logic it doesn't need the heavier build-package/discovery-dir/
// enable ceremony that exists only to get a worker live — so this suite skips straight to a
// direct installModule() call, the same pattern Task 4's job-search-tables-install.test.ts and
// Task 13's job-search-store.test.ts already use.
describe("job-search module RLS (#1305, tier A — no worker process)", () => {
  const realModuleId = "job-search";
  const runtimeRole = moduleRuntimeRoleName(realModuleId);
  const ownedTables = JOB_SEARCH_TABLES.map((table) => `app.${table}`);

  beforeAll(async () => {
    await installModule({
      moduleId: realModuleId,
      manifest: { database: { ownedTables } },
      bootstrapConnectionString: connectionStrings.bootstrap,
      migrationConnectionString: connectionStrings.migration,
      migrationsDirectory: "external-modules/job-search/sql"
    });
  });

  afterAll(async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      for (const table of ownedTables) {
        await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
      // Same REVOKE-before-DROP-CASCADE ordering as job-search-tables-install.test.ts's
      // afterEach — see its comments for why CASCADE and this exact order are both required.
      await client.query(
        `REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${moduleInstallRoleName(realModuleId)} CASCADE`
      );
      await client.query(
        `REVOKE ALL PRIVILEGES ON app.users FROM ${moduleInstallRoleName(realModuleId)}`
      );
      await client.query(
        `REVOKE REFERENCES (id) ON app.users FROM ${moduleInstallRoleName(realModuleId)}`
      );
      await client.query(
        `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ` +
          `${moduleInstallRoleName(realModuleId)} CASCADE`
      );
      // Cluster-global: locked, and fail-closed apart from the one documented 2BP01 case (#1013).
      await dropModuleRolesAtTeardown([moduleInstallRoleName(realModuleId), runtimeRole]);
      await client.query("DELETE FROM app.module_installs WHERE module_id = $1", [realModuleId]);
      await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = $1", [
        realModuleId
      ]);
    } finally {
      await client.end();
    }
  });

  // Every job_search_* row this describe block's `it`s create, cleared between cases so tests
  // 2/3's isolation loops always start from an empty table — this file's DB is shared and never
  // reset between integration files (N21), and this cleanup must run even on a failing
  // assertion, which is exactly what vitest's afterEach guarantees.
  afterEach(async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      for (const table of ownedTables) {
        await client.query(`DELETE FROM ${table}`);
      }
    } finally {
      await client.end();
    }
  });

  async function asRuntime<T>(
    actorUserId: string,
    fn: (client: pg.Client) => Promise<T>
  ): Promise<T> {
    const client = new Client({ connectionString: connectionStrings.worker });
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
           (id, owner_user_id, profile_id, source_id, external_id, title, company, location, url,
            body)
         VALUES ($1, $2, $3, 'linkedin', $4, 'Staff Engineer', 'Acme', 'Remote',
                 'https://www.linkedin.com/jobs/1', 'Job body text')`,
        [postingId, ownerUserId, profileId, postingId]
      )
    );
  }

  // Exactly one row under test per table, plus whatever FK parents that row needs — a fresh
  // profile (and posting, where required) per call, so two calls for two different owners never
  // collide (task spec, test 2: "insert as owner A ... then the reverse").
  async function seedOwnedRow(table: string, ownerUserId: string): Promise<void> {
    const profileId = randomUUID();
    await seedProfile(ownerUserId, profileId);
    if (table === "job_search_profiles") return;

    const postingId = randomUUID();
    if (table === "job_search_postings" || table === "job_search_matches") {
      await seedPosting(ownerUserId, profileId, postingId);
      if (table === "job_search_postings") return;
    }

    if (table === "job_search_portals") {
      await asRuntime(ownerUserId, (client) =>
        client.query(
          `INSERT INTO app.job_search_portals (owner_user_id, profile_id, source_id)
           VALUES ($1, $2, 'linkedin')`,
          [ownerUserId, profileId]
        )
      );
      return;
    }
    if (table === "job_search_resumes") {
      await asRuntime(ownerUserId, (client) =>
        client.query(
          `INSERT INTO app.job_search_resumes (owner_user_id, profile_id, version, content)
           VALUES ($1, $2, 1, 'resume text')`,
          [ownerUserId, profileId]
        )
      );
      return;
    }
    if (table === "job_search_matches") {
      await asRuntime(ownerUserId, (client) =>
        client.query(
          `INSERT INTO app.job_search_matches (owner_user_id, profile_id, posting_id, state)
           VALUES ($1, $2, $3, 'unscored')`,
          [ownerUserId, profileId, postingId]
        )
      );
      return;
    }
    if (table === "job_search_custom_sources") {
      // Migration 0008 (Task 24, #1309): host/label/url define a user-named board. The
      // composite FK to job_search_profiles(owner_user_id, id) is why this branch, like
      // portals/resumes above, seeds off the same profileId rather than a bare insert.
      await asRuntime(ownerUserId, (client) =>
        client.query(
          `INSERT INTO app.job_search_custom_sources (owner_user_id, profile_id, host, label, url)
           VALUES ($1, $2, 'boards.example.com', 'Example Boards', 'https://boards.example.com/jobs')`,
          [ownerUserId, profileId]
        )
      );
      return;
    }
    if (table === "job_search_rescore_state") {
      await asRuntime(ownerUserId, (client) =>
        client.query(
          `INSERT INTO app.job_search_rescore_state (owner_user_id, pending)
           VALUES ($1, jsonb_build_object($2::text, '{}'::jsonb))`,
          [ownerUserId, profileId]
        )
      );
      return;
    }
    throw new Error(`seedOwnedRow: unhandled table ${table}`);
  }

  it("the database's tables are exactly the canonical list", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'app' AND table_name LIKE 'job_search_%'`
      );
      expect(result.rows.map((row) => row.table_name).sort()).toEqual(
        [...JOB_SEARCH_TABLES].sort()
      );
    } finally {
      await client.end();
    }
  });

  it("cross-owner isolation, both directions, on every table", async () => {
    for (const table of JOB_SEARCH_TABLES) {
      await seedOwnedRow(table, ids.userA);
      const seenByB = await asRuntime(ids.userB, (client) =>
        client.query(`SELECT 1 FROM app.${table}`)
      );
      expect(seenByB.rows, `${table}: B must not see A's row`).toHaveLength(0);

      await seedOwnedRow(table, ids.userB);
      const seenByA = await asRuntime(ids.userA, (client) =>
        client.query(`SELECT 1 FROM app.${table}`)
      );
      // Table now holds one row for A and one for B — A must see only its own, not both.
      expect(seenByA.rows, `${table}: A must not see B's row`).toHaveLength(1);
    }
  });

  it("an admin actor sees nothing — same loop, admin context", async () => {
    for (const table of JOB_SEARCH_TABLES) {
      await seedOwnedRow(table, ids.userA);
      const seenByAdmin = await asRuntime(ids.adminUser, (client) =>
        client.query(`SELECT 1 FROM app.${table}`)
      );
      // Admin power is configuration power, not private-data access (CLAUDE.md hard invariant)
      // — this is the assertion that says so for every job-search table.
      expect(seenByAdmin.rows, `${table}: admin must not see any owner's row`).toHaveLength(0);
    }
  });

  it("every owned table actually has an RLS policy", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      // installModule() Phase B generates RLS from manifest.database.ownedTables — a table
      // missing from that array gets no policy at all, which fails open. Test 2 alone would
      // still pass if this row simply were not there (an empty table looks isolated either way),
      // so this is a distinct assertion, not a restatement of it.
      const result = await client.query<{ tablename: string }>(
        `SELECT DISTINCT tablename FROM pg_policies
         WHERE schemaname = 'app' AND tablename = ANY($1::text[])`,
        [[...JOB_SEARCH_TABLES]]
      );
      const withPolicies = new Set(result.rows.map((row) => row.tablename));
      for (const table of JOB_SEARCH_TABLES) {
        expect(withPolicies.has(table), `${table} has no pg_policies row at all`).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  it("the stored embedding has the dimension the port reports", async () => {
    const profileId = randomUUID();
    await seedProfile(ids.userA, profileId);
    const postingId = randomUUID();
    // No worker process in tier A, so there is no live ctx.embed to call — the port's
    // dimensions come from the same StubEmbeddingProvider the host resolves in tests (never
    // production; see LocalEmbeddingProvider for the real 768-dim nomic model this stands in
    // for), not a hand-picked constant.
    const { dimensions } = new StubEmbeddingProvider();
    const vectorLiteral = `[${Array(dimensions).fill(0.001).join(",")}]`;
    await asRuntime(ids.userA, (client) =>
      client.query(
        `INSERT INTO app.job_search_postings
           (id, owner_user_id, profile_id, source_id, external_id, title, company, location, url,
            body, embedding)
         VALUES ($1, $2, $3, 'linkedin', $4, 'Staff Engineer', 'Acme', 'Remote',
                 'https://www.linkedin.com/jobs/1', 'Job body text', $5::vector)`,
        [postingId, ids.userA, profileId, postingId, vectorLiteral]
      )
    );
    const read = await asRuntime(ids.userA, (client) =>
      client.query<{ dims: number }>(
        "SELECT vector_dims(embedding) AS dims FROM app.job_search_postings WHERE id = $1",
        [postingId]
      )
    );
    expect(read.rows[0]?.dims).toBe(dimensions);
  });
});
