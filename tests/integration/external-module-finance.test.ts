// tests/integration/external-module-finance.test.ts
// FIN-01 (#1146) Task 7: the finance module through the REAL activation and
// invoke paths — build the bundle, install the trust set via the admin
// registration route, invoke finance.accounts.list over
// /api/ai/assistant-tools (the response crosses three lossy layers:
// sanitizeAssistantToolResult projection, 16k degradation, and
// fast-json-stringify's silent field drop — the recurring #859/#885 trap),
// and assert queue/schedule reconciliation registers finance.sync-run /
// finance.connect-poll / finance.sync-sweep.
// Harness cloned from tests/integration/js06-module-surface.test.ts
// (better-auth first-signup bootstraps the admin — do not invent a new auth
// path).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutgoingHttpHeaders } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { setModuleKvValue } from "@moss/settings";
import {
  validateExternalModuleManifest,
  type ExternalModuleDiscovery
} from "@moss/module-registry";
import { ExternalModuleJobReconciler } from "@moss/module-registry/node";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";
import { buildExternalModule } from "../../scripts/build-external-module.js";
import { itemKey, NS } from "../../external-modules/finance/src/domain/index.js";

const sourceDir = fileURLToPath(new URL("../../external-modules/finance", import.meta.url));

let root: string;
let modulesDir: string;
let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let server: ReturnType<typeof createApiServer>;
let adminCookie: string;
let adminUserId: string;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  await buildExternalModule(sourceDir);

  root = mkdtempSync(join(tmpdir(), "fin01-module-"));
  modulesDir = join(root, "modules");
  const installedDir = join(modulesDir, "finance");
  mkdirSync(installedDir, { recursive: true });
  cpSync(join(sourceDir, "jarvis.module.json"), join(installedDir, "jarvis.module.json"));
  cpSync(join(sourceDir, "dist"), join(installedDir, "dist"), { recursive: true });

  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
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

  const admin = await signUp(server, "owner@fin01-module.test", "Owner");
  adminCookie = admin.cookie;
  adminUserId = admin.userId;
  const enable = await server.inject({
    method: "POST",
    url: "/api/admin/external-modules/finance",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { enabled: true }
  });
  expect(enable.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([server?.close(), appDb?.destroy(), workerDb?.destroy()]);
  rmSync(root, { recursive: true, force: true });
});

const invokeTool = (name: string, input: Record<string, unknown> = {}) =>
  server.inject({
    method: "POST",
    url: `/api/ai/assistant-tools/${name}/invoke`,
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { input }
  });

/**
 * Seed the owner's module KV the way production writes it: setModuleKvValue
 * on a worker-role DataContext with app.current_module_id set — the same GUC
 * pair worker-rpc-host.ts establishes, because module_kv RLS keys on both
 * the actor and the module.
 */
async function seedKv(namespace: string, key: string, value: Record<string, unknown>) {
  await new DataContextRunner(workerDb).withDataContext(
    { actorUserId: adminUserId, requestId: `fin01-seed-${key}` },
    async (scopedDb) => {
      await sql`SELECT set_config('app.current_module_id', ${"finance"}, true)`.execute(
        scopedDb.db
      );
      await setModuleKvValue(
        scopedDb,
        { moduleId: "finance", namespace, scope: "user", ownerUserId: adminUserId, key },
        value
      );
    }
  );
}

// Parse the SHIPPED manifest through the real validator so this suite's
// reconciliation assertions cannot drift from what production enforces.
function loadFinanceModule(): ExternalModuleDiscovery {
  const raw = JSON.parse(readFileSync(join(sourceDir, "jarvis.module.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const result = validateExternalModuleManifest(raw, "finance", "0.1.0");
  if (!result.ok) {
    throw new Error(`shipped manifest failed validation: ${JSON.stringify(result.errors)}`);
  }
  return {
    id: "finance",
    dir: sourceDir,
    manifest: result.manifest,
    // assertModuleJobPayload requires a well-formed hash; content is irrelevant here.
    manifestHash: `sha256:${"a".repeat(64)}`,
    packageHash: `sha256:${"b".repeat(64)}`
  };
}

describe("finance module surface (#1146)", () => {
  it("declares the four FIN-01 assistant tools once enabled", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-tools",
      headers: { cookie: adminCookie }
    });
    expect(response.statusCode).toBe(200);
    const names = response
      .json<{ tools: Array<{ moduleId: string; name: string }> }>()
      .tools.filter((tool) => tool.moduleId === "finance")
      .map((tool) => tool.name);
    for (const required of [
      "finance.accounts.list",
      "finance.connect.start",
      "finance.connect.poll",
      "finance.sync.run-now"
    ]) {
      expect(names).toContain(required);
    }
  });

  it("accounts.list succeeds over the invoke route with the connect nextStep when empty", async () => {
    const response = await invokeTool("finance.accounts.list");
    expect(response.statusCode).toBe(200);
    expect(response.json().invocation).toMatchObject({
      status: "succeeded",
      blockedReason: null,
      result: {
        accounts: [],
        nextStep: "connect a bank with finance.connect.start"
      }
    });
  });

  it("accounts.list returns a seeded account with every field intact through the lossy layers", async () => {
    await seedKv(NS.connections, itemKey("item-1"), {
      itemId: "item-1",
      institutionId: "ins_1",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "connected"
    });
    await seedKv(NS.accounts, "acc-1", {
      accountId: "acc-1",
      itemId: "item-1",
      name: "Checking",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: "0000",
      balanceCents: 500000,
      isoCurrency: "USD",
      updatedAt: "2026-07-18T06:00:00Z"
    });

    const response = await invokeTool("finance.accounts.list");
    expect(response.statusCode).toBe(200);
    const invocation = response.json<{
      invocation: { status: string; result: { accounts: unknown[]; banks: unknown[] } };
    }>().invocation;
    expect(invocation.status).toBe("succeeded");
    // toEqual (not matchObject): a field silently dropped by any of the three
    // layers must fail loudly here.
    expect(invocation.result.accounts).toEqual([
      {
        accountId: "acc-1",
        itemId: "item-1",
        name: "Checking",
        mask: "0000",
        type: "depository",
        subtype: "checking",
        balanceCents: 500000,
        isoCurrency: "USD",
        institutionId: "ins_1",
        itemStatus: "connected",
        updatedAt: "2026-07-18T06:00:00Z",
        // FIN-04 (#1149): accounts.list now reports the household-share flag; an
        // unshared account defaults to false (flag key absent in KV).
        sharedToHousehold: false
      }
    ]);
    expect(invocation.result.banks).toEqual([
      {
        itemId: "item-1",
        institutionId: "ins_1",
        institutionName: null,
        status: "connected",
        lastSyncAt: null,
        message: null
      }
    ]);
  });

  it("blocks the connect.start write tool with confirmation_required (D4)", async () => {
    const response = await invokeTool("finance.connect.start", { environment: "sandbox" });
    expect(response.statusCode).toBe(403);
    expect(response.json().invocation).toMatchObject({
      status: "blocked",
      blockedReason: "confirmation_required"
    });
  });
});

describe("finance job reconciliation (#1146)", () => {
  it("registers both queues and the per-user sync-sweep schedule from the shipped manifest", async () => {
    const calls: string[] = [];
    const schedules: Array<{
      name: string;
      cron: string;
      payload: Record<string, unknown>;
      options: Record<string, unknown>;
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
      schedule: async (
        name: string,
        cron: string,
        payload: Record<string, unknown>,
        options: Record<string, unknown>
      ) => {
        schedules.push({ name, cron, payload, options });
      }
    } as unknown as PgBoss;
    const module = loadFinanceModule();
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [adminUserId]
    });

    await reconciler.reconcileAll();

    // Manifest order, create-then-converge per queue (no dead-letter targets
    // declared in FIN-01, so no reordering). storage-migrate (FIN-06b, #1166)
    // is the manifest's last-declared queue, hence last here too.
    expect(calls).toEqual([
      "create:finance.sync-run",
      'update:finance.sync-run:{"retryLimit":3}',
      "create:finance.connect-poll",
      'update:finance.connect-poll:{"retryLimit":5}',
      "create:finance.categorize-apply",
      'update:finance.categorize-apply:{"retryLimit":1}',
      "create:finance.budget-apply",
      'update:finance.budget-apply:{"retryLimit":1}',
      "create:finance.share-apply",
      'update:finance.share-apply:{"retryLimit":1}',
      "create:finance.storage-migrate",
      'update:finance.storage-migrate:{"retryLimit":1}'
    ]);
    // One schedule per active user; payload is metadata-only (D6) and the
    // key is the reconciler's module/schedule/user triple ("/"-separated —
    // pg-boss v12's assertKey rejects ":", see job-reconciler.ts / #1147).
    expect(schedules).toEqual([
      {
        name: "finance.sync-run",
        cron: "41 */6 * * *",
        payload: {
          actorUserId: adminUserId,
          moduleId: "finance",
          jobKind: "finance.sync-sweep",
          manifestHash: module.manifestHash
        },
        options: { tz: "UTC", key: `finance/finance.sync-sweep/${adminUserId}` }
      }
    ]);
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
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}
