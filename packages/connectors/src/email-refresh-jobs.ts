import type { Job, PgBoss, WorkOptions } from "pg-boss";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import { AiRepository, createAiSecretCipher } from "@moss/ai";
import type { ConnectorEmailRefreshErrorCode, MossDatabase, DataContextRunner } from "@moss/db";
import { EmailRepository } from "@moss/email";
import { registerDataContextWorker, sendJob, toAccessContext } from "@moss/jobs";
import type { EmailThreadJudgementRequester } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { createConnectorSecretCipher } from "./crypto.js";
import { buildEmailExtractDeps, type BuildEmailExtractDepsOptions } from "./extract-deps.js";
import { featureGrantsPrefKey, resolveEffectiveGrants } from "./feature-grants.js";
import { GoogleApiClient } from "./google-api-client.js";
import { GoogleConnectionService } from "./google-connection.js";
import { GoogleOAuthClient } from "./oauth.js";
import { ConnectorsRepository } from "./repository.js";
import {
  EMAIL_REFRESH_ACCOUNT_QUEUE,
  EMAIL_REFRESH_DISPATCH_QUEUE,
  EMAIL_REFRESH_SWEEP_QUEUE,
  EmailRefreshRepository,
  dispatchPendingEmailRefreshJobs,
  type EmailRefreshAccountJobPayload,
  type EmailRefreshDispatchJobPayload
} from "./email-refresh.js";
import {
  runGoogleSyncChunk,
  loadGoogleSyncActiveAccount,
  type GoogleSyncDeps,
  type GoogleSyncResult,
  type GoogleSyncChunkOutcome,
  type GoogleSyncContinuationState,
  type SyncLogger
} from "./sync-jobs.js";
import {
  runImapSync,
  type ImapSyncResult,
  type RegisterImapSyncWorkerDeps
} from "./imap-sync-jobs.js";
import type { ProjectEmailActionsDeps } from "./monitor-jobs.js";
import { EmailActionSuppressionRepository } from "./action-suppression-repository.js";

export const EMAIL_REFRESH_SWEEP_CRON = "*/1 * * * *";

export interface RegisterEmailRefreshWorkersDeps {
  readonly dataContext: DataContextRunner;
  readonly rootDb: Kysely<MossDatabase>;
  readonly taskPort: ProjectEmailActionsDeps["taskPort"];
  readonly actionRowRelevance?: ProjectEmailActionsDeps["actionRowRelevance"];
  readonly createCliStructuredAdapter?: BuildEmailExtractDepsOptions["createCliStructuredAdapter"];
  readonly workOptions?: WorkOptions;
  readonly logger?: SyncLogger;
  readonly threadJudgementRequester?: EmailThreadJudgementRequester;
  readonly knownSenderAddresses?: GoogleSyncDeps["knownSenderAddresses"];
}

type RefreshWorkerOutcome = {
  readonly status: "succeeded" | "partial" | "failed";
  readonly errorCode: ConnectorEmailRefreshErrorCode | null;
  readonly emailUpserted: number;
  readonly emailFailures: number;
};

function boundedError(errors: readonly string[]): ConnectorEmailRefreshErrorCode | null {
  const terminal = new Set<ConnectorEmailRefreshErrorCode>([
    "no-active-connection",
    "auth-error",
    "email-needs-config"
  ]);
  const failure = errors.find((error): error is ConnectorEmailRefreshErrorCode =>
    terminal.has(error as ConnectorEmailRefreshErrorCode)
  );
  if (failure) return failure;
  const allowed = new Set<ConnectorEmailRefreshErrorCode>([
    "no-active-connection",
    "auth-error",
    "email-error",
    "email-message-error",
    "email-needs-config"
  ]);
  return (
    errors.find((error): error is ConnectorEmailRefreshErrorCode =>
      allowed.has(error as ConnectorEmailRefreshErrorCode)
    ) ?? (errors.length > 0 ? "email-error" : null)
  );
}

export function toRefreshOutcome(
  result: Pick<GoogleSyncResult | ImapSyncResult, "errors" | "emailUpserted" | "emailFailures">
): RefreshWorkerOutcome {
  const errorCode = boundedError(result.errors);
  const status =
    errorCode === "auth-error" ||
    errorCode === "no-active-connection" ||
    errorCode === "email-needs-config"
      ? "failed"
      : result.errors.length > 0
        ? "partial"
        : "succeeded";
  return {
    status,
    errorCode,
    emailUpserted: result.emailUpserted,
    emailFailures: result.emailFailures ?? 0
  };
}

function emptyFailure(
  errorCode: "no-active-connection" | "email-needs-config"
): RefreshWorkerOutcome {
  return { status: "failed", errorCode, emailUpserted: 0, emailFailures: 0 };
}

export async function registerEmailRefreshWorkers(
  boss: PgBoss,
  deps: RegisterEmailRefreshWorkersDeps
): Promise<string[]> {
  const refreshRepository = new EmailRefreshRepository();
  const connectorsRepository = new ConnectorsRepository();
  const preferencesRepository = new PreferencesRepository();
  const connectorCipher = createConnectorSecretCipher();
  const googleService = new GoogleConnectionService({
    repository: connectorsRepository,
    cipher: connectorCipher,
    oauthClient: new GoogleOAuthClient()
  });
  const googleClient = new GoogleApiClient();
  const emailRepository = new EmailRepository();
  const aiRepository = new AiRepository();
  const aiCipher = createAiSecretCipher();
  const suppressionRepository = new EmailActionSuppressionRepository();

  const accountWorker = await boss.work<EmailRefreshAccountJobPayload, RefreshWorkerOutcome>(
    EMAIL_REFRESH_ACCOUNT_QUEUE,
    deps.workOptions ?? { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error("pg-boss invoked email refresh without a job");
      const accessContext = toAccessContext(job);
      const { refreshId, connectorAccountId } = job.data.idempotencyKey
        ? { refreshId: job.data.idempotencyKey, connectorAccountId: job.data.connectorAccountId }
        : { refreshId: "", connectorAccountId: "" };
      if (!refreshId || !connectorAccountId)
        throw new Error("Email refresh job metadata is incomplete");

      const started = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
        refreshRepository.startAccount(scopedDb, refreshId, connectorAccountId)
      );
      if (!started) {
        return { status: "succeeded", errorCode: null, emailUpserted: 0, emailFailures: 0 };
      }

      const preflight = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const snapshot = await refreshRepository.getAccountSnapshot(
          scopedDb,
          refreshId,
          connectorAccountId
        );
        const account = (await connectorsRepository.listAccounts(scopedDb)).find(
          (row) => row.id === connectorAccountId
        );
        if (!snapshot || !account || account.status !== "active")
          return { failure: "no-active-connection" as const };
        if (account.provider_type !== snapshot.provider_type)
          return { failure: "no-active-connection" as const };
        const grants = await preferencesRepository.get(scopedDb, featureGrantsPrefKey(account.id));
        if (!resolveEffectiveGrants(account.scopes, grants).email) {
          return { failure: "email-needs-config" as const };
        }
        return { providerType: snapshot.provider_type };
      });

      const outcome =
        "failure" in preflight
          ? emptyFailure(preflight.failure ?? "no-active-connection")
          : preflight.providerType === "google"
            ? toRefreshOutcome(
                await runGoogleEmailRefresh(job, refreshId, connectorAccountId, accessContext, {
                  ...deps,
                  connectorsRepository,
                  connectorCipher,
                  googleService,
                  googleClient,
                  preferencesRepository,
                  emailRepository,
                  aiRepository,
                  aiCipher,
                  suppressionRepository
                })
              )
            : toRefreshOutcome(
                await runImapEmailRefresh(job, connectorAccountId, accessContext, {
                  ...deps,
                  connectorsRepository,
                  connectorCipher,
                  emailRepository,
                  aiRepository,
                  aiCipher
                })
              );

      await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
        refreshRepository.finishAccount(scopedDb, refreshId, connectorAccountId, outcome)
      );
      return outcome;
    }
  );

  const dispatchWorker = await registerDataContextWorker<EmailRefreshDispatchJobPayload, number>(
    boss,
    EMAIL_REFRESH_DISPATCH_QUEUE,
    deps.dataContext,
    (job, scopedDb) =>
      dispatchPendingEmailRefreshJobs(scopedDb, boss, job.data.actorUserId, refreshRepository)
  );

  const sweepWorker = await boss.work<Record<string, never>, number>(
    EMAIL_REFRESH_SWEEP_QUEUE,
    deps.workOptions ?? { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error("pg-boss invoked email refresh sweep without a job");
      const result = await sql<{ readonly actor_user_id: string }>`
        SELECT actor_user_id FROM app.list_connector_email_refresh_dispatch_actors()
      `.execute(deps.rootDb);
      let sent = 0;
      for (const { actor_user_id: actorUserId } of result.rows) {
        const payload: EmailRefreshDispatchJobPayload = {
          actorUserId,
          kind: "email-refresh-dispatch",
          idempotencyKey: "email-refresh-dispatch"
        };
        if (
          (await sendJob(boss, EMAIL_REFRESH_DISPATCH_QUEUE, payload, {
            singletonKey: actorUserId
          })) !== null
        ) {
          sent += 1;
        }
      }
      return sent;
    }
  );

  await boss.schedule(
    EMAIL_REFRESH_SWEEP_QUEUE,
    EMAIL_REFRESH_SWEEP_CRON,
    {},
    { key: "connectors-email-refresh-outbox", tz: "UTC" }
  );
  return [accountWorker, dispatchWorker, sweepWorker];
}

async function runGoogleEmailRefresh(
  job: Job<EmailRefreshAccountJobPayload>,
  refreshId: string,
  accountId: string,
  accessContext: ReturnType<typeof toAccessContext>,
  deps: RegisterEmailRefreshWorkersDeps & {
    readonly connectorsRepository: ConnectorsRepository;
    readonly connectorCipher: ReturnType<typeof createConnectorSecretCipher>;
    readonly googleService: GoogleConnectionService;
    readonly googleClient: GoogleApiClient;
    readonly preferencesRepository: PreferencesRepository;
    readonly emailRepository: EmailRepository;
    readonly aiRepository: AiRepository;
    readonly aiCipher: ReturnType<typeof createAiSecretCipher>;
    readonly suppressionRepository: EmailActionSuppressionRepository;
  }
): Promise<GoogleSyncResult> {
  const now = new Date().toISOString();
  let continuation: GoogleSyncContinuationState | undefined = {
    idempotencyKey: refreshId,
    connectorAccountId: accountId,
    phase: "email-current-day",
    chunkIndex: 0,
    startedAt: now,
    calendarSeenSince: now,
    calendarUpserted: 0,
    calendarReconciled: 0,
    emailUpserted: 0,
    emailFailures: 0,
    escalations: 0,
    errors: []
  };
  let result: GoogleSyncResult | undefined;
  while (continuation) {
    const state: GoogleSyncContinuationState = continuation;
    const outcome: GoogleSyncChunkOutcome = await deps.dataContext.withDataContext(
      accessContext,
      async (scopedDb) => {
        if (state.chunkIndex === 0) {
          await deps.connectorsRepository.markSyncStarted(scopedDb, accountId, {
            startedAt: new Date(),
            trigger: "manual"
          });
        }
        const emailExtractDeps = buildEmailExtractDeps(scopedDb, deps.aiRepository, deps.aiCipher, {
          createCliStructuredAdapter: deps.createCliStructuredAdapter,
          logger: deps.logger
        });
        const syncDeps: GoogleSyncDeps = {
          actorUserId: job.data.actorUserId,
          getActiveAccount: async (db) => {
            const account = await loadGoogleSyncActiveAccount(
              deps.connectorsRepository,
              deps.connectorCipher,
              db,
              deps.logger ?? { warn: () => undefined, info: () => undefined }
            );
            return account?.id === accountId ? account : undefined;
          },
          getFreshAccessToken: (db, options) => deps.googleService.getFreshAccessToken(db, options),
          googleClient: deps.googleClient,
          emailExtractDeps,
          emailRepository: deps.emailRepository,
          connectorsRepository: deps.connectorsRepository,
          preferencesRepository: deps.preferencesRepository,
          logger: deps.logger,
          actionProjection: {
            taskPort: deps.taskPort,
            preferencesRepository: deps.preferencesRepository,
            suppressionRepository: deps.suppressionRepository,
            actionRowRelevance: deps.actionRowRelevance,
            actorUserId: job.data.actorUserId,
            logger: deps.logger
          },
          runId: refreshId,
          trigger: "manual",
          threadJudgementRequester: deps.threadJudgementRequester,
          knownSenderAddresses: deps.knownSenderAddresses
        };
        return runGoogleSyncChunk(scopedDb, syncDeps, state);
      }
    );
    result = outcome.result;
    continuation = outcome.continuation;
  }
  return result ?? { calendarUpserted: 0, calendarReconciled: 0, emailUpserted: 0, errors: [] };
}

async function runImapEmailRefresh(
  job: Job<EmailRefreshAccountJobPayload>,
  accountId: string,
  accessContext: ReturnType<typeof toAccessContext>,
  deps: RegisterImapSyncWorkerDeps & {
    readonly connectorsRepository: ConnectorsRepository;
    readonly connectorCipher: ReturnType<typeof createConnectorSecretCipher>;
    readonly emailRepository: EmailRepository;
    readonly aiRepository: AiRepository;
    readonly aiCipher: ReturnType<typeof createAiSecretCipher>;
  }
): Promise<ImapSyncResult> {
  return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
    const emailExtractDeps = buildEmailExtractDeps(scopedDb, deps.aiRepository, deps.aiCipher, {
      createCliStructuredAdapter: deps.createCliStructuredAdapter,
      logger: deps.logger
    });
    return runImapSync(scopedDb, accountId, {
      repository: deps.connectorsRepository,
      cipher: deps.connectorCipher,
      emailExtractDeps,
      emailRepository: deps.emailRepository,
      logger: deps.logger,
      trigger: "manual",
      actorUserId: job.data.actorUserId,
      threadJudgementRequester: deps.threadJudgementRequester,
      knownSenderAddresses: deps.knownSenderAddresses
    });
  });
}
