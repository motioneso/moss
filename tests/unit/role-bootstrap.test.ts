import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RUNTIME_ROLE_PASSWORD_DEFAULTS,
  applyRolePasswords,
  buildAlterRoleStatement,
  buildRolePasswordPlan,
  getMossDatabaseUrls
} from "@moss/db";

import { createFakeLockHarness } from "../../packages/db/src/__tests__/fake-lock-client.js";

describe("buildRolePasswordPlan", () => {
  it("derives runtime role passwords from local dev fallback URLs", () => {
    const plan = buildRolePasswordPlan(getMossDatabaseUrls({} as NodeJS.ProcessEnv));
    expect(plan).toEqual([
      { role: "jarvis_migration_owner", password: "migration_password" },
      { role: "jarvis_app_runtime", password: "app_password" },
      { role: "jarvis_worker_runtime", password: "worker_password" },
      { role: "jarvis_auth_runtime", password: "auth_password" }
    ]);
  });

  it("derives passwords from explicit production URLs", () => {
    const env = {
      NODE_ENV: "production",
      JARVIS_BOOTSTRAP_DATABASE_URL: "postgres://postgres:rootpw@db/prod",
      JARVIS_MIGRATION_DATABASE_URL: "postgres://jarvis_migration_owner:mig-secret@db/prod",
      JARVIS_APP_DATABASE_URL: "postgres://jarvis_app_runtime:app-secret@db/prod",
      JARVIS_AUTH_DATABASE_URL: "postgres://jarvis_auth_runtime:auth-secret@db/prod",
      JARVIS_WORKER_DATABASE_URL: "postgres://jarvis_worker_runtime:worker-secret@db/prod"
    } as NodeJS.ProcessEnv;
    const plan = buildRolePasswordPlan(getMossDatabaseUrls(env), env);
    expect(plan.map((e) => e.password)).toEqual([
      "mig-secret",
      "app-secret",
      "worker-secret",
      "auth-secret"
    ]);
  });

  it("percent-decodes role passwords so they match what the pg driver authenticates with", () => {
    // The configured password is `p@ss:w%rd` (reserved `@`/`:` plus a literal `%`), which is
    // percent-encoded in the URL userinfo as `p%40ss%3Aw%25rd`. The pg driver decodes this with
    // decodeURIComponent at connect time, so the bootstrap must ALTER ROLE with the decoded value
    // or the runtime role can never authenticate.
    const env = {
      NODE_ENV: "production",
      JARVIS_BOOTSTRAP_DATABASE_URL: "postgres://postgres:rootpw@db/prod",
      JARVIS_MIGRATION_DATABASE_URL: "postgres://jarvis_migration_owner:p%40ss%3Aw%25rd@db/prod",
      JARVIS_APP_DATABASE_URL: "postgres://jarvis_app_runtime:app-secret@db/prod",
      JARVIS_AUTH_DATABASE_URL: "postgres://jarvis_auth_runtime:auth-secret@db/prod",
      JARVIS_WORKER_DATABASE_URL: "postgres://jarvis_worker_runtime:worker-secret@db/prod"
    } as NodeJS.ProcessEnv;
    const plan = buildRolePasswordPlan(getMossDatabaseUrls(env), env);
    const migration = plan.find((e) => e.role === "jarvis_migration_owner");
    expect(migration?.password).toBe("p@ss:w%rd");
  });

  it("refuses in production when a role password is missing", () => {
    const env = {
      NODE_ENV: "production",
      JARVIS_BOOTSTRAP_DATABASE_URL: "postgres://postgres:rootpw@db/prod",
      JARVIS_MIGRATION_DATABASE_URL: "postgres://migration.example/prod",
      JARVIS_APP_DATABASE_URL: "postgres://jarvis_app_runtime:app-secret@db/prod",
      JARVIS_AUTH_DATABASE_URL: "postgres://jarvis_auth_runtime:auth-secret@db/prod",
      JARVIS_WORKER_DATABASE_URL: "postgres://jarvis_worker_runtime:worker-secret@db/prod"
    } as NodeJS.ProcessEnv;
    expect(() => buildRolePasswordPlan(getMossDatabaseUrls(env), env)).toThrow(
      /jarvis_migration_owner/
    );
  });

  it("refuses in production when a role password is still a development default", () => {
    const env = {
      NODE_ENV: "production",
      JARVIS_BOOTSTRAP_DATABASE_URL: "postgres://postgres:rootpw@db/prod",
      JARVIS_MIGRATION_DATABASE_URL: "postgres://jarvis_migration_owner:migration_password@db/prod",
      JARVIS_APP_DATABASE_URL: "postgres://jarvis_app_runtime:app-secret@db/prod",
      JARVIS_AUTH_DATABASE_URL: "postgres://jarvis_auth_runtime:auth-secret@db/prod",
      JARVIS_WORKER_DATABASE_URL: "postgres://jarvis_worker_runtime:worker-secret@db/prod"
    } as NodeJS.ProcessEnv;
    expect(() => buildRolePasswordPlan(getMossDatabaseUrls(env), env)).toThrow(
      /jarvis_migration_owner.*development-default/
    );
    expect(RUNTIME_ROLE_PASSWORD_DEFAULTS.has("app_password")).toBe(true);
  });
});

describe("buildAlterRoleStatement", () => {
  it("escapes the identifier and password literal", () => {
    const sql = buildAlterRoleStatement({
      role: "jarvis_app_runtime",
      password: "a'b\\c"
    });
    expect(sql).toContain('"jarvis_app_runtime"');
    expect(sql).toContain("WITH LOGIN PASSWORD ");
    // The raw, unescaped password must never appear verbatim in the statement.
    expect(sql).not.toContain("a'b\\c");
  });
});

// #1632: ALTER ROLE is cluster-global DDL, so it must run on the cluster-DDL lock's owner
// session rather than a connection of its own.
describe("applyRolePasswords under the cluster DDL lock", () => {
  it("runs every ALTER ROLE on the lock-owner session and opens no other client", async () => {
    const harness = createFakeLockHarness();

    await applyRolePasswords(
      "postgres://postgres:rootpw@db:5432/moss",
      [
        { role: "jarvis_app_runtime", password: "app-secret" },
        { role: "jarvis_worker_runtime", password: "worker-secret" }
      ],
      harness.options
    );

    const texts = harness.owner.texts;
    expect(texts[0]).toContain("pg_advisory_lock");
    expect(texts.at(-1)).toContain("pg_advisory_unlock");
    expect(texts).toContain(`ALTER ROLE "jarvis_app_runtime" WITH LOGIN PASSWORD 'app-secret'`);
    expect(texts).toContain(
      `ALTER ROLE "jarvis_worker_runtime" WITH LOGIN PASSWORD 'worker-secret'`
    );
    expect(harness.owner.connectCalls).toBe(1);
    // #1632 fix: the owner session executes the ALTER ROLE DDL directly, so it must stay on the
    // caller's real target database (moss) — only the heartbeat probe (never DDL) uses the
    // maintenance-DB swap (postgres).
    expect(harness.connectionStrings).toEqual([
      "postgres://postgres:rootpw@db:5432/moss",
      "postgres://postgres:rootpw@db:5432/postgres"
    ]);
  });
});

describe("bootstrap SQL", () => {
  it("contains no committed Jarvis role-password literals", async () => {
    const bootstrapDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../infra/postgres/bootstrap"
    );
    const files = (await readdir(bootstrapDir)).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const sql = await readFile(join(bootstrapDir, file), "utf8");
      for (const literal of RUNTIME_ROLE_PASSWORD_DEFAULTS) {
        expect(sql, `${file} must not contain ${literal}`).not.toContain(literal);
      }
      expect(sql, `${file} must not assign role passwords`).not.toMatch(/PASSWORD\s+'/i);
    }
  });
});
