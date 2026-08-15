// #1632: the three module role-broker entry points must run their CREATE/ALTER/GRANT ROLE DDL
// on the cluster-DDL lock's owner session. Running it on a second connection is the exact bug
// this feature fixes — the lock holder could die while the DDL session carried on unaware.
import { describe, expect, it } from "vitest";

import {
  disableInstallerLogin,
  enableInstallerLogin,
  ensureModuleRoles
} from "../module-role-broker.js";
import { createFakeLockHarness } from "./fake-lock-client.js";

const BOOTSTRAP_URL = "postgres://postgres:rootpw@db:5432/moss";

describe("ensureModuleRoles under the cluster DDL lock", () => {
  it("runs every role statement on the lock-owner session and opens no other client", async () => {
    const harness = createFakeLockHarness();

    const roles = await ensureModuleRoles(BOOTSTRAP_URL, "demo-module", harness.options);

    expect(roles).toEqual({
      runtimeRole: "jarvis_mod_demo_module_runtime",
      installRole: "jarvis_mod_demo_module_install"
    });

    const texts = harness.owner.texts;
    expect(texts[0]).toContain("pg_advisory_lock");
    expect(texts.at(-1)).toContain("pg_advisory_unlock");
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

    // One owner client, one probe client — no third connection of the caller's own.
    expect(harness.owner.connectCalls).toBe(1);
    expect(harness.connectionStrings).toEqual([
      "postgres://postgres:rootpw@db:5432/postgres",
      "postgres://postgres:rootpw@db:5432/postgres"
    ]);
  });

  it("rejects an invalid module id before acquiring the lock", async () => {
    const harness = createFakeLockHarness();
    await expect(ensureModuleRoles(BOOTSTRAP_URL, "Bad_Id", harness.options)).rejects.toThrow(
      /invalid module id/
    );
    expect(harness.owner.queries).toHaveLength(0);
  });
});

describe("enableInstallerLogin under the cluster DDL lock", () => {
  it("alters the install role on the owner session and returns the password only in memory", async () => {
    const harness = createFakeLockHarness();

    const password = await enableInstallerLogin(BOOTSTRAP_URL, "demo-module", harness.options);

    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const alter = harness.owner.texts.find((t) => t.includes("LOGIN PASSWORD"));
    expect(alter).toContain('ALTER ROLE "jarvis_mod_demo_module_install" LOGIN PASSWORD');
    // The password is escaped as a SQL literal, never interpolated raw.
    expect(alter).toContain(`'${password}'`);
    expect(harness.owner.texts[0]).toContain("pg_advisory_lock");
    expect(harness.owner.texts.at(-1)).toContain("pg_advisory_unlock");
  });
});

describe("disableInstallerLogin under the cluster DDL lock", () => {
  it("clears LOGIN and the password on the owner session", async () => {
    const harness = createFakeLockHarness();

    await expect(
      disableInstallerLogin(BOOTSTRAP_URL, "demo-module", harness.options)
    ).resolves.toBeUndefined();

    expect(harness.owner.texts).toContain(
      'ALTER ROLE "jarvis_mod_demo_module_install" NOLOGIN PASSWORD NULL'
    );
    expect(harness.owner.texts[0]).toContain("pg_advisory_lock");
    expect(harness.owner.texts.at(-1)).toContain("pg_advisory_unlock");
  });
});
