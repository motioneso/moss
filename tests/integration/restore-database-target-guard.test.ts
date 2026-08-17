// #1468: extends #1383's target-identity guard to scripts/restore-database.ts. Requires a live
// dev Postgres — run via the root `pnpm vitest run tests/integration/restore-database-target-guard.test.ts`
// against an isolated gate database (never `pnpm --filter`), per test-database.ts's isolation guard.
import { beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createDatabase, NoBootstrapOwnerFoundError, TargetIdentityMismatchError } from "@moss/db";
import { assertRestoreTargetIdentity } from "../../scripts/restore-database.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const OWNER_ID = "00000000-0000-4000-8000-000000001470";
const OWNER_EMAIL = "owner-1468-restore@example.test";

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function insertUser(input: {
  readonly id: string;
  readonly email: string;
  readonly isBootstrapOwner?: boolean;
}): Promise<void> {
  await withClient(connectionStrings.bootstrap, (client) =>
    client.query(`INSERT INTO app.users (id, email, is_bootstrap_owner) VALUES ($1, $2, $3)`, [
      input.id,
      input.email,
      input.isBootstrapOwner ?? false
    ])
  );
}

describe("assertRestoreTargetIdentity", () => {
  beforeEach(resetEmptyFoundationDatabase);

  it("rejects a restore pointed at a target whose bootstrap owner doesn't match the confirmation", async () => {
    await insertUser({ id: OWNER_ID, email: OWNER_EMAIL, isBootstrapOwner: true });

    const db = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      await expect(
        assertRestoreTargetIdentity(db, { confirmOwnerEmail: "wrong@example.test" })
      ).rejects.toThrow(TargetIdentityMismatchError);
    } finally {
      await db.destroy();
    }
  });

  it("allows a restore through when the confirmation matches the target's bootstrap owner", async () => {
    await insertUser({ id: OWNER_ID, email: OWNER_EMAIL, isBootstrapOwner: true });

    const db = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      await expect(
        assertRestoreTargetIdentity(db, { confirmOwnerEmail: OWNER_EMAIL })
      ).resolves.toEqual({ id: OWNER_ID, email: OWNER_EMAIL });
    } finally {
      await db.destroy();
    }
  });

  it("rejects a restore into a target with no bootstrap owner unless --allow-empty-target is set", async () => {
    // A populated app.users with no row flagged is_bootstrap_owner — schema exists, has rows,
    // but nothing to confirm identity against.
    await insertUser({ id: OWNER_ID, email: OWNER_EMAIL, isBootstrapOwner: false });

    const db = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      await expect(
        assertRestoreTargetIdentity(db, { confirmOwnerEmail: OWNER_EMAIL })
      ).rejects.toThrow(NoBootstrapOwnerFoundError);

      await expect(
        assertRestoreTargetIdentity(db, { confirmOwnerEmail: OWNER_EMAIL, allowEmptyTarget: true })
      ).resolves.toBeNull();
    } finally {
      await db.destroy();
    }
  });
});
