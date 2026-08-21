import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutgoingHttpHeaders } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import { createApiServer } from "../../apps/api/src/server.js";
import { buildWorker, type WorkerHandle } from "../../apps/worker/src/worker.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

// #1752 Task 4: the end-to-end proof that a module dropped onto the modules folder on disk,
// while both the web server and the background worker are ALREADY RUNNING, becomes usable
// after a rescan with neither process restarted. Starts a real worker via `buildWorker` (not
// just its internal pieces, unlike worker-lifecycle.test.ts) alongside a real API server —
// that is the only way to directly prove the running worker's own discovery holder picked up
// the on-disk change, rather than inferring it from a queued message. See
// docs/superpowers/plans/2026-08-20-1752-task4-e2e-proof.md for the seams check behind this.

let root: string;
let modulesDir: string;
let appDb: Kysely<MossDatabase>;
let server: ReturnType<typeof createApiServer>;
let worker: WorkerHandle;
let pollBoss: PgBoss;
let adminCookie: string;
let previousModulesDirEnv: string | undefined;

const FIRST_MODULE_ID = "first-live-module";
const SECOND_MODULE_ID = "second-live-module";
const SECOND_MODULE_QUEUE = `${SECOND_MODULE_ID}.manual`;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  root = mkdtempSync(join(tmpdir(), "extmod-live-rescan-"));
  modulesDir = join(root, "modules");
  writeModuleFixture(FIRST_MODULE_ID, `${FIRST_MODULE_ID}.manual`);

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

  const admin = await signUp(server, "owner@live-rescan.test", "Owner");
  adminCookie = admin.cookie;

  // buildWorker reads its modules directory from JARVIS_MODULES_DIR (no override parameter
  // exists), so point the environment at the same temp folder the API server was given, then
  // restore whatever was there before once the worker is built.
  previousModulesDirEnv = process.env.JARVIS_MODULES_DIR;
  process.env.JARVIS_MODULES_DIR = modulesDir;
  try {
    worker = await buildWorker({ connectionString: connectionStrings.worker });
  } finally {
    if (previousModulesDirEnv === undefined) {
      delete process.env.JARVIS_MODULES_DIR;
    } else {
      process.env.JARVIS_MODULES_DIR = previousModulesDirEnv;
    }
  }

  pollBoss = createPgBossClient(connectionStrings.migration);
  await pollBoss.start();
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([
    worker?.shutdown(),
    pollBoss?.stop({ graceful: false }),
    server?.close(),
    appDb?.destroy()
  ]);
  rmSync(root, { recursive: true, force: true });
});

describe("live rescan picks up a module dropped on disk while both processes are running (#1752)", () => {
  it("is not visible before the rescan, then usable end to end after it — no restart", async () => {
    // Baseline: guards against a false positive from a stale queue left by another run.
    // pg-boss returns null (not undefined) for a queue that doesn't exist.
    expect(await pollBoss.getQueue(SECOND_MODULE_QUEUE)).toBeNull();

    // Drop the second module onto disk while the API server and the worker are already running.
    writeModuleFixture(SECOND_MODULE_ID, SECOND_MODULE_QUEUE);

    const beforeRescan = await server.inject({
      method: "GET",
      url: "/api/admin/external-modules",
      headers: { cookie: adminCookie }
    });
    expect(
      beforeRescan.json().modules.some((module: { id: string }) => module.id === SECOND_MODULE_ID)
    ).toBe(false);

    const rescanRes = await server.inject({
      method: "POST",
      url: "/api/admin/modules/rescan",
      headers: { cookie: adminCookie }
    });
    expect(rescanRes.statusCode).toBe(200);

    const afterRescan = await server.inject({
      method: "GET",
      url: "/api/admin/external-modules",
      headers: { cookie: adminCookie }
    });
    expect(
      afterRescan.json().modules.some((module: { id: string }) => module.id === SECOND_MODULE_ID)
    ).toBe(true);

    const enableRes = await server.inject({
      method: "POST",
      url: `/api/admin/external-modules/${SECOND_MODULE_ID}`,
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { enabled: true }
    });
    expect(enableRes.statusCode).toBe(200);

    // The only way this queue can exist is if the ALREADY-RUNNING worker process's own
    // discovery holder picked up the on-disk module through the rescan control message it
    // received while running, and its reconciler then created the queue. Bounded because
    // pg-boss delivery to the worker is asynchronous.
    await vi.waitFor(
      async () => {
        expect(await pollBoss.getQueue(SECOND_MODULE_QUEUE)).toBeDefined();
      },
      { timeout: 15_000, interval: 200 }
    );
  });
});

function writeModuleFixture(moduleId: string, queueName: string): void {
  const dir = join(modulesDir, moduleId);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "worker.js"), "// fixture worker\n");
  writeFileSync(
    join(dir, "jarvis.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: moduleId,
      name: moduleId,
      version: "0.1.0",
      publisher: "Acme, Inc.",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.1.0" },
      navigation: [{ id: moduleId, label: moduleId, path: "/", icon: "briefcase", order: 3 }],
      runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
      worker: {
        queues: [{ name: queueName, handler: "manual", allowManualRun: true }]
      }
    })
  );
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
