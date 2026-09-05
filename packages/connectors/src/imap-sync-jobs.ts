import type { Job, PgBoss, WorkOptions } from "pg-boss";

import type { ActorScopedJobPayload, QueueDefinition } from "@moss/jobs";
import { registerDataContextWorker } from "@moss/jobs";
import type { ConnectorSyncStatus, DataContextDb, DataContextRunner } from "@moss/db";
import { AiRepository, createAiSecretCipher } from "@moss/ai";
import { EmailRepository } from "@moss/email";

import { createConnectorSecretCipher, type ConnectorSecretCipher } from "./crypto.js";
import type { EmailExtractDeps } from "./email-extract.js";
import { extractEmailSignals } from "./email-extract.js";
import { buildEmailExtractDeps, type BuildEmailExtractDepsOptions } from "./extract-deps.js";
import type { EmailReadProvider } from "./email-read-provider.js";
import { ImapEmailReadProvider, IMAP_DEFAULT_FOLDER } from "./imap-email-read-provider.js";
import { decryptImapConnectionSecret, type ImapConnectionSecret } from "./imap-secret.js";
import { ConnectorsRepository, type ConnectorSyncTrigger } from "./repository.js";
import { withSavepoint, type SyncLogger } from "./sync-jobs.js";

export const IMAP_SYNC_QUEUE = "connectors.imap-sync";

export const IMAP_SYNC_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: IMAP_SYNC_QUEUE,
    options: {
      // exclusive + keyed by connectorAccountId at enqueue time — one in-flight sync per
      // IMAP account, mirroring GOOGLE_SYNC_QUEUE's per-actor exclusivity.
      policy: "exclusive",
      retryLimit: 1,
      deleteAfterSeconds: 300,
      retentionSeconds: 600
    }
  }
];

export interface ImapSyncPayload extends ActorScopedJobPayload {
  readonly kind: "imap-sync";
  readonly connectorAccountId: string;
  readonly idempotencyKey?: string;
  /** What caused this run to start. Today only the recurring schedule enqueues IMAP syncs. */
  readonly trigger: ConnectorSyncTrigger;
}

export interface ImapSyncResult {
  readonly emailUpserted: number;
  readonly emailFailures: number;
  readonly errors: string[];
  readonly truncated: boolean;
}

const NOOP_LOGGER: SyncLogger = { warn: () => undefined, info: () => undefined };

export interface RunImapSyncDeps {
  readonly repository: ConnectorsRepository;
  readonly cipher: ConnectorSecretCipher;
  readonly emailExtractDeps: EmailExtractDeps;
  readonly emailReadProvider?: EmailReadProvider<ImapConnectionSecret>;
  readonly emailRepository?: EmailRepository;
  readonly now?: () => Date;
  readonly logger?: SyncLogger;
  /** What caused this run to start. Defaults to "schedule" when a caller does not specify one. */
  readonly trigger?: ConnectorSyncTrigger;
}

export async function runImapSync(
  scopedDb: DataContextDb,
  connectorAccountId: string,
  deps: RunImapSyncDeps
): Promise<ImapSyncResult> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? NOOP_LOGGER;
  const emailRepo = deps.emailRepository ?? new EmailRepository();
  const provider = deps.emailReadProvider ?? new ImapEmailReadProvider();
  const errors: string[] = [];
  let emailUpserted = 0;
  let emailFailures = 0;

  await deps.repository.markSyncStarted(scopedDb, connectorAccountId, {
    startedAt: now(),
    trigger: deps.trigger ?? "schedule"
  });

  let secret: ImapConnectionSecret;
  try {
    const secretRow = await deps.repository.getActiveImapAccountSecret(
      scopedDb,
      connectorAccountId
    );
    if (!secretRow) {
      await deps.repository.markSyncFinished(scopedDb, connectorAccountId, {
        finishedAt: now(),
        status: "failed",
        error: "no-active-connection",
        counts: { emailUpserted: 0, emailFailures: 0, truncated: false },
        isContinuation: false
      });
      return {
        emailUpserted: 0,
        emailFailures: 0,
        errors: ["no-active-connection"],
        truncated: false
      };
    }
    secret = decryptImapConnectionSecret(deps.cipher, secretRow.encryptedSecret);
  } catch {
    logger.warn({ actorScoped: true, stage: "auth" }, "imap-sync auth failed");
    await deps.repository.markSyncFinished(scopedDb, connectorAccountId, {
      finishedAt: now(),
      status: "failed",
      error: "auth-error",
      counts: { emailUpserted: 0, emailFailures: 0, truncated: false },
      isContinuation: false
    });
    return { emailUpserted: 0, emailFailures: 0, errors: ["auth-error"], truncated: false };
  }

  try {
    const keys = await provider.listMessageKeys(secret, IMAP_DEFAULT_FOLDER);

    for (const key of keys) {
      try {
        const parsed = await provider.getMessage(secret, key);
        const extracted = await extractEmailSignals(parsed, deps.emailExtractDeps);
        await withSavepoint(scopedDb, (savepointDb) =>
          emailRepo.upsertCachedMessage(savepointDb, {
            connectorAccountId,
            externalId: parsed.externalId,
            sender: parsed.from,
            recipients: parsed.recipients,
            subject: parsed.subject,
            snippet: parsed.snippet,
            receivedAt: parsed.receivedAt,
            externalMetadata: {},
            summary: extracted.summary,
            signals: extracted.signals as Record<string, unknown>
          })
        );
        emailUpserted += 1;
      } catch (error) {
        emailFailures += 1;
        if (!errors.includes("email-message-error")) errors.push("email-message-error");
        logger.warn(
          { stage: "email-message", name: (error as Error).name },
          "imap-sync email message failed"
        );
      }
    }
  } catch (error) {
    logger.warn({ stage: "email", name: (error as Error).name }, "imap-sync email failed");
    errors.push("email-error");
  }

  const status: ConnectorSyncStatus = errors.length > 0 ? "partial" : "success";
  await deps.repository.markSyncFinished(scopedDb, connectorAccountId, {
    finishedAt: now(),
    status,
    error: errors[0] ?? null,
    counts: { emailUpserted, emailFailures, truncated: false },
    isContinuation: false
  });

  return { emailUpserted, emailFailures, errors, truncated: false };
}

export interface RegisterImapSyncWorkerDeps {
  readonly dataContext: DataContextRunner;
  readonly createCliStructuredAdapter?: BuildEmailExtractDepsOptions["createCliStructuredAdapter"];
  readonly workOptions?: WorkOptions;
  readonly onResult?: (job: Job<ImapSyncPayload>, result: ImapSyncResult) => void;
  readonly logger?: SyncLogger;
}

export async function registerImapSyncWorker(
  boss: PgBoss,
  deps: RegisterImapSyncWorkerDeps
): Promise<string[]> {
  const repository = new ConnectorsRepository();
  const cipher = createConnectorSecretCipher();
  const aiRepo = new AiRepository();
  const aiCipher = createAiSecretCipher();

  const workId = await registerDataContextWorker<ImapSyncPayload, ImapSyncResult>(
    boss,
    IMAP_SYNC_QUEUE,
    deps.dataContext,
    async (job, scopedDb) => {
      const emailExtractDeps = buildEmailExtractDeps(scopedDb, aiRepo, aiCipher, {
        createCliStructuredAdapter: deps.createCliStructuredAdapter,
        logger: deps.logger
      });

      const result = await runImapSync(scopedDb, job.data.connectorAccountId, {
        repository,
        cipher,
        emailExtractDeps,
        logger: deps.logger,
        trigger: job.data.trigger
      });
      deps.onResult?.(job, result);
      return result;
    },
    deps.workOptions
  );

  return [workId];
}
