import { randomUUID } from "node:crypto";

import pg from "pg";

import { getMossDatabaseUrls } from "@moss/db";
import { deleteUserVaultDir, getVaultBaseDir } from "@moss/vault";

const { Client } = pg;

export interface DeleteUserDataOptions {
  readonly actorUserId?: string | null;
  readonly auditAction?: string;
  readonly bootstrapConnectionString?: string;
  readonly confirmUserId?: string;
  readonly dryRun?: boolean;
  readonly requestId?: string;
  readonly userId: string;
  /**
   * Module-owned deletion tables derived from `dataLifecycle.deletion.tables`
   * (#801 Phase A). API callers get this from the composition root
   * (`@moss/module-registry`'s `getModuleDeletionTables`/`MODULE_DELETION_TABLES`);
   * the CLI entrypoint (`scripts/delete-user-data-cli.ts`) derives it there — this
   * library file must never reference `@moss/module-registry` in any form (see
   * the CLI file's header for the bundle mis-emit + ESM deadlock that causes).
   * Defaults to empty so existing callers/tests are unaffected until they opt in.
   */
  readonly moduleDeletionTables?: readonly { table: string; countPredicate: string }[];
}

export interface DeleteUserDataResult {
  readonly auditEventId: string | null;
  readonly countsBeforeDelete: Readonly<Record<string, number>>;
  readonly deleted: boolean;
  readonly dryRun: boolean;
  readonly userId: string;
  /**
   * Whether the user's on-disk vault subtree was removed. False on dry-run
   * (the vault is only deleted after the DB commit); true once executed. The
   * operator-facing field exists so a delete is visibly known to have purged
   * filesystem-resident vault data, not only DB rows (#171).
   */
  readonly vaultDeleted: boolean;
}

/**
 * Thrown when deleting the target would leave the instance with zero active
 * admins. Distinct type so the admin DELETE/reject route can map it to a 409
 * (rather than a generic 500) when a concurrent removal loses the race that the
 * advisory lock serializes. See the last-admin re-check in deleteUserData (#94).
 */
export class LastActiveAdminError extends Error {
  constructor() {
    super("Cannot remove the last active admin");
    this.name = "LastActiveAdminError";
  }
}

const userScopedCountQueries: ReadonlyArray<readonly [table: string, predicate: string]> = [
  ["app.users", "id = $1::uuid"],
  ["app.auth_sessions", "user_id = $1::uuid"],
  ["app.auth_accounts", "user_id = $1::uuid"],
  ["app.better_auth_sessions", "user_id = $1::uuid"],
  ["app.tasks", "owner_user_id = $1::uuid"],
  ["app.task_activity", "actor_user_id = $1::uuid"],
  ["app.notifications", "recipient_user_id = $1::uuid OR actor_user_id = $1::uuid"],
  ["app.notification_reads", "user_id = $1::uuid"],
  ["app.connector_accounts", "owner_user_id = $1::uuid"],
  ["app.connector_oauth_pending", "owner_user_id = $1::uuid"],
  ["app.calendar_events", "owner_user_id = $1::uuid"],
  ["app.email_messages", "owner_user_id = $1::uuid"],
  ["app.ai_provider_configs", "owner_user_id = $1::uuid"],
  ["app.ai_configured_models", "owner_user_id = $1::uuid"],
  ["app.ai_assistant_action_requests", "owner_user_id = $1::uuid"],
  ["app.chat_threads", "owner_user_id = $1::uuid"],
  ["app.chat_messages", "owner_user_id = $1::uuid"],
  ["app.briefing_definitions", "owner_user_id = $1::uuid"],
  ["app.briefing_runs", "owner_user_id = $1::uuid"],
  // Tasks foundation (#39): owner-scoped lists/tags/preferences cascade on user delete.
  // task_tag_assignments has no owner_user_id column (it links tasks↔tags); its rows
  // are transitively cascade-deleted via the owning task, so count via that join.
  ["app.task_lists", "owner_user_id = $1::uuid"],
  ["app.task_tags", "owner_user_id = $1::uuid"],
  [
    "app.task_tag_assignments",
    "task_id IN (SELECT id FROM app.tasks WHERE owner_user_id = $1::uuid)"
  ],
  ["app.task_preferences", "owner_user_id = $1::uuid"],
  // Shares: a user's deletion removes shares they granted AND shares granted to them
  // (both FKs are ON DELETE CASCADE — 0017).
  ["app.shares", "owner_user_id = $1::uuid OR grantee_user_id = $1::uuid"],
  // Wellness module (0082–0089) moved to its dataLifecycle.deletion declaration
  // (#801 Phase A, packages/wellness/src/manifest.ts) — no longer hardcoded here.
  // Memory: chunks/links/file-index/facts + the chat-memory settings/suppressions.
  // All owner_user_id / user_id ON DELETE CASCADE.
  ["app.memory_chunks", "owner_user_id = $1::uuid"],
  ["app.memory_links", "owner_user_id = $1::uuid"],
  ["app.memory_file_index", "owner_user_id = $1::uuid"],
  ["app.chat_memory_facts", "owner_user_id = $1::uuid"],
  ["app.chat_memory_suppressions", "owner_user_id = $1::uuid"],
  ["app.chat_user_memory_settings", "user_id = $1::uuid"],
  ["app.memory_entities", "owner_user_id = $1::uuid"],
  ["app.memory_facts", "owner_user_id = $1::uuid"],
  ["app.memory_episodes", "owner_user_id = $1::uuid"],
  ["app.memory_fact_sources", "owner_user_id = $1::uuid"],
  ["app.memory_aliases", "owner_user_id = $1::uuid"],
  ["app.memory_search_documents", "owner_user_id = $1::uuid"],
  ["app.memory_legacy_fact_migrations", "owner_user_id = $1::uuid"],
  ["app.memory_conflict_groups", "owner_user_id = $1::uuid"],
  ["app.memory_candidates", "owner_user_id = $1::uuid"],
  // Structured-state (0031): commitments/entities/preferences.
  ["app.commitments", "owner_user_id = $1::uuid"],
  ["app.entities", "owner_user_id = $1::uuid"],
  ["app.preferences", "owner_user_id = $1::uuid"],
  // Usefulness feedback (#527, story feedback #2016): both cascade from app.users, but neither was
  // counted, so a deletion report under-reported what it had removed.
  ["app.usefulness_feedback_signals", "owner_user_id = $1::uuid"],
  ["app.usefulness_feedback_targets", "owner_user_id = $1::uuid"],
  // Per-user module enablement deny rows (0065): only scope='user' rows are
  // owner-scoped (scope='instance' rows are global; disabled_by_user_id is
  // ON DELETE SET NULL — retained/anonymized, not counted here).
  ["app.module_enablement", "scope = 'user' AND user_id = $1::uuid"],
  // Per-member onboarding state (0079).
  ["app.member_onboarding", "user_id = $1::uuid"],
  // Module platform tables (#918): user-scope rows cascade via owner FK; instance
  // rows have owner_user_id IS NULL so these predicates can never match them.
  ["app.module_credentials", "owner_user_id = $1::uuid"],
  ["app.module_kv", "scope = 'user' AND owner_user_id = $1::uuid"]
];

export async function deleteUserData(
  options: DeleteUserDataOptions
): Promise<DeleteUserDataResult> {
  const dryRun = options.dryRun ?? true;
  const auditAction = options.auditAction ?? "user.delete";

  if (!dryRun && options.confirmUserId !== options.userId) {
    throw new Error("Confirmation user id must match the target user id");
  }

  const client = new Client({
    connectionString: options.bootstrapConnectionString ?? getMossDatabaseUrls().bootstrap
  });

  const moduleDeletionTables = options.moduleDeletionTables ?? [];

  await client.connect();
  try {
    await client.query("BEGIN");

    const counts = await readCounts(client, options.userId, moduleDeletionTables);

    if (dryRun) {
      await client.query("ROLLBACK");
      return {
        auditEventId: null,
        countsBeforeDelete: counts,
        deleted: false,
        dryRun,
        userId: options.userId,
        vaultDeleted: false
      };
    }

    // Last-active-admin TOCTOU guard (#94). The route's pre-check ran in a
    // *separate* committed transaction, so by the time we reach this DELETE the
    // instance state may have changed. Serialize against the repository's admin
    // mutations on the same advisory key, then re-assert under the lock that
    // removing this user does not drop the active-admin count to zero. The lock
    // is per-database, so it serializes correctly even though this is the
    // bootstrap connection rather than an app-runtime one. Both run inside one
    // transaction here, so the xact lock is held through the DELETE and COMMIT.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jarv1s:last-active-admin'))");
    const adminGuard = await client.query<{
      target_is_admin: boolean | null;
      other_active_admin: boolean;
    }>(
      `
        SELECT
          (SELECT is_instance_admin FROM app.users WHERE id = $1::uuid) AS target_is_admin,
          EXISTS (
            SELECT 1 FROM app.users
            WHERE is_instance_admin = true AND status = 'active' AND id != $1::uuid
          ) AS other_active_admin
      `,
      [options.userId]
    );
    if (adminGuard.rows[0]?.target_is_admin === true && !adminGuard.rows[0]?.other_active_admin) {
      // The catch below issues the ROLLBACK that releases the advisory lock.
      throw new LastActiveAdminError();
    }

    const auditEventId = randomUUID();
    await client.query(
      `
        INSERT INTO app.admin_audit_events (
          id,
          actor_user_id,
          action,
          target_type,
          target_id,
          metadata,
          request_id
        )
        VALUES (
          $1,
          $2,
          $3,
          'user',
          $4,
          $5::jsonb,
          $6
        )
      `,
      [
        auditEventId,
        options.actorUserId ?? null,
        auditAction,
        options.userId,
        JSON.stringify({
          countsBeforeDelete: counts,
          script: "scripts/delete-user-data.ts"
        }),
        options.requestId ?? `maintenance:user-delete:${auditEventId}`
      ]
    );

    const deleted = await client.query("DELETE FROM app.users WHERE id = $1::uuid", [
      options.userId
    ]);

    await client.query("COMMIT");

    // Delete the user's vault filesystem directory AFTER the DB commit.
    // Ordering rationale: if the DB delete fails the vault is untouched; if
    // the vault rm fails the user rows are already gone (effectively deleted)
    // and the orphan can be retried manually without risk of data inconsistency.
    // The operation is idempotent — no error if the directory does not exist.
    await deleteUserVaultDir(getVaultBaseDir(), options.userId);

    return {
      auditEventId,
      countsBeforeDelete: counts,
      deleted: (deleted.rowCount ?? 0) > 0,
      dryRun,
      userId: options.userId,
      vaultDeleted: true
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function readCounts(
  client: pg.Client,
  userId: string,
  moduleDeletionTables: readonly { table: string; countPredicate: string }[] = []
): Promise<Readonly<Record<string, number>>> {
  const entries: Array<readonly [string, number]> = [];

  for (const [table, predicate] of userScopedCountQueries) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${table} WHERE ${predicate}`,
      [userId]
    );
    entries.push([table, Number(result.rows[0]?.count ?? 0)]);
  }

  for (const { table, countPredicate } of moduleDeletionTables) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${table} WHERE ${countPredicate}`,
      [userId]
    );
    entries.push([table, Number(result.rows[0]?.count ?? 0)]);
  }

  return Object.fromEntries(entries);
}

// NOTE: no CLI entry here. The `pnpm delete:user` entrypoint lives in
// `scripts/delete-user-data-cli.ts` — this file is a pure library (imported by
// packages/settings) and must never reference `@moss/module-registry` in any
// form (static, or even a guarded dynamic import): see the header comment in the
// CLI file for the esbuild bundle mis-emit and the ESM top-level-await deadlock
// that referencing it from here causes (#801 Phase A, QA on PR #816).
