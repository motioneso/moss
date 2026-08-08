// Requires a live dev Postgres (JARVIS_MIGRATION_DATABASE_URL) — run against the
// per-agent database used by the foundation gate.
import { afterEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase } from "../database.js";
import { getMossDatabaseUrls } from "../urls.js";
import type { MossDatabase } from "../types.js";
import {
  assertOperatorConfirmsTargetOwner,
  NoBootstrapOwnerFoundError,
  TargetIdentityMismatchError
} from "../target-identity-guard.js";

const OWNER_ID = "00000000-0000-4000-8000-000000001383";
const OWNER_EMAIL = "owner-1383@example.com";

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
});
