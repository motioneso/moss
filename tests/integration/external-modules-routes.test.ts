import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
          },
          {
            name: "acme-widgets.manual-race",
            handler: "manual",
            allowManualRun: true
          }
        ]
      }
    })
  );

  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
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
    expect(body.modules).toHaveLength(1);
    expect(body.modules[0]).toMatchObject({
      id: "acme-widgets",
      status: "discovered",
      active: false
    });
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

  it("#1547 dedupes two genuinely concurrent manual-run calls that straddle a singleton bucket boundary", async () => {
    const migrationBoss = createPgBossClient(connectionStrings.migration);
    await migrationBoss.start();
    await migrationBoss.createQueue("acme-widgets.manual-race");
    await migrationBoss.stop({ graceful: false });

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const singletonSeconds = 5;
      const { boundaryEpoch, bucketStart } = await waitForBoundaryApproach(
        client,
        singletonSeconds,
        500,
        150
      );

      const first = server.inject({
        method: "POST",
        url: "/api/modules/acme-widgets/queues/acme-widgets.manual-race/run",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        payload: { jobKind: "manual" }
      });
      const crossedEpoch = await waitForDbEpochAtLeast(client, boundaryEpoch, 8000);
      const second = server.inject({
        method: "POST",
        url: "/api/modules/acme-widgets/queues/acme-widgets.manual-race/run",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        payload: { jobKind: "manual" }
      });
      const [firstRes, secondRes] = await Promise.all([first, second]);

      // Self-check: prove the harness actually forced a bucket increment, not luck.
      expect(crossedEpoch).toBeGreaterThanOrEqual(boundaryEpoch);
      expect(Math.floor(crossedEpoch / singletonSeconds)).toBeGreaterThan(
        Math.floor(bucketStart / singletonSeconds)
      );

      expect(firstRes.statusCode).toBe(202);
      expect(firstRes.json()).toEqual({ jobId: expect.any(String) });
      expect(secondRes.statusCode).toBe(202);
      expect(secondRes.json()).toEqual({ jobId: null });

      const rows = await client.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM pgboss.job_common WHERE name = 'acme-widgets.manual-race'`
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
    } finally {
      await client.end();
    }
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

async function readDbEpoch(client: Client): Promise<number> {
  const res = await client.query<{ now_epoch: string }>(
    `SELECT extract(epoch from now())::float8 AS now_epoch`
  );
  return Number(res.rows[0]?.now_epoch);
}

// #1547: forces the two manual-run inserts below onto opposite sides of pg-boss's fixed
// singleton_on epoch bucket by grounding dispatch timing in Postgres's own clock (never
// Date.now(), which would only estimate the boundary and cannot deterministically place it).
async function waitForBoundaryApproach(
  client: Client,
  singletonSeconds: number,
  leadMs: number,
  minMarginMs: number
): Promise<{ boundaryEpoch: number; bucketStart: number }> {
  for (;;) {
    const nowEpoch = await readDbEpoch(client);
    const bucketStart = Math.floor(nowEpoch / singletonSeconds) * singletonSeconds;
    const boundaryEpoch = bucketStart + singletonSeconds;
    const marginMs = (boundaryEpoch - nowEpoch) * 1000;
    if (marginMs <= leadMs && marginMs >= minMarginMs) {
      return { boundaryEpoch, bucketStart };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForDbEpochAtLeast(
  client: Client,
  targetEpoch: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nowEpoch = await readDbEpoch(client);
    if (nowEpoch >= targetEpoch) {
      return nowEpoch;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitForDbEpochAtLeast: db clock never reached ${targetEpoch} within ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
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
