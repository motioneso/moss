// #1013: the cluster-DDL lock derives its maintenance database from the env it is HANDED, while
// connection strings come from the caller-injected env. If a call site forgets to pass the lock
// options through, the two diverge: the lock still acquires successfully, just in a different
// database — and advisory-lock tags are scoped by database OID, so it excludes nobody. That is a
// silent failure with no error, no log, and a green test suite; it is the exact defect class
// #1624 fixed once, and #1632's production port re-opened at these four sites.
//
// Behaviour is pinned through purgeModule, the one site reachable without a live cluster. The
// remaining three (installModule's phases A and D) construct their own pg.Client for the journal
// and migration ledger, so a source guard is the only assertion available without a database —
// same rationale as scripts/migrate.ts in cluster-ddl-lock-wiring.test.ts.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFakeClusterHarness,
  FakePgCluster
} from "../../packages/db/src/__tests__/fake-pg-cluster.js";
import { purgeModule } from "../../scripts/module-reconcile.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BOOTSTRAP_URL = "postgres://postgres:rootpw@db:5432/moss";
const MODULE_ID = "demo-module";
/** Deliberately not the DEFAULT_CLUSTER_LOCK_DATABASE — a default would pass either way. */
const MAINTENANCE_DB = "moss_cluster_maintenance";

class SilentReconcileClient {
  async query(text: string): Promise<{ rows: unknown[] }> {
    if (text.includes("owned_tables")) {
      return { rows: [{ owned_tables: ["app.demo_module_leads"] }] };
    }
    return { rows: [] };
  }
}

async function readSource(relativePath: string): Promise<string> {
  // Whitespace-collapsed so Prettier's line wrapping cannot break the assertions.
  return (await readFile(join(repoRoot, relativePath), "utf8")).replace(/\s+/g, " ");
}

let modulesDir: string;

beforeEach(async () => {
  modulesDir = await mkdtemp(join(tmpdir(), "moss-lock-domain-"));
});

afterEach(async () => {
  await rm(modulesDir, { recursive: true, force: true });
});

describe("injected-env lock domain", () => {
  it("routes the lock session to the injected JARVIS_CLUSTER_LOCK_DATABASE, not the bootstrap database", async () => {
    const harness = createFakeClusterHarness({
      cluster: new FakePgCluster(MAINTENANCE_DB, "jarv1s:cluster-ddl")
    });

    await purgeModule(
      new SilentReconcileClient() as unknown as Client,
      modulesDir,
      MODULE_ID,
      BOOTSTRAP_URL,
      {
        ...harness.options,
        env: { JARVIS_CLUSTER_LOCK_DATABASE: MAINTENANCE_DB } as NodeJS.ProcessEnv
      }
    );

    // The lock session must move off the bootstrap database entirely; the DDL session must not —
    // that split is the whole design, and both halves have to follow the injected env together.
    expect(harness.lock.db).toBe(MAINTENANCE_DB);
    expect(harness.ddl.db).toBe("moss");
    // Asserting the recorded acquire, not just the URL: a session that connects to the right
    // database but never takes the lock there would satisfy the pathname check alone.
    expect(
      harness.cluster.log.some((event) => event.kind === "acquire" && event.db === MAINTENANCE_DB)
    ).toBe(true);
  });

  it("falls back to the default maintenance database when no env is injected", async () => {
    const harness = createFakeClusterHarness();

    await purgeModule(
      new SilentReconcileClient() as unknown as Client,
      modulesDir,
      MODULE_ID,
      BOOTSTRAP_URL,
      harness.options
    );

    // Pins the fallback as a real decision: an empty env means `postgres`, never the caller's own
    // per-lane database — which is what makes a forgotten pass-through survivable in dev and fatal
    // under a non-default deployment.
    expect(harness.lock.db).toBe("postgres");
  });
});

describe("lock options reach every cluster-global call site", () => {
  it("reconcileModules builds the lock options from its injected env", async () => {
    const source = await readSource("scripts/module-reconcile.ts");
    // Not `process.env`: reconcileModules already resolves `env` once for getMossDatabaseUrls, and
    // the lock must resolve from the same value or the two disagree.
    expect(source).toContain("const lock: WithClusterDdlLockOptions = { env };");
  });

  it("reconcileModules forwards them to purgeModule and installModule", async () => {
    const source = await readSource("scripts/module-reconcile.ts");
    expect(source).toContain(
      "purgeModule(client, options.modulesDir, row.id, urls.bootstrap, lock)"
    );
    expect(source).toContain("migrationsDirectory: sqlDir, lock");
  });

  it("installModule forwards them to all three role-touching broker calls", async () => {
    const source = await readSource("scripts/module-install.ts");
    // Phase A ensures the roles, Phase A enables the installer login, Phase D disables it — all
    // three write pg_authid, so a partial thread-through is a partial lock domain.
    expect(source).toContain("ensureModuleRoles( bootstrapConnectionString, moduleId, lock )");
    expect(source).toContain("enableInstallerLogin(bootstrapConnectionString, moduleId, lock)");
    expect(source).toContain("disableInstallerLogin(bootstrapConnectionString, moduleId, lock)");
  });

  it("installModule resolves the options once, so the three phases cannot diverge", async () => {
    const source = await readSource("scripts/module-install.ts");
    expect(source).toContain("const lock = options.lock ?? {};");
  });
});
