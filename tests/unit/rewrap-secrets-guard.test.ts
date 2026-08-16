// Requires a live dev Postgres (JARVIS_MIGRATION_DATABASE_URL) — proves scripts/rewrap-secrets.ts
// is wired to the real #1383 guard, not re-deriving the guard's own logic already covered by
// packages/db/src/__tests__/target-identity-guard.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase, getMossDatabaseUrls, TargetIdentityMismatchError } from "@moss/db";
import type { MossDatabase } from "@moss/db";

import { assertRewrapTargetIdentity } from "../../scripts/rewrap-secrets.js";

const OWNER_ID = "00000000-0000-4000-8000-000000001468";
const OWNER_EMAIL = "owner-1468@example.com";

function createMigrationOwnerDb(): Kysely<MossDatabase> {
  return createDatabase({ connectionString: getMossDatabaseUrls().migration });
}

async function deleteTestUsers(): Promise<void> {
  const db = createMigrationOwnerDb();
  try {
    await db.deleteFrom("app.users").where("id", "=", OWNER_ID).execute();
  } finally {
    await db.destroy();
  }
}

afterEach(deleteTestUsers);

describe("assertRewrapTargetIdentity", () => {
  it("rejects a mismatched confirmation email, proving the caller is wired to the real guard", async () => {
    const db = createMigrationOwnerDb();
    try {
      await db
        .insertInto("app.users")
        .values({
          id: OWNER_ID,
          email: OWNER_EMAIL,
          name: "Bootstrap owner",
          email_verified: true,
          image: null,
          is_instance_admin: true,
          is_bootstrap_owner: true,
          status: "active",
          created_at: new Date(0),
          updated_at: new Date(0)
        })
        .execute();

      await expect(assertRewrapTargetIdentity(db, "wrong@example.com")).rejects.toThrow(
        TargetIdentityMismatchError
      );
    } finally {
      await db.destroy();
    }
  });
});
