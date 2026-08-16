/**
 * Operator script: re-encrypt all connector and AI secrets with the current key.
 *
 * IMPORTANT: Stop the API and worker processes before running this script.
 * A concurrent token-refresh or credential-update can overwrite a rewrapped row
 * with stale plaintext if the application is running during the rewrap.
 *
 * Run this after rotating JARVIS_*_SECRET_KEY_ID to force-rewrap every row so
 * the old key can be retired from the keyring promptly. Safe to run multiple
 * times — it is idempotent (already-current envelopes get re-encrypted with
 * the same key, which is a no-op in practice).
 *
 * Usage:
 *   JARVIS_CONNECTOR_SECRET_KEY=... JARVIS_AI_SECRET_KEY=... \
 *   JARVIS_CONNECTOR_SECRET_KEYS='{"v1":"old"}' JARVIS_AI_SECRET_KEYS='{"v1":"old"}' \
 *   JARVIS_CONNECTOR_SECRET_KEY_ID=v2 JARVIS_AI_SECRET_KEY_ID=v2 \
 *   pnpm tsx scripts/rewrap-secrets.ts --confirm-owner-email <target's bootstrap owner email>
 *
 * --confirm-owner-email proves this run is pointed at the instance the operator thinks it is
 * (#1383) — the target's actual bootstrap-owner email, not a hardcoded fingerprint.
 *
 * See docs/operations/secret-key-rotation.md for the full runbook.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createConnectorSecretCipher } from "@moss/connectors";
import {
  assertOperatorConfirmsTargetOwner,
  DataContextRunner,
  createDatabase,
  getMossDatabaseUrls,
  type MossDatabase
} from "@moss/db";
import type { Kysely } from "kysely";
import { createAiSecretCipher } from "@moss/ai";

export async function assertRewrapTargetIdentity(
  db: Kysely<MossDatabase>,
  confirmOwnerEmail: string | undefined
): Promise<void> {
  await assertOperatorConfirmsTargetOwner(db, confirmOwnerEmail);
}

function parseArgs(args: readonly string[]): { readonly confirmOwnerEmail?: string } {
  return { confirmOwnerEmail: readFlag(args, "--confirm-owner-email") };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = createDatabase({ connectionString: getMossDatabaseUrls().bootstrap });
  await assertRewrapTargetIdentity(db, args.confirmOwnerEmail);
  const connectorCipher = createConnectorSecretCipher();
  const aiCipher = createAiSecretCipher();
  const dataContext = new DataContextRunner(db);

  // Enumerate distinct owner user ids from both tables (root query, no RLS)
  const connectorOwners = await db
    .selectFrom("app.connector_accounts")
    .select("owner_user_id")
    .distinct()
    .execute();

  const connectorPendingOwners = await db
    .selectFrom("app.connector_oauth_pending")
    .select("owner_user_id")
    .distinct()
    .execute();

  const aiOwners = await db
    .selectFrom("app.ai_provider_configs")
    .select("owner_user_id")
    .distinct()
    .execute();

  const allUserIds = new Set<string>([
    ...connectorOwners.map((r) => r.owner_user_id),
    ...connectorPendingOwners.map((r) => r.owner_user_id),
    ...aiOwners.map((r) => r.owner_user_id)
  ]);

  console.log(`Rewrapping secrets for ${allUserIds.size} user(s)…`);

  let connectorRewrapped = 0;
  let connectorPendingRewrapped = 0;
  let aiRewrapped = 0;
  let skipped = 0;

  for (const userId of allUserIds) {
    const accessContext = { actorUserId: userId, requestId: randomUUID() };

    await dataContext.withDataContext(accessContext, async (scopedDb) => {
      // Rewrap connector_accounts — FOR UPDATE locks rows against concurrent writes
      const connectorRows = await scopedDb.db
        .selectFrom("app.connector_accounts")
        .select(["id", "encrypted_secret"])
        .forUpdate()
        .execute();

      for (const row of connectorRows) {
        try {
          const envelope = connectorCipher.parseEnvelope(row.encrypted_secret);
          const plaintext = connectorCipher.decryptJson(envelope);
          const rewrapped = connectorCipher.encryptJson(plaintext);
          await scopedDb.db
            .updateTable("app.connector_accounts")
            .set({ encrypted_secret: rewrapped })
            .where("id", "=", row.id)
            .execute();
          connectorRewrapped++;
          console.log(`  connector_accounts row ${row.id} — rewrapped → keyId:${rewrapped.keyId}`);
        } catch (err) {
          skipped++;
          console.error(
            `  connector_accounts row ${row.id} SKIPPED: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Rewrap connector_oauth_pending
      const pendingRows = await scopedDb.db
        .selectFrom("app.connector_oauth_pending")
        .select(["id", "encrypted_secret"])
        .forUpdate()
        .execute();

      for (const row of pendingRows) {
        try {
          const envelope = connectorCipher.parseEnvelope(row.encrypted_secret);
          const plaintext = connectorCipher.decryptJson(envelope);
          const rewrapped = connectorCipher.encryptJson(plaintext);
          await scopedDb.db
            .updateTable("app.connector_oauth_pending")
            .set({ encrypted_secret: rewrapped })
            .where("id", "=", row.id)
            .execute();
          connectorPendingRewrapped++;
          console.log(
            `  connector_oauth_pending row ${row.id} — rewrapped → keyId:${rewrapped.keyId}`
          );
        } catch (err) {
          skipped++;
          console.error(
            `  connector_oauth_pending row ${row.id} SKIPPED: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Rewrap ai_provider_configs
      const aiRows = await scopedDb.db
        .selectFrom("app.ai_provider_configs")
        .select(["id", "encrypted_credential"])
        .where("encrypted_credential", "is not", null)
        .forUpdate()
        .execute();

      for (const row of aiRows) {
        if (!row.encrypted_credential) continue;
        try {
          const envelope = aiCipher.parseEnvelope(row.encrypted_credential);
          const plaintext = aiCipher.decryptJson(envelope);
          const rewrapped = aiCipher.encryptJson(plaintext);
          await scopedDb.db
            .updateTable("app.ai_provider_configs")
            .set({ encrypted_credential: rewrapped })
            .where("id", "=", row.id)
            .execute();
          aiRewrapped++;
          console.log(`  ai_provider_configs row ${row.id} — rewrapped → keyId:${rewrapped.keyId}`);
        } catch (err) {
          skipped++;
          console.error(
            `  ai_provider_configs row ${row.id} SKIPPED: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    });
  }

  const skippedSuffix = skipped > 0 ? ` — ${skipped} row(s) SKIPPED (check errors above)` : "";
  console.log(
    `Done. Rewrapped: ${connectorRewrapped} connector_accounts, ` +
      `${connectorPendingRewrapped} connector_oauth_pending, ` +
      `${aiRewrapped} ai_provider_configs${skippedSuffix}.`
  );
  if (skipped > 0) process.exit(1);

  await db.destroy();
}

// Run only when executed directly (`tsx scripts/rewrap-secrets.ts`) — mirrors the guard
// convention of the other operator scripts. Without this, importing assertRewrapTargetIdentity
// for tests would also trigger a live rewrap run as a side effect of module evaluation.
const isThisModuleEntry =
  import.meta.url.endsWith("rewrap-secrets.ts") || import.meta.url.endsWith("rewrap-secrets.js");
if (
  isThisModuleEntry &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main().catch((err: unknown) => {
    console.error("rewrap-secrets failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
