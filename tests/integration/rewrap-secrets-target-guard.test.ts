// Proves scripts/rewrap-secrets.ts is wired to the real #1383 guard, not re-deriving the guard's
// own logic already covered by packages/db/src/__tests__/target-identity-guard.test.ts. Requires
// a live dev Postgres — run via the root `pnpm vitest run tests/integration/rewrap-secrets-target-guard.test.ts`
// against an isolated gate database (never `pnpm --filter`), per test-database.ts's isolation
// guard.
//
// #1468: originally landed under tests/unit/, which runs before `db:migrate` in
// verify:foundation — `app.users` doesn't exist yet at that point, so a real-DB test there fails
// deterministically. Relocated alongside the other #1468 target-guard integration tests.
import { beforeEach, describe, expect, it } from "vitest";

import { createDatabase, TargetIdentityMismatchError } from "@moss/db";

import { assertRewrapTargetIdentity } from "../../scripts/rewrap-secrets.js";
import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

describe("assertRewrapTargetIdentity", () => {
  beforeEach(resetEmptyFoundationDatabase);

  it("rejects a mismatched confirmation email, proving the caller is wired to the real guard", async () => {
    const db = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      await db
        .insertInto("app.users")
        .values({
          id: ids.userA,
          email: "owner-1468@example.com",
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
