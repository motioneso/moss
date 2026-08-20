// Requires a live dev Postgres (JARVIS_MIGRATION_DATABASE_URL) — run against the
// per-agent database used by the foundation gate.
import { afterEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase } from "../database.js";
import { getMossDatabaseUrls } from "../urls.js";
import type { MossDatabase } from "../types.js";
import {
  AmbiguousBootstrapOwnerError,
  assertOperatorConfirmsTargetOwner,
  NoBootstrapOwnerFoundError,
  TargetIdentityMismatchError
} from "../target-identity-guard.js";

const OWNER_ID = "00000000-0000-4000-8000-000000001383";
const OWNER_EMAIL = "owner-1383@example.com";
const SECOND_OWNER_ID = "00000000-0000-4000-8000-000000001721";
const SECOND_OWNER_EMAIL = "owner-1721@example.com";

function createMigrationOwnerDb(): Kysely<MossDatabase> {
  return createDatabase({ connectionString: getMossDatabaseUrls().migration });
}

async function deleteTestUsers(): Promise<void> {
  const db = createMigrationOwnerDb();
  try {
    await db.deleteFrom("app.users").where("id", "in", [OWNER_ID, SECOND_OWNER_ID]).execute();
  } finally {
    await db.destroy();
  }
}

afterEach(deleteTestUsers);

describe("assertOperatorConfirmsTargetOwner", () => {
  it("fails closed when the target has no bootstrap owner", async () => {
    const db = createMigrationOwnerDb();
    try {
      await expect(assertOperatorConfirmsTargetOwner(db, OWNER_EMAIL)).rejects.toThrow(
        NoBootstrapOwnerFoundError
      );
    } finally {
      await db.destroy();
    }
  });

  it("refuses when no confirmation is supplied", async () => {
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

      await expect(assertOperatorConfirmsTargetOwner(db, undefined)).rejects.toThrow(
        TargetIdentityMismatchError
      );
    } finally {
      await db.destroy();
    }
  });

  it("refuses when the confirmation does not match the target's actual owner", async () => {
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

      await expect(
        assertOperatorConfirmsTargetOwner(db, "wrong-guess@example.com")
      ).rejects.toThrow(TargetIdentityMismatchError);
    } finally {
      await db.destroy();
    }
  });

  it("allows the operator through when the confirmation matches the target's actual owner", async () => {
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

      await expect(assertOperatorConfirmsTargetOwner(db, OWNER_EMAIL)).resolves.toEqual({
        id: OWNER_ID,
        email: OWNER_EMAIL
      });
    } finally {
      await db.destroy();
    }
  });

  // #1721: the guard used to take whichever flagged row the database handed back first, with no
  // ordering. Both owners' emails would then pass on some runs and fail on others — a guard that
  // protects destructive operations cannot let the answer depend on physical row order. Refusing
  // is the only safe reading of "more than one owner", because the confirmation email no longer
  // identifies a single instance.
  it("refuses when the target has more than one bootstrap owner, whichever email is supplied", async () => {
    const db = createMigrationOwnerDb();
    try {
      await db
        .insertInto("app.users")
        .values([
          {
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
          },
          {
            id: SECOND_OWNER_ID,
            email: SECOND_OWNER_EMAIL,
            name: "Second bootstrap owner",
            email_verified: true,
            image: null,
            is_instance_admin: true,
            is_bootstrap_owner: true,
            status: "active",
            created_at: new Date(1000),
            updated_at: new Date(1000)
          }
        ])
        .execute();

      // Both, not just one: a guard that accepted the "first" owner would still pass this test
      // if it only checked the other email.
      await expect(assertOperatorConfirmsTargetOwner(db, OWNER_EMAIL)).rejects.toThrow(
        AmbiguousBootstrapOwnerError
      );
      await expect(assertOperatorConfirmsTargetOwner(db, SECOND_OWNER_EMAIL)).rejects.toThrow(
        AmbiguousBootstrapOwnerError
      );

      // The operator has to be able to act on this, which means knowing who the owners are.
      await expect(assertOperatorConfirmsTargetOwner(db, OWNER_EMAIL)).rejects.toThrow(
        new RegExp(`${OWNER_EMAIL}.*${SECOND_OWNER_EMAIL}`)
      );
    } finally {
      await db.destroy();
    }
  });
});
