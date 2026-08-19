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

// #1547: dedicated file per the spec's "Exclusive owned surface" — the boundary-forcing
// harness below (DB-epoch reads, a controlled wait to a real singleton_on bucket edge) is
// heavy enough to deserve its own describe rather than being folded into
// job-search-worker-surface.test.ts's existing worker-RPC surface. Mirrors
// external-modules-routes.test.ts's synthetic fixture-module bootstrap pattern, but does not
// touch that file — the spec explicitly forbids widening it for this issue.

let root: string;
let appDb: Kysely<MossDatabase>;
let server: ReturnType<typeof createApiServer>;
let adminCookie: string;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  root = mkdtempSync(join(tmpdir(), "manual-run-race-"));
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
            name: "acme-widgets.manual-race",
            handler: "manual",
            allowManualRun: true
          }
        ]
      }
    })
  );

  // Two connections: the fix holds one open inside a transaction across the awaited
  // boss.send() call (packages/jobs/src/module-jobs.ts's locked path), so a genuinely
  // concurrent second request needs its own connection to even attempt entry.
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

  const admin = await signUp(server, "owner@manual-run-race.test", "Owner");
  adminCookie = admin.cookie;

  const enableRes = await server.inject({
    method: "POST",
    url: "/api/admin/external-modules/acme-widgets",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { enabled: true }
  });
  expect(enableRes.statusCode).toBe(200);

  const migrationBoss = createPgBossClient(connectionStrings.migration);
  await migrationBoss.start();
  await migrationBoss.createQueue("acme-widgets.manual-race");
  await migrationBoss.stop({ graceful: false });
});

afterAll(async () => {
  await Promise.allSettled([server?.close(), appDb?.destroy()]);
  rmSync(root, { recursive: true, force: true });
});

describe("manual-run job idempotency race (#1547)", () => {
  it("dedupes two genuinely concurrent manual-run calls that straddle a singleton bucket boundary", async () => {
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
});

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
