// #1632: the three module role-broker entry points must run their CREATE/ALTER/GRANT ROLE DDL on
// the lock's DDL session — the caller's target database — while a separate lock session holds the
// cluster-global advisory lock on the maintenance database. Role DDL is cluster-global in effect
// but must be issued from a session connected to the target database, which is why the two
// sessions exist; asserting both here keeps a future single-session "simplification" from
// silently reintroducing either the per-database-locktag bug or the wrong-database DDL bug.
import { describe, expect, it } from "vitest";

import {
  disableInstallerLogin,
  enableInstallerLogin,
  ensureModuleRoles
} from "../module-role-broker.js";
import { createFakeClusterHarness } from "./fake-pg-cluster.js";

const BOOTSTRAP_URL = "postgres://postgres:rootpw@db:5432/moss";

describe("ensureModuleRoles under the cluster DDL lock", () => {
  it("runs every role statement on the DDL session and opens no other client", async () => {
    const harness = createFakeClusterHarness();

    const roles = await ensureModuleRoles(BOOTSTRAP_URL, "demo-module", harness.options);

    expect(roles).toEqual({
      runtimeRole: "jarvis_mod_demo_module_runtime",
      installRole: "jarvis_mod_demo_module_install"
    });

    const texts = harness.ddl.texts;
    expect(texts.some((t) => t.includes("CREATE ROLE %I NOLOGIN"))).toBe(true);
    expect(
      texts.some((t) =>
        t.includes('ALTER ROLE "jarvis_mod_demo_module_install" NOLOGIN PASSWORD NULL')
      )
    ).toBe(true);
    expect(
      texts.some((t) => t.includes('GRANT "jarvis_mod_demo_module_runtime" TO jarvis_app_runtime'))
    ).toBe(true);
    expect(
      texts.some((t) =>
        t.includes('GRANT CREATE ON SCHEMA app TO "jarvis_mod_demo_module_install"')
      )
    ).toBe(true);
    expect(texts.some((t) => t.includes("WITH GRANT OPTION"))).toBe(true);
    expect(texts.some((t) => t.includes("GRANT REFERENCES (id) ON app.users"))).toBe(true);
    // No lock traffic leaks onto the DDL session, and no DDL leaks onto the lock session.
    expect(texts.some((t) => t.includes("pg_advisory"))).toBe(false);
    expect(harness.lock.texts[0]).toContain("pg_advisory_lock");
    expect(harness.lock.texts.at(-1)).toContain("pg_advisory_unlock");
    expect(harness.lock.texts.some((t) => t.includes("ROLE"))).toBe(false);

    // Exactly two connections: one lock session, one DDL session — no third of the caller's own.
    expect(harness.lockClients).toHaveLength(1);
    expect(harness.ddlClients).toHaveLength(1);
    expect(harness.lock.connectCalls).toBe(1);
    expect(harness.ddl.connectCalls).toBe(1);
    expect(harness.connectionStrings).toEqual([
      "postgres://postgres:rootpw@db:5432/postgres",
      "postgres://postgres:rootpw@db:5432/moss"
    ]);
  });

  it("rejects an invalid module id before acquiring the lock", async () => {
    const harness = createFakeClusterHarness();
    await expect(ensureModuleRoles(BOOTSTRAP_URL, "Bad_Id", harness.options)).rejects.toThrow(
      /invalid module id/
    );
    expect(harness.lockClients).toHaveLength(0);
    expect(harness.ddlClients).toHaveLength(0);
  });
});

describe("enableInstallerLogin under the cluster DDL lock", () => {
  it("alters the install role on the DDL session and returns the password only in memory", async () => {
    const harness = createFakeClusterHarness();

    const password = await enableInstallerLogin(BOOTSTRAP_URL, "demo-module", harness.options);

    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const alter = harness.ddl.texts.find((t) => t.includes("LOGIN PASSWORD"));
    expect(alter).toContain('ALTER ROLE "jarvis_mod_demo_module_install" LOGIN PASSWORD');
    // The password is escaped as a SQL literal, never interpolated raw.
    expect(alter).toContain(`'${password}'`);
    expect(harness.lock.texts[0]).toContain("pg_advisory_lock");
    expect(harness.lock.texts.at(-1)).toContain("pg_advisory_unlock");
  });
});

describe("disableInstallerLogin under the cluster DDL lock", () => {
  it("clears LOGIN and the password on the DDL session", async () => {
    const harness = createFakeClusterHarness();

    await expect(
      disableInstallerLogin(BOOTSTRAP_URL, "demo-module", harness.options)
    ).resolves.toBeUndefined();

    expect(harness.ddl.texts).toContain(
      'ALTER ROLE "jarvis_mod_demo_module_install" NOLOGIN PASSWORD NULL'
    );
    expect(harness.lock.texts[0]).toContain("pg_advisory_lock");
    expect(harness.lock.texts.at(-1)).toContain("pg_advisory_unlock");
  });
});
