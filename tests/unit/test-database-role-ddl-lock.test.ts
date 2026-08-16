// #1013: the integration suite's own cluster-global DDL — DROP ROLE and role-membership
// GRANT/REVOKE — must run on #1632's guarded DDL session, not on a bare teardown connection.
// #1632 wired the production path only; these helpers are the test path, which is where the
// `tuple concurrently updated` collisions between parallel gates actually happen.
//
// The lock is exercised through its DI seams, so nothing here touches a database.
import type { ClusterDdlLockClient } from "@moss/db";
import { MAX_LIVENESS_INTERVAL_MS } from "@moss/db";
import { describe, expect, it } from "vitest";

import {
  dropModuleRolesAtTeardown,
  grantModuleMembershipAtSetup,
  revokeModuleMembershipAtTeardown
} from "../integration/test-database.js";

interface Statement {
  readonly session: "lock" | "ddl";
  readonly text: string;
}

interface Harness {
  readonly statements: Statement[];
  readonly connections: { readonly session: "lock" | "ddl"; readonly url: string }[];
  readonly lockOptions: {
    readonly livenessIntervalMs: number;
    readonly createLockClient: (url: string) => ClusterDdlLockClient;
    readonly createDdlClient: (url: string) => ClusterDdlLockClient;
  };
}

/**
 * Records which session each statement landed on. `failWith` lets a test make one DDL statement
 * reject with a chosen SQLSTATE, which is how the 2BP01 tolerance is pinned without a cluster.
 */
function harness(failWith?: { readonly match: string; readonly code: string }): Harness {
  const statements: Statement[] = [];
  const connections: { session: "lock" | "ddl"; url: string }[] = [];

  const make =
    (session: "lock" | "ddl") =>
    (url: string): ClusterDdlLockClient => {
      connections.push({ session, url });
      return {
        connect: async () => {},
        query: async <T>(text: string): Promise<{ rows: T[] }> => {
          statements.push({ session, text });
          if (session === "ddl" && failWith && text.includes(failWith.match)) {
            throw Object.assign(new Error(`simulated ${failWith.code}`), { code: failWith.code });
          }
          if (text.includes("pg_backend_pid")) {
            return { rows: [{ pid: 4242 } as unknown as T] };
          }
          return { rows: [] };
        },
        end: async () => {},
        on: () => undefined,
        removeListener: () => undefined
      };
    };

  return {
    statements,
    connections,
    lockOptions: {
      // The heartbeat must not fire mid-test; these helpers finish in microseconds.
      livenessIntervalMs: MAX_LIVENESS_INTERVAL_MS,
      createLockClient: make("lock"),
      createDdlClient: make("ddl")
    }
  };
}

const ddlOf = (h: Harness): string[] =>
  h.statements.filter((s) => s.session === "ddl").map((s) => s.text);

const acquisitions = (h: Harness): number =>
  h.statements.filter((s) => s.text.includes("pg_advisory_lock")).length;

describe("dropModuleRolesAtTeardown", () => {
  it("drops every role on the guarded DDL session, never on the caller's connection", async () => {
    const h = harness();

    await dropModuleRolesAtTeardown(["jarvis_mod_probe_install", "jarvis_mod_probe_runtime"], {
      lock: h.lockOptions
    });

    // Issuing DROP ROLE on the teardown connection instead would still hold the advisory lock and
    // still pass a naive "did it drop?" assertion, while forfeiting the liveness guarantee that
    // is the entire point of #1632's dual-session design.
    expect(ddlOf(h)).toEqual([
      "DROP ROLE IF EXISTS jarvis_mod_probe_install",
      "DROP ROLE IF EXISTS jarvis_mod_probe_runtime"
    ]);
  });

  it("takes exactly one lock section for the whole role list", async () => {
    const h = harness();

    await dropModuleRolesAtTeardown(["role_a", "role_b", "role_c"], { lock: h.lockOptions });

    // Per-role locking would be three acquire/release round trips per teardown across ~100 resets
    // a gate — and nesting them to avoid that throws ClusterDdlLockReentrancyError outright.
    expect(acquisitions(h)).toBe(1);
    expect(h.statements.filter((s) => s.text.includes("pg_advisory_unlock"))).toHaveLength(1);
  });

  it("takes the lock on the maintenance database, not the gate database", async () => {
    const h = harness();

    await dropModuleRolesAtTeardown(["role_a"], { lock: h.lockOptions });

    // Advisory-lock tags are scoped by database OID: a lock session that lands on the caller's own
    // per-lane gate DB excludes nobody, which is the exact lock-domain split #1624 fixed once.
    const lockUrl = h.connections.find((c) => c.session === "lock")?.url;
    expect(lockUrl).toBeDefined();
    expect(new URL(lockUrl!).pathname).toBe("/postgres");
  });

  it("tolerates 2BP01 and keeps dropping the remaining roles", async () => {
    const h = harness({ match: "jarvis_mod_probe_install", code: "2BP01" });

    await expect(
      dropModuleRolesAtTeardown(["jarvis_mod_probe_install", "jarvis_mod_probe_runtime"], {
        lock: h.lockOptions
      })
    ).resolves.toBeUndefined();

    // The role is owned by another database's install (#1345); that refusal is correct and must
    // not abort the rest of the teardown.
    expect(ddlOf(h)).toContain("DROP ROLE IF EXISTS jarvis_mod_probe_runtime");
  });

  it("rethrows any SQLSTATE other than 2BP01", async () => {
    const h = harness({ match: "jarvis_mod_probe_install", code: "42501" });

    // A blanket `.catch(() => {})` here is what let a real permission failure read as a clean
    // teardown; only the one documented dependency error is tolerated.
    await expect(
      dropModuleRolesAtTeardown(["jarvis_mod_probe_install"], { lock: h.lockOptions })
    ).rejects.toThrow(/simulated 42501/);
  });
});

describe("role membership helpers", () => {
  it("grants membership on the guarded DDL session in one lock section", async () => {
    const h = harness();

    await grantModuleMembershipAtSetup(
      [
        "GRANT jarvis_mod_probe_runtime TO jarvis_app_runtime WITH INHERIT FALSE",
        "GRANT jarvis_mod_probe_runtime TO jarvis_worker_runtime WITH INHERIT FALSE"
      ],
      { lock: h.lockOptions }
    );

    // Membership writes pg_auth_members, which is cluster-global exactly like pg_authid — main's
    // wiring test calls membership "not a standalone call site", true for production and false
    // here, which is why these races were left uncovered.
    expect(ddlOf(h)).toEqual([
      "GRANT jarvis_mod_probe_runtime TO jarvis_app_runtime WITH INHERIT FALSE",
      "GRANT jarvis_mod_probe_runtime TO jarvis_worker_runtime WITH INHERIT FALSE"
    ]);
    expect(acquisitions(h)).toBe(1);
  });

  it("revokes membership on the guarded DDL session", async () => {
    const h = harness();

    await revokeModuleMembershipAtTeardown(
      ["REVOKE jarvis_mod_probe_runtime FROM jarvis_app_runtime"],
      {
        lock: h.lockOptions
      }
    );

    expect(ddlOf(h)).toEqual(["REVOKE jarvis_mod_probe_runtime FROM jarvis_app_runtime"]);
  });

  it("is fail-closed — a failing membership statement rejects", async () => {
    const h = harness({ match: "REVOKE", code: "2BP01" });

    // Deliberately not given DROP ROLE's 2BP01 tolerance: a membership revoke that fails is a
    // real cluster-catalog failure, not another database's ownership claim.
    await expect(
      revokeModuleMembershipAtTeardown(
        ["REVOKE jarvis_mod_probe_runtime FROM jarvis_app_runtime"],
        {
          lock: h.lockOptions
        }
      )
    ).rejects.toThrow(/simulated 2BP01/);
  });

  it("accepts an empty statement list without taking the lock", async () => {
    const h = harness();

    await grantModuleMembershipAtSetup([], { lock: h.lockOptions });

    // Suites build these lists conditionally; an empty list must not cost a cluster-wide
    // serialization point.
    expect(h.statements).toEqual([]);
  });
});
