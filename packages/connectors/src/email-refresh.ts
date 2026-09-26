import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import { sql } from "kysely";

import {
  assertDataContextDb,
  type AccessContext,
  type ConnectorEmailRefreshErrorCode,
  type ConnectorEmailRefreshStatus as DbEmailRefreshStatus,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import { sendJob, type ActorScopedJobPayload, type QueueDefinition } from "@moss/jobs";
import {
  emailRefreshStatusRouteSchema,
  requestEmailRefreshRouteSchema,
  type EmailRefreshAccountStatusDto,
  type EmailRefreshStatusResponse,
  type RequestEmailRefreshRequest,
  type RequestEmailRefreshResponse
} from "@moss/shared";
import { handleRouteError } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { featureGrantsPrefKey, resolveEffectiveGrants } from "./feature-grants.js";
import { ConnectorsRepository, type ConnectorAccountSafeRow } from "./repository.js";

export const EMAIL_REFRESH_ACCOUNT_QUEUE = "connectors.email-refresh-account";
export const EMAIL_REFRESH_DISPATCH_QUEUE = "connectors.email-refresh-dispatch";
export const EMAIL_REFRESH_SWEEP_QUEUE = "connectors.email-refresh-sweep";
export const EMAIL_REFRESH_DISPATCH_MAX_ATTEMPTS = 3;

export const EMAIL_REFRESH_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: EMAIL_REFRESH_ACCOUNT_QUEUE,
    options: {
      policy: "exclusive",
      retryLimit: 1,
      expireInSeconds: 1800,
      deleteAfterSeconds: 300,
      retentionSeconds: 600
    }
  },
  {
    name: EMAIL_REFRESH_DISPATCH_QUEUE,
    options: {
      policy: "exclusive",
      retryLimit: 1,
      deleteAfterSeconds: 300,
      retentionSeconds: 600
    }
  },
  {
    name: EMAIL_REFRESH_SWEEP_QUEUE,
    options: {
      policy: "singleton",
      retryLimit: 1,
      deleteAfterSeconds: 300,
      retentionSeconds: 600
    }
  }
];

export interface EmailRefreshAccountJobPayload extends ActorScopedJobPayload {
  readonly kind: "email-refresh-account";
  readonly connectorAccountId: string;
  /** Refresh ID correlates provider work with the durable owner-scoped attempt. */
  readonly idempotencyKey: string;
  readonly trigger: "manual";
}

export interface EmailRefreshDispatchJobPayload extends ActorScopedJobPayload {
  readonly kind: "email-refresh-dispatch";
  readonly idempotencyKey: "email-refresh-dispatch";
}

export interface EmailRefreshRequestResult {
  readonly refreshId: string;
  readonly created: boolean;
  readonly deduped: boolean;
}

interface RefreshKeyRow {
  readonly refresh_id: string;
}

interface RefreshParentRow {
  readonly id: string;
  readonly status: DbEmailRefreshStatus;
  readonly error_code: ConnectorEmailRefreshErrorCode | null;
  readonly created_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
}

interface RefreshAccountRow {
  readonly account_id: string;
  readonly provider_type: "google" | "imap";
  readonly status: DbEmailRefreshStatus;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly email_upserted: number;
  readonly email_failures: number;
  readonly error_code: ConnectorEmailRefreshErrorCode | null;
}

export interface PendingEmailRefreshDispatch {
  readonly refresh_id: string;
  readonly account_id: string;
  readonly provider_type: "google" | "imap";
  readonly dispatch_attempts: number;
}

export interface EmailRefreshDispatchRepository {
  listPendingDispatch(scopedDb: DataContextDb): Promise<PendingEmailRefreshDispatch[]>;
  markDispatched(scopedDb: DataContextDb, refreshId: string, accountId: string): Promise<void>;
  recordDispatchFailure(
    scopedDb: DataContextDb,
    refreshId: string,
    accountId: string
  ): Promise<void>;
}

export interface EmailRefreshAccountSnapshot {
  readonly provider_type: "google" | "imap";
  readonly status: DbEmailRefreshStatus;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function asApiStatus(status: DbEmailRefreshStatus): EmailRefreshStatusResponse["status"] {
  return status;
}

function eligibleEmailAccount(account: ConnectorAccountSafeRow, storedGrants: unknown): boolean {
  if (account.status !== "active") return false;
  if (account.provider_type !== "google" && account.provider_type !== "imap") return false;
  return resolveEffectiveGrants(account.scopes, storedGrants).email;
}

export class EmailRefreshRepository {
  constructor(
    private readonly connectors = new ConnectorsRepository(),
    private readonly preferences = new PreferencesRepository()
  ) {}

  async request(
    scopedDb: DataContextDb,
    idempotencyKey: string
  ): Promise<EmailRefreshRequestResult> {
    assertDataContextDb(scopedDb);
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtext(app.current_actor_user_id()::text),
        hashtext('connectors.email-refresh')
      )
    `.execute(scopedDb.db);

    const priorKey = await sql<RefreshKeyRow>`
      SELECT refresh_id
      FROM app.connector_email_refresh_keys
      WHERE owner_user_id = app.current_actor_user_id()
        AND idempotency_key = ${idempotencyKey}::uuid
    `.execute(scopedDb.db);
    if (priorKey.rows[0]) {
      return { refreshId: priorKey.rows[0].refresh_id, created: false, deduped: true };
    }

    const active = await scopedDb.db
      .selectFrom("app.connector_email_refreshes")
      .select("id")
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (active) {
      await this.insertKey(scopedDb, active.id, idempotencyKey);
      return { refreshId: active.id, created: false, deduped: true };
    }

    const accounts = await this.connectors.listAccounts(scopedDb);
    const eligible: Array<{ account: ConnectorAccountSafeRow; providerType: "google" | "imap" }> =
      [];
    for (const account of accounts) {
      if (account.provider_type !== "google" && account.provider_type !== "imap") continue;
      const grants = await this.preferences.get(scopedDb, featureGrantsPrefKey(account.id));
      if (!eligibleEmailAccount(account, grants)) continue;
      eligible.push({ account, providerType: account.provider_type });
    }

    const refreshId = randomUUID();
    const noEligibleAccounts = eligible.length === 0;
    await scopedDb.db
      .insertInto("app.connector_email_refreshes")
      .values({
        id: refreshId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        status: noEligibleAccounts ? "failed" : "queued",
        error_code: noEligibleAccounts ? "no-eligible-accounts" : null,
        completed_at: noEligibleAccounts ? new Date() : null
      })
      .execute();
    await this.insertKey(scopedDb, refreshId, idempotencyKey);
    if (eligible.length > 0) {
      await scopedDb.db
        .insertInto("app.connector_email_refresh_accounts")
        .values(
          eligible.map(({ account, providerType }) => ({
            refresh_id: refreshId,
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            account_id: account.id,
            provider_type: providerType,
            status: "queued" as const,
            dispatch_status: "pending" as const,
            error_code: null
          }))
        )
        .execute();
    }
    return { refreshId, created: true, deduped: false };
  }

  async getStatus(
    scopedDb: DataContextDb,
    refreshId: string
  ): Promise<EmailRefreshStatusResponse | undefined> {
    assertDataContextDb(scopedDb);
    const parent = await sql<RefreshParentRow>`
      SELECT id, status, error_code, created_at, started_at, completed_at
      FROM app.connector_email_refreshes
      WHERE id = ${refreshId}::uuid
        AND owner_user_id = app.current_actor_user_id()
    `.execute(scopedDb.db);
    const parentRow = parent.rows[0];
    if (!parentRow) return undefined;

    const accounts = await sql<RefreshAccountRow>`
      SELECT refresh_accounts.account_id,
        refresh_accounts.provider_type,
        refresh_accounts.status,
        refresh_accounts.started_at,
        refresh_accounts.completed_at,
        refresh_accounts.email_upserted,
        refresh_accounts.email_failures,
        refresh_accounts.error_code
      FROM app.connector_email_refresh_accounts AS refresh_accounts
      JOIN app.connector_accounts AS connector_accounts
        ON connector_accounts.id = refresh_accounts.account_id
        AND connector_accounts.owner_user_id = refresh_accounts.owner_user_id
      WHERE refresh_accounts.refresh_id = ${refreshId}::uuid
        AND refresh_accounts.owner_user_id = app.current_actor_user_id()
      ORDER BY refresh_accounts.account_id
    `.execute(scopedDb.db);
    const accountDtos: EmailRefreshAccountStatusDto[] = accounts.rows.map((row) => ({
      accountId: row.account_id,
      providerType: row.provider_type,
      status: asApiStatus(row.status),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      counts: { emailUpserted: row.email_upserted, emailFailures: row.email_failures },
      errorCode: row.error_code
    }));
    return {
      refreshId: parentRow.id,
      status: asApiStatus(parentRow.status),
      createdAt: iso(parentRow.created_at)!,
      startedAt: iso(parentRow.started_at),
      completedAt: iso(parentRow.completed_at),
      accounts: accountDtos,
      errorCode: parentRow.error_code
    };
  }

  async listPendingDispatch(scopedDb: DataContextDb): Promise<PendingEmailRefreshDispatch[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.connector_email_refresh_accounts")
      .innerJoin(
        "app.connector_email_refreshes",
        "app.connector_email_refreshes.id",
        "app.connector_email_refresh_accounts.refresh_id"
      )
      .select([
        "app.connector_email_refresh_accounts.refresh_id as refresh_id",
        "app.connector_email_refresh_accounts.account_id as account_id",
        "app.connector_email_refresh_accounts.provider_type as provider_type",
        "app.connector_email_refresh_accounts.dispatch_attempts as dispatch_attempts"
      ])
      .where(
        "app.connector_email_refresh_accounts.owner_user_id",
        "=",
        sql<string>`app.current_actor_user_id()`
      )
      .where("app.connector_email_refresh_accounts.status", "=", "queued")
      .where("app.connector_email_refresh_accounts.dispatch_status", "=", "pending")
      .where(
        "app.connector_email_refresh_accounts.dispatch_attempts",
        "<",
        EMAIL_REFRESH_DISPATCH_MAX_ATTEMPTS
      )
      .where("app.connector_email_refreshes.status", "in", ["queued", "running"])
      .orderBy("app.connector_email_refresh_accounts.refresh_id")
      .orderBy("app.connector_email_refresh_accounts.account_id")
      .execute();
    return rows;
  }

  async getAccountSnapshot(
    scopedDb: DataContextDb,
    refreshId: string,
    accountId: string
  ): Promise<EmailRefreshAccountSnapshot | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.connector_email_refresh_accounts")
      .select(["provider_type", "status"])
      .where("refresh_id", "=", refreshId)
      .where("account_id", "=", accountId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
  }

  async markDispatched(
    scopedDb: DataContextDb,
    refreshId: string,
    accountId: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.connector_email_refresh_accounts")
      .set({ dispatch_status: "dispatched" })
      .where("refresh_id", "=", refreshId)
      .where("account_id", "=", accountId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("status", "=", "queued")
      .where("dispatch_status", "=", "pending")
      .execute();
  }

  async recordDispatchFailure(
    scopedDb: DataContextDb,
    refreshId: string,
    accountId: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      SELECT id
      FROM app.connector_email_refreshes
      WHERE id = ${refreshId}::uuid
        AND owner_user_id = app.current_actor_user_id()
      FOR UPDATE
    `.execute(scopedDb.db);
    await sql`
      UPDATE app.connector_email_refresh_accounts
      SET dispatch_attempts = dispatch_attempts + 1,
          status = CASE WHEN dispatch_attempts + 1 >= ${EMAIL_REFRESH_DISPATCH_MAX_ATTEMPTS}
            THEN 'failed' ELSE status END,
          error_code = CASE WHEN dispatch_attempts + 1 >= ${EMAIL_REFRESH_DISPATCH_MAX_ATTEMPTS}
            THEN 'enqueue-failed' ELSE error_code END,
          completed_at = CASE WHEN dispatch_attempts + 1 >= ${EMAIL_REFRESH_DISPATCH_MAX_ATTEMPTS}
            THEN now() ELSE completed_at END
      WHERE refresh_id = ${refreshId}::uuid
        AND account_id = ${accountId}::uuid
        AND owner_user_id = app.current_actor_user_id()
        AND status = 'queued'
        AND dispatch_status = 'pending'
    `.execute(scopedDb.db);
    await this.aggregateParent(scopedDb, refreshId);
  }

  async startAccount(
    scopedDb: DataContextDb,
    refreshId: string,
    accountId: string
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const parent = await scopedDb.db
      .selectFrom("app.connector_email_refreshes")
      .select("id")
      .where("id", "=", refreshId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (!parent) return false;

    const current = await scopedDb.db
      .selectFrom("app.connector_email_refresh_accounts")
      .select("status")
      .where("refresh_id", "=", refreshId)
      .where("account_id", "=", accountId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
    if (current?.status === "running") return true;
    if (current?.status !== "queued") return false;

    const updated = await scopedDb.db
      .updateTable("app.connector_email_refresh_accounts")
      .set({ status: "running", started_at: new Date() })
      .where("refresh_id", "=", refreshId)
      .where("account_id", "=", accountId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("status", "=", "queued")
      .returning("account_id")
      .executeTakeFirst();
    if (!updated) return false;
    await scopedDb.db
      .updateTable("app.connector_email_refreshes")
      .set({ status: "running", started_at: sql<Date>`COALESCE(started_at, now())` })
      .where("id", "=", refreshId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .execute();
    return true;
  }

  async finishAccount(
    scopedDb: DataContextDb,
    refreshId: string,
    accountId: string,
    result: {
      readonly status: Exclude<DbEmailRefreshStatus, "queued" | "running">;
      readonly errorCode: ConnectorEmailRefreshErrorCode | null;
      readonly emailUpserted: number;
      readonly emailFailures: number;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    // Serialize completion across child workers so the last account always sees all prior
    // terminal outcomes before aggregating the parent row.
    await sql`
      SELECT id
      FROM app.connector_email_refreshes
      WHERE id = ${refreshId}::uuid
        AND owner_user_id = app.current_actor_user_id()
      FOR UPDATE
    `.execute(scopedDb.db);
    await scopedDb.db
      .updateTable("app.connector_email_refresh_accounts")
      .set({
        status: result.status,
        error_code: result.errorCode,
        email_upserted: result.emailUpserted,
        email_failures: result.emailFailures,
        completed_at: new Date()
      })
      .where("refresh_id", "=", refreshId)
      .where("account_id", "=", accountId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("status", "in", ["queued", "running"])
      .execute();
    await this.aggregateParent(scopedDb, refreshId);
  }

  private async insertKey(scopedDb: DataContextDb, refreshId: string, idempotencyKey: string) {
    await scopedDb.db
      .insertInto("app.connector_email_refresh_keys")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        idempotency_key: idempotencyKey,
        refresh_id: refreshId
      })
      .execute();
  }

  private async aggregateParent(scopedDb: DataContextDb, refreshId: string): Promise<void> {
    await sql`
      SELECT id
      FROM app.connector_email_refreshes
      WHERE id = ${refreshId}::uuid
        AND owner_user_id = app.current_actor_user_id()
      FOR UPDATE
    `.execute(scopedDb.db);
    const rows = await sql<{
      readonly status: DbEmailRefreshStatus;
      readonly error_code: ConnectorEmailRefreshErrorCode | null;
    }>`
      SELECT status, error_code
      FROM app.connector_email_refresh_accounts
      WHERE refresh_id = ${refreshId}::uuid
        AND owner_user_id = app.current_actor_user_id()
      FOR UPDATE
    `.execute(scopedDb.db);
    if (
      rows.rows.length === 0 ||
      rows.rows.some((row) => row.status === "queued" || row.status === "running")
    ) {
      return;
    }
    const statuses = rows.rows.map((row) => row.status);
    const status: Exclude<DbEmailRefreshStatus, "queued" | "running"> = statuses.every(
      (item) => item === "succeeded"
    )
      ? "succeeded"
      : statuses.every((item) => item === "failed")
        ? "failed"
        : "partial";
    const errors = [...new Set(rows.rows.map((row) => row.error_code).filter(Boolean))];
    const errorCode = errors.length === 1 ? errors[0]! : null;
    await scopedDb.db
      .updateTable("app.connector_email_refreshes")
      .set({ status, error_code: errorCode, completed_at: new Date() })
      .where("id", "=", refreshId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("status", "in", ["queued", "running"])
      .execute();
  }
}

export async function dispatchPendingEmailRefreshJobs(
  scopedDb: DataContextDb,
  boss: PgBoss,
  actorUserId: string,
  repository: EmailRefreshDispatchRepository = new EmailRefreshRepository()
): Promise<number> {
  const pending = await repository.listPendingDispatch(scopedDb);
  let enqueued = 0;
  for (const account of pending) {
    const payload: EmailRefreshAccountJobPayload = {
      actorUserId,
      connectorAccountId: account.account_id,
      idempotencyKey: account.refresh_id,
      kind: "email-refresh-account",
      trigger: "manual"
    };
    let jobId: string | null;
    try {
      jobId = await sendJob(boss, EMAIL_REFRESH_ACCOUNT_QUEUE, payload, {
        singletonKey: `${account.refresh_id}:${account.account_id}`
      });
    } catch {
      await repository.recordDispatchFailure(scopedDb, account.refresh_id, account.account_id);
      continue;
    }
    await repository.markDispatched(scopedDb, account.refresh_id, account.account_id);
    if (jobId !== null) enqueued += 1;
  }
  return enqueued;
}

export interface EmailRefreshRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  readonly repository?: EmailRefreshRepository;
}

export function registerEmailRefreshRoutes(
  server: FastifyInstance,
  dependencies: EmailRefreshRouteDependencies
): void {
  const repository = dependencies.repository ?? new EmailRefreshRepository();
  server.post(
    "/api/connectors/email-refresh",
    { schema: requestEmailRefreshRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as RequestEmailRefreshRequest;
        const attempt = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.request(scopedDb, body.idempotencyKey)
        );
        let enqueued = false;
        if (attempt.created) {
          enqueued = await dependencies.dataContext.withDataContext(
            accessContext,
            async (scopedDb) =>
              (await dispatchPendingEmailRefreshJobs(
                scopedDb,
                dependencies.boss,
                accessContext.actorUserId,
                repository
              )) > 0
          );
        }
        const response: RequestEmailRefreshResponse = {
          refreshId: attempt.refreshId,
          enqueued,
          deduped: attempt.deduped
        };
        return reply.code(202).send(response);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: { refreshId: string } }>(
    "/api/connectors/email-refresh/:refreshId",
    { schema: emailRefreshStatusRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const status = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.getStatus(scopedDb, request.params.refreshId)
        );
        return status ?? reply.code(404).send({ error: "Email refresh not found" });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
