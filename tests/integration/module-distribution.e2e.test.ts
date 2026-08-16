// #964: end-to-end module distribution — download from a real (local) registry via
// the admin route, accept + install via boot reconcile, then remove + purge.
// Mirrors tests/integration/external-modules-routes.test.ts (fixture module, real
// server, signUp cookie auth) and adds a node:http mock registry: index.json + a
// tarball produced by the SAME packer the publish workflow uses (Task 4), so the
// hash/format contract is tested against the real artifact shape, not a hand-rolled one.
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { OutgoingHttpHeaders } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { Client } from "pg";

import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { getExternalModuleRegistrations } from "@moss/module-registry/node";

import { createApiServer } from "../../apps/api/src/server.js";
import { packModuleArtifact } from "../../scripts/publish-module-registry.js";
import { reconcileModules } from "../../scripts/module-reconcile.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

let root: string;
let modulesDir: string;
let registry: Server;
let registryUrl: string;
let latestVersion: "0.2.0" | "0.3.0" = "0.2.0";
let refs: Record<"0.2.0" | "0.3.0", { artifact: string; sha256: string; sizeBytes: number }>;
let appDb: Kysely<MossDatabase>;
let boss: PgBoss;
let server: ReturnType<typeof createApiServer>;
let adminCookie: string;
let memberCookie: string;

const MANIFEST = {
  schemaVersion: 1,
  id: "acme-widgets",
  name: "Acme Widgets",
  version: "0.2.0",
  publisher: "Acme, Inc.",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.1.0" },
  runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
  worker: { queues: [{ name: "acme-widgets.manual", handler: "manual", allowManualRun: true }] },
  database: { ownedTables: ["app.acme_widgets_items"] }
};

function buildServer(): ReturnType<typeof createApiServer> {
  // #1124: reuse the one module-level boss (constructed in beforeAll) across the mid-suite
  // restartServer() rebuilds — createApiServer()'s default boss falls back to pg-boss's own 10s
  // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can exceed
  // even when the connection ultimately succeeds. The explicit, longer-but-still-under-hookTimeout
  // override keeps a slow-but-healthy CI connection from being killed prematurely.
  // Test-only — production callers of createApiServer() are unaffected.
  return createApiServer({
    appDb,
    boss,
    logger: false,
    apiServerConfig: {
      host: "0.0.0.0",
      port: 0,
      mcpServerUrl: "http://127.0.0.1:0/api/mcp",
      externalModulesDir: modulesDir
    }
  });
}

// External-module discovery is captured ONCE at boot (apps/api/src/server.ts,
// discoverExternalModules, #917) — a deliberate design choice ("rescan requires a process
// restart"). A reconcileModules() call that writes new modules/versions to disk is invisible
// to the shared `server` instance's registry-list route until we recreate it. Sessions stay
// valid across the restart since better-auth storage is DB-backed (same appDb), not in-memory.
async function restartServer(): Promise<void> {
  await server.close();
  server = buildServer();
  await server.ready();
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  root = mkdtempSync(join(tmpdir(), "moddist-"));
  modulesDir = join(root, "modules");
  mkdirSync(modulesDir, { recursive: true });

  // Build the publishable module source, then pack it with the real packer.
  const srcDir = join(root, "src-module");
  mkdirSync(join(srcDir, "dist"), { recursive: true });
  mkdirSync(join(srcDir, "sql"), { recursive: true });
  writeFileSync(join(srcDir, "dist", "worker.js"), "// fixture worker\n");
  writeFileSync(
    join(srcDir, "sql", "0001_items.sql"),
    // owner_user_id is required on every database.ownedTables entry — module-install's
    // generateModuleTableRlsSql (packages/db/src/module-rls-emitter.ts) always emits an
    // owner-only RLS policy keyed on this column (Private-by-default hard invariant).
    "CREATE TABLE IF NOT EXISTS app.acme_widgets_items (id bigint PRIMARY KEY, owner_user_id uuid NOT NULL);\n"
  );
  writeFileSync(join(srcDir, "jarvis.module.json"), JSON.stringify(MANIFEST));
  // Pack BOTH versions with the REAL Task 4 packer (writes <id>-<version>.tgz into
  // outDir, returns { version, artifact, sha256, sizeBytes }) so the hash/format
  // contract is tested against the exact artifact shape the publish workflow produces.
  // 0.3.0 adds a second migration — the update test asserts only NEW migrations run.
  const outDir = join(root, "registry-out");
  mkdirSync(outDir, { recursive: true });
  const ref020 = await packModuleArtifact(srcDir, outDir, "acme-widgets", "0.2.0");
  writeFileSync(
    join(srcDir, "sql", "0002_labels.sql"),
    "ALTER TABLE app.acme_widgets_items ADD COLUMN IF NOT EXISTS label text;\n"
  );
  writeFileSync(
    join(srcDir, "jarvis.module.json"),
    JSON.stringify({ ...MANIFEST, version: "0.3.0" })
  );
  const ref030 = await packModuleArtifact(srcDir, outDir, "acme-widgets", "0.3.0");
  refs = { "0.2.0": ref020, "0.3.0": ref030 };

  // Mock registry on an ephemeral port. The index is built PER REQUEST from the
  // mutable `latestVersion` so the update test can "publish" 0.3.0 mid-suite.
  registry = createServer((req, res) => {
    if (req.url === "/index.json") {
      const latest = refs[latestVersion];
      const index = {
        schemaVersion: 1,
        generatedAt: "2026-07-12T00:00:00Z",
        modules: [
          {
            id: "acme-widgets",
            name: "Acme Widgets",
            description: "Fixture module",
            version: latestVersion,
            requiresCore: ">=0.1.0",
            // Bare filename only (schema-enforced, ARTIFACT_FILENAME_RE) — the pipeline
            // resolves it via `new URL(ref.artifact, indexUrl)`, i.e. relative to this
            // mock's own /index.json, never a full URL (that would fail validation and
            // the entry would be silently dropped).
            artifact: latest.artifact,
            sha256: latest.sha256,
            sizeBytes: latest.sizeBytes,
            capabilities: {
              permissions: [],
              fetchHosts: [],
              tools: [],
              ownsTables: ["app.acme_widgets_items"]
            },
            previousVersions:
              latestVersion === "0.3.0"
                ? [
                    {
                      version: "0.2.0",
                      artifact: refs["0.2.0"].artifact,
                      sha256: refs["0.2.0"].sha256,
                      sizeBytes: refs["0.2.0"].sizeBytes
                    }
                  ]
                : []
          }
        ]
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(index));
      return;
    }
    if (req.url?.endsWith(".tgz")) {
      const file = join(outDir, req.url.slice(1));
      if (existsSync(file)) {
        res.setHeader("content-type", "application/gzip");
        res.end(readFileSync(file));
        return;
      }
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  process.env.JARVIS_MODULE_REGISTRY_URL = `${registryUrl}/index.json`;

  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = buildServer();
  await server.ready();

  const admin = await signUp(server, "owner@moddist.test", "Owner");
  adminCookie = admin.cookie;
  const member = await signUp(server, "member@moddist.test", "Member");
  memberCookie = member.cookie;

  // #1468: reconcileModules() now runs the target-identity guard (scripts/module-reconcile.ts,
  // assertReconcileTargetIdentity). Once the admin sign-up above creates the bootstrap owner
  // row, the DB is no longer "unprovisioned", so every reconcileModules({ modulesDir }) call
  // below needs a confirmation email that matches it — same env var prod's compose sets
  // (7c350344a), just scoped to this suite's fixture owner.
  process.env.JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL = "owner@moddist.test";
});

afterAll(async () => {
  delete process.env.JARVIS_MODULE_REGISTRY_URL;
  delete process.env.JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL;
  await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  await new Promise((resolve) => registry?.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

describe("module distribution e2e (#964)", () => {
  it("denies non-admin access to every registry route", async () => {
    // Bodies must satisfy each route's request schema — an invalid/missing body would
    // 400 at schema validation before ever reaching assertAdminUser, which would make
    // this test pass for the wrong reason (not proving authz is enforced).
    for (const [method, url, payload] of [
      ["GET", "/api/admin/module-registry", undefined],
      ["POST", "/api/admin/external-modules/acme-widgets/download", {}],
      ["POST", "/api/admin/external-modules/acme-widgets/remove", { purgeData: false }],
      ["DELETE", "/api/admin/external-modules/acme-widgets/purge", undefined]
    ] as const) {
      const res = await server.inject({
        method,
        url,
        // Only set content-type when there's a body — an empty body with a JSON
        // content-type fails Fastify's body-parser (400) before assertAdminUser
        // ever runs, which would test parsing, not authz.
        headers:
          payload === undefined
            ? { cookie: memberCookie }
            : { cookie: memberCookie, "content-type": "application/json" },
        payload
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("lists the registry module as not-installed with full capabilities", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/module-registry",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.registryUnavailable).toBe(false);
    const row = body.modules.find((m: { id: string }) => m.id === "acme-widgets");
    // Every DTO field must survive fast-json-stringify (additionalProperties:false
    // drops undeclared fields SILENTLY — the recurring trap; assert them all).
    expect(row).toEqual({
      id: "acme-widgets",
      name: "Acme Widgets",
      description: "Fixture module",
      state: "not-installed",
      installedVersion: null,
      latestVersion: "0.2.0",
      stagedVersion: null,
      requiresCore: ">=0.1.0",
      capabilities: {
        permissions: [],
        fetchHosts: [],
        tools: [],
        ownsTables: ["app.acme_widgets_items"]
      },
      lastInstallError: null,
      purgePending: false
    });
  });

  it("downloads + stages via the admin route → pending-restart, files on disk", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets/download",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().module).toMatchObject({ state: "pending-restart", stagedVersion: "0.2.0" });
    expect(existsSync(join(modulesDir, "acme-widgets", "jarvis.module.json"))).toBe(true);
    expect(existsSync(join(modulesDir, "acme-widgets", "sql", "0001_items.sql"))).toBe(true);
  });

  it("boot reconcile accepts the staged download and installs the module schema", async () => {
    const report = await reconcileModules({ modulesDir });
    expect(report.accepted).toEqual(["acme-widgets"]);
    expect(report.installed).toEqual(["acme-widgets"]);
    expect(report.warnings).toEqual([]);

    // 4-phase install evidence (spec §12): table created, both module roles exist,
    // the installer role's login is disabled after phase D, migration ledger recorded.
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const table = await client.query("SELECT to_regclass('app.acme_widgets_items') AS t");
    const roles = await client.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'jarvis_mod_acme_widgets_%' ORDER BY rolname"
    );
    const ledger = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.module_schema_migrations WHERE module_id = 'acme-widgets'"
    );
    const baseline = await client.query<{ manifest_hash: string; package_hash: string }>(
      "SELECT manifest_hash, package_hash FROM app.external_modules WHERE id = 'acme-widgets'"
    );
    await client.end();
    expect(table.rows[0].t).toBe("app.acme_widgets_items");
    expect(roles.rows.some((r) => r.rolname === "jarvis_mod_acme_widgets_runtime")).toBe(true);
    expect(
      roles.rows.find((r) => r.rolname === "jarvis_mod_acme_widgets_install")?.rolcanlogin
    ).toBe(false);
    expect(ledger.rows[0]!.n).toBe(1);
    const discovery = getExternalModuleRegistrations({ modulesDir }).discoveries[0]!;
    expect(baseline.rows[0]).toEqual({
      manifest_hash: discovery.manifestHash,
      package_hash: discovery.packageHash
    });

    // Boot discovery is a startup-only snapshot (#917) — restart to pick up the module
    // reconcile just installed onto disk.
    await restartServer();
    const list = await server.inject({
      method: "GET",
      url: "/api/admin/module-registry",
      headers: { cookie: adminCookie }
    });
    const row = list.json().modules.find((m: { id: string }) => m.id === "acme-widgets");
    expect(row).toMatchObject({ state: "installed-enabled", installedVersion: "0.2.0" });
  });

  it("download while a purge is pending is refused with 409", async () => {
    // Mark remove+purge first…
    const remove = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets/remove",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { purgeData: true }
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().module).toMatchObject({ purgePending: true });
    // …then a download attempt must not clear or race the mark.
    const download = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets/download",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: {}
    });
    expect(download.statusCode).toBe(409);
  });

  it("cancel purge restores the removable state without touching data", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/external-modules/acme-widgets/purge",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().module.purgePending).toBe(false);
  });

  it("remove+purge then reconcile destroys tables, roles, journal, files, and the row", async () => {
    await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets/remove",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { purgeData: true }
    });
    const report = await reconcileModules({ modulesDir });
    expect(report.purged).toEqual(["acme-widgets"]);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const table = await client.query("SELECT to_regclass('app.acme_widgets_items') AS t");
    const role = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_mod_acme_widgets_runtime'"
    );
    const journal = await client.query(
      "SELECT 1 FROM app.module_installs WHERE module_id = 'acme-widgets'"
    );
    const row = await client.query("SELECT 1 FROM app.external_modules WHERE id = 'acme-widgets'");
    await client.end();
    expect(table.rows[0].t).toBeNull();
    expect(role.rowCount).toBe(0);
    expect(journal.rowCount).toBe(0);
    expect(row.rowCount).toBe(0);
    expect(existsSync(join(modulesDir, "acme-widgets"))).toBe(false);

    const list = await server.inject({
      method: "GET",
      url: "/api/admin/module-registry",
      headers: { cookie: adminCookie }
    });
    const listed = list.json().modules.find((m: { id: string }) => m.id === "acme-widgets");
    expect(listed).toMatchObject({ state: "not-installed", purgePending: false });
  });

  it("purge re-run is idempotent (crash-safety)", async () => {
    const report = await reconcileModules({ modulesDir });
    expect(report.purged).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("compose-ensure downloads and installs a missing module in one boot", async () => {
    const report = await reconcileModules({
      modulesDir,
      env: { ...process.env, JARVIS_MODULES_ENSURE: "acme-widgets" }
    });
    expect(report.ensured).toEqual(["acme-widgets"]);
    expect(report.accepted).toEqual(["acme-widgets"]);
    expect(report.installed).toEqual(["acme-widgets"]);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const table = await client.query("SELECT to_regclass('app.acme_widgets_items') AS t");
    await client.end();
    expect(table.rows[0].t).toBe("app.acme_widgets_items");
  });

  it("registry outage during ensure → boot completes with a warning, not a failure", async () => {
    const report = await reconcileModules({
      modulesDir,
      env: {
        ...process.env,
        JARVIS_MODULES_ENSURE: "some-other-module",
        // Dead port: connection refused. The reconcile must warn and keep going.
        JARVIS_MODULE_REGISTRY_URL: "http://127.0.0.1:9/index.json"
      }
    });
    expect(report.warnings.some((w) => w.moduleId === "some-other-module")).toBe(true);
  });

  it("published 0.3.0 → update-available → download → boot applies ONLY new migrations", async () => {
    latestVersion = "0.3.0";
    // ?refresh=1 busts the server's 10-minute index cache (Task 6).
    const list = await server.inject({
      method: "GET",
      url: "/api/admin/module-registry?refresh=1",
      headers: { cookie: adminCookie }
    });
    expect(list.json().modules.find((m: { id: string }) => m.id === "acme-widgets")).toMatchObject({
      state: "update-available",
      installedVersion: "0.2.0",
      latestVersion: "0.3.0"
    });

    const download = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets/download",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: {}
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().module).toMatchObject({
      state: "update-pending-restart",
      stagedVersion: "0.3.0"
    });

    const report = await reconcileModules({ modulesDir });
    expect(report.accepted).toEqual(["acme-widgets"]);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const ledger = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.module_schema_migrations WHERE module_id = 'acme-widgets'"
    );
    const column = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'acme_widgets_items' AND column_name = 'label'"
    );
    await client.end();
    // 0001 was applied before the update and is NOT re-run; only 0002 is added.
    expect(ledger.rows[0]!.n).toBe(2);
    expect(column.rowCount).toBe(1);

    // Boot discovery is a startup-only snapshot (#917) — restart to pick up the 0.3.0
    // reconcile just applied.
    await restartServer();
    const after = await server.inject({
      method: "GET",
      url: "/api/admin/module-registry",
      headers: { cookie: adminCookie }
    });
    expect(after.json().modules.find((m: { id: string }) => m.id === "acme-widgets")).toMatchObject(
      { state: "installed-enabled", installedVersion: "0.3.0" }
    );
  });

  it("remove keeps data; reinstall resumes the migration ledger instead of re-running", async () => {
    const remove = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets/remove",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { purgeData: false }
    });
    expect(remove.statusCode).toBe(200);
    await reconcileModules({ modulesDir });
    expect(existsSync(join(modulesDir, "acme-widgets"))).toBe(false);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const kept = await client.query("SELECT to_regclass('app.acme_widgets_items') AS t");
    expect(kept.rows[0].t).toBe("app.acme_widgets_items"); // data preserved

    // Reinstall: download again + reconcile — ledger resumes, nothing re-runs.
    const download = await server.inject({
      method: "POST",
      url: "/api/admin/external-modules/acme-widgets/download",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: {}
    });
    expect(download.statusCode).toBe(200);
    const report = await reconcileModules({ modulesDir });
    expect(report.accepted).toEqual(["acme-widgets"]);
    const ledger = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.module_schema_migrations WHERE module_id = 'acme-widgets'"
    );
    await client.end();
    expect(ledger.rows[0]!.n).toBe(2); // unchanged — 0001/0002 skipped as already applied
  });

  it("tampered on-disk package → drift-disabled at the next boot", async () => {
    writeFileSync(join(modulesDir, "acme-widgets", "dist", "worker.js"), "// tampered\n");
    const report = await reconcileModules({ modulesDir });
    expect(report.drifted).toEqual(["acme-widgets"]);

    const list = await server.inject({
      method: "GET",
      url: "/api/admin/module-registry",
      headers: { cookie: adminCookie }
    });
    expect(list.json().modules.find((m: { id: string }) => m.id === "acme-widgets")).toMatchObject({
      state: "installed-disabled"
    });
  });
});

// signUp: copied VERBATIM from tests/integration/external-modules-routes.test.ts:214-end
// (better-auth sign-up cookie pattern; first sign-up bootstraps the instance admin).
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
