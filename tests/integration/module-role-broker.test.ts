import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  disableInstallerLogin,
  enableInstallerLogin,
  ensureModuleRoles,
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { getMossDatabaseUrls } from "../../packages/db/src/urls.js";
import {
  dropModuleRolesAtTeardown,
  laneScopedModuleId,
  resetEmptyFoundationDatabase
} from "./test-database.js";

const urls = getMossDatabaseUrls();
const moduleId = laneScopedModuleId("role-broker-fixture");

// ensureModuleRoles now grants schema/table-level ACLs on schema app (#914 Task 7), so this
// suite needs the app schema to exist regardless of file run order — it can no longer piggyback
// on some other file's reset having run first in the same shared test database.
beforeAll(async () => {
  await resetEmptyFoundationDatabase();
});

afterAll(async () => {
  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  // ensureModuleRoles grants schema/table-level ACLs to the install role (spec D2); Postgres
  // refuses DROP ROLE while grants are outstanding, so revoke before dropping.
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${moduleInstallRoleName(moduleId)}`);
  await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${moduleInstallRoleName(moduleId)}`);
  await client.query(
    `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${moduleInstallRoleName(moduleId)}`
  );
  await dropModuleRolesAtTeardown([
    moduleInstallRoleName(moduleId),
    moduleRuntimeRoleName(moduleId)
  ]);
  await client.end();
});

describe("module role broker", () => {
  it("creates both roles NOLOGIN, then flips and unflips the installer role's login", async () => {
    const roles = await ensureModuleRoles(urls.bootstrap, moduleId);
    expect(roles.runtimeRole).toBe(moduleRuntimeRoleName(moduleId));

    const check = new Client({ connectionString: urls.bootstrap });
    await check.connect();
    const before = await check.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [
      roles.installRole
    ]);
    expect(before.rows[0].rolcanlogin).toBe(false);

    const password = await enableInstallerLogin(urls.bootstrap, moduleId);
    expect(password).toHaveLength(32);
    const afterEnable = await check.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [
      roles.installRole
    ]);
    expect(afterEnable.rows[0].rolcanlogin).toBe(true);

    await disableInstallerLogin(urls.bootstrap, moduleId);
    const afterDisable = await check.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [
      roles.installRole
    ]);
    expect(afterDisable.rows[0].rolcanlogin).toBe(false);
    await check.end();
  });

  it("is idempotent and Phase A self-heals a crash that left the installer LOGIN", async () => {
    // Second call on an existing pair must not throw.
    await expect(ensureModuleRoles(urls.bootstrap, moduleId)).resolves.toBeDefined();

    const installRole = moduleInstallRoleName(moduleId);
    const check = new Client({ connectionString: urls.bootstrap });
    await check.connect();

    // Simulate a crash between Phase B and Phase D: installer is left LOGIN with a live password.
    await enableInstallerLogin(urls.bootstrap, moduleId);
    const midCrash = await check.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [
      installRole
    ]);
    expect(midCrash.rows[0].rolcanlogin).toBe(true);

    // A retried Phase A (Task 7 rerun) must itself reset the installer to NOLOGIN, without ever
    // running Phase D.
    await ensureModuleRoles(urls.bootstrap, moduleId);
    const afterRetry = await check.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [
      installRole
    ]);
    expect(afterRetry.rows[0].rolcanlogin).toBe(false);
    await check.end();
  });

  it("grants the runtime role WITH INHERIT FALSE to both parent runtime roles", async () => {
    await ensureModuleRoles(urls.bootstrap, moduleId);
    const runtimeRole = moduleRuntimeRoleName(moduleId);

    const check = new Client({ connectionString: urls.bootstrap });
    await check.connect();
    // inherit_option exists on pg_auth_members in Postgres 16+ (target image is pgvector/pgvector:pg17).
    // false => the parent runtime roles do NOT ambiently inherit the module role; they must
    // SET LOCAL ROLE to use it.
    const membership = await check.query(
      `SELECT m.rolname AS member, am.inherit_option
         FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = $1 AND m.rolname IN ('jarvis_app_runtime', 'jarvis_worker_runtime')`,
      [runtimeRole]
    );
    const byMember = new Map(
      membership.rows.map((row: { member: string; inherit_option: boolean }) => [
        row.member,
        row.inherit_option
      ])
    );
    expect(byMember.get("jarvis_app_runtime")).toBe(false);
    expect(byMember.get("jarvis_worker_runtime")).toBe(false);
    await check.end();
  });
});
