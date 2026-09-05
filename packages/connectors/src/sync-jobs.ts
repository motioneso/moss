import { createHash, randomUUID } from "node:crypto";

import type { Job, PgBoss, WorkOptions } from "pg-boss";
import type { Kysely } from "kysely";

import type { ConnectorSyncDeferredReason } from "@moss/shared";
import type { ActorScopedJobPayload, QueueDefinition } from "@moss/jobs";
import type { ConnectorSyncStatus, DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import { hasInFlightJob, sendJob, toAccessContext } from "@moss/jobs";
import { AiRepository, createAiSecretCipher } from "@moss/ai";
import type { EmailThreadJudgementRequester } from "@moss/module-sdk";
import { CalendarRepository } from "@moss/calendar";
import { EmailRepository } from "@moss/email";
import { PreferencesRepository } from "@moss/structured-state";

import { createConnectorSecretCipher, type ConnectorSecretCipher } from "./crypto.js";
import { featureGrantsPrefKey, isFeatureGranted } from "./feature-grants.js";
import {
  GoogleApiClient,
  type GoogleCalendarEvent,
  type GmailMessageFull
} from "./google-api-client.js";
import { decryptGoogleConnectionSecret, GoogleConnectionService } from "./google-connection.js";
import { GoogleOAuthClient } from "./oauth.js";
import { ConnectorsRepository, type ConnectorSyncTrigger } from "./repository.js";
import type { EmailExtractDeps } from "./email-extract.js";
import { buildEmailExtractDeps, type BuildEmailExtractDepsOptions } from "./extract-deps.js";
import { EmailActionSuppressionRepository } from "./action-suppression-repository.js";
import type { ProjectEmailActionsDeps } from "./monitor-jobs.js";
import { assertGoogleSyncContinuationPayload } from "./google-sync-payload.js";
import { runGoogleCalendarPhase, runGoogleEmailPhase } from "./google-sync-phases.js";

export const GOOGLE_SYNC_QUEUE = "connectors.google-sync";
export const GOOGLE_SYNC_CONTINUATION_QUEUE = "connectors.google-sync-continuation";
export const GOOGLE_SYNC_EXPIRE_SECONDS = 840;

export {
  GOOGLE_CALENDAR_CHUNK_SIZE,
  GOOGLE_CURRENT_DAY_EMAIL_PAGE_SIZE,
  GOOGLE_EMAIL_CHUNK_SIZE,
  GOOGLE_EMAIL_FETCH_CONCURRENCY,
  withSavepoint
} from "./google-sync-phases.js";

export const GOOGLE_SYNC_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: GOOGLE_SYNC_QUEUE,
    options: {
      // exclusive collapses racing actor-scoped manual and connect sync jobs.
      policy: "exclusive",
      retryLimit: 1,
      expireInSeconds: GOOGLE_SYNC_EXPIRE_SECONDS,
      deleteAfterSeconds: 300,
      retentionSeconds: 600
    }
  },
  {
    name: GOOGLE_SYNC_CONTINUATION_QUEUE,
    options: {
      // One active continuation keeps structured extraction sequential; the adapter also guards it.
      policy: "singleton",
      retryLimit: 1,
      expireInSeconds: GOOGLE_SYNC_EXPIRE_SECONDS,
      deleteAfterSeconds: 300,
      retentionSeconds: 600
    }
  }
];

export interface GoogleSyncPayload extends ActorScopedJobPayload {
  readonly kind: "google-sync";
  readonly idempotencyKey?: string;
  /** What caused this run to be enqueued: a schedule tick, a manual click, the assistant, or right after connecting. */
  readonly trigger: ConnectorSyncTrigger;
}

type GoogleSyncPhase = "calendar" | "email-current-day" | "email";

export interface GoogleSyncContinuationPayload extends ActorScopedJobPayload {
  readonly kind: "google-sync-continuation";
  readonly idempotencyKey: string;
  readonly connectorAccountId: string;
  readonly phase: GoogleSyncPhase;
  readonly cursor?: string;
  readonly chunkIndex: number;
  readonly startedAt: string;
  readonly calendarSeenSince: string;
  readonly calendarUpserted: number;
  readonly calendarReconciled: number;
  readonly emailUpserted: number;
  readonly emailFailures: number;
  readonly escalations: number;
  /**
   * Distinct messages set aside for a later retry this run (never more than emailUpserted).
   * Absent on a job queued before this field existed; such a job is read as zero.
   */
  readonly emailDeferred?: number;
  /**
   * The message ids currently set aside, so retrying the same page cannot count one message
   * twice and a later success can take it back off the list. Bounded by MAX_DEFERRED_KEYS.
   */
  readonly deferredKeys?: readonly string[];
  /** Why email work was set aside, as a fixed code the shared wording module understands. */
  readonly deferredReason?: ConnectorSyncDeferredReason | null;
  readonly errors: readonly string[];
}

export type GoogleSyncContinuationState = Omit<
  GoogleSyncContinuationPayload,
  "actorUserId" | "kind"
>;

export interface GoogleSyncChunkOutcome {
  readonly result: GoogleSyncResult;
  readonly continuation?: GoogleSyncContinuationState;
}

export interface GoogleSyncResult {
  readonly calendarUpserted: number;
  readonly calendarReconciled: number;
  readonly emailUpserted: number;
  /** Count of messages that failed to fetch/parse/upsert (metadata only; no detail). */
  readonly emailFailures?: number;
  /** Count of LLM escalations to a higher tier (cost/telemetry; metadata only). */
  readonly escalations?: number;
  /** Messages set aside for a later retry this run (never more than emailUpserted). */
  readonly emailDeferred?: number;
  readonly errors: string[];
  readonly truncated?: boolean;
}

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const DEFAULT_EMAIL_MESSAGE_CAP = 50;

export function resolveEmailMessageCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EMAIL_MESSAGE_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_EMAIL_MESSAGE_CAP;
  return parsed;
}

interface GoogleClientLike {
  listCalendarEvents(input: {
    accessToken: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
  }): Promise<GoogleCalendarEvent[]>;
  listCalendarEventsPage?(input: {
    accessToken: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{ items: GoogleCalendarEvent[]; nextPageToken?: string }>;
  listMessageIds(input: { accessToken: string; query?: string }): Promise<Array<{ id: string }>>;
  listMessageIdsPage?(input: {
    accessToken: string;
    query?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{ messages: Array<{ id: string }>; nextPageToken?: string }>;
  getMessage(input: { accessToken: string; id: string }): Promise<GmailMessageFull>;
}

export interface GoogleSyncDeps {
  readonly actorUserId?: string;
  getActiveAccount(scopedDb: DataContextDb): Promise<{ id: string; scopes: string[] } | undefined>;
  /** Return a usable token; `force` bypasses cache for the single 401 retry. */
  getFreshAccessToken(scopedDb: DataContextDb, opts?: { force?: boolean }): Promise<string>;
  readonly googleClient: GoogleClientLike;
  readonly emailExtractDeps: EmailExtractDeps;
  readonly now?: () => Date;
  readonly calendarRepository?: CalendarRepository;
  readonly emailRepository?: EmailRepository;
  readonly connectorsRepository?: ConnectorsRepository;
  readonly preferencesRepository?: PreferencesRepository;
  /** Structured, sanitized sync logger (never token/body content). Defaults to a console shim. */
  readonly logger?: SyncLogger;
  readonly actionProjection?: ProjectEmailActionsDeps;
  /** Stable root job id used to derive deterministic continuation job ids. */
  readonly runId?: string;
  /**
   * #2274: after a message the gate marks maybe_owed, ask the Commitments module to judge its
   * thread. Ids only cross this boundary.
   */
  readonly threadJudgementRequester?: EmailThreadJudgementRequester;
  /** #2274: lower-cased addresses the user already deals with, built once per sync phase. */
  readonly knownSenderAddresses?: (
    scopedDb: DataContextDb,
    actorUserId: string
  ) => Promise<ReadonlySet<string>>;
  /** What caused this run to start. Defaults to "manual" when a caller does not specify one. */
  readonly trigger?: ConnectorSyncTrigger;
}

/** Sanitized structured logging for partial-failure observability (never secrets/body). */
export interface SyncLogger {
  warn(data: Record<string, unknown>, message: string): void;
  info(data: Record<string, unknown>, message: string): void;
}

const NOOP_SYNC_LOGGER: SyncLogger = {
  // Silent fallback; production injects the structured server logger at composition.
  warn: () => undefined,
  info: () => undefined
};

export async function loadGoogleSyncActiveAccount(
  repository: ConnectorsRepository,
  cipher: ConnectorSecretCipher,
  scopedDb: DataContextDb,
  logger: SyncLogger
): Promise<{ id: string; scopes: string[] } | undefined> {
  const secret = await repository.getActiveGoogleAccountSecret(scopedDb);
  if (!secret) return undefined;
  try {
    const bundle = decryptGoogleConnectionSecret(cipher, secret.encryptedSecret);
    return { id: secret.id, scopes: bundle.grantedScopes };
  } catch {
    logger.warn({ actorScoped: true, stage: "auth" }, "google-sync stored connection invalid");
    return undefined;
  }
}

export async function runGoogleSyncChunk(
  scopedDb: DataContextDb,
  deps: GoogleSyncDeps,
  continuation?: GoogleSyncContinuationState
): Promise<GoogleSyncChunkOutcome> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? NOOP_SYNC_LOGGER;
  const calendarRepo = deps.calendarRepository ?? new CalendarRepository();
  const emailRepo = deps.emailRepository ?? new EmailRepository();
  const connectorsRepo = deps.connectorsRepository ?? new ConnectorsRepository();
  const preferencesRepo = deps.preferencesRepository ?? new PreferencesRepository();
  const errors: string[] = [...(continuation?.errors ?? [])];
  let calendarUpserted = continuation?.calendarUpserted ?? 0;
  let calendarReconciled = continuation?.calendarReconciled ?? 0;
  let emailUpserted = continuation?.emailUpserted ?? 0;
  let emailFailures = continuation?.emailFailures ?? 0;
  let escalations = continuation?.escalations ?? 0;
  // An old queued job carries only a total. Freeze that total as a baseline and count new
  // deferrals by distinct message id on top of it.
  const carriedDeferred =
    continuation?.deferredKeys === undefined ? (continuation?.emailDeferred ?? 0) : 0;
  const deferredKeys = new Set<string>(continuation?.deferredKeys ?? []);
  let deferredReason: ConnectorSyncDeferredReason | null = continuation?.deferredReason ?? null;
  let emailDeferred = carriedDeferred + deferredKeys.size;

  const account = await deps.getActiveAccount(scopedDb);
  if (!account) {
    return {
      result: {
        calendarUpserted,
        calendarReconciled,
        emailUpserted,
        emailFailures,
        escalations,
        errors: [...errors, "no-active-connection"],
        truncated: false
      }
    };
  }
  if (continuation && continuation.connectorAccountId !== account.id) {
    return {
      result: {
        calendarUpserted,
        calendarReconciled,
        emailUpserted,
        emailFailures,
        escalations,
        errors: [...errors, "no-active-connection"],
        truncated: false
      }
    };
  }

  // Stamp the start of the run on the account row (health metadata only — never status).
  if (!continuation) {
    await connectorsRepo.markSyncStarted(scopedDb, account.id, {
      startedAt: now(),
      trigger: deps.trigger ?? "manual"
    });
  }

  // Single shared token holder for the whole run: withTokenRetry writes a refreshed token back
  // here the instant it refreshes (even if the retried op then fails), so every later call —
  // across the calendar AND email sections and every message in the loop — uses the fresh token
  // rather than re-triggering a 401 → refresh per remaining message (mid-loop stale-token bug).
  const tokenHolder = { token: "" };
  try {
    tokenHolder.token = await deps.getFreshAccessToken(scopedDb);
  } catch {
    // Never log the underlying auth error object (may carry client_secret/refresh_token).
    logger.warn({ actorScoped: true, stage: "auth" }, "google-sync auth failed");
    // Record a failed run with the bounded auth label only — never the raw provider error.
    try {
      await connectorsRepo.markSyncFinished(scopedDb, account.id, {
        finishedAt: now(),
        status: "failed",
        error: "auth-error",
        counts: {
          calendarUpserted: 0,
          calendarReconciled: 0,
          emailUpserted: 0,
          emailFailures: 0,
          escalations: 0,
          emailDeferred,
          deferredReason,
          truncated: false
        }
      });
    } catch (persistErr) {
      logger.warn({ err: persistErr }, "google-sync: failed to persist auth-failure outcome");
    }
    return {
      result: {
        calendarUpserted,
        calendarReconciled,
        emailUpserted,
        emailFailures,
        escalations,
        errors: ["auth-error"],
        truncated: false
      }
    };
  }

  const featureGrants = await preferencesRepo.get(scopedDb, featureGrantsPrefKey(account.id));
  const calendarEnabled =
    (account.scopes.includes(CALENDAR_SCOPE) || account.scopes.includes("calendar")) &&
    isFeatureGranted(featureGrants, "calendar");
  const emailEnabled =
    (account.scopes.includes(GMAIL_SCOPE) || account.scopes.includes("gmail")) &&
    isFeatureGranted(featureGrants, "email");
  let phase: GoogleSyncPhase | undefined =
    continuation?.phase ??
    (calendarEnabled ? "calendar" : emailEnabled ? "email-current-day" : undefined);
  let phaseCursor = continuation?.cursor;
  const startedAt = continuation?.startedAt ?? now().toISOString();
  const calendarSeenSince = continuation?.calendarSeenSince ?? new Date().toISOString();
  const runId = continuation?.idempotencyKey ?? deps.runId ?? randomUUID();
  const chunkIndex = continuation?.chunkIndex ?? 0;
  const progress = {
    calendarUpserted,
    calendarReconciled,
    emailUpserted,
    emailFailures,
    escalations,
    emailDeferred,
    deferredKeys,
    deferredReason,
    errors
  };
  const phaseContext = {
    scopedDb,
    deps,
    tokenHolder,
    calendarRepo,
    emailRepo,
    connectorsRepo,
    preferencesRepo,
    account,
    startedAt,
    calendarSeenSince,
    runId,
    now,
    logger,
    progress
  };

  const next = (nextPhase: GoogleSyncPhase, cursor?: string): GoogleSyncChunkOutcome => ({
    result: {
      calendarUpserted,
      calendarReconciled,
      emailUpserted,
      emailFailures,
      escalations,
      emailDeferred,
      errors,
      truncated: true
    },
    continuation: {
      idempotencyKey: runId,
      connectorAccountId: account.id,
      phase: nextPhase,
      cursor,
      chunkIndex: chunkIndex + 1,
      startedAt,
      calendarSeenSince,
      calendarUpserted,
      calendarReconciled,
      emailUpserted,
      emailFailures,
      escalations,
      emailDeferred,
      deferredKeys: [...deferredKeys],
      deferredReason,
      errors
    }
  });

  if (phase === "calendar" && calendarEnabled) {
    const nextCursor = await runGoogleCalendarPhase({ ...phaseContext, cursor: phaseCursor });
    calendarUpserted = progress.calendarUpserted;
    calendarReconciled = progress.calendarReconciled;
    if (nextCursor) return next("calendar", nextCursor);
    if (emailEnabled) {
      phase = "email-current-day";
      phaseCursor = undefined;
    }
  }

  if ((phase === "email-current-day" || phase === "email") && emailEnabled) {
    const result = await runGoogleEmailPhase({ ...phaseContext, cursor: phaseCursor }, phase);
    emailUpserted = progress.emailUpserted;
    emailFailures = progress.emailFailures;
    escalations = progress.escalations;
    emailDeferred = carriedDeferred + progress.deferredKeys.size;
    deferredReason = progress.deferredReason;
    if (result.retry) return next(phase, phaseCursor);
    if (result.nextCursor) return next(phase, result.nextCursor);
    if (phase === "email-current-day") return next("email");
  }

  logger.info(
    {
      calendarUpserted,
      calendarReconciled,
      emailUpserted,
      emailFailures,
      escalations,
      emailDeferred,
      truncated: false,
      errorCount: errors.length
    },
    "google-sync complete"
  );
  // Bounded item errors (calendar/email section or per-item labels) make the run `partial`.
  // A clean run is `success`. A thrown top-level failure (auth) is recorded as `failed` above.
  // The persisted error is the first bounded label only — never raw provider/error text.
  const status: ConnectorSyncStatus = errors.length > 0 ? "partial" : "success";
  try {
    await connectorsRepo.markSyncFinished(scopedDb, account.id, {
      finishedAt: now(),
      status,
      error: errors[0] ?? null,
      counts: {
        calendarUpserted,
        calendarReconciled,
        emailUpserted,
        emailFailures,
        escalations,
        emailDeferred,
        deferredReason,
        truncated: false
      }
    });
  } catch (error) {
    logger.warn({ err: error }, "google-sync: failed to persist sync outcome; not retrying job");
  }
  return {
    result: {
      calendarUpserted,
      calendarReconciled,
      emailUpserted,
      emailFailures,
      escalations,
      emailDeferred,
      errors,
      truncated: false
    }
  };
}

/** Compatibility runner for direct callers; production workers persist one bounded chunk/job. */
export async function runGoogleSync(
  scopedDb: DataContextDb,
  deps: GoogleSyncDeps
): Promise<GoogleSyncResult> {
  let continuation: GoogleSyncContinuationState | undefined;
  let outcome: GoogleSyncChunkOutcome;
  do {
    outcome = await runGoogleSyncChunk(scopedDb, deps, continuation);
    continuation = outcome.continuation;
  } while (continuation);
  return outcome.result;
}

function continuationJobId(runId: string, chunkIndex: number): string {
  const bytes = createHash("sha256").update(`${runId}:${chunkIndex}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function handleGoogleSyncJob(
  boss: PgBoss,
  dataContext: DataContextRunner,
  job: Job<GoogleSyncPayload | GoogleSyncContinuationPayload>,
  runChunk: (
    scopedDb: DataContextDb,
    continuation?: GoogleSyncContinuationState
  ) => Promise<GoogleSyncChunkOutcome>,
  shouldSkipRoot?: (actorUserId: string) => Promise<boolean>
): Promise<GoogleSyncResult> {
  if (job.data.kind === "google-sync" && (await shouldSkipRoot?.(job.data.actorUserId))) {
    return {
      calendarUpserted: 0,
      calendarReconciled: 0,
      emailUpserted: 0,
      emailFailures: 0,
      escalations: 0,
      errors: [],
      truncated: false
    };
  }
  const continuation =
    job.data.kind === "google-sync-continuation"
      ? ((assertGoogleSyncContinuationPayload(job.data), job.data) as GoogleSyncContinuationState)
      : undefined;
  const outcome = await dataContext.withDataContext(toAccessContext(job), (scopedDb) =>
    runChunk(scopedDb, continuation)
  );
  if (outcome.continuation) {
    const payload: GoogleSyncContinuationPayload = {
      actorUserId: job.data.actorUserId,
      kind: "google-sync-continuation",
      ...outcome.continuation
    };
    assertGoogleSyncContinuationPayload(payload);
    await sendJob(boss, GOOGLE_SYNC_CONTINUATION_QUEUE, payload, {
      id: continuationJobId(payload.idempotencyKey, payload.chunkIndex)
    });
  }
  return outcome.result;
}

export interface RegisterConnectorsJobWorkersDeps {
  readonly dataContext: DataContextRunner;
  readonly rootDb: Kysely<MossDatabase>;
  readonly taskPort: ProjectEmailActionsDeps["taskPort"];
  readonly actionRowRelevance?: ProjectEmailActionsDeps["actionRowRelevance"];
  readonly createCliStructuredAdapter?: BuildEmailExtractDepsOptions["createCliStructuredAdapter"];
  readonly workOptions?: WorkOptions;
  readonly onResult?: (
    job: Job<GoogleSyncPayload | GoogleSyncContinuationPayload>,
    result: GoogleSyncResult
  ) => void;
  readonly logger?: SyncLogger;
  /** #2274: hands maybe_owed threads to the Commitments judgement queue. Optional so tests and
   *  hosts without the commitments module keep working. */
  readonly threadJudgementRequester?: GoogleSyncDeps["threadJudgementRequester"];
  /** #2274: addresses the user already knows, computed once per sync phase. */
  readonly knownSenderAddresses?: GoogleSyncDeps["knownSenderAddresses"];
}

export async function registerConnectorsJobWorkers(
  boss: PgBoss,
  deps: RegisterConnectorsJobWorkersDeps
): Promise<string[]> {
  const connectorsRepo = new ConnectorsRepository();
  const connectorCipher = createConnectorSecretCipher();
  const aiRepo = new AiRepository();
  const aiCipher = createAiSecretCipher();
  const googleService = new GoogleConnectionService({
    repository: connectorsRepo,
    cipher: connectorCipher,
    oauthClient: new GoogleOAuthClient()
  });
  const googleClient = new GoogleApiClient();
  const preferencesRepository = new PreferencesRepository();
  const suppressionRepository = new EmailActionSuppressionRepository();

  const processJob = async (
    job: Job<GoogleSyncPayload | GoogleSyncContinuationPayload>
  ): Promise<GoogleSyncResult> => {
    const result = await handleGoogleSyncJob(
      boss,
      deps.dataContext,
      job,
      (scopedDb, state) => {
        const emailExtractDeps = buildEmailExtractDeps(scopedDb, aiRepo, aiCipher, {
          createCliStructuredAdapter: deps.createCliStructuredAdapter,
          logger: deps.logger
        });
        return runGoogleSyncChunk(
          scopedDb,
          {
            actorUserId: job.data.actorUserId,
            getActiveAccount: (db) =>
              loadGoogleSyncActiveAccount(
                connectorsRepo,
                connectorCipher,
                db,
                deps.logger ?? NOOP_SYNC_LOGGER
              ),
            getFreshAccessToken: (db, opts) => googleService.getFreshAccessToken(db, opts),
            googleClient,
            emailExtractDeps,
            actionProjection: {
              taskPort: deps.taskPort,
              preferencesRepository,
              suppressionRepository,
              actionRowRelevance: deps.actionRowRelevance,
              actorUserId: job.data.actorUserId,
              logger: deps.logger
            },
            logger: deps.logger,
            runId: job.data.kind === "google-sync" ? job.id : job.data.idempotencyKey,
            threadJudgementRequester: deps.threadJudgementRequester,
            knownSenderAddresses: deps.knownSenderAddresses
            trigger: job.data.kind === "google-sync" ? job.data.trigger : undefined
          },
          state
        );
      },
      async (actorUserId) => {
        const skipped = await hasInFlightJob(
          deps.rootDb,
          GOOGLE_SYNC_CONTINUATION_QUEUE,
          actorUserId
        );
        if (skipped) {
          deps.logger?.info(
            { actorScoped: true, event: "skipped:lineage-in-flight" },
            "google-sync root skipped while continuation lineage is in flight"
          );
        }
        return skipped;
      }
    );
    if (!result.truncated) deps.onResult?.(job, result);
    return result;
  };

  const register = <TPayload extends GoogleSyncPayload | GoogleSyncContinuationPayload>(
    queue: string
  ) =>
    boss.work<TPayload, GoogleSyncResult>(
      queue,
      deps.workOptions ?? { pollingIntervalSeconds: 2 },
      async ([job]) => {
        if (!job) throw new Error(`pg-boss invoked ${queue} without a job`);
        return processJob(job);
      }
    );

  return Promise.all([
    register<GoogleSyncPayload>(GOOGLE_SYNC_QUEUE),
    register<GoogleSyncContinuationPayload>(GOOGLE_SYNC_CONTINUATION_QUEUE)
  ]);
}
