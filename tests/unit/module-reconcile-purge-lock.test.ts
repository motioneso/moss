// #1632: a module purge drops cluster-global Postgres roles. Only that final REVOKE/DROP ROLE
// block runs under the cluster-DDL lock — on the lock's own owner session — while the rest of the
// purge (table drops, journal deletes, the purge mark) stays on the reconcile run's client, which
// holds the separate, unrelated `jarv1s:module-reconcile` advisory lock for the whole run.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { purgeModule } from "../../scripts/module-reconcile.js";
import { createFakeLockHarness } from "../../packages/db/src/__tests__/fake-lock-client.js";

const BOOTSTRAP_URL = "postgres://postgres:rootpw@db:5432/moss";
const MODULE_ID = "demo-module";

class RecordingReconcileClient {
  readonly texts: string[] = [];

  async query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> {
    this.texts.push(text);
    void params;
    if (text.includes("owned_tables")) {
      return { rows: [{ owned_tables: ["app.demo_module_leads"] }] };
    }
    return { rows: [] };
  }
}

let modulesDir: string;

beforeEach(async () => {
  modulesDir = await mkdtemp(join(tmpdir(), "moss-purge-lock-"));
});

afterEach(async () => {
  await rm(modulesDir, { recursive: true, force: true });
});

describe("purgeModule role teardown", () => {
  it("runs the role REVOKE/DROP block on the lock-owner session, not the reconcile client", async () => {
    const outer = new RecordingReconcileClient();
    const harness = createFakeLockHarness();

    await purgeModule(
      outer as unknown as Client,
      modulesDir,
      MODULE_ID,
      BOOTSTRAP_URL,
      harness.options
    );

    const lockTexts = harness.owner.texts;
    expect(lockTexts[0]).toContain("pg_advisory_lock");
    expect(lockTexts.at(-1)).toContain("pg_advisory_unlock");
    expect(lockTexts.some((t) => t.includes("REVOKE GRANT OPTION FOR USAGE ON SCHEMA app"))).toBe(
      true
    );
    expect(lockTexts.some((t) => t.includes("REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION"))).toBe(
      true
    );
    expect(
      lockTexts.some(
        (t) => t.includes("DROP ROLE %I") && t.includes("jarvis_mod_demo_module_runtime")
      )
    ).toBe(true);
    expect(
      lockTexts.some(
        (t) => t.includes("DROP ROLE %I") && t.includes("jarvis_mod_demo_module_install")
      )
    ).toBe(true);

    // The reconcile client must never issue role DDL itself.
    expect(outer.texts.some((t) => t.includes("DROP ROLE"))).toBe(false);
    expect(outer.texts.some((t) => t.includes("REVOKE GRANT OPTION"))).toBe(false);
  });

  it("keeps the non-role purge steps on the reconcile client, with the purge mark deleted last", async () => {
    const outer = new RecordingReconcileClient();
    const harness = createFakeLockHarness();

    await purgeModule(
      outer as unknown as Client,
      modulesDir,
      MODULE_ID,
      BOOTSTRAP_URL,
      harness.options
    );

    expect(outer.texts).toContain("DROP TABLE IF EXISTS app.demo_module_leads CASCADE");
    expect(outer.texts).toContain("DELETE FROM app.module_kv WHERE module_id = $1");
    expect(outer.texts).toContain("DELETE FROM app.module_installs WHERE module_id = $1");
    expect(outer.texts.at(-1)).toBe("DELETE FROM app.external_modules WHERE id = $1");
  });

  it("rejects an invalid module id before touching either connection", async () => {
    const outer = new RecordingReconcileClient();
    const harness = createFakeLockHarness();

    await expect(
      purgeModule(outer as unknown as Client, modulesDir, "Bad_Id", BOOTSTRAP_URL, harness.options)
    ).rejects.toThrow(/invalid module id/);

    expect(outer.texts).toHaveLength(0);
    expect(harness.owner.queries).toHaveLength(0);
  });
});
