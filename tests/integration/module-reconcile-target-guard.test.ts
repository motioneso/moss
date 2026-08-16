// #1468: extends #1383's target-identity guard to scripts/module-reconcile.ts. Requires a live
// dev Postgres — run via the root `pnpm vitest run tests/integration/module-reconcile-target-guard.test.ts`
// against an isolated gate database (never `pnpm --filter`), per test-database.ts's isolation guard.
import { beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { TargetIdentityMismatchError } from "@moss/db";
import { assertReconcileTargetIdentity } from "../../scripts/module-reconcile.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const OWNER_ID = "00000000-0000-4000-8000-000000001468";
const OWNER_EMAIL = "owner-1468@example.test";
const OTHER_ID = "00000000-0000-4000-8000-000000001469";
const OTHER_EMAIL = "other-1468@example.test";
const ENV_VAR = "MOSS_RECONCILE_CONFIRM_OWNER_EMAIL";

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

describe("assertReconcileTargetIdentity", () => {
  beforeEach(resetEmptyFoundationDatabase);

  it("resolves an un-provisioned target (trusted role, genuinely empty app.users) without requiring the env var", async () => {
    await withClient(connectionStrings.bootstrap, async (client) => {
      await expect(assertReconcileTargetIdentity(client, {})).resolves.toBeUndefined();
    });
  });

  it("refuses an un-provisioned-looking target when the connected role is not trusted", async () => {
    // app.users is empty (beforeEach reset), but jarvis_app_runtime is NOSUPERUSER,
    // NOBYPASSRLS, and does not own app.users (jarvis_migration_owner does) — an
    // unprivileged connection must not be able to forge the un-provisioned exception.
    await withClient(connectionStrings.app, async (client) => {
      await expect(assertReconcileTargetIdentity(client, {})).rejects.toThrow(
        TargetIdentityMismatchError
      );
    });
  });

  it("rejects when the confirmation env var is unset and a bootstrap owner exists", async () => {
    await insertUser({ id: OWNER_ID, email: OWNER_EMAIL, isBootstrapOwner: true });

    await withClient(connectionStrings.bootstrap, async (client) => {
      await expect(assertReconcileTargetIdentity(client, {})).rejects.toThrow(
        TargetIdentityMismatchError
      );
    });
  });

  it("rejects when the confirmation env var does not match the target's actual owner", async () => {
    await insertUser({ id: OWNER_ID, email: OWNER_EMAIL, isBootstrapOwner: true });

    await withClient(connectionStrings.bootstrap, async (client) => {
      await expect(
        assertReconcileTargetIdentity(client, { [ENV_VAR]: "wrong@example.test" })
      ).rejects.toThrow(TargetIdentityMismatchError);
    });
  });

  it("resolves when the confirmation env var matches the target's actual bootstrap owner", async () => {
    await insertUser({ id: OWNER_ID, email: OWNER_EMAIL, isBootstrapOwner: true });

    await withClient(connectionStrings.bootstrap, async (client) => {
      await expect(
        assertReconcileTargetIdentity(client, { [ENV_VAR]: OWNER_EMAIL })
      ).resolves.toBeUndefined();
    });
  });

  it("refuses a populated app.users with no flagged bootstrap owner, not taking the un-provisioned exception", async () => {
    // A row exists but is_bootstrap_owner is false — this must NOT be treated as
    // "empty table" (the un-provisioned exception requires COUNT(*) = 0, not merely
    // "no bootstrap-owner row found") — a populated-but-untagged table is a broken or
    // tampered state, not a fresh install, so it must still refuse.
    await insertUser({ id: OTHER_ID, email: OTHER_EMAIL, isBootstrapOwner: false });

    await withClient(connectionStrings.bootstrap, async (client) => {
      await expect(
        assertReconcileTargetIdentity(client, { [ENV_VAR]: OTHER_EMAIL })
      ).rejects.toThrow(TargetIdentityMismatchError);
    });
  });
});
