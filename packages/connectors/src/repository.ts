import { randomUUID } from "node:crypto";

import { sql, type Updateable } from "kysely";

import {
  assertDataContextDb,
  type ConnectorAccountStatus,
  type ConnectorAccountsTable,
  type ConnectorProvider,
  type ConnectorProviderStatus,
  type ConnectorProviderType,
  type ConnectorSyncStatus,
  type DataContextDb,
  type TriageFeedbackVerdict
} from "@moss/db";
import type { ConnectorSyncCounts } from "@moss/shared";

import type { EncryptedConnectorSecret } from "./crypto.js";

export const GOOGLE_PROVIDER_ID = "google";

export interface GooglePendingRow {
  readonly id: string;
  readonly state: string;
  readonly encryptedSecret: EncryptedConnectorSecret;
}

/** What caused a sync run to start: a schedule tick, a manual click, the assistant, or right after connecting an account. */
export type ConnectorSyncTrigger = "schedule" | "manual" | "assistant" | "on-connect";

/**
 * Snapshot of the prior finished run, copied here right before the current run's outcome
 * overwrites the `last_sync_*` columns. Lets the UI/API show "what changed since last time"
 * without keeping a full history table. Counts only, never message content.
 */
export interface PreviousSyncSnapshot {
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly status: ConnectorSyncStatus;
  readonly errorCode: string | null;
  readonly counts: ConnectorSyncCounts;
  readonly trigger: ConnectorSyncTrigger | null;
}

export interface ConnectorAccountSafeRow {
  readonly id: string;
  readonly provider_id: string;
  readonly provider_type: ConnectorProviderType;
  readonly provider_display_name: string;
  readonly provider_status: ConnectorProviderStatus;
  readonly owner_user_id: string;
  readonly scopes: string[];
  readonly status: ConnectorAccountStatus;
  readonly has_secret: boolean;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_sync_started_at: Date | null;
  readonly last_sync_finished_at: Date | null;
  readonly last_sync_status: ConnectorSyncStatus | null;
  readonly last_sync_error: string | null;
  readonly last_sync_counts: ConnectorSyncCounts | null;
  // Optional: the admin-safe metadata SQL function (list_connector_account_safe_metadata)
  // does not select these yet, so admin rows omit them rather than sending null.
  readonly last_sync_trigger?: ConnectorSyncTrigger | null;
  readonly previous_sync?: PreviousSyncSnapshot | null;
}

export interface CreateConnectorAccountInput {
  readonly providerId: string;
  readonly scopes: readonly string[];
  readonly status?: Exclude<ConnectorAccountStatus, "revoked">;
  readonly encryptedSecret: EncryptedConnectorSecret;
}

export interface UpdateConnectorAccountInput {
  readonly scopes?: readonly string[];
  readonly status?: Exclude<ConnectorAccountStatus, "revoked">;
  readonly encryptedSecret?: EncryptedConnectorSecret;
}

export interface AdminUserCheckRow {
  readonly id: string;
  readonly is_instance_admin: boolean;
}

export interface TriageFeedbackInput {
  readonly connectorAccountId: string | null;
  readonly actionability: string;
  readonly sender: string;
  readonly senderDomain: string;
  readonly subjectPrefix: string | null;
  readonly actionType: string | null;
  readonly confidence: number | null;
  readonly modelVersion: string | null;
  readonly verdict: TriageFeedbackVerdict;
  readonly reason: string | null;
}

export interface TriageRejectionAggregate {
  readonly senderDomain: string;
  readonly rejected: number;
  readonly accepted: number;
}

export class ConnectorsRepository {
  /**
   * Look up the actor's admin flag through the branded DataContextDb handle (never a
   * root Kysely instance — DataContextDb-only invariant). `app.get_user_by_id` is a
   * SECURITY DEFINER helper granted to the runtime role, so it resolves the row inside
   * the actor's scoped transaction. Returns undefined when no such user exists.
   */
  async getUserById(
    scopedDb: DataContextDb,
    userId: string
  ): Promise<AdminUserCheckRow | undefined> {
    assertDataContextDb(scopedDb);

    const result = await sql<AdminUserCheckRow>`
      SELECT id, is_instance_admin FROM app.get_user_by_id(${userId}::uuid)
    `.execute(scopedDb.db);

    return result.rows[0];
  }

  async listProviders(scopedDb: DataContextDb): Promise<ConnectorProvider[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.connector_definitions")
      .selectAll()
      .orderBy("provider_type")
      .orderBy("display_name")
      .execute();
  }

  async listAccounts(scopedDb: DataContextDb): Promise<ConnectorAccountSafeRow[]> {
    assertDataContextDb(scopedDb);

    return this.safeAccountQuery(scopedDb.db).execute();
  }

  async listAdminSafeAccounts(scopedDb: DataContextDb): Promise<ConnectorAccountSafeRow[]> {
    assertDataContextDb(scopedDb);

    const result =
      await sql<ConnectorAccountSafeRow>`select * from app.list_connector_account_safe_metadata()`.execute(
        scopedDb.db
      );

    return result.rows;
  }

  async createAccount(
    scopedDb: DataContextDb,
    input: CreateConnectorAccountInput
  ): Promise<ConnectorAccountSafeRow> {
    assertDataContextDb(scopedDb);

    const now = new Date();
    const inserted = await scopedDb.db
      .insertInto("app.connector_accounts")
      .values({
        id: randomUUID(),
        provider_id: input.providerId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        scopes: [...input.scopes],
        status: input.status ?? "active",
        encrypted_secret: input.encryptedSecret,
        revoked_at: null,
        created_at: now,
        updated_at: now
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return this.requireVisibleAccount(scopedDb, inserted.id);
  }

  async updateAccount(
    scopedDb: DataContextDb,
    accountId: string,
    input: UpdateConnectorAccountInput
  ): Promise<ConnectorAccountSafeRow | undefined> {
    assertDataContextDb(scopedDb);

    const updates: Updateable<ConnectorAccountsTable> = {
      updated_at: new Date()
    };

    if (input.scopes !== undefined) {
      updates.scopes = [...input.scopes];
    }
    if (input.status !== undefined) {
      // `status` is `Exclude<…, "revoked">`, so a provided status is always a
      // reactivation. Clearing `revoked_at` ONLY here (not unconditionally) stops
      // an unrelated PATCH — e.g. a scope change — from silently un-revoking a
      // revoked account (#143). Revocation itself stays owned by revokeAccount.
      updates.status = input.status;
      updates.revoked_at = null;
    }
    if (input.encryptedSecret !== undefined) {
      updates.encrypted_secret = input.encryptedSecret;
    }

    const updated = await scopedDb.db
      .updateTable("app.connector_accounts")
      .set(updates)
      .where("id", "=", accountId)
      .returning("id")
      .executeTakeFirst();

    return updated ? this.requireVisibleAccount(scopedDb, updated.id) : undefined;
  }

  async revokeAccount(
    scopedDb: DataContextDb,
    accountId: string,
    encryptedSecret: EncryptedConnectorSecret
  ): Promise<ConnectorAccountSafeRow | undefined> {
    assertDataContextDb(scopedDb);

    const updated = await scopedDb.db
      .updateTable("app.connector_accounts")
      .set({
        encrypted_secret: encryptedSecret,
        status: "revoked",
        revoked_at: new Date(),
        updated_at: new Date()
      })
      .where("id", "=", accountId)
      .returning("id")
      .executeTakeFirst();

    return updated ? this.requireVisibleAccount(scopedDb, updated.id) : undefined;
  }

  /**
   * Stamp the start of a sync run on the actor's own account row. Touches only the
   * health/`updated_at` columns — never `status` or `revoked_at`, so an in-flight sync can
   * never silently un-revoke a revoked account. The `id` predicate runs under owner RLS, so
   * only the actor's visible row is affected.
   *
   * Before overwriting, copies the row's current (pre-update) summary into `previous_sync` —
   * this is the only safe point to do it. `markSyncFinished` clears `last_sync_status` back to
   * null the moment a new run starts, so by the time that new run's own `markSyncFinished`
   * call runs, the prior run's status is already gone. Reading it here, before this call's own
   * write, is what "the last good run" actually means. Skipped when there is no prior finished
   * run to copy (first sync ever) — an empty snapshot is not useful.
   */
  async markSyncStarted(
    scopedDb: DataContextDb,
    accountId: string,
    input: { startedAt: Date; trigger: ConnectorSyncTrigger }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    const priorRow = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select([
        "last_sync_started_at",
        "last_sync_finished_at",
        "last_sync_status",
        "last_sync_error",
        "last_sync_counts",
        "last_sync_trigger"
      ])
      .where("id", "=", accountId)
      .executeTakeFirst();
    let previousSync: PreviousSyncSnapshot | null | undefined;
    if (priorRow && priorRow.last_sync_finished_at && priorRow.last_sync_status) {
      previousSync = {
        startedAt: priorRow.last_sync_started_at
          ? priorRow.last_sync_started_at.toISOString()
          : null,
        finishedAt: priorRow.last_sync_finished_at.toISOString(),
        status: priorRow.last_sync_status,
        errorCode: priorRow.last_sync_error,
        counts: (priorRow.last_sync_counts ?? {}) as ConnectorSyncCounts,
        trigger: (priorRow.last_sync_trigger as ConnectorSyncTrigger | null) ?? null
      };
    }
    await scopedDb.db
      .updateTable("app.connector_accounts")
      .set({
        last_sync_started_at: input.startedAt,
        last_sync_status: null,
        last_sync_trigger: input.trigger,
        ...(previousSync !== undefined
          ? { previous_sync: previousSync as unknown as Record<string, unknown> | null }
          : {}),
        updated_at: input.startedAt
      })
      .where("id", "=", accountId)
      .execute();
  }

  /**
   * Stamp the outcome of a sync run with aggregate-only health. Writes the bounded status,
   * a bounded error label (or null), and the small counts object. Like markSyncStarted it
   * never touches `status`/`revoked_at`. Never touches `previous_sync` — that snapshot is
   * captured by `markSyncStarted`, the only point where the prior run's status is still on
   * the row (see that method's doc comment). Because the snapshot is taken at run start, this
   * call needs no continuation flag: a mid-run chunk writing an outcome cannot disturb a
   * snapshot it never touches.
   */
  async markSyncFinished(
    scopedDb: DataContextDb,
    accountId: string,
    input: {
      finishedAt: Date;
      status: ConnectorSyncStatus;
      error: string | null;
      counts: ConnectorSyncCounts;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.connector_accounts")
      .set({
        last_sync_finished_at: input.finishedAt,
        last_sync_status: input.status,
        last_sync_error: input.error,
        last_sync_counts: input.counts as unknown as Record<string, unknown>,
        updated_at: input.finishedAt
      })
      .where("id", "=", accountId)
      .execute();
  }

  async upsertGooglePending(
    scopedDb: DataContextDb,
    input: { state: string; encryptedSecret: EncryptedConnectorSecret }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .deleteFrom("app.connector_oauth_pending")
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .execute();
    await scopedDb.db
      .insertInto("app.connector_oauth_pending")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        provider_id: GOOGLE_PROVIDER_ID,
        state: input.state,
        encrypted_secret: input.encryptedSecret,
        created_at: new Date()
      })
      .execute();
  }

  async getGooglePending(scopedDb: DataContextDb): Promise<GooglePendingRow | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.connector_oauth_pending")
      .select(["id", "state", "encrypted_secret"])
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id,
      state: row.state,
      encryptedSecret: row.encrypted_secret as EncryptedConnectorSecret
    };
  }

  async deleteGooglePending(scopedDb: DataContextDb): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .deleteFrom("app.connector_oauth_pending")
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .execute();
  }

  async upsertGoogleAccount(
    scopedDb: DataContextDb,
    input: { scopes: readonly string[]; encryptedSecret: EncryptedConnectorSecret }
  ): Promise<ConnectorAccountSafeRow> {
    assertDataContextDb(scopedDb);
    const existing = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select("id")
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .executeTakeFirst();
    if (existing) {
      const updated = await this.updateAccount(scopedDb, existing.id, {
        scopes: [...input.scopes],
        status: "active",
        encryptedSecret: input.encryptedSecret
      });
      if (!updated) throw new Error("Failed to update google account");
      return updated;
    }
    return this.createAccount(scopedDb, {
      providerId: GOOGLE_PROVIDER_ID,
      scopes: [...input.scopes],
      status: "active",
      encryptedSecret: input.encryptedSecret
    });
  }

  async getActiveGoogleAccountSecret(
    scopedDb: DataContextDb
  ): Promise<{ id: string; encryptedSecret: EncryptedConnectorSecret } | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select(["id", "encrypted_secret"])
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) return undefined;
    return { id: row.id, encryptedSecret: row.encrypted_secret as EncryptedConnectorSecret };
  }

  /**
   * IMAP analog of getActiveGoogleAccountSecret. Unlike Google (one fixed providerId), an
   * actor may have several active IMAP accounts (one per preset), so this is keyed by the
   * specific account id rather than a provider constant.
   */
  async getActiveImapAccountSecret(
    scopedDb: DataContextDb,
    accountId: string
  ): Promise<{ id: string; encryptedSecret: EncryptedConnectorSecret } | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select(["id", "encrypted_secret"])
      .where("id", "=", accountId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) return undefined;
    return { id: row.id, encryptedSecret: row.encrypted_secret as EncryptedConnectorSecret };
  }

  /**
   * Get account provider type by ID. Used by email write impl to dispatch to the correct provider.
   */
  async getAccountProviderType(
    scopedDb: DataContextDb,
    accountId: string
  ): Promise<ConnectorProviderType | undefined> {
    assertDataContextDb(scopedDb);
    const row = await this.safeAccountQuery(scopedDb.db)
      .where("accounts.id", "=", accountId)
      .executeTakeFirst();
    return row?.provider_type;
  }

  /**
   * Upsert a generic-IMAP account keyed by providerId (one of the IMAP_PRESETS keys),
   * unlike upsertGoogleAccount whose providerId is a single fixed constant — IMAP has
   * one row per preset the actor has connected.
   */
  async upsertImapAccount(
    scopedDb: DataContextDb,
    input: { providerId: string; encryptedSecret: EncryptedConnectorSecret }
  ): Promise<ConnectorAccountSafeRow> {
    assertDataContextDb(scopedDb);
    const definition = await scopedDb.db
      .selectFrom("app.connector_definitions")
      .select("default_scopes")
      .where("provider_id", "=", input.providerId)
      .executeTakeFirst();
    const scopes = definition?.default_scopes ?? [];

    const existing = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select("id")
      .where("provider_id", "=", input.providerId)
      .executeTakeFirst();
    if (existing) {
      const updated = await this.updateAccount(scopedDb, existing.id, {
        scopes,
        status: "active",
        encryptedSecret: input.encryptedSecret
      });
      if (!updated) throw new Error("Failed to update imap account");
      return updated;
    }
    return this.createAccount(scopedDb, {
      providerId: input.providerId,
      scopes,
      status: "active",
      encryptedSecret: input.encryptedSecret
    });
  }

  /**
   * Read-only, owner-scoped check: does the active google account hold the calendar
   * write scope? Reads `accounts.scopes` (already owner-RLS-scoped). Returns false when
   * there is no active google account. Never decrypts the secret bundle.
   */
  async hasCalendarWriteScope(scopedDb: DataContextDb): Promise<boolean> {
    return (await this.getCalendarWriteScopeState(scopedDb))?.hasScope ?? false;
  }

  async getCalendarWriteScopeState(
    scopedDb: DataContextDb
  ): Promise<{ accountId: string; hasScope: boolean } | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select(["id", "scopes"])
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      accountId: row.id,
      hasScope: row.scopes.includes("https://www.googleapis.com/auth/calendar")
    };
  }

  /**
   * Gmail-write analog of getCalendarWriteScopeState. Returns the single active Google account
   * and whether its stored scopes include gmail.modify (the send/draft capability). Used by the
   * email reply write-impl to gate the provider (only the active Google account can reply) and
   * the scope (no Gmail write call without gmail.modify). Scope literal mirrors GMAIL_SCOPE.
   */
  async getGmailWriteScopeState(
    scopedDb: DataContextDb
  ): Promise<{ accountId: string; hasScope: boolean } | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select(["id", "scopes"])
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      accountId: row.id,
      hasScope: row.scopes.includes("https://www.googleapis.com/auth/gmail.modify")
    };
  }

  /**
   * Record one accept/reject verdict for an email triage suggestion (#729 §6). Metadata
   * only — never message bodies; subject_prefix is defensively capped at 120 chars here
   * even though callers truncate first. Rows are owner-only under FORCE RLS.
   */
  async recordTriageFeedback(scopedDb: DataContextDb, input: TriageFeedbackInput): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.email_triage_feedback")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        connector_account_id: input.connectorAccountId,
        source: "email",
        actionability: input.actionability,
        sender: input.sender,
        sender_domain: input.senderDomain,
        subject_prefix: input.subjectPrefix === null ? null : input.subjectPrefix.slice(0, 120),
        action_type: input.actionType,
        confidence: input.confidence,
        model_version: input.modelVersion,
        verdict: input.verdict,
        reason: input.reason,
        created_at: new Date()
      })
      .execute();
  }

  /**
   * Per-sender-domain accept/reject counts for the actor's own feedback, used by the
   * triage learning pass to demote repeatedly rejected domains. COUNT comes back from
   * pg as a string, hence the Number() casts.
   */
  async listTriageRejectionAggregates(
    scopedDb: DataContextDb
  ): Promise<TriageRejectionAggregate[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.email_triage_feedback")
      .select((eb) => [
        "sender_domain",
        eb.fn.count<string>("id").filterWhere("verdict", "=", "rejected").as("rejected"),
        eb.fn.count<string>("id").filterWhere("verdict", "=", "accepted").as("accepted")
      ])
      .groupBy("sender_domain")
      .orderBy("sender_domain")
      .execute();

    return rows.map((row) => ({
      senderDomain: row.sender_domain,
      rejected: Number(row.rejected),
      accepted: Number(row.accepted)
    }));
  }

  private async requireVisibleAccount(
    scopedDb: DataContextDb,
    accountId: string
  ): Promise<ConnectorAccountSafeRow> {
    const account = await this.safeAccountQuery(scopedDb.db)
      .where("accounts.id", "=", accountId)
      .executeTakeFirst();

    if (!account) {
      throw new Error("Connector account is not visible after write");
    }

    return account;
  }

  private safeAccountQuery(db: DataContextDb["db"]) {
    return db
      .selectFrom("app.connector_accounts as accounts")
      .innerJoin(
        "app.connector_definitions as definitions",
        "definitions.provider_id",
        "accounts.provider_id"
      )
      .select([
        "accounts.id as id",
        "accounts.provider_id as provider_id",
        "definitions.provider_type as provider_type",
        "definitions.display_name as provider_display_name",
        "definitions.status as provider_status",
        "accounts.owner_user_id as owner_user_id",
        "accounts.scopes as scopes",
        "accounts.status as status",
        sql<boolean>`accounts.encrypted_secret IS NOT NULL`.as("has_secret"),
        "accounts.revoked_at as revoked_at",
        "accounts.created_at as created_at",
        "accounts.updated_at as updated_at",
        "accounts.last_sync_started_at as last_sync_started_at",
        "accounts.last_sync_finished_at as last_sync_finished_at",
        "accounts.last_sync_status as last_sync_status",
        "accounts.last_sync_error as last_sync_error",
        "accounts.last_sync_counts as last_sync_counts",
        sql<ConnectorSyncTrigger | null>`accounts.last_sync_trigger`.as("last_sync_trigger"),
        sql<PreviousSyncSnapshot | null>`accounts.previous_sync`.as("previous_sync")
      ])
      .orderBy("accounts.created_at", "desc")
      .orderBy("accounts.id");
  }
}
