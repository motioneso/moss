// #3722: ctx.jobs.enqueue through the production construction sites.
//
// A real module child process calls the host's jobs.enqueue over the real RPC handler, on a real
// pg-boss. The API side is createExternalModuleTools with the real active-module resolver. The
// worker side is createExternalModuleJobHandler with the factory worker.ts uses. Only the module
// bundle is a fixture. Run only through scripts/run-gate.sh.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import type { PgBoss, Job } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, migratePgBoss, type ExternalModuleJobPayload } from "@moss/jobs";
import {
  hashCanonicalManifest,
  ExternalModuleWorkerRuntime,
  validateExternalModuleManifest
} from "@moss/module-registry/node";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { SettingsRepository } from "@moss/settings";
import type { Kysely } from "kysely";

import {
  createActiveExternalModulesResolverForApi,
  createExternalModuleTools,
  isExternalModuleActiveFor
} from "../../apps/api/src/external-module-tools.js";
import { createWorkerEnqueuePortFactory } from "../../apps/worker/src/external-module-enqueue.js";
import { createExternalModuleJobHandler } from "../../apps/worker/src/external-module-job-handler.js";
import { createIsModuleEnabled } from "../../apps/worker/src/worker-module-gate.js";
import {
  connectionStrings,
  ids,
  laneScopedModuleId,
  resetFoundationDatabase
} from "./test-database.js";

const { Client } = pg;

const MOD = laneScopedModuleId("enq4");
const RUN = `${MOD}.run`;
const STEP = `${MOD}.step`;
const PLAIN = `${MOD}.plain`;
const PACKAGE_HASH = `sha256:${"b".repeat(64)}`;
const KEY = "plan:secret-marker-3722:day:3";
const PLAN = "11111111-1111-4111-8111-111111111111";
const STEP_SCHEMA = {
  type: "object",
  fields: { planId: { type: "uuid" }, day: { type: "integer", min: 0, max: 31 } }
} as const;

// The module child. It performs the host calls listed in its script, records what came back, and
// can pause mid-run so a test changes host state between the parent's start and its enqueue.
const WORKER_JS = `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const pending = new Map();
let n = 0;
let buffer = "";
const call = (method, params) => new Promise((resolve) => {
  const id = "w" + (++n);
  pending.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(m) {
  const { handler, input } = m.params;
  const script = input.calls
    ? { calls: input.calls }
    : JSON.parse(readFileSync(join(dir, "script.json"), "utf8"));
  if (script.waitForGo) {
    writeFileSync(join(dir, "ready"), "1");
    for (let i = 0; i < 750 && !existsSync(join(dir, "go")); i++) await sleep(20);
  }
  const outcomes = [];
  for (const c of script.calls ?? []) {
    const r = await call(c.method, c.params);
    outcomes.push(r.error ? { error: r.error.message } : { result: r.result });
  }
  writeFileSync(join(dir, "outcomes.json"), JSON.stringify(outcomes));
  if (script.throwAfter) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "boom" } });
    return;
  }
  const result = handler === "candidates" ? [{ id: input.actorUserId, label: "x" }] : { ok: true };
  send({ jsonrpc: "2.0", id: m.id, result });
}
send({ jsonrpc: "2.0", method: "worker.ready", params: { version: 1 } });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "module.invoke") void run(m);
    else if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
`;

function rawManifest() {
  return {
    schemaVersion: 1,
    id: MOD,
    name: "Enqueue Four",
    version: "0.1.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    worker: {
      queues: [
        { name: RUN, handler: "main" },
        { name: STEP, handler: "step", allowModuleEnqueue: true, paramsSchema: STEP_SCHEMA },
        { name: PLAIN, handler: "plain", paramsSchema: STEP_SCHEMA }
      ]
    },
    assistantTools: [
      {
        name: `${MOD}.do`,
        permissionId: `${MOD}.do`,
        description: "Run the scripted host calls.",
        risk: "write",
        inputSchema: { type: "object", properties: { calls: { type: "array" } } },
        outputSchema: { type: "object", properties: {} },
        handler: "tool.run"
      },
      {
        name: `${MOD}.peek`,
        permissionId: `${MOD}.peek`,
        description: "Read-risk tool that tries to enqueue.",
        risk: "read",
        inputSchema: { type: "object", properties: { device: { type: "string" } } },
        outputSchema: { type: "object", properties: {} },
        handler: "tool.peek",
        classifier: {
          description: "Peek at a device",
          arguments: { device: { kind: "candidates" } },
          candidatesHandler: "candidates",
          replyTemplate: "Peeked."
        }
      }
    ]
  };
}

const enqueueCall = (
  key: string,
  overrides: { queue?: string; params?: unknown; extra?: Record<string, unknown> } = {}
) => ({
  method: "jobs.enqueue",
  params: {
    queue: overrides.queue ?? STEP,
    jobKind: "next",
    idempotencyKey: key,
    params: overrides.params ?? { planId: PLAN, day: 2 },
    ...overrides.extra
  }
});

let dir: string;
let bootstrap: pg.Client;
let workerDb: Kysely<MossDatabase>;
let appDb: Kysely<MossDatabase>;
let boss: PgBoss;
let discovery: ExternalModuleDiscovery;
const warns: Array<Record<string, unknown>> = [];
const logger = { warn: (data: Record<string, unknown>) => void warns.push(data) };
let workerRuntime: ExternalModuleWorkerRuntime;
let apiTools: ReturnType<typeof createExternalModuleTools>;

const actorOf = (userId: string) => ({ actorUserId: userId, requestId: `req-${userId}` });

async function setScript(script: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "script.json"), JSON.stringify(script));
}

async function outcomes(): Promise<Array<{ result?: unknown; error?: string }>> {
  return JSON.parse(await readFile(join(dir, "outcomes.json"), "utf8"));
}

async function stepRows(): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const result = await bootstrap.query(
    `SELECT id, data FROM pgboss.job WHERE name = $1 ORDER BY created_on`,
    [STEP]
  );
  return result.rows;
}

function buildWorkerHandler(
  module: ExternalModuleDiscovery,
  queue: { name: string; handler: string }
) {
  const getDiscoveryById = (id: string) => (id === module.id ? module : undefined);
  return createExternalModuleJobHandler({
    module,
    queue,
    runtime: workerRuntime,
    workerDb,
    dataContext: new DataContextRunner(workerDb),
    getDiscoveryById,
    listDiscoveredModuleIds: () => [module.id],
    listActiveUserIds: activeUsers,
    logger,
    createEnqueuePort: createWorkerEnqueuePortFactory({
      boss,
      rootDb: workerDb,
      isModuleEnabled: createIsModuleEnabled({ db: workerDb, getDiscoveryById }),
      listActiveUserIds: activeUsers
    })
  });
}

async function activeUsers(moduleId: string): Promise<readonly string[]> {
  const result = await bootstrap.query(
    `SELECT user_id FROM app.list_active_external_module_users($1)`,
    [moduleId]
  );
  return result.rows.map((row) => row.user_id as string);
}

const parentPayload = (actor: string, module = discovery): ExternalModuleJobPayload => ({
  actorUserId: actor,
  moduleId: MOD,
  jobKind: "run",
  manifestHash: module.manifestHash
});

const jobOf = (data: unknown, id = "parent-1"): Job<ExternalModuleJobPayload> =>
  ({ id, name: RUN, data }) as Job<ExternalModuleJobPayload>;

async function runParent(actor: string, jobId = "parent-1"): Promise<void> {
  const handler = buildWorkerHandler(discovery, rawQueue(RUN));
  await handler(jobOf(parentPayload(actor), jobId));
}

function rawQueue(name: string) {
  const queue = discovery.manifest.worker!.queues!.find((item) => item.name === name)!;
  return queue;
}

function tool(name: string) {
  const found = apiTools.getManifests()[0]!.assistantTools!.find((item) => item.name === name)!;
  return found;
}

async function runTool(name: string, actor: string, calls?: unknown[]): Promise<void> {
  await tool(name).execute!(
    null as never,
    (calls ? { calls } : {}) as never,
    {
      ...actorOf(actor),
      chatSessionId: "chat-1"
    } as never
  );
}

/** Starts a paused run, applies `mutate` while the module waits, then lets it continue. */
async function withMidRunChange(
  start: () => Promise<void>,
  mutate: () => Promise<void>
): Promise<void> {
  const running = start().catch(() => undefined);
  for (let i = 0; i < 500 && !existsSync(join(dir, "ready")); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(existsSync(join(dir, "ready"))).toBe(true);
  await mutate();
  await writeFile(join(dir, "go"), "1");
  await running;
}

beforeAll(async () => {
  await resetFoundationDatabase();
  await migratePgBoss(connectionStrings.migration, [
    { name: RUN, options: { retryLimit: 1, retryDelay: 0 } },
    { name: STEP },
    { name: PLAIN }
  ]);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  boss = createPgBossClient(connectionStrings.worker, { connectionTimeoutMillis: 25_000 });
  await boss.start();

  dir = await mkdtemp(join(tmpdir(), "enq4-"));
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "worker.js"), WORKER_JS);
  await writeFile(join(dir, "dist", "package.json"), JSON.stringify({ type: "module" }));
  const validated = validateExternalModuleManifest(rawManifest(), MOD, "0.1.0");
  if (!validated.ok) throw new Error(validated.errors.join(", "));
  discovery = {
    id: MOD,
    dir,
    manifest: validated.manifest,
    manifestHash: hashCanonicalManifest(validated.manifest),
    packageHash: PACKAGE_HASH
  };

  workerRuntime = new ExternalModuleWorkerRuntime({ logger });
  const appDataContext = new DataContextRunner(appDb);
  const settingsRepository = new SettingsRepository();
  apiTools = createExternalModuleTools({
    discoveries: () => [discovery],
    workerDataContext: new DataContextRunner(workerDb),
    appDataContext,
    settingsRepository,
    boss,
    rootDb: appDb,
    isModuleActive: isExternalModuleActiveFor(
      createActiveExternalModulesResolverForApi({
        appDataContext,
        settingsRepository,
        discoveries: () => [discovery]
      })
    ),
    logger
  });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([
    workerRuntime?.close(),
    apiTools?.runtime?.close(),
    boss?.stop({ graceful: false }),
    workerDb?.destroy(),
    appDb?.destroy(),
    bootstrap?.end(),
    dir ? rm(dir, { recursive: true, force: true }) : undefined
  ]);
}, 60_000);

beforeEach(async () => {
  warns.length = 0;
  await bootstrap.query(`DELETE FROM pgboss.job WHERE starts_with(name, $1)`, [`${MOD}.`]);
  await bootstrap.query(`DELETE FROM app.module_enablement WHERE module_id = $1`, [MOD]);
  await bootstrap.query(`DELETE FROM app.external_modules WHERE id = $1`, [MOD]);
  await bootstrap.query(
    `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, enabled_at, enabled_by)
     VALUES ($1, 'enabled', $2, $3, now(), $4)`,
    [MOD, discovery.manifestHash, PACKAGE_HASH, ids.adminUser]
  );
  await Promise.all(
    ["ready", "go", "outcomes.json", "script.json"].map((name) =>
      rm(join(dir, name), { force: true })
    )
  );
});

describe("ctx.jobs.enqueue on the production construction sites (#3722)", () => {
  it("1. a job handler enqueues the next step with the parent's actor", async () => {
    await setScript({ calls: [enqueueCall("k1")] });
    await runParent(ids.userA);
    expect((await outcomes())[0]).toEqual({ result: { status: "enqueued" } });
    const rows = await stepRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.actorUserId).toBe(ids.userA);
  });

  it("2. a tool call enqueues with the tool caller's id", async () => {
    await runTool(`${MOD}.do`, ids.userB, [enqueueCall("k2")]);
    expect((await outcomes())[0]).toEqual({ result: { status: "enqueued" } });
    const rows = await stepRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.actorUserId).toBe(ids.userB);
  });

  it("3. an extra actorUserId in the RPC params is refused and nothing is inserted", async () => {
    const call = enqueueCall("k3", { extra: { actorUserId: ids.userB } });
    await setScript({ calls: [call] });
    await runParent(ids.userA);
    expect((await outcomes())[0]).toEqual({ error: "rpc_failed" });
    await runTool(`${MOD}.do`, ids.userA, [call]);
    expect((await outcomes())[0]).toEqual({ error: "rpc_failed" });
    expect(await stepRows()).toHaveLength(0);
  });

  it("4. another module's queue, an undeclared queue and a non-opted-in queue are refused", async () => {
    const calls = [
      enqueueCall("k4a", { queue: "someone-else.step" }),
      enqueueCall("k4b", { queue: `${MOD}.nope` }),
      enqueueCall("k4c", { queue: PLAIN })
    ];
    await setScript({ calls });
    await runParent(ids.userA);
    expect(await outcomes()).toEqual(calls.map(() => ({ error: "rpc_failed" })));
    expect(warns.filter((entry) => entry.reason === "undeclared_queue")).toHaveLength(3);
    const rows = await bootstrap.query(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE starts_with(name, $1) AND name <> $2`,
      [`${MOD}.`, RUN]
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("5. params that fail the schema are refused and nothing is inserted", async () => {
    await setScript({ calls: [enqueueCall("k5", { params: { planId: "nope", day: 2 } })] });
    await runParent(ids.userA);
    expect((await outcomes())[0]).toEqual({ error: "rpc_failed" });
    expect(warns.some((entry) => entry.reason === "invalid_job_params")).toBe(true);
    expect(await stepRows()).toHaveLength(0);
  });

  it("6. a parent that enqueues then throws is retried and yields exactly one child", async () => {
    await setScript({ calls: [enqueueCall("k6")], throwAfter: true });
    await boss.send(RUN, parentPayload(ids.userA));
    const handler = buildWorkerHandler(discovery, rawQueue(RUN));

    const [first] = await boss.fetch<ExternalModuleJobPayload>(RUN);
    await expect(handler(first!)).rejects.toThrow();
    await boss.fail(RUN, first!.id);
    expect((await outcomes())[0]).toEqual({ result: { status: "enqueued" } });

    await setScript({ calls: [enqueueCall("k6")] });
    const [second] = await boss.fetch<ExternalModuleJobPayload>(RUN);
    expect(second?.id).toBe(first!.id);
    await handler(second!);
    expect((await outcomes())[0]).toEqual({ result: { status: "duplicate" } });
    expect(await stepRows()).toHaveLength(1);
  });

  it("14. a read-risk tool and a candidate hook are refused", async () => {
    const call = enqueueCall("k14");
    await runTool(`${MOD}.peek`, ids.userA, [call]);
    expect((await outcomes())[0]).toEqual({ error: "rpc_failed" });
    expect(warns.some((entry) => entry.reason === "forbidden_enqueue_mutation")).toBe(true);

    warns.length = 0;
    await setScript({ calls: [call] });
    const provider = apiTools
      .getManifests()[0]!
      .assistantTools!.find((item) => item.name === `${MOD}.peek`)!.classifier!.candidates!;
    await provider(null as never, actorOf(ids.userA) as never, {
      signal: new AbortController().signal
    });
    expect((await outcomes())[0]).toEqual({ error: "rpc_failed" });
    expect(warns.some((entry) => entry.reason === "forbidden_enqueue_mutation")).toBe(true);
    expect(await stepRows()).toHaveLength(0);
  });

  describe.each([
    {
      change: "a disabled module",
      mutate: () =>
        bootstrap.query(`UPDATE app.external_modules SET status = 'disabled' WHERE id = $1`, [MOD])
    },
    {
      change: "an actor without access",
      mutate: () =>
        bootstrap.query(
          `INSERT INTO app.module_enablement (scope, module_id, user_id) VALUES ('user', $1, $2)`,
          [MOD, ids.userA]
        )
    }
  ])("15. $change", ({ mutate }) => {
    it.each(["worker", "api"] as const)("gives module_inactive on the %s root", async (root) => {
      await setScript({ calls: [enqueueCall("k15")], waitForGo: true });
      await withMidRunChange(
        () => (root === "worker" ? runParent(ids.userA) : runTool(`${MOD}.do`, ids.userA)),
        async () => void (await mutate())
      );
      expect((await outcomes())[0]).toEqual({ error: "rpc_failed" });
      expect(warns.some((entry) => entry.reason === "module_inactive")).toBe(true);
      expect(await stepRows()).toHaveLength(0);
    });
  });

  it("16. a pending child runs after a compatible upgrade and fails on a broken schema", async () => {
    await setScript({ calls: [enqueueCall("k16a"), enqueueCall("k16b")] });
    await runParent(ids.userA);
    expect(await stepRows()).toHaveLength(2);

    const upgraded: ExternalModuleDiscovery = {
      ...discovery,
      manifestHash: `sha256:${"c".repeat(64)}`
    };
    await bootstrap.query(`UPDATE app.external_modules SET manifest_hash = $2 WHERE id = $1`, [
      MOD,
      upgraded.manifestHash
    ]);
    await setScript({ calls: [] });
    const [childA, childB] = await boss.fetch<ExternalModuleJobPayload>(STEP, { batchSize: 2 });

    await buildWorkerHandler(upgraded, rawQueue(STEP))(childA!);
    expect(await outcomes()).toEqual([]);

    const broken = {
      ...rawQueue(STEP),
      paramsSchema: { type: "object", fields: { day: { type: "boolean" } } }
    };
    await expect(buildWorkerHandler(upgraded, broken as never)(childB!)).rejects.toThrow(
      /paramsSchema/
    );
  });

  it("17. the row holds only envelope keys and never the key text", async () => {
    await setScript({ calls: [enqueueCall(KEY)] });
    await runParent(ids.userA);
    const result = await bootstrap.query(
      `SELECT to_jsonb(j) AS row FROM pgboss.job j WHERE name = $1`,
      [STEP]
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0].row as { data: Record<string, unknown> };
    expect(Object.keys(row.data).sort()).toEqual([
      "actorUserId",
      "jobKind",
      "manifestHash",
      "moduleId",
      "params"
    ]);
    expect(JSON.stringify(row)).not.toContain("secret-marker-3722");
  });
});
