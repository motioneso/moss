import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Kysely } from "kysely";
import pg from "pg";

import { createDatabase, type MossDatabase } from "@moss/db";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #1383 pin-down test: confirms 0045_auth_secret_rls.sql's grants currently block
// jarvis_app_runtime and jarvis_worker_runtime from writing app.auth_accounts, and that
// jarvis_auth_runtime (the only role granted access) can. This is honest about what it does
// NOT prove: #1383's actual incident vector was a script connecting with the bootstrap
// superuser role, which bypasses FORCE ROW LEVEL SECURITY (and every grant) unconditionally —
// no RLS policy or grant can constrain a superuser connection. That is why the real fix for
// #1383 is packages/db/src/target-identity-guard.ts, applied at the operator-script layer
// before any bootstrap-connection write, not a tighter RLS policy here. This test only
// documents the (real, but narrower) protection RLS already gives the app/worker roles.

const userId = "00000000-0000-4000-8000-000000001384";
const userEmail = "auth-accounts-write-rls@example.test";

let appDb: Kysely<MossDatabase>;
let authDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status)
       VALUES ($1, $2, 'Auth Accounts Write RLS', false, false, 'active')`,
      [userId, userEmail]
    );
  } finally {
    await client.end();
  }

  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  authDb = createDatabase({ connectionString: connectionStrings.auth, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });

  // Seed the credential row as jarvis_auth_runtime itself — the only role with any grant on
  // this table (0045_auth_secret_rls.sql) — rather than reaching for a raw bootstrap insert.
  await authDb
    .insertInto("app.auth_accounts")
    .values({
      id: "00000000-0000-4000-8000-000000001385",
      account_id: userId,
      provider_id: "credential",
      user_id: userId,
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      password: "seed-hash-not-a-real-credential",
      created_at: new Date(0),
      updated_at: new Date(0)
    })
    .execute();
});

afterAll(async () => {
  await Promise.allSettled([appDb?.destroy(), authDb?.destroy(), workerDb?.destroy()]);
});

describe("app.auth_accounts write RLS (#1383 pin-down)", () => {
  it("jarvis_app_runtime is denied writing to app.auth_accounts", async () => {
    await expect(
      appDb
        .updateTable("app.auth_accounts")
        .set({ password: "attempted-app-runtime-write" })
        .where("provider_id", "=", "credential")
        .where("account_id", "=", userId)
        .execute()
    ).rejects.toThrow(/permission denied/i);
  });

  it("jarvis_worker_runtime is denied writing to app.auth_accounts", async () => {
    await expect(
      workerDb
        .updateTable("app.auth_accounts")
        .set({ password: "attempted-worker-runtime-write" })
        .where("provider_id", "=", "credential")
        .where("account_id", "=", userId)
        .execute()
    ).rejects.toThrow(/permission denied/i);
  });

  it("jarvis_auth_runtime (the sanctioned role) can write to app.auth_accounts", async () => {
    await authDb
      .updateTable("app.auth_accounts")
      .set({ password: "auth-runtime-write-ok" })
      .where("provider_id", "=", "credential")
      .where("account_id", "=", userId)
      .execute();

    const row = await authDb
      .selectFrom("app.auth_accounts")
      .select(["password"])
      .where("provider_id", "=", "credential")
      .where("account_id", "=", userId)
      .executeTakeFirstOrThrow();

    expect(row.password).toBe("auth-runtime-write-ok");
  });
});
