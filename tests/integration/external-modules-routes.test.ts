import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutgoingHttpHeaders } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { Client } from "pg";

import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

// #917 Task 9: exercise the admin external-modules read/reconcile surface end-to-end
// via app.inject. Boots the REAL server with the feature flag ON pointed at a temp
// modules dir holding one valid metadata-only module, then drives GET/POST as an admin.
// createApiServer returns the Fastify instance directly (not { server }); auth uses the
// better-auth sign-up cookie pattern (first sign-up bootstraps the instance owner/admin),
// mirroring tests/integration/chat-multiplexer-admin.test.ts — do not invent a new path.

let root: string;
let appDb: Kysely<MossDatabase>;
let server: ReturnType<typeof createApiServer>;
let adminCookie: string;
let adminUserId: string;
let memberCookie: string;
let memberUserId: string;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  root = mkdtempSync(join(tmpdir(), "extmod-routes-"));
  const modulesDir = join(root, "modules");
  const dir = join(modulesDir, "acme-widgets");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "worker.js"), "// fixture worker\n");
  writeFileSync(
    join(dir, "jarvis.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "acme-widgets",
      name: "Acme Widgets",
      version: "0.1.0",
      publisher: "Acme, Inc.",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.1.0" },
      navigation: [
        { id: "acme-widgets", label: "Widgets", path: "/", icon: "briefcase", order: 3 }
      ],
      runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
      worker: {
        queues: [
          {
            name: "acme-widgets.manual",
            handler: "manual",
            allowManualRun: true
          }
        ]
      }
    })
  );

  // #1753 Task 10: a second on-disk discovery, kept row-less ('discovered') until a given
  // test inserts a draft row for it directly — the ship route needs a real discovery to
  // capture manifestHash/packageHash from, exactly like the enable route above.
  const draftDir = join(modulesDir, "acme-widgets-draft");
  mkdirSync(join(draftDir, "dist"), { recursive: true });
  writeFileSync(join(draftDir, "dist", "worker.js"), "// fixture worker\n");
  writeFileSync(
    join(draftDir, "jarvis.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "acme-widgets-draft",
      name: "Acme Widgets (draft)",
      version: "0.1.0",
      publisher: "Acme, Inc.",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.1.0" }
    })
  );

  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
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

  // First sign-up bootstraps the instance owner (admin); the second is a plain member.
  const admin = await signUp(server, "owner@extmod.test", "Owner");
  adminCookie = admin.cookie;
  adminUserId = admin.userId;
  const member = await signUp(server, "member@extmod.test", "Member");
  memberCookie = member.cookie;
  memberUserId = member.userId;
});

afterAll(async () => {
  await Promise.allSettled([server?.close(), appDb?.destroy()]);
  rmSync(root, { recursive: true, force: true });
});

describe("external-module admin routes (#917)", () => {
  it("lists the discovered module as 'discovered' + inactive before enable", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/external-modules",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.modules).toHaveLength(2);
    expect(body.modules).toContainEqual(
      expect.objectContaining({
        id: "acme-widgets",
        status: "discovered",
        active: false
      })
    );
  });

  it("enables the module, then /api/modules includes it with external:true", async () => {
    const enableRes = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { enabled: true }
    });
    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json().module).toMatchObject({ status: "enabled", active: true });

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const controls = await client.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job_common WHERE name = 'platform.module-control' ORDER BY created_on DESC LIMIT 1`
    );
    await client.end();
    expect(controls.rows[0]?.data).toEqual({ moduleId: "acme-widgets", action: "reconcile" });

    const modulesRes = await server.inject({
      method: "GET",
      url: "/api/modules",
      headers: { cookie: adminCookie }
    });
    const listed = modulesRes.json().modules.find((m: { id: string }) => m.id === "acme-widgets");
    expect(listed).toMatchObject({
      id: "acme-widgets",
      external: true,
      navigation: [
        {
          id: "acme-widgets",
          label: "Widgets",
          path: "/m/acme-widgets",
          icon: "briefcase",
          order: 3
        }
      ]
    });

    const migrationBoss = createPgBossClient(connectionStrings.migration);
    await migrationBoss.start();
    await migrationBoss.createQueue("acme-widgets.manual");
    await migrationBoss.stop({ graceful: false });

    const run = await server.inject({
      method: "POST",
      url: "/api/modules/acme-widgets/queues/acme-widgets.manual/run",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { jobKind: "manual" }
    });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ jobId: expect.any(String) });
    const duplicateRun = await server.inject({
      method: "POST",
      url: "/api/modules/acme-widgets/queues/acme-widgets.manual/run",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { jobKind: "manual" }
    });
    expect(duplicateRun.statusCode).toBe(202);
    expect(duplicateRun.json()).toEqual({ jobId: null });
    const payloadClient = new Client({ connectionString: connectionStrings.bootstrap });
    await payloadClient.connect();
    const payload = await payloadClient.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job_common WHERE name = 'acme-widgets.manual' ORDER BY created_on DESC LIMIT 1`
    );
    await payloadClient.end();
    expect(payload.rows[0]?.data).toEqual({
      actorUserId: adminUserId,
      moduleId: "acme-widgets",
      jobKind: "manual",
      manifestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
  });

  it("returns 404 for POST to an unknown external module id", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/ghost",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { enabled: true }
    });
    expect(res.statusCode).toBe(404);
  });

  it("hides a globally enabled external module from a user deny-listed for it", async () => {
    const approve = await server.inject({
      method: "POST",
      url: `/api/admin/users/${memberUserId}/approve`,
      headers: { cookie: adminCookie }
    });
    expect(approve.statusCode).toBe(200);
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `INSERT INTO app.module_enablement (scope, module_id, user_id) VALUES ('user', 'acme-widgets', $1)`,
      [memberUserId]
    );
    await client.end();

    const res = await server.inject({
      method: "GET",
      url: "/api/modules",
      headers: { cookie: memberCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().modules.some((module: { id: string }) => module.id === "acme-widgets")).toBe(
      false
    );
    const run = await server.inject({
      method: "POST",
      url: "/api/modules/acme-widgets/queues/acme-widgets.manual/run",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { jobKind: "manual" }
    });
    expect(run.statusCode).toBe(404);
  });

  it("denies a non-admin GET with 403 (admin-gated surface)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/external-modules",
      headers: { cookie: memberCookie }
    });
    expect(res.statusCode).toBe(403);
  });

  // #1753 Task 10: shipping ends a draft's author-only exemption. All four cases share one
  // inserted draft row, owned by the admin — a fresh row per test keeps them independent.
  it("ships the admin's own draft: flips it to enabled, clears the owner", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, owner_user_id, created_at, updated_at)
       VALUES ('acme-widgets-draft', 'draft', 'sha256:stale', 'sha256:stale', $1, now(), now())`,
      [adminUserId]
    );
    await client.end();

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/modules/acme-widgets-draft/ship",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ shipped: true, restartRequired: true });

    const verifyClient = new Client({ connectionString: connectionStrings.bootstrap });
    await verifyClient.connect();
    const row = await verifyClient.query<{
      status: string;
      owner_user_id: string | null;
      manifest_hash: string;
    }>(
      `SELECT status, owner_user_id, manifest_hash FROM app.external_modules WHERE id = 'acme-widgets-draft'`
    );
    await verifyClient.end();
    expect(row.rows[0]).toMatchObject({ status: "enabled", owner_user_id: null });
    expect(row.rows[0]?.manifest_hash).not.toBe("sha256:stale");
  });

  it("returns 404 shipping another user's draft (ownership, not existence)", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, owner_user_id, created_at, updated_at)
       VALUES ('acme-widgets-draft', 'draft', 'sha256:stale', 'sha256:stale', $1, now(), now())
       ON CONFLICT (id) DO UPDATE SET status = 'draft', owner_user_id = $1`,
      [memberUserId]
    );
    await client.end();

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/modules/acme-widgets-draft/ship",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(404);
  });

  it("denies a non-admin ship attempt with 403", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/modules/acme-widgets-draft/ship",
      headers: { cookie: memberCookie }
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 shipping an unknown module id", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/modules/ghost/ship",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(404);
  });
});

// #1808 QA follow-up: the personal Modules pane (GET/PATCH /api/me/modules) reads through a
// second resolver (createInstalledExternalModulesResolverForApi) that the original #1753 fix
// missed. Before this, any logged-in user's own module list showed the name and version of
// every other user's in-progress draft, and the same PATCH route would toggle one on or off.
describe("the personal Modules pane hides a draft from everyone but its owner (#1753)", () => {
  it("does not list another user's draft, and 404s trying to toggle it", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, owner_user_id, created_at, updated_at)
       VALUES ('acme-widgets-draft', 'draft', 'sha256:stale', 'sha256:stale', $1, now(), now())
       ON CONFLICT (id) DO UPDATE SET status = 'draft', owner_user_id = $1`,
      [memberUserId]
    );
    await client.end();

    const list = await server.inject({
      method: "GET",
      url: "/api/me/modules",
      headers: { cookie: adminCookie }
    });
    expect(list.statusCode).toBe(200);
    const modules = (list.json() as { modules: { id: string }[] }).modules;
    expect(modules.map((module) => module.id)).not.toContain("acme-widgets-draft");

    const patch = await server.inject({
      method: "PATCH",
      url: "/api/me/modules/acme-widgets-draft",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { disabled: true }
    });
    expect(patch.statusCode).toBe(404);
  });

  it("lists the owner's own draft and lets them toggle it", async () => {
    const list = await server.inject({
      method: "GET",
      url: "/api/me/modules",
      headers: { cookie: memberCookie }
    });
    expect(list.statusCode).toBe(200);
    const modules = (list.json() as { modules: { id: string }[] }).modules;
    expect(modules.map((module) => module.id)).toContain("acme-widgets-draft");

    const patch = await server.inject({
      method: "PATCH",
      url: "/api/me/modules/acme-widgets-draft",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { disabled: true }
    });
    expect(patch.statusCode).toBe(200);
  });
});

// #1890: throwing a draft away. The route must delete the row, the installed module folder and
// the build's source folder — and must refuse for anything that is not the caller's own draft.
// A dedicated module id and its own folders keep this block independent of the fixtures above.
describe("throwing a draft away (#1890)", () => {
  const buildsDir = () => join(root, "module-builds");

  async function insertDraft(ownerUserId: string, status: "draft" | "enabled") {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, owner_user_id, created_at, updated_at)
       VALUES ('throwaway-draft', $2, 'sha256:stale', 'sha256:stale', $1, now(), now())
       ON CONFLICT (id) DO UPDATE SET status = $2, owner_user_id = $1`,
      [status === "enabled" ? null : ownerUserId, status]
    );
    await client.end();
  }

  async function draftRowCount(): Promise<number> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const rows = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.external_modules WHERE id = 'throwaway-draft'`
    );
    await client.end();
    return Number(rows.rows[0]?.count ?? "0");
  }

  it("deletes the owner's own draft: row, installed folder and build folder all go", async () => {
    process.env.JARVIS_MODULE_BUILDS_DIR = buildsDir();
    await insertDraft(adminUserId, "draft");

    const buildId = randomUUID();
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `INSERT INTO app.module_builds (id, owner_user_id, status, module_id, created_at, updated_at)
       VALUES ($1, $2, 'ready', 'throwaway-draft', now(), now())`,
      [buildId, adminUserId]
    );
    await client.end();

    const installedDir = join(root, "modules", "throwaway-draft");
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(installedDir, "jarvis.module.json"), "{}");
    const buildSourceDir = join(buildsDir(), buildId);
    mkdirSync(buildSourceDir, { recursive: true });
    writeFileSync(join(buildSourceDir, "index.ts"), "// build source\n");

    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/throwaway-draft/draft",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });

    expect(await draftRowCount()).toBe(0);
    expect(existsSync(installedDir)).toBe(false);
    expect(existsSync(buildSourceDir)).toBe(false);
  });

  it("returns 404 for another user's draft, and leaves that draft alone", async () => {
    await insertDraft(memberUserId, "draft");

    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/throwaway-draft/draft",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(404);
    expect(await draftRowCount()).toBe(1);
  });

  it("returns 404 for a shipped module, and leaves it installed", async () => {
    await insertDraft(adminUserId, "enabled");

    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/throwaway-draft/draft",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(404);
    expect(await draftRowCount()).toBe(1);
  });

  it("denies a non-admin with 403", async () => {
    await insertDraft(memberUserId, "draft");

    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/throwaway-draft/draft",
      headers: { cookie: memberCookie }
    });
    expect(res.statusCode).toBe(403);
    expect(await draftRowCount()).toBe(1);
  });

  it("returns 404 for an unknown module id", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/ghost/draft",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(404);
  });
});

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
