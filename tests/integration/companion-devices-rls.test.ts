import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// The two Trail Marker tables hold a pairing verifier hash and a companion credential hash
// (#2560). Only the auth runtime role may touch them. If a module or a background job could
// read app.companion_devices, a credential hash would leave the auth boundary — so these
// assertions are the boundary, not a description of it.

const userId = "00000000-0000-4000-8000-000000002560";
const userEmail = "companion-devices-rls@example.test";

const clients: pg.Client[] = [];

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new Client({ connectionString });
  await client.connect();
  clients.push(client);
  return client;
}

let bootstrapClient: pg.Client;
let authClient: pg.Client;
let appClient: pg.Client;
let workerClient: pg.Client;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  bootstrapClient = await connect(connectionStrings.bootstrap);
  await bootstrapClient.query(
    `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status)
     VALUES ($1, $2, 'Companion RLS', false, false, 'active')`,
    [userId, userEmail]
  );

  authClient = await connect(connectionStrings.auth);
  appClient = await connect(connectionStrings.app);
  workerClient = await connect(connectionStrings.worker);
});

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.end()));
});

describe("app.companion_devices and app.companion_pair_attempts are auth-runtime only", () => {
  it("the auth runtime can insert and read a companion device", async () => {
    await authClient.query(
      `INSERT INTO app.companion_devices
         (user_id, credential_hash, display_name, platform, app_version, os_version,
          expires_at, absolute_expires_at)
       VALUES ($1, 'hash-not-a-real-credential', 'Studio Mac', 'macos', '1.0.0', '14.5',
               now() + interval '90 days', now() + interval '365 days')`,
      [userId]
    );

    const result = await authClient.query<{ display_name: string }>(
      `SELECT display_name FROM app.companion_devices WHERE user_id = $1`,
      [userId]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.display_name).toBe("Studio Mac");
  });

  it("the app runtime cannot read companion devices", async () => {
    await expect(appClient.query("SELECT * FROM app.companion_devices")).rejects.toThrow(
      /permission denied/i
    );
  });

  it("the worker runtime cannot read companion devices", async () => {
    await expect(workerClient.query("SELECT * FROM app.companion_devices")).rejects.toThrow(
      /permission denied/i
    );
  });

  it("the app runtime cannot read pairing attempts", async () => {
    await expect(appClient.query("SELECT * FROM app.companion_pair_attempts")).rejects.toThrow(
      /permission denied/i
    );
  });

  it("the worker runtime cannot read pairing attempts", async () => {
    await expect(workerClient.query("SELECT * FROM app.companion_pair_attempts")).rejects.toThrow(
      /permission denied/i
    );
  });

  it("both tables force row level security", async () => {
    const result = await bootstrapClient.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app'
          AND c.relname IN ('companion_devices', 'companion_pair_attempts')
        ORDER BY c.relname`
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("deleting the account removes its companion devices", async () => {
    await bootstrapClient.query("DELETE FROM app.users WHERE id = $1", [userId]);
    const result = await authClient.query(
      "SELECT 1 FROM app.companion_devices WHERE user_id = $1",
      [userId]
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe("companion table constraints", () => {
  const otherUserId = "00000000-0000-4000-8000-000000002561";

  beforeAll(async () => {
    await bootstrapClient.query(
      `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status)
       VALUES ($1, 'companion-constraints@example.test', 'Companion Constraints', false, false, 'active')`,
      [otherUserId]
    );
  });

  it("rejects an empty or over-long display name", async () => {
    const insert = (displayName: string) =>
      authClient.query(
        `INSERT INTO app.companion_devices
           (user_id, credential_hash, display_name, platform, app_version, os_version,
            expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, 'macos', '1.0.0', '14.5',
                 now() + interval '90 days', now() + interval '365 days')`,
        [otherUserId, `hash-${displayName.length}-${Math.random()}`, displayName]
      );

    await expect(insert("")).rejects.toThrow();
    await expect(insert("x".repeat(65))).rejects.toThrow();
  });

  it("rejects a second device reusing the same credential hash", async () => {
    const values = (hash: string) =>
      authClient.query(
        `INSERT INTO app.companion_devices
           (user_id, credential_hash, display_name, platform, app_version, os_version,
            expires_at, absolute_expires_at)
         VALUES ($1, $2, 'Duplicate Hash', 'macos', '1.0.0', '14.5',
                 now() + interval '90 days', now() + interval '365 days')`,
        [otherUserId, hash]
      );

    await values("shared-hash-value");
    await expect(values("shared-hash-value")).rejects.toThrow(/duplicate key/i);
  });

  it("rejects a decided pairing attempt with no account bound to it", async () => {
    await expect(
      authClient.query(
        `INSERT INTO app.companion_pair_attempts
           (approval_code_hash, verifier_hash, device_name, platform, app_version, os_version,
            status, expires_at)
         VALUES ('code-hash-1', 'verifier-hash-1', 'Orphan Mac', 'macos', '1.0.0', '14.5',
                 'approved', now() + interval '10 minutes')`
      )
    ).rejects.toThrow();
  });

  it("rejects a pairing attempt status outside the known set", async () => {
    await expect(
      authClient.query(
        `INSERT INTO app.companion_pair_attempts
           (approval_code_hash, verifier_hash, device_name, platform, app_version, os_version,
            status, user_id, expires_at)
         VALUES ('code-hash-2', 'verifier-hash-2', 'Bad Status Mac', 'macos', '1.0.0', '14.5',
                 'linked', $1, now() + interval '10 minutes')`,
        [otherUserId]
      )
    ).rejects.toThrow();
  });
});
