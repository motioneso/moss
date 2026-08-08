/**
 * #1383: sanctioned recovery path for a locked-out bootstrap owner. This is the ONLY approved
 * way to reset the bootstrap owner's password outside the app's own auth flows — it exists so
 * nobody reaches for an ad-hoc script (like the one that caused #1383) that writes
 * app.auth_accounts directly against whatever JARVIS_PG* the shell happens to have exported.
 *
 * Connects as jarvis_migration_owner (never the bootstrap superuser), and before touching any
 * credential requires the operator to name the target database's actual bootstrap-owner email
 * back (assertOperatorConfirmsTargetOwner, packages/db/src/target-identity-guard.ts) — proving
 * identity against the target itself, not a fingerprint the operator could have gotten wrong
 * by pointing at the wrong instance in the first place.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "@moss/auth";
import { assertOperatorConfirmsTargetOwner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { sql } from "kysely";

const MIN_PASSWORD_LENGTH = 8;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.execute) {
    throw new Error(
      "Usage: pnpm admin:reset-password -- --execute [--confirm-owner-email <email>] " +
        "[--password <new password>]\n" +
        "Both flags are prompted for interactively when omitted. There is no dry-run mode: " +
        "this script performs exactly one guarded write."
    );
  }

  const db = createDatabase({ connectionString: getMossDatabaseUrls().migration });

  try {
    const confirmedOwnerEmail =
      args.confirmOwnerEmail ?? (await promptFor("Target bootstrap owner email: "));
    const owner = await assertOperatorConfirmsTargetOwner(db, confirmedOwnerEmail);

    const password = args.password ?? (await promptFor("New password: "));
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const passwordHash = await hashPassword(password);
    const auditEventId = randomUUID();

    await db.transaction().execute(async (trx) => {
      // 0045_auth_secret_rls.sql scopes app.auth_accounts to jarvis_auth_runtime under FORCE
      // RLS; jarvis_migration_owner can satisfy that policy via SET LOCAL ROLE because it is a
      // member of jarvis_auth_runtime (infra/postgres/bootstrap/0000_roles.sql). SET LOCAL only
      // holds for this transaction, so the switch and the UPDATE must share one connection.
      await sql`SET LOCAL ROLE jarvis_auth_runtime`.execute(trx);
      const updated = await trx
        .updateTable("app.auth_accounts")
        .set({ password: passwordHash, updated_at: new Date() })
        .where("provider_id", "=", "credential")
        .where("account_id", "=", owner.id)
        .executeTakeFirst();

      const numUpdatedRows = updated?.numUpdatedRows ?? 0n;
      if (numUpdatedRows !== 1n) {
        throw new Error(
          `Expected exactly one credential account for user ${owner.id}, updated ` +
            `${numUpdatedRows.toString()}.`
        );
      }

      await sql`RESET ROLE`.execute(trx);

      // Back on jarvis_migration_owner here, which satisfies 0184's scoped INSERT policy
      // (packages/settings/sql/0184_admin_reset_password_audit_insert.sql).
      await trx
        .insertInto("app.admin_audit_events")
        .values({
          id: auditEventId,
          actor_user_id: null,
          action: "admin_password_reset",
          target_type: "user",
          target_id: owner.id,
          metadata: { script: "scripts/admin-reset-password.ts" },
          request_id: `admin-reset-password:${auditEventId}`,
          created_at: new Date()
        })
        .execute();
    });

    console.log(`Password reset for ${owner.email} (${owner.id}). Audit event ${auditEventId}.`);
  } finally {
    await db.destroy();
  }
}

function parseArgs(args: readonly string[]): {
  readonly confirmOwnerEmail?: string;
  readonly execute: boolean;
  readonly password?: string;
} {
  return {
    confirmOwnerEmail: readFlag(args, "--confirm-owner-email"),
    execute: args.includes("--execute"),
    password: readFlag(args, "--password")
  };
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

async function promptFor(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Run only when executed directly (`tsx scripts/admin-reset-password.ts`) — mirrors the guard
// convention of the other operator scripts (see delete-user-data-cli.ts).
const isThisModuleEntry =
  import.meta.url.endsWith("admin-reset-password.ts") ||
  import.meta.url.endsWith("admin-reset-password.js");
if (
  isThisModuleEntry &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
