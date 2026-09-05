import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";

import {
  resolveMossEnv,
  type AccessContext,
  type ConnectorAccountStatus,
  type ConnectorProvider,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import { sendJob } from "@moss/jobs";
import { recordAuditEvent } from "@moss/settings";
import { reconcileGoogleAccountSchedule } from "./google-schedule.js";
import { reconcileImapAccountSchedule } from "./imap-schedule.js";
import { reconcileMonitorSchedules } from "./monitor-schedule.js";
import {
  createConnectorAccountRouteSchema,
  getFeatureGrantsRouteSchema,
  googleAuthorizeRouteSchema,
  googleCompleteRouteSchema,
  googleSyncRouteSchema,
  imapConnectRouteSchema,
  imapTestRouteSchema,
  listAdminConnectorAccountsRouteSchema,
  listConnectorAccountsRouteSchema,
  listConnectorProvidersRouteSchema,
  putFeatureGrantsRouteSchema,
  parsePositiveIntEnv,
  revokeConnectorAccountRouteSchema,
  updateConnectorAccountRouteSchema,
  type ConnectorAccountDto,
  type ConnectorProviderDto,
  type CreateConnectorAccountRequest,
  type GoogleAuthorizeRequest,
  type GoogleCompleteRequest,
  type ImapConnectRequest,
  type UpdateFeatureGrantsRequest,
  type UpdateConnectorAccountRequest
} from "@moss/shared";
import { HttpError, handleRouteError as handleModuleRouteError } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { createConnectorSecretCipher, type ConnectorSecretCipher } from "./crypto.js";
import {
  featureGrantsPrefKey,
  isFeatureGranted,
  resolveEffectiveGrants
} from "./feature-grants.js";
import { GoogleConnectionService, GoogleConnectError } from "./google-connection.js";
import { ImapConnectError, ImapConnectionService } from "./imap-connection.js";
import { LiveImapProbeClient } from "./imap-probe-client.js";
import { GoogleOAuthClient } from "./oauth.js";
import { ConnectorsRepository, type ConnectorAccountSafeRow } from "./repository.js";
import { GOOGLE_SYNC_QUEUE } from "./sync-jobs.js";

export interface ConnectorsRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  readonly repository?: ConnectorsRepository;
  readonly preferencesRepository?: PreferencesRepository;
  readonly secretCipher?: ConnectorSecretCipher;
  readonly googleService?: GoogleConnectionService;
  readonly imapService?: ImapConnectionService;
}

interface AccountParams {
  readonly id: string;
}

export function registerConnectorsRoutes(
  server: FastifyInstance,
  dependencies: ConnectorsRoutesDependencies
): void {
  const repository = dependencies.repository ?? new ConnectorsRepository();
  const preferencesRepository = dependencies.preferencesRepository ?? new PreferencesRepository();
  const secretCipher = dependencies.secretCipher ?? createConnectorSecretCipher();
  const googleService =
    dependencies.googleService ??
    new GoogleConnectionService({
      repository,
      cipher: secretCipher,
      oauthClient: new GoogleOAuthClient()
    });
  const imapService =
    dependencies.imapService ??
    new ImapConnectionService({
      repository,
      cipher: secretCipher,
      probeClient: new LiveImapProbeClient()
    });

  server.post(
    "/api/connectors/google/authorize",
    { schema: googleAuthorizeRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as GoogleAuthorizeRequest;
        const clientId = requiredString(body.clientId, "clientId");
        const clientSecret = requiredString(body.clientSecret, "clientSecret");
        const result = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          googleService.startAuthorization(scopedDb, { clientId, clientSecret })
        );
        return result;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  const oauthMax = parsePositiveIntEnv(resolveMossEnv(process.env, "JARVIS_RL_OAUTH_MAX"), 5);
  const syncMax = parsePositiveIntEnv(resolveMossEnv(process.env, "JARVIS_RL_GOOGLE_SYNC_MAX"), 6);

  server.post(
    "/api/connectors/google/complete",
    {
      schema: googleCompleteRouteSchema,
      config: { rateLimit: { max: oauthMax, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as GoogleCompleteRequest;
        const redirectUrl = requiredString(body.redirectUrl, "redirectUrl");
        const account = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          googleService.completeAuthorization(scopedDb, { redirectUrl })
        );
        try {
          await sendJob(
            dependencies.boss,
            GOOGLE_SYNC_QUEUE,
            {
              actorUserId: accessContext.actorUserId,
              kind: "google-sync" as const,
              idempotencyKey: randomUUID(),
              trigger: "on-connect" as const
            },
            { singletonKey: accessContext.actorUserId }
          );
        } catch (error) {
          // best-effort: the user can sync manually if the enqueue fails. Log a sanitized,
          // structured event (name only — never the error object, which may carry connection
          // strings) so a swallowed enqueue is still observable.
          request.log.warn(
            { event: "connectors.sync_on_connect_enqueue_failed", name: (error as Error).name },
            "sync-on-connect enqueue failed; user can sync manually"
          );
        }
        try {
          await reconcileGoogleAccountSchedule(dependencies.boss, accessContext.actorUserId, true);
          await reconcileMonitorSchedules(
            dependencies.boss,
            accessContext.actorUserId,
            account.id,
            { email: true, calendar: true },
            true
          );
        } catch (error) {
          request.log.warn(
            { event: "connectors.google_schedule_reconcile_failed", name: (error as Error).name },
            "google schedule reconcile failed; account is connected but will not auto-sync on schedule until reconnect"
          );
        }
        return reply.code(201).send({ account: serializeAccount(account) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/connectors/google/sync",
    {
      schema: googleSyncRouteSchema,
      config: { rateLimit: { max: syncMax, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const idempotencyKey = randomUUID();
        const jobId = await sendJob(
          dependencies.boss,
          GOOGLE_SYNC_QUEUE,
          {
            actorUserId: accessContext.actorUserId,
            kind: "google-sync" as const,
            idempotencyKey,
            trigger: "manual" as const
          },
          // Per-actor singletonKey: a manual click racing sync-on-connect (or a second click)
          // collapses to one in-flight job. A null jobId means the collision happened — report
          // dedupe, not a fresh enqueue (briefings null-jobId precedent).
          { singletonKey: accessContext.actorUserId }
        );
        return reply.code(202).send({
          enqueued: jobId !== null,
          deduped: jobId === null,
          jobId
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/connectors/imap/connect",
    { schema: imapConnectRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as ImapConnectRequest;
        const input = {
          providerId: requiredString(body.providerId, "providerId"),
          username: requiredString(body.username, "username"),
          password: requiredString(body.password, "password")
        };
        const account = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          imapService.connect(scopedDb, input)
        );
        try {
          await reconcileImapAccountSchedule(
            dependencies.boss,
            accessContext.actorUserId,
            account.id,
            true
          );
          await reconcileMonitorSchedules(
            dependencies.boss,
            accessContext.actorUserId,
            account.id,
            { email: true, calendar: false },
            true
          );
        } catch (error) {
          request.log.warn(
            { event: "connectors.imap_schedule_reconcile_failed", name: (error as Error).name },
            "imap schedule reconcile failed; account is connected but will not auto-sync until reconnect"
          );
        }
        return reply.code(201).send({ account: serializeAccount(account) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/connectors/imap/test-connection",
    { schema: imapTestRouteSchema },
    async (request, reply) => {
      try {
        await dependencies.resolveAccessContext(request);
        const body = request.body as ImapConnectRequest;
        const input = {
          providerId: requiredString(body.providerId, "providerId"),
          username: requiredString(body.username, "username"),
          password: requiredString(body.password, "password")
        };
        const result = await imapService.testConnection(input);
        return reply.code(200).send(result);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/connectors/providers",
    { schema: listConnectorProvidersRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const providers = await dependencies.dataContext.withDataContext(
          accessContext,
          (scopedDb) => repository.listProviders(scopedDb)
        );

        return { providers: providers.map(serializeProvider) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/connectors/accounts",
    { schema: listConnectorAccountsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const accounts = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.listAccounts(scopedDb)
        );

        return { accounts: accounts.map(serializeAccount) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/connectors/accounts",
    { schema: createConnectorAccountRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseCreateAccountBody(request.body);
        const encryptedSecret = secretCipher.encryptJson(body.tokenPayload);
        const account = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.createAccount(scopedDb, {
            providerId: body.providerId,
            scopes: body.scopes ?? [],
            status: body.status ?? "active",
            encryptedSecret
          })
        );

        return reply.code(201).send({ account: serializeAccount(account) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: AccountParams }>(
    "/api/connectors/accounts/:id",
    { schema: updateConnectorAccountRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseUpdateAccountBody(request.body);
        const encryptedSecret =
          body.tokenPayload === undefined ? undefined : secretCipher.encryptJson(body.tokenPayload);
        const account = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.updateAccount(scopedDb, request.params.id, {
            scopes: body.scopes,
            status: body.status,
            encryptedSecret
          })
        );

        if (!account) {
          return reply.code(404).send({ error: "Connector account not found" });
        }

        return { account: serializeAccount(account) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: AccountParams }>(
    "/api/connectors/accounts/:id/revoke",
    { schema: revokeConnectorAccountRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const encryptedSecret = secretCipher.encryptJson({ revoked: true });
        const account = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.revokeAccount(scopedDb, request.params.id, encryptedSecret)
        );

        if (!account) {
          return reply.code(404).send({ error: "Connector account not found" });
        }

        if (account.provider_type === "imap") {
          try {
            await reconcileImapAccountSchedule(
              dependencies.boss,
              accessContext.actorUserId,
              account.id,
              false
            );
          } catch (error) {
            request.log.warn(
              { event: "connectors.imap_schedule_reconcile_failed", name: (error as Error).name },
              "imap schedule unreconcile failed on revoke; account may keep syncing until next reconcile"
            );
          }
        }

        if (account.provider_type === "google") {
          try {
            await reconcileGoogleAccountSchedule(
              dependencies.boss,
              accessContext.actorUserId,
              false
            );
          } catch (error) {
            request.log.warn(
              { event: "connectors.google_schedule_reconcile_failed", name: (error as Error).name },
              "google schedule unreconcile failed on revoke; account may keep syncing until next reconcile"
            );
          }
        }

        try {
          // connected=false unschedules both monitor queues regardless of capability flags.
          await reconcileMonitorSchedules(
            dependencies.boss,
            accessContext.actorUserId,
            account.id,
            { email: true, calendar: true },
            false
          );
        } catch (error) {
          request.log.warn(
            { event: "connectors.monitor_schedule_reconcile_failed", name: (error as Error).name },
            "monitor schedule unreconcile failed on revoke; monitors may keep running until next reconcile"
          );
        }

        return { account: serializeAccount(account) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: AccountParams }>(
    "/api/connectors/accounts/:id/feature-grants",
    { schema: getFeatureGrantsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const grants = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const account = await findVisibleAccount(repository, scopedDb, request.params.id);
            if (!account) return undefined;
            const stored = await preferencesRepository.get(
              scopedDb,
              featureGrantsPrefKey(account.id)
            );
            return resolveEffectiveGrants(account.scopes, stored);
          }
        );

        if (!grants) return reply.code(404).send({ error: "Connector account not found" });
        return grants;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put<{ Params: AccountParams }>(
    "/api/connectors/accounts/:id/feature-grants",
    { schema: putFeatureGrantsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseUpdateFeatureGrantsBody(request.body);
        const grants = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const account = await findVisibleAccount(repository, scopedDb, request.params.id);
            if (!account) return undefined;
            const key = featureGrantsPrefKey(account.id);
            const stored = await preferencesRepository.get(scopedDb, key);
            const next = {
              email: isFeatureGranted(stored, "email"),
              calendar: isFeatureGranted(stored, "calendar")
            };
            if (body.email !== undefined) next.email = body.email;
            if (body.calendar !== undefined) next.calendar = body.calendar;
            await preferencesRepository.upsert(scopedDb, key, next);
            for (const feature of ["email", "calendar"] as const) {
              const enabled = body[feature];
              if (enabled === undefined) continue;
              await recordAuditEvent(scopedDb, {
                actorUserId: accessContext.actorUserId,
                action: "connector.feature_grant.set",
                targetType: "connector_account",
                targetId: account.id,
                metadata: { feature, enabled },
                requestId: accessContext.requestId ?? randomUUID()
              });
            }
            return resolveEffectiveGrants(account.scopes, next);
          }
        );

        if (!grants) return reply.code(404).send({ error: "Connector account not found" });
        return grants;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/admin/connectors/accounts",
    { schema: listAdminConnectorAccountsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        // Admin check runs through the branded DataContextDb (not a root Kysely handle)
        // and shares the actor's scoped transaction with the listing query.
        const accounts = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            return repository.listAdminSafeAccounts(scopedDb);
          }
        );

        return { accounts: accounts.map(serializeAccount) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

async function findVisibleAccount(
  repository: ConnectorsRepository,
  scopedDb: DataContextDb,
  accountId: string
): Promise<ConnectorAccountSafeRow | undefined> {
  return (await repository.listAccounts(scopedDb)).find((account) => account.id === accountId);
}

function parseCreateAccountBody(body: unknown): CreateConnectorAccountRequest {
  const value = requireObject(body);

  return {
    providerId: requiredString(value.providerId, "providerId"),
    scopes: optionalStringArray(value.scopes, "scopes"),
    status: optionalWritableAccountStatus(value.status),
    tokenPayload: requireObject(value.tokenPayload, "tokenPayload")
  };
}

function parseUpdateAccountBody(body: unknown): UpdateConnectorAccountRequest {
  const value = requireObject(body);

  return {
    scopes: optionalStringArray(value.scopes, "scopes"),
    status: optionalWritableAccountStatus(value.status),
    tokenPayload:
      value.tokenPayload === undefined
        ? undefined
        : requireObject(value.tokenPayload, "tokenPayload")
  };
}

function parseUpdateFeatureGrantsBody(body: unknown): UpdateFeatureGrantsRequest {
  const value = requireObject(body);

  return {
    email: optionalBoolean(value.email, "email"),
    calendar: optionalBoolean(value.calendar, "calendar")
  };
}

function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new HttpError(400, `${fieldName} must be a boolean`);
}

async function assertInstanceAdmin(
  repository: ConnectorsRepository,
  scopedDb: DataContextDb,
  userId: string
): Promise<void> {
  const user = await repository.getUserById(scopedDb, userId);

  if (!user) {
    throw new HttpError(401, "Session is missing or expired");
  }
  if (!user.is_instance_admin) {
    throw new HttpError(403, "Instance admin permission is required");
  }
}

function serializeProvider(provider: ConnectorProvider): ConnectorProviderDto {
  return {
    id: provider.provider_id,
    providerType: provider.provider_type,
    displayName: provider.display_name,
    status: provider.status,
    defaultScopes: provider.default_scopes,
    createdAt: serializeRequiredDate(provider.created_at),
    updatedAt: serializeRequiredDate(provider.updated_at)
  };
}

function serializeAccount(account: ConnectorAccountSafeRow): ConnectorAccountDto {
  return {
    id: account.id,
    providerId: account.provider_id,
    providerType: account.provider_type,
    providerDisplayName: account.provider_display_name,
    providerStatus: account.provider_status,
    ownerUserId: account.owner_user_id,
    scopes: account.scopes,
    status: account.status,
    hasSecret: account.has_secret,
    revokedAt: serializeNullableDate(account.revoked_at),
    createdAt: serializeRequiredDate(account.created_at),
    updatedAt: serializeRequiredDate(account.updated_at),
    lastSyncStartedAt: serializeNullableDate(account.last_sync_started_at),
    lastSyncFinishedAt: serializeNullableDate(account.last_sync_finished_at),
    lastSyncStatus: account.last_sync_status,
    lastSyncError: account.last_sync_error,
    lastSyncCounts: account.last_sync_counts
  };
}

function requireObject(value: unknown, label = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      label === "body" ? "Expected JSON object body" : `${label} must be a JSON object`
    );
  }

  return value as Record<string, unknown>;
}

function requiredString(value: unknown, fieldName: string): string {
  const parsed = optionalString(value, fieldName);

  if (!parsed) {
    throw new HttpError(400, `${fieldName} is required`);
  }

  return parsed;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new HttpError(400, `${fieldName} must not be empty`);
  }

  return trimmed;
}

function optionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be an array`);
  }

  return value.map((item, index) => requiredString(item, `${fieldName}[${index}]`));
}

function optionalWritableAccountStatus(
  value: unknown
): Exclude<ConnectorAccountStatus, "revoked"> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "active" || value === "error") {
    return value;
  }

  throw new HttpError(400, "status must be active or error");
}

function serializeNullableDate(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function serializeRequiredDate(value: Date | string): string {
  return serializeNullableDate(value) ?? "";
}

function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    mappers: [
      (e, r) =>
        e instanceof GoogleConnectError
          ? r.code(e.statusCode).send({ error: e.message })
          : undefined,
      (e, r) =>
        e instanceof ImapConnectError ? r.code(e.statusCode).send({ error: e.message }) : undefined
    ],
    invalidRequestMessage: "Connector account request is invalid"
  });
}
