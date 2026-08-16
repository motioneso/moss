// Task 21 (#1305) tests 6, 9, 11: the REAL API server (server.inject, never a live port — see
// external-modules-routes.test.ts) plus the REAL ExternalModuleWorkerRuntime (a real spawned
// child process, never the stub-runtime pattern tests/integration/job-search.test.ts's synthetic
// briefing fixture uses). Split into its own file (not appended to job-search.test.ts) purely to
// stay under the file-size gate's 1000-line cap — this describe owns its own independent
// installModule()/dist-build/server lifecycle, so the split has no cross-file coupling.
//
// Deliberately absent: a Task 21 "test 10" here (a partial crawl through the real worker
// asserting both the landed postings and a portal's structured FailureCause persist). Ruling N41
// (docs/superpowers/handoffs/2026-07-27-job-search/rulings-ledger.md, unreopened through N49)
// found that coverage already exists at better levels and must NOT grow an integration test:
// "the postings landed" is tests/unit/job-search-crawl-stage.test.ts:225 (a healthy portal and a
// rate_limited portal in one crawl pass, fake store), and "lastOkAt intact" is
// tests/integration/job-search-store.test.ts:380 case 6 (real Postgres, the actual COALESCE at
// worker/store-sql.ts:361). The plan's Task 21 text predates N41 and was never amended, so an
// audit that diffs this file against the plan alone will re-find this "gap" — it is a recorded
// deviation, not a hole (ruling N49).
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { collectExternalBriefingContributions } from "@moss/briefings";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import {
  validateExternalModuleManifest,
  type ExternalModuleDiscovery
} from "@moss/module-registry";
import {
  ExternalModuleWorkerRuntime,
  hashCanonicalManifest,
  hashExternalPackage
} from "@moss/module-registry/node";
import type { JsonMossModuleManifest } from "@moss/module-sdk";
import { createModuleCredentialSecretCipher } from "@moss/settings";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createExternalBriefingInvoker } from "../../apps/worker/src/external-module-invoke.js";
import { installModule } from "../../scripts/module-install.js";
import { buildExternalModule } from "../../scripts/build-external-module.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { JOB_SEARCH_TABLES } from "../../external-modules/job-search/src/db/tables.js";
import {
  connectionStrings,
  dropModuleRolesAtTeardown,
  resetEmptyFoundationDatabase
} from "./test-database.js";

const { Client } = pg;

// resetFoundationDatabase() (seeded via seedProbeData) inserts 3 users directly via raw SQL,
// none with is_bootstrap_owner set — bypassing packages/auth's bootstrap path entirely. That
// makes bootstrapOwnerExists() report false forever, so the real sign-up below tries to
// self-promote to admin and app.users_guard_admin_flag() (migration 0053, #97) correctly
// rejects it: its exemption only fires at count_all_users() = 1, not "no flagged owner yet".
// This file mints its own admin from the sign-up response and never touches seedProbeData's
// rows, so resetEmptyFoundationDatabase() is both correct and matches every other integration
// suite that performs a real self-service sign-up (api-rate-limit, chat-multiplexer-admin,
// me-sessions, news-personalization-repository) — none of them use the seeded reset either.
beforeAll(async () => {
  await resetEmptyFoundationDatabase();
});

describe("job-search module through the real API + worker RPC surface (#1305, tests 6/9/11)", () => {
  const realModuleId = "job-search";
  const runtimeRole = moduleRuntimeRoleName(realModuleId);
  const ownedTables = JOB_SEARCH_TABLES.map((table) => `app.${table}`);
  const sourceDir = fileURLToPath(new URL("../../external-modules/job-search", import.meta.url));

  let root: string;
  let appDb: Kysely<MossDatabase>;
  let heavyWorkerDb: Kysely<MossDatabase>;
  let server: ReturnType<typeof createApiServer>;
  let adminCookie: string;
  let adminUserId: string;
  let realManifest: JsonMossModuleManifest;
  let realDiscovery: ExternalModuleDiscovery;
  let expectedManifestHash: string;
  let workerRuntime: ExternalModuleWorkerRuntime;

  beforeAll(async () => {
    await installModule({
      moduleId: realModuleId,
      manifest: { database: { ownedTables } },
      bootstrapConnectionString: connectionStrings.bootstrap,
      migrationConnectionString: connectionStrings.migration,
      migrationsDirectory: "external-modules/job-search/sql"
    });

    await buildExternalModule(sourceDir);
    root = mkdtempSync(join(tmpdir(), "job-search-tierb-"));
    const modulesDir = join(root, "modules");
    const installedDir = join(modulesDir, "job-search");
    mkdirSync(installedDir, { recursive: true });
    cpSync(join(sourceDir, "jarvis.module.json"), join(installedDir, "jarvis.module.json"));
    cpSync(join(sourceDir, "dist"), join(installedDir, "dist"), { recursive: true });

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    heavyWorkerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 4
    });
    server = createApiServer({
      appDb,
      logger: false,
      apiServerConfig: {
        host: "0.0.0.0",
        port: 0,
        mcpServerUrl: "http://127.0.0.1:0/api/mcp",
        externalModulesDir: modulesDir
      }
    });
    await server.ready();

    const admin = await signUp(server, "owner@job-search-tierb.test", "Owner");
    adminCookie = admin.cookie;
    adminUserId = admin.userId;
    const enable = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/job-search",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { enabled: true }
    });
    expect(enable.statusCode).toBe(200);

    // Real hashes, not synthetic ones: createVerifiedExternalModuleInvoker's gate (test 11
    // runs through it via createExternalBriefingInvoker) checks both against this row, so a
    // *hand-picked* hash here would make the gate the thing under test instead of the handler.
    // That instinct doesn't extend to a value derived independently from the same source the
    // enable route hashed — see the anchor assertions right after expectedManifestHash/
    // expectedPackageHash below, which is exactly that: the row is read back for realDiscovery's
    // consumers (test 11), and separately verified against a from-source recomputation so this
    // isn't just re-reading what was written without checking it.
    const row = await appDb
      .selectFrom("app.external_modules")
      .select(["manifest_hash", "package_hash"])
      .where("id", "=", realModuleId)
      .executeTakeFirstOrThrow();
    const raw: unknown = JSON.parse(readFileSync(join(sourceDir, "jarvis.module.json"), "utf8"));
    const validation = validateExternalModuleManifest(raw, "job-search", "0.1.0");
    if (!validation.ok) {
      throw new Error(`job-search manifest failed validation: ${validation.errors.join(", ")}`);
    }
    realManifest = validation.manifest;
    realDiscovery = {
      id: realModuleId,
      dir: sourceDir,
      manifest: realManifest,
      manifestHash: row.manifest_hash,
      packageHash: row.package_hash
    };
    // De-tautologized (#1305 Task 21 test 9 follow-up, N47 review): test 6 asserts the manual-run
    // job payload's manifestHash against a value from this same app.external_modules row — if
    // enable-time had written the wrong hash, that assertion would still pass against itself.
    // hashCanonicalManifest is pure content hashing (packages/module-registry/src/external/
    // hash.ts) with no filesystem dependency, so recomputing it from the validated manifest here
    // is a genuine, independent check against what the enable route actually persisted.
    expectedManifestHash = hashCanonicalManifest(realManifest);
    // hashExternalPackage walks installedDir (not sourceDir) — that's the exact directory
    // node.ts:137 hashes at enable time, so this reproduces the real derivation rather than
    // comparing against a different tree that happens to look similar.
    const expectedPackageHash = hashExternalPackage(installedDir);
    // The independent anchor: row.manifest_hash/package_hash are what realDiscovery hands to
    // test 11's invoker gate below. Without this, every downstream comparison against
    // realDiscovery traces back to the same enable-time write with nothing to catch it if that
    // write were wrong — this line is what makes the rest of the chain load-bearing.
    expect(row.manifest_hash).toBe(expectedManifestHash);
    expect(row.package_hash).toBe(expectedPackageHash);
    workerRuntime = new ExternalModuleWorkerRuntime();
  }, 120_000);

  afterAll(async () => {
    await workerRuntime?.close();
    await Promise.allSettled([server?.close(), appDb?.destroy(), heavyWorkerDb?.destroy()]);
    rmSync(root, { recursive: true, force: true });

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      for (const table of ownedTables) {
        await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
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

  async function asHeavyRuntime<T>(
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

  it("test 6: manual-run enqueues a metadata-only job and dedupes a duplicate call", async () => {
    const profileId = randomUUID();
    await asHeavyRuntime(adminUserId, (client) =>
      client.query(
        `INSERT INTO app.job_search_profiles (id, owner_user_id, name, state)
         VALUES ($1, $2, 'Staff Engineer search', 'active')`,
        [profileId, adminUserId]
      )
    );

    // No reconciler runs in this harness, so the queue must exist before manual-run can enqueue
    // into it — same precondition external-modules-routes.test.ts's own manual-run test relies on.
    const migrationBoss = createPgBossClient(connectionStrings.migration);
    await migrationBoss.start();
    await migrationBoss.createQueue("job-search.crawl-run");
    await migrationBoss.stop({ graceful: false });

    const run = await server.inject({
      method: "POST",
      url: "/api/modules/job-search/queues/job-search.crawl-run/run",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { jobKind: "job-search.crawl-run", params: { profileId } }
    });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ jobId: expect.any(String) });

    // Same singleton window, called again immediately: the production dedupe path, not a
    // second distinct job.
    const duplicateRun = await server.inject({
      method: "POST",
      url: "/api/modules/job-search/queues/job-search.crawl-run/run",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { jobKind: "job-search.crawl-run", params: { profileId } }
    });
    expect(duplicateRun.statusCode).toBe(202);
    expect(duplicateRun.json()).toEqual({ jobId: null });

    const payloadClient = new Client({ connectionString: connectionStrings.bootstrap });
    await payloadClient.connect();
    try {
      const payload = await payloadClient.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM pgboss.job_common WHERE name = 'job-search.crawl-run'
         ORDER BY created_on DESC LIMIT 1`
      );
      // Metadata-only whitelist (CLAUDE.md hard invariant): actor/resource ids, job kind,
      // manifest hash, and the small command param — never posting bodies, prompts, or secrets.
      // Asserted against expectedManifestHash (independently recomputed), not realDiscovery's
      // copy of the same DB row this payload was itself populated from — see the comment at
      // expectedManifestHash's computation above for why that would be tautological.
      expect(payload.rows[0]?.data).toEqual({
        actorUserId: adminUserId,
        moduleId: "job-search",
        jobKind: "job-search.crawl-run",
        manifestHash: expectedManifestHash,
        params: { profileId }
      });
    } finally {
      await payloadClient.end();
    }
  });

  it("test 9: every manifest tool is exposed and invocable exactly as it declares itself", async () => {
    const toolsResponse = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-tools",
      headers: { cookie: adminCookie }
    });
    expect(toolsResponse.statusCode).toBe(200);
    const jobSearchTools = toolsResponse
      .json<{ tools: Array<{ moduleId: string; name: string }> }>()
      .tools.filter((tool) => tool.moduleId === "job-search");
    // Derived from the manifest, never hardcoded (#1305 requirement) — a renamed or removed
    // tool must fail here, not silently at invoke time (see prose-tool-names-unvalidated).
    expect(jobSearchTools.map((tool) => tool.name).sort()).toEqual(
      [...realManifest.assistantTools!.map((tool) => tool.name)].sort()
    );

    const profileId = randomUUID();
    const postingId = randomUUID();
    const matchId = randomUUID();
    await asHeavyRuntime(adminUserId, async (client) => {
      await client.query(
        `INSERT INTO app.job_search_profiles (id, owner_user_id, name, state)
         VALUES ($1, $2, 'Staff Engineer search', 'active')`,
        [profileId, adminUserId]
      );
      await client.query(
        `INSERT INTO app.job_search_postings
           (id, owner_user_id, profile_id, source_id, external_id, title, company, location, url, body)
         VALUES ($1, $2, $3, 'linkedin', $4, 'Staff Engineer', 'Acme', 'Remote',
                 'https://www.linkedin.com/jobs/1', 'Job body text')`,
        [postingId, adminUserId, profileId, postingId]
      );
      await client.query(
        `INSERT INTO app.job_search_matches (id, owner_user_id, profile_id, posting_id, fit, want, state)
         VALUES ($1, $2, $3, $4, 70, 80, 'new')`,
        [matchId, adminUserId, profileId, postingId]
      );
    });

    const invokeTool = (name: string, input: Record<string, unknown>) =>
      server.inject({
        method: "POST",
        url: `/api/ai/assistant-tools/job-search.${name}/invoke`,
        headers: { cookie: adminCookie, "content-type": "application/json" },
        payload: { input }
      });

    // -- Risk "read" (5 of 15): the invoke route runs manifestTool.execute() directly and
    // returns 200 succeeded. Each assertion below checks the tool actually did its own job,
    // not just that a 200 came back.
    const matchesList = await invokeTool("matches.list", { profileId, limit: 15 });
    expect(matchesList.statusCode).toBe(200);
    const matchesListInvocation = matchesList.json<{
      invocation: { status: string; result: { items: Array<{ id: string }> } };
    }>().invocation;
    expect(matchesListInvocation.status).toBe("succeeded");
    expect(matchesListInvocation.result.items.map((item) => item.id)).toContain(matchId);

    const matchGet = await invokeTool("match.get", { matchId });
    expect(matchGet.statusCode).toBe(200);
    const matchGetInvocation = matchGet.json<{
      invocation: { status: string; result: { matchId: string; match: { id: string } | null } };
    }>().invocation;
    expect(matchGetInvocation.status).toBe("succeeded");
    expect(matchGetInvocation.result.match?.id).toBe(matchId);

    const profileList = await invokeTool("profile.list", {});
    expect(profileList.statusCode).toBe(200);
    const profileListInvocation = profileList.json<{
      invocation: { status: string; result: { profiles: Array<{ profileId: string }> } };
    }>().invocation;
    expect(profileListInvocation.status).toBe("succeeded");
    expect(profileListInvocation.result.profiles.map((p) => p.profileId)).toContain(profileId);

    const resumeGet = await invokeTool("resume.get", { profileId });
    expect(resumeGet.statusCode).toBe(200);
    const resumeGetInvocation = resumeGet.json<{
      invocation: { status: string; result: { profileId: string } };
    }>().invocation;
    expect(resumeGetInvocation.status).toBe("succeeded");
    expect(resumeGetInvocation.result.profileId).toBe(profileId);

    const portalList = await invokeTool("portal.list", { profileId });
    expect(portalList.statusCode).toBe(200);
    const portalListInvocation = portalList.json<{
      invocation: { status: string; result: { portals: unknown[] } };
    }>().invocation;
    expect(portalListInvocation.status).toBe("succeeded");
    expect(Array.isArray(portalListInvocation.result.portals)).toBe(true);

    // -- Risk "write" (10 of 15): packages/ai/src/routes.ts:645 — every non-"read" tool always
    // 403s with confirmation_required and a fresh PendingAssistantAction row, before ever
    // reaching manifestTool.execute(). Per that route's own comment (routes.ts:692-697), "Any
    // service-backed write tool must be invoked via the gateway/CLI path, which threads
    // per-tool ToolServices only after an Approve" — the generic REST invoke route this test
    // drives structurally cannot carry a write tool to "succeeded". So for these 10, "the
    // envelope survives" means asserting the well-formed BLOCKED envelope the route actually
    // returns (status "blocked", blockedReason "confirmation_required", a real
    // actionRequestId) — not a false claim that the write itself ran.
    const writeToolInputs: Record<string, Record<string, unknown>> = {
      "profile.create": { name: "Staff Engineer search 2" },
      "criteria.set": { profileId, criteria: { titles: ["Staff Engineer"], remote: "preferred" } },
      "profile.set-context": { profileId, summary: "Looking for senior IC roles." },
      "profile.set-briefing-detail": { profileId, detail: "top" },
      "resume.set": { profileId, content: "Resume text." },
      "portal.set-enabled": { profileId, sourceId: "linkedin", enabled: true },
      "source.add": { profileId, url: "https://boards.greenhouse.io/acme" },
      "source.remove": { profileId, sourceId: "linkedin" },
      "crawl.run-now": { profileId },
      "match.dismiss": { matchId }
    };
    // Derived from the manifest, same discipline as the tool-name check above (and N47's
    // registry discovery test): if a write tool is renamed or added without this map keeping
    // up, this fails loud instead of the loop below silently covering fewer than 10 tools.
    const writeToolNames = realManifest
      .assistantTools!.filter((tool) => tool.risk !== "read")
      .map((tool) => tool.name.replace("job-search.", ""));
    expect(Object.keys(writeToolInputs).sort()).toEqual([...writeToolNames].sort());

    for (const [name, input] of Object.entries(writeToolInputs)) {
      const res = await invokeTool(name, input);
      expect(res.statusCode).toBe(403);
      const blocked = res.json<{
        invocation: {
          status: string;
          blockedReason: string | null;
          actionRequestId: string | null;
        };
      }>().invocation;
      expect(blocked.status).toBe("blocked");
      expect(blocked.blockedReason).toBe("confirmation_required");
      expect(blocked.actionRequestId).toEqual(expect.any(String));
    }
  });

  // Test 11: three separate actors, one active profile each, so "most generous detail wins"
  // (briefing.ts) is trivially that profile's own briefingDetail — no need for a second profile
  // per actor to make the assertion real.
  async function seedBriefingScenario(
    detail: "count" | "top" | "full"
  ): Promise<{ actorUserId: string; profileId: string; matchIds: readonly string[] }> {
    const actor = await signUp(
      server,
      `briefing-${detail}-${randomUUID()}@job-search-tierb.test`,
      "Owner"
    );
    const profileId = randomUUID();
    const wants = [90, 70, 50, 30];
    const matchIds: string[] = [];
    await asHeavyRuntime(actor.userId, async (client) => {
      await client.query(
        `INSERT INTO app.job_search_profiles (id, owner_user_id, name, state, briefing_detail)
         VALUES ($1, $2, 'Staff Engineer search', 'active', $3)`,
        [profileId, actor.userId, detail]
      );
      for (const want of wants) {
        const postingId = randomUUID();
        const matchId = randomUUID();
        matchIds.push(matchId);
        await client.query(
          `INSERT INTO app.job_search_postings
             (id, owner_user_id, profile_id, source_id, external_id, title, company, location, url, body)
           VALUES ($1, $2, $3, 'linkedin', $4, $5, 'Acme', 'Remote',
                   'https://www.linkedin.com/jobs/' || $4, 'Job body text')`,
          [postingId, actor.userId, profileId, postingId, `Role Want ${want}`]
        );
        await client.query(
          `INSERT INTO app.job_search_matches (id, owner_user_id, profile_id, posting_id, fit, want, state)
           VALUES ($1, $2, $3, $4, 70, $5, 'new')`,
          [matchId, actor.userId, profileId, postingId, want]
        );
      }
    });
    return { actorUserId: actor.userId, profileId, matchIds };
  }

  it("test 11 (count): a count-detail profile contributes no items, only the headline", async () => {
    const scenario = await seedBriefingScenario("count");
    const invoke = createExternalBriefingInvoker({
      workerDb: heavyWorkerDb,
      discoveryById: new Map([[realModuleId, realDiscovery]]),
      dataContext: new DataContextRunner(heavyWorkerDb),
      cipher: createModuleCredentialSecretCipher(),
      runtime: workerRuntime,
      listActiveUserIds: async () => [scenario.actorUserId]
    });
    const result = await collectExternalBriefingContributions({
      manifests: [realManifest],
      selectedToolNames: [realManifest.briefing!.toolName],
      section: "morning",
      actorUserId: scenario.actorUserId,
      requestId: `req-briefing-count-${scenario.profileId}`,
      invoke
    });
    expect(result).toEqual([
      { moduleId: realModuleId, headline: "4 new job matches in Staff Engineer search.", items: [] }
    ]);
  });

  it("test 11 (top): a top-detail profile contributes its 3 highest-want matches", async () => {
    const scenario = await seedBriefingScenario("top");
    const invoke = createExternalBriefingInvoker({
      workerDb: heavyWorkerDb,
      discoveryById: new Map([[realModuleId, realDiscovery]]),
      dataContext: new DataContextRunner(heavyWorkerDb),
      cipher: createModuleCredentialSecretCipher(),
      runtime: workerRuntime,
      listActiveUserIds: async () => [scenario.actorUserId]
    });
    const result = await collectExternalBriefingContributions({
      manifests: [realManifest],
      selectedToolNames: [realManifest.briefing!.toolName],
      section: "morning",
      actorUserId: scenario.actorUserId,
      requestId: `req-briefing-top-${scenario.profileId}`,
      invoke
    });
    expect(result).toEqual([
      {
        moduleId: realModuleId,
        headline: "4 new job matches in Staff Engineer search.",
        items: [90, 70, 50].map((want) => ({
          id: expect.any(String),
          title: `Role Want ${want} at Acme`,
          detail: `Fit 70 · Want ${want}`,
          href: expect.stringMatching(
            new RegExp(`^/m/job-search/${scenario.profileId}/matches/.+$`)
          )
        }))
      }
    ]);
  });

  it("test 11 (full): a full-detail profile contributes all 4 matches", async () => {
    const scenario = await seedBriefingScenario("full");
    const invoke = createExternalBriefingInvoker({
      workerDb: heavyWorkerDb,
      discoveryById: new Map([[realModuleId, realDiscovery]]),
      dataContext: new DataContextRunner(heavyWorkerDb),
      cipher: createModuleCredentialSecretCipher(),
      runtime: workerRuntime,
      listActiveUserIds: async () => [scenario.actorUserId]
    });
    const result = await collectExternalBriefingContributions({
      manifests: [realManifest],
      selectedToolNames: [realManifest.briefing!.toolName],
      section: "morning",
      actorUserId: scenario.actorUserId,
      requestId: `req-briefing-full-${scenario.profileId}`,
      invoke
    });
    expect(result).toEqual([
      {
        moduleId: realModuleId,
        headline: "4 new job matches in Staff Engineer search.",
        items: [90, 70, 50, 30].map((want) => ({
          id: expect.any(String),
          title: `Role Want ${want} at Acme`,
          detail: `Fit 70 · Want ${want}`,
          href: expect.stringMatching(
            new RegExp(`^/m/job-search/${scenario.profileId}/matches/.+$`)
          )
        }))
      }
    ]);
  });

  it("test 12: no response, at any level, carries a blended score", async () => {
    // The detector must first prove it can actually fail — a walker that always returns []
    // would make every assertion below pass for the wrong reason (the same reads-like-coverage
    // failure named in N41's generalisation). Fixtures here are synthetic, never real API output.
    expect(collectBlendedScoreViolations({ overall: 42 })).toEqual([
      "$.overall is a forbidden key name holding a numeric/percent value: 42"
    ]);
    expect(collectBlendedScoreViolations({ match: 87 })).toEqual([
      "$.match is a forbidden key name holding a numeric/percent value: 87"
    ]);
    expect(collectBlendedScoreViolations({ note: "92% match" })).toEqual([
      '$.note looks like a blended-score string: "92% match"'
    ]);
    // N48: a forbidden key NAME is only a violation when its VALUE is numeric or percent-shaped.
    // `job-search.match.get`'s shipped, unit-tested envelope is `{ matchId, match: MatchDetail |
    // null }` (worker/handlers/matches.ts) — `match` is a wrapper key holding an object, never a
    // blended number. Narrowing on the value lets that envelope through while `match: 87` above
    // still fails, so `match.get` can be invoked by this test (and by #82) without a collision.
    expect(
      collectBlendedScoreViolations({
        matchId: randomUUID(),
        match: { fit: 70, want: 80, fitReason: "x", wantReason: "y" }
      })
    ).toEqual([]);
    expect(
      collectBlendedScoreViolations({ fit: 70, want: 80, fitReason: "x", wantReason: "y" })
    ).toEqual([]);

    // Now walk the real tier-B response shapes this harness already exercises: the manual-run
    // enqueue response (test 7's path), the matches.list and match.get invoke responses through
    // the real gateway (test 9's path — match.get is the one shape carrying fit and want side by
    // side, the single likeliest place a blend would appear), and a briefing contribution
    // round-trip (test 11's path). L9/domain score.ts enforces the no-blend rule in the scoring
    // schema; this is the same rule enforced at the wire boundary, independent of the schema.
    const profileId = randomUUID();
    const postingId = randomUUID();
    const matchId = randomUUID();
    await asHeavyRuntime(adminUserId, async (client) => {
      await client.query(
        `INSERT INTO app.job_search_profiles (id, owner_user_id, name, state)
         VALUES ($1, $2, 'Staff Engineer search', 'active')`,
        [profileId, adminUserId]
      );
      await client.query(
        `INSERT INTO app.job_search_postings
           (id, owner_user_id, profile_id, source_id, external_id, title, company, location, url, body)
         VALUES ($1, $2, $3, 'linkedin', $4, 'Staff Engineer', 'Acme', 'Remote',
                 'https://www.linkedin.com/jobs/3', 'Job body text')`,
        [postingId, adminUserId, profileId, postingId]
      );
      await client.query(
        `INSERT INTO app.job_search_matches (id, owner_user_id, profile_id, posting_id, fit, want, state)
         VALUES ($1, $2, $3, $4, 65, 55, 'new')`,
        [matchId, adminUserId, profileId, postingId]
      );
    });

    const migrationBoss = createPgBossClient(connectionStrings.migration);
    await migrationBoss.start();
    await migrationBoss.createQueue("job-search.crawl-run");
    await migrationBoss.stop({ graceful: false });

    const run = await server.inject({
      method: "POST",
      url: "/api/modules/job-search/queues/job-search.crawl-run/run",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { jobKind: "job-search.crawl-run", params: { profileId } }
    });
    expect(run.statusCode).toBe(202);

    const invoke = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/job-search.matches.list/invoke",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { input: { profileId, limit: 15 } }
    });
    expect(invoke.statusCode).toBe(200);

    // N48: match.get's `{ matchId, match: MatchDetail }` envelope carries fit and want side by
    // side — the shape most likely to grow a blend — so it must be in this walk, not exempted.
    const matchGetInvoke = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/job-search.match.get/invoke",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { input: { matchId } }
    });
    expect(matchGetInvoke.statusCode).toBe(200);

    const briefingScenario = await seedBriefingScenario("full");
    const briefingInvoke = createExternalBriefingInvoker({
      workerDb: heavyWorkerDb,
      discoveryById: new Map([[realModuleId, realDiscovery]]),
      dataContext: new DataContextRunner(heavyWorkerDb),
      cipher: createModuleCredentialSecretCipher(),
      runtime: workerRuntime,
      listActiveUserIds: async () => [briefingScenario.actorUserId]
    });
    const briefing = await collectExternalBriefingContributions({
      manifests: [realManifest],
      selectedToolNames: [realManifest.briefing!.toolName],
      section: "morning",
      actorUserId: briefingScenario.actorUserId,
      requestId: `req-briefing-blend-check-${briefingScenario.profileId}`,
      invoke: briefingInvoke
    });

    const violations = [
      ...collectBlendedScoreViolations(run.json(), "$.manualRunResponse"),
      ...collectBlendedScoreViolations(invoke.json(), "$.matchesListInvokeResponse"),
      ...collectBlendedScoreViolations(matchGetInvoke.json(), "$.matchGetInvokeResponse"),
      ...collectBlendedScoreViolations(briefing, "$.briefingContribution")
    ];
    expect(violations).toEqual([]);
  });
});

const BLENDED_SCORE_KEY = /^(score|overall|match|rank)$/i;
const BLENDED_SCORE_STRING = /\b\d{1,3}%\s*(match|overall|fit and want)\b/i;
const BLENDED_SCORE_VALUE = /^\d{1,3}(?:\.\d+)?%$/;

/**
 * Recursively walks a JSON-shaped value for the blended-score tells plan test 12 names: a key
 * whose name IS one of the forbidden words AND whose value is itself a number or a bare
 * percent-shaped string (ruling N48), and a string VALUE anywhere that reads like a percent-based
 * combined score. Fit and Want are two independent axes, never one number (L9, domain/score.ts)
 * — this is that invariant enforced at the wire boundary, not just in the scoring schema a
 * model's output is validated against.
 *
 * N48 narrows the key check to the VALUE's shape (not just the key's name) so a wrapper key like
 * `match` holding an object — job-search.match.get's shipped `{ matchId, match: MatchDetail }`
 * envelope — passes, while `match: 87` (or `score`/`overall`/`rank` holding a number or "87%")
 * still fails. See the self-tests above this it() block for both directions.
 */
function collectBlendedScoreViolations(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    return BLENDED_SCORE_STRING.test(value)
      ? [`${path} looks like a blended-score string: "${value}"`]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectBlendedScoreViolations(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    const violations: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const isNumericLike =
        typeof child === "number" || (typeof child === "string" && BLENDED_SCORE_VALUE.test(child));
      if (BLENDED_SCORE_KEY.test(key) && isNumericLike) {
        violations.push(
          `${path}.${key} is a forbidden key name holding a numeric/percent value: ${JSON.stringify(child)}`
        );
      }
      violations.push(...collectBlendedScoreViolations(child, `${path}.${key}`));
    }
    return violations;
  }
  return [];
}

async function signUp(
  target: ReturnType<typeof createApiServer>,
  email: string,
  name: string
): Promise<{ cookie: string; userId: string }> {
  const res = await target.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json" },
    payload: { name, email, password: "correct horse battery staple" }
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-up for ${email} failed (${res.statusCode}): ${res.body}`);
  }
  return {
    cookie: cookieHeader(res.headers),
    userId: res.json<{ user: { id: string } }>().user.id
  };
}

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}
