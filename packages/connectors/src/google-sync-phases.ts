import { replyThreadingMetadata } from "./reply-threading.js";
import { sql } from "kysely";

import type { ConnectorSyncDeferredReason, ConnectorSyncErrorDetail } from "@moss/shared";
import type { StructuredRunScope } from "@moss/ai";
import type { DataContextDb } from "@moss/db";
import type { CalendarRepository } from "@moss/calendar";
import type { EmailRepository } from "@moss/email";
import type { PreferencesRepository } from "@moss/structured-state";

import type { GoogleCalendarEvent } from "./google-api-client.js";
import { isRetryableGoogleError } from "./google-api-client.js";
import {
  EmailExtractNeedsConfigurationError,
  EmailExtractRetryableError,
  extractEmailSignalsBatch,
  looksLikeOneTimeCodeEmail,
  otpSkippedResult,
  senderAddress,
  type EmailExtractOptions,
  type EmailExtractResult,
  type EmailExtractRetryableReason,
  type ParsedEmail
} from "./email-extract.js";
import {
  GoogleEmailReadProvider,
  GMAIL_READ_FOLDER,
  type MailMessageKey
} from "./email-read-provider.js";
import { ownAddressSet } from "./email-sorting.js";
import { loadOwnAddressesAndSettle, settleOwnSent } from "./own-sent.js";
import { runSortingModelPass, threadUserSentLast } from "./email-sorting-live.js";
import { projectEmailActions } from "./monitor-jobs.js";
import { listSavedEmailContext } from "./source-context/email.js";
import type { ConnectorsRepository } from "./repository.js";
import type { GoogleSyncDeps, SyncLogger } from "./sync-jobs.js";
import { resolveHistoryWalk } from "./google-sync-history.js";
import { MAX_DEFERRED_KEYS } from "./google-sync-payload.js";
import type { EmailThreadJudgementRequester } from "@moss/module-sdk";

export const GOOGLE_EMAIL_CHUNK_SIZE = 8;
export const GOOGLE_EMAIL_FETCH_CONCURRENCY = 8;
/**
 * A chunk hands off the rest of its page well before the 840 s job expiry,
 * so a slow model can never trap the whole page in an expired job. Each
 * chunk still attempts its first unit unconditionally, so a stuck page makes
 * progress (or a recorded failure) instead of handing off forever.
 */
export const GOOGLE_SYNC_CHUNK_TIME_BUDGET_MS = 600_000;
/**
 * A message whose analysis failed this many times is given up on: the next
 * sync leaves it alone instead of re-sending it. Attempts count once per run
 * (a chunk retry inside the same run does not count again), and a new Gmail
 * revision resets the count.
 */
export const MAX_ANALYSIS_ATTEMPTS = 5;
export const GOOGLE_CALENDAR_CHUNK_SIZE = 100;
/**
 * A transient Google failure (rate limit / 5xx) is retried this many times in total before the
 * sync step gives up; the delay grows a little after each try. A genuine permission refusal is
 * never retried.
 */
export const GOOGLE_READ_RETRY_ATTEMPTS = 3;
export const DEFAULT_GOOGLE_RETRY_DELAY_MS = 250;

const CALENDAR_WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const CALENDAR_WINDOW_FUTURE_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_QUERY = "newer_than:30d older_than:1d";
const CURRENT_DAY_EMAIL_QUERY = "newer_than:1d";

interface TokenHolder {
  token: string;
  refreshing?: Promise<string>;
}

interface PhaseProgress {
  calendarUpserted: number;
  calendarReconciled: number;
  emailUpserted: number;
  emailFailures: number;
  escalations: number;
  readonly errors: string[];
  /** Messages set aside for a later retry this run (never more than emailUpserted). */
  emailDeferred: number;
  /**
   * The ids of the messages currently set aside. Membership, not arithmetic, is what makes
   * the count distinct: retrying the same page re-adds an id that is already there, and a
   * later success removes it.
   */
  readonly deferredKeys: Set<string>;
  /** The most recent reason a message was deferred, for the sync-status "why" text. */
  deferredReason: ConnectorSyncDeferredReason | null;
  /**
   * The first provider refusal this run (HTTP status, provider reason, refused
   * operation). First wins: the earliest failure is usually the root cause and
   * later ones its echo. Secret-free by construction, stored in the sync record.
   */
  errorDetail: ConnectorSyncErrorDetail | null;
}

interface PhaseContext {
  readonly scopedDb: DataContextDb;
  readonly deps: GoogleSyncDeps;
  readonly tokenHolder: TokenHolder;
  readonly calendarRepo: CalendarRepository;
  readonly emailRepo: EmailRepository;
  readonly connectorsRepo: ConnectorsRepository;
  readonly preferencesRepo: PreferencesRepository;
  readonly account: { id: string };
  readonly startedAt: string;
  readonly calendarSeenSince: string;
  readonly runId: string;
  readonly now: () => Date;
  readonly logger: SyncLogger;
  readonly progress: PhaseProgress;
  readonly cursor: string | undefined;
  /** Backlog walk state carried from the previous chunk (#2804). */
  readonly historyMode?: "history" | "full";
  readonly historyAnchor?: string;
}

/** What one email chunk hands back to the sync loop. */
/**
 * The row saved for one fetched Gmail message. A sign-in code message keeps no preview, so the
 * code text never lands in a column other readers use.
 */
export function cachedEmailInput(
  connectorAccountId: string,
  parsed: ParsedEmail,
  extracted: EmailExtractResult
) {
  return {
    connectorAccountId,
    externalId: parsed.externalId,
    sender: parsed.from,
    recipients: parsed.recipients,
    subject: parsed.subject,
    snippet: looksLikeOneTimeCodeEmail(parsed) ? null : parsed.snippet,
    receivedAt: parsed.receivedAt,
    externalMetadata: {
      labelIds: parsed.labelIds,
      historyId: parsed.historyId ?? null,
      threadId: parsed.threadId ?? null,
      ...replyThreadingMetadata(parsed)
    },
    summary: extracted.summary,
    signals: extracted.signals as Record<string, unknown>
  };
}

export interface EmailPhaseResult {
  readonly nextCursor: string | undefined;
  readonly retry: boolean;
  /** The cursor this chunk listed from. A retry resumes here, which a fallback resets. */
  readonly listedCursor: string | undefined;
  readonly historyMode?: "history" | "full";
  readonly historyAnchor?: string;
}

/** The oldest mail the backlog walk keeps, matching EMAIL_QUERY's newer_than:30d. */
const EMAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

let savepointCounter = 0;

export async function withSavepoint<T>(
  scopedDb: DataContextDb,
  work: (savepointDb: DataContextDb) => Promise<T>
): Promise<T> {
  savepointCounter += 1;
  const name = `jarvis_sync_sp_${savepointCounter}`;
  await sql.raw(`SAVEPOINT ${name}`).execute(scopedDb.db);
  try {
    const result = await work(scopedDb);
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(scopedDb.db);
    return result;
  } catch (error) {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(scopedDb.db);
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(scopedDb.db);
    throw error;
  }
}

export async function withTokenRetry<T>(
  scopedDb: DataContextDb,
  deps: GoogleSyncDeps,
  holder: TokenHolder,
  op: (token: string) => Promise<T>
): Promise<T> {
  const retryDelayMs = deps.googleRetryDelayMs ?? DEFAULT_GOOGLE_RETRY_DELAY_MS;
  let attempt = 0;
  let refreshed = false;
  for (;;) {
    const attemptedToken = holder.token;
    try {
      return await op(attemptedToken);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 401 && !refreshed) {
        refreshed = true;
        if (holder.token === attemptedToken) {
          holder.refreshing ??= deps.getFreshAccessToken(scopedDb, { force: true });
          try {
            holder.token = await holder.refreshing;
          } finally {
            holder.refreshing = undefined;
          }
        }
        // Loop rather than return: the retried call goes through the same transient handling,
        // and a second 401 with the refreshed token falls through to the throw below.
        continue;
      }
      // A rate limit or a Google server hiccup is transient, not a refusal: back off and try
      // the same call again rather than failing the whole sync step. A genuine permission
      // error is not retried and keeps its named operation for the log. Jitter spreads the
      // retries of the parallel message fetches so they do not all return at the same instant.
      if (isRetryableGoogleError(error) && attempt + 1 < GOOGLE_READ_RETRY_ATTEMPTS) {
        attempt += 1;
        const backoff = retryDelayMs * attempt;
        const jitter = Math.floor(Math.random() * retryDelayMs);
        await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
        continue;
      }
      throw error;
    }
  }
}

/**
 * The storable subset of a provider refusal: HTTP status, Google's reason code,
 * refused operation. Tokens are bounded to a safe alphabet and length, so a
 * hostile or chatty provider body can never smuggle content or secrets into
 * the sync record. Null when the error names nothing worth keeping.
 */
export function toSyncErrorDetail(error: unknown): ConnectorSyncErrorDetail | null {
  const fields = googleFailureFields(error);
  const detail: ConnectorSyncErrorDetail = {
    status: Number.isInteger(fields.status) ? fields.status : null,
    reason: sanitizeDetailToken(fields.reason),
    operation: sanitizeDetailToken(fields.operation)
  };
  if (detail.status === null && detail.reason === null && detail.operation === null) return null;
  return detail;
}

/** Reason and operation codes are short dotted or camel-case tokens, never prose. */
function sanitizeDetailToken(value: string | null): string | null {
  if (value === null) return null;
  const token = value.trim().slice(0, 64);
  if (token.length === 0 || /[^A-Za-z0-9_.-]/.test(token)) return null;
  return token;
}

/**
 * Bounded, non-secret fields that name a refused Google call: which operation, its status and
 * Google's own reason code. Never the response body or the request's content. Shared by every
 * failure log in this file so the operation is always present when there is one (#2300).
 */
function googleFailureFields(error: unknown): {
  name: string;
  status: number | null;
  reason: string | null;
  operation: string | null;
} {
  const e = error as
    | { name?: string; statusCode?: number; reason?: string; operation?: string }
    | undefined;
  return {
    name: e?.name ?? "Error",
    status: e?.statusCode ?? null,
    reason: e?.reason ?? null,
    operation: e?.operation ?? null
  };
}

function mapEventInstants(
  event: Pick<GoogleCalendarEvent, "start" | "end">
): { startsAt: string; endsAt: string; allDay: boolean } | null {
  const { start, end } = event;
  if (start?.dateTime && end?.dateTime) {
    return { startsAt: start.dateTime, endsAt: end.dateTime, allDay: false };
  }
  if (start?.date && end?.date) {
    return {
      startsAt: `${start.date}T00:00:00.000Z`,
      endsAt: `${end.date}T00:00:00.000Z`,
      allDay: true
    };
  }
  return null;
}

export async function runGoogleCalendarPhase(context: PhaseContext): Promise<string | undefined> {
  let nextCursor: string | undefined;
  try {
    const ref = new Date(context.startedAt).getTime();
    const page: { items: GoogleCalendarEvent[]; nextPageToken?: string } = await withTokenRetry(
      context.scopedDb,
      context.deps,
      context.tokenHolder,
      async (token) => {
        const input = {
          accessToken: token,
          calendarId: "primary",
          timeMin: new Date(ref - CALENDAR_WINDOW_PAST_MS).toISOString(),
          timeMax: new Date(ref + CALENDAR_WINDOW_FUTURE_MS).toISOString()
        };
        return context.deps.googleClient.listCalendarEventsPage
          ? context.deps.googleClient.listCalendarEventsPage({
              ...input,
              pageToken: context.cursor,
              maxResults: GOOGLE_CALENDAR_CHUNK_SIZE
            })
          : { items: await context.deps.googleClient.listCalendarEvents(input) };
      }
    );
    nextCursor = page.nextPageToken;
    for (const event of page.items) {
      if (!event.id || event.status === "cancelled") continue;
      const instants = mapEventInstants(event);
      if (!instants) {
        context.logger.warn(
          { stage: "calendar", reason: "unusable-event-times" },
          "google-sync skipped a calendar event with no usable start/end"
        );
        continue;
      }
      try {
        await withSavepoint(context.scopedDb, (savepointDb) =>
          context.calendarRepo.upsertCachedEvent(savepointDb, {
            connectorAccountId: context.account.id,
            externalId: event.id,
            title: event.summary ?? "(no title)",
            startsAt: instants.startsAt,
            endsAt: instants.endsAt,
            location: event.location ?? null,
            summary: event.description ? event.description.slice(0, 2000) : null,
            externalMetadata: {
              status: event.status ?? null,
              htmlLink: event.htmlLink ?? null,
              attendeeCount: event.attendees?.length ?? 0,
              allDay: instants.allDay
            }
          })
        );
        context.progress.calendarUpserted += 1;
      } catch (error) {
        if (!context.progress.errors.includes("calendar-item-error")) {
          context.progress.errors.push("calendar-item-error");
        }
        context.logger.warn(
          {
            stage: "calendar-item",
            name: (error as Error).name,
            status: (error as { statusCode?: number }).statusCode ?? null
          },
          "google-sync calendar item upsert failed"
        );
      }
    }
    if (!nextCursor) {
      context.progress.calendarReconciled =
        await context.calendarRepo.deleteCachedEventsNotSeenSince(context.scopedDb, {
          connectorAccountId: context.account.id,
          seenSince: new Date(context.calendarSeenSince)
        });
    }
  } catch (error) {
    context.logger.warn(
      {
        stage: "calendar",
        name: (error as Error).name,
        status: (error as { statusCode?: number }).statusCode ?? null
      },
      "google-sync calendar failed"
    );
    context.progress.errors.push("calendar-error");
  }
  return nextCursor;
}

/** What the sync already knows about a saved message, from the email store's sync markers. */
export interface SavedEmailMarker {
  readonly historyId: string | null;
  /** A summary with complete triage, a junk verdict, or a hand-off to the thread judgement. */
  readonly hasFinishedVerdict: boolean;
  /** Handed to the thread judgement, which may not have run yet. */
  readonly awaitingJudgement?: boolean;
  /** How many times analysis already failed for this revision. */
  readonly analysisAttempts: number;
  /** When the thread judgement was last requested for this revision, or null. */
  readonly judgementRequestedAt?: Date | null;
}

/** An unchanged hand-off is asked about again only after this long, so a lost request heals. */
export const REJUDGEMENT_RETRY_MS = 6 * 60 * 60 * 1000;

export interface SortFetchedEmailsInput {
  readonly parsedMessages: readonly ParsedEmail[];
  readonly seen: ReadonlyMap<string, SavedEmailMarker>;
  readonly persistEmail: (parsed: ParsedEmail, extracted: EmailExtractResult) => Promise<unknown>;
  readonly progress: Pick<PhaseProgress, "emailUpserted" | "emailFailures" | "errors">;
  readonly onFailure: (error: unknown) => void;
  /** The clock for the judgement retry window. Defaults to the current time. */
  readonly now?: Date;
  /** The user's own addresses. Mail sent from one is settled without any model. */
  readonly ownAddresses?: ReadonlySet<string>;
}

/**
 * Decide what happens to each fetched message and save it at most once.
 *
 * A sign-in code message is decided first, before the unchanged check, and saved a single time
 * with the fixed "skipped" marker. Deciding first is what catches a message that already
 * carries a full saved analysis from before this filter existed: otherwise it would be left
 * alone as "unchanged" and keep showing up in Today. Everything else keeps the old behaviour —
 * an unchanged message is not written at all, and a changed or new one is saved once with an
 * empty analysis and queued for the model in the order it was fetched.
 *
 * An unchanged hand-off returns its thread in rejudgeThreadRefs, once per thread, so the sync
 * asks for the judgement again, but only when it was never requested or the last request is
 * older than REJUDGEMENT_RETRY_MS. That keeps a lost request healing without a queued job and
 * a thread read on every run. rejudgeKeys maps each returned thread to the messages to stamp. A message
 * whose analysis already failed MAX_ANALYSIS_ATTEMPTS times returns in gaveUpKeys and is
 * never written or queued again for this revision.
 */
export async function sortFetchedEmails(input: SortFetchedEmailsInput): Promise<{
  readonly pending: ParsedEmail[];
  readonly unchangedKeys: string[];
  readonly otpKeys: string[];
  readonly ownSentKeys: string[];
  readonly rejudgeThreadRefs: string[];
  readonly rejudgeKeys: ReadonlyMap<string, string[]>;
  readonly gaveUpKeys: string[];
}> {
  const nowMs = (input.now ?? new Date()).getTime();
  const rejudgeKeys = new Map<string, string[]>();
  const pending: ParsedEmail[] = [];
  const rejudgeThreadRefs = new Set<string>();
  const unchangedKeys: string[] = [];
  const otpKeys: string[] = [];
  const ownSentKeys: string[] = [];
  const gaveUpKeys: string[] = [];
  const fail = (error: unknown): void => {
    input.progress.emailFailures += 1;
    if (!input.progress.errors.includes("email-message-error")) {
      input.progress.errors.push("email-message-error");
    }
    input.onFailure(error);
  };
  for (const parsed of input.parsedMessages) {
    const prior = input.seen.get(parsed.externalId);
    const unchanged = Boolean(
      parsed.historyId && prior?.historyId === parsed.historyId && prior.hasFinishedVerdict
    );
    // A message whose analysis already failed enough times is left alone, so it
    // stops being re-sent every sync. Only the same revision counts: a changed
    // message resets its attempts when it is saved and is analysed as new.
    const sameRevision = Boolean(parsed.historyId && prior?.historyId === parsed.historyId);
    if (sameRevision && (prior?.analysisAttempts ?? 0) >= MAX_ANALYSIS_ATTEMPTS) {
      gaveUpKeys.push(parsed.externalId);
      continue;
    }
    if (looksLikeOneTimeCodeEmail(parsed)) {
      try {
        await input.persistEmail(parsed, otpSkippedResult());
        if (!unchanged) input.progress.emailUpserted += 1;
        otpKeys.push(parsed.externalId);
      } catch (error) {
        fail(error);
      }
      continue;
    }
    const awaiting = Boolean(prior?.awaitingJudgement);
    const keys = { settled: ownSentKeys, unchanged: unchangedKeys };
    if (await settleOwnSent(input, parsed, { unchanged, awaiting }, keys, fail)) continue;
    if (unchanged) {
      unchangedKeys.push(parsed.externalId);
      const askedAt = prior?.judgementRequestedAt?.getTime();
      if (
        prior?.awaitingJudgement &&
        (askedAt === undefined || nowMs - askedAt > REJUDGEMENT_RETRY_MS)
      ) {
        const threadRef = parsed.threadId ?? parsed.externalId;
        rejudgeThreadRefs.add(threadRef);
        rejudgeKeys.set(threadRef, [...(rejudgeKeys.get(threadRef) ?? []), parsed.externalId]);
      }
      continue;
    }
    try {
      await input.persistEmail(parsed, { summary: null, signals: {} });
      input.progress.emailUpserted += 1;
      pending.push(parsed);
    } catch (error) {
      fail(error);
    }
  }
  pending.sort(
    (left, right) =>
      right.receivedAt.localeCompare(left.receivedAt) ||
      left.externalId.localeCompare(right.externalId)
  );
  return {
    pending,
    unchangedKeys,
    otpKeys,
    ownSentKeys,
    rejudgeThreadRefs: [...rejudgeThreadRefs],
    rejudgeKeys,
    gaveUpKeys
  };
}

export interface EmailBatchExtractOptionsInput {
  readonly phase: "email" | "email-current-day";
  readonly extractionScope?: StructuredRunScope;
  readonly closeScope: boolean;
  readonly knownSenders?: ReadonlySet<string>;
  readonly runId?: string;
  readonly logger: SyncLogger;
}

/** The per-batch options handed to the first-pass gate. Metadata only; no message content. */
export function buildEmailBatchExtractOptions(
  input: EmailBatchExtractOptionsInput
): EmailExtractOptions {
  return {
    priority: input.phase === "email-current-day" ? "foreground" : "background",
    scope: input.extractionScope,
    closeScope: input.closeScope,
    knownSenders: input.knownSenders,
    telemetry: (telemetryBatchIndex, telemetryBatchSize) => ({
      emit: (event) =>
        input.logger.info(
          {
            stage: "email-extraction",
            jobId: input.runId,
            batchIndex: telemetryBatchIndex,
            batchSize: telemetryBatchSize,
            ...event
          },
          "google-sync email extraction telemetry"
        )
    })
  };
}

export interface PersistExtractedBatchInput {
  readonly batch: readonly ParsedEmail[];
  readonly batchResults: readonly EmailExtractResult[];
  readonly persistEmail: (parsed: ParsedEmail, extracted: EmailExtractResult) => Promise<unknown>;
  readonly progress: {
    emailFailures: number;
    escalations?: number;
    errors: string[];
  };
  readonly onFailure: (error: unknown) => void;
  readonly actorUserId?: string;
  readonly threadJudgementRequester?: EmailThreadJudgementRequester;
}

/**
 * Save each gated result, then (spec 2026-09-04-email-chief-of-staff §3.2) ask for a thread
 * judgement on every maybe_owed message. The queue collapses repeats per thread; only ids cross.
 * Returns the ids that saved, for action projection.
 */
export async function persistExtractedBatch(input: PersistExtractedBatchInput): Promise<string[]> {
  const projectedKeys: string[] = [];
  for (let index = 0; index < input.batch.length; index += 1) {
    const parsed = input.batch[index]!;
    try {
      const extracted = input.batchResults[index]!;
      if (extracted.escalated && input.progress.escalations !== undefined) {
        input.progress.escalations += 1;
      }
      await input.persistEmail(parsed, extracted);
      projectedKeys.push(parsed.externalId);
      if (extracted.gate === "maybe_owed" && input.threadJudgementRequester && input.actorUserId) {
        await input.threadJudgementRequester.requestThreadJudgement(
          input.actorUserId,
          parsed.threadId ?? parsed.externalId
        );
      }
    } catch (error) {
      input.progress.emailFailures += 1;
      if (!input.progress.errors.includes("email-message-error")) {
        input.progress.errors.push("email-message-error");
      }
      input.onFailure(error);
    }
  }
  return projectedKeys;
}

/** Asks again for each unchanged hand-off's thread judgement and stamps the request. A failure is only logged. */
async function requestRejudgements(
  context: PhaseContext,
  threadRefs: readonly string[],
  keysByThread: ReadonlyMap<string, readonly string[]>
): Promise<void> {
  const { threadJudgementRequester, actorUserId } = context.deps;
  if (!threadJudgementRequester || !actorUserId) return;
  for (const threadRef of threadRefs) {
    try {
      await threadJudgementRequester.requestThreadJudgement(actorUserId, threadRef);
      await context.emailRepo.markJudgementRequested(
        context.scopedDb,
        context.account.id,
        keysByThread.get(threadRef) ?? [],
        context.now()
      );
    } catch (error) {
      context.logger.warn(
        { stage: "email-judgement-request", ...googleFailureFields(error) },
        "google-sync thread judgement request failed"
      );
    }
  }
}

/**
 * #2805: the sorting model sorts first. What it settles is saved (and handed to the thread
 * judgement when it may be owed) before the general model runs; the rest is returned for the
 * general model's first pass. Logs counts only.
 */
async function sortOnSortingModelFirst(
  context: PhaseContext,
  pending: readonly ParsedEmail[],
  knownSenders: ReadonlySet<string> | undefined,
  io: {
    readonly persistEmail: (parsed: ParsedEmail, extracted: EmailExtractResult) => Promise<unknown>;
    readonly projectKeys: (keys: readonly string[]) => Promise<void>;
  }
): Promise<readonly ParsedEmail[]> {
  const actorUserId = context.deps.actorUserId;
  let userSentLast: ((parsed: ParsedEmail) => Promise<boolean>) | undefined;
  const pass = await runSortingModelPass({
    pending,
    sorting: context.deps.emailExtractDeps.sorting,
    userSentLast: async (parsed) => {
      if (!actorUserId) return false;
      userSentLast ??= threadUserSentLast(
        context.emailRepo,
        context.scopedDb,
        actorUserId,
        ownAddressSet(
          await context.emailRepo.listFrequentRecipientAddresses(context.scopedDb, actorUserId)
        )
      );
      return userSentLast(parsed);
    },
    knownSender: (parsed) => knownSenders?.has(senderAddress(parsed.from)) ?? false,
    now: context.now,
    guard: (work) => withSavepoint(context.scopedDb, () => work())
  });
  if (pass.sorted.length > 0) {
    const projectedKeys = await persistExtractedBatch({
      batch: pass.sorted.map((entry) => entry.parsed),
      batchResults: pass.sorted.map((entry) => entry.result),
      persistEmail: io.persistEmail,
      progress: context.progress,
      onFailure: (error) => {
        context.progress.errorDetail ??= toSyncErrorDetail(error);
        context.logger.warn(
          { stage: "email-message", ...googleFailureFields(error) },
          "google-sync email message failed"
        );
      },
      actorUserId,
      threadJudgementRequester: context.deps.threadJudgementRequester
    });
    await io.projectKeys(projectedKeys);
    for (const entry of pass.sorted) context.progress.deferredKeys.delete(entry.parsed.externalId);
    context.progress.emailDeferred = context.progress.deferredKeys.size;
  }
  if (pending.length > 0) {
    context.logger.info(
      { stage: "email-sorting", sorted: pass.counts.sorted, general: pass.counts.general },
      "google-sync email sorting model pass"
    );
  }
  return pass.general;
}

export async function runGoogleEmailPhase(
  context: PhaseContext,
  phase: "email-current-day" | "email"
): Promise<EmailPhaseResult> {
  let nextCursor: string | undefined;
  let listedCursor = context.cursor;
  let walkMode = context.historyMode;
  let walkAnchor = context.historyAnchor;
  const outcome = (next: string | undefined, retry: boolean): EmailPhaseResult => ({
    nextCursor: next,
    retry,
    listedCursor,
    ...(walkMode ? { historyMode: walkMode } : {}),
    ...(walkAnchor ? { historyAnchor: walkAnchor } : {})
  });
  // Which messages are inside the extraction call right now. The deferral is caught outside
  // the batch loop, so without this the run knows a message was deferred but not which one.
  let inFlightKeys: readonly string[] = [];
  const query = phase === "email-current-day" ? CURRENT_DAY_EMAIL_QUERY : EMAIL_QUERY;
  // Both phases list at most one chunk per page, so every chunk commits a small batch and
  // new mail saved with an empty analysis is visible as soon as its chunk commits (#2804).
  const pageLimit = GOOGLE_EMAIL_CHUNK_SIZE;
  // The job expires 840 s after it was queued. When this chunk has spent its budget it
  // hands the rest of the page to the next chunk (same phase and cursor) instead of
  // running past the expiry. The first unit always runs, so a page still moves forward.
  const chunkStartMs = context.now().getTime();
  let completedUnits = 0;
  const timeBudgetSpent = (): boolean =>
    completedUnits > 0 && context.now().getTime() - chunkStartMs > GOOGLE_SYNC_CHUNK_TIME_BUDGET_MS;
  const extractionScope = context.deps.actorUserId
    ? {
        actorUserId: context.deps.actorUserId,
        connectorAccountId: context.account.id,
        lineageId: context.runId
      }
    : undefined;
  const persistEmail = (parsed: ParsedEmail, extracted: EmailExtractResult) =>
    withSavepoint(context.scopedDb, (savepointDb) =>
      context.emailRepo.upsertCachedMessage(
        savepointDb,
        cachedEmailInput(context.account.id, parsed, extracted)
      )
    );
  const projectKeys = async (keys: readonly string[]) => {
    if (!context.deps.actionProjection || keys.length === 0) return;
    const projection = context.deps.actionProjection;
    const saved = await listSavedEmailContext(
      context.scopedDb,
      {
        connectorsRepository: context.connectorsRepo,
        preferencesRepository: context.preferencesRepo,
        emailRepository: context.emailRepo
      },
      context.account.id,
      keys
    );
    const projected = await projectEmailActions(context.scopedDb, saved.items, {
      ...projection,
      taskPort: {
        create: (db, input) =>
          withSavepoint(db, (savepointDb) => projection.taskPort.create(savepointDb, input))
      },
      now: projection.now ?? context.now
    });
    if (projected.taskFailures > 0) {
      context.progress.emailFailures += projected.taskFailures;
      if (!context.progress.errors.includes("email-task-error")) {
        context.progress.errors.push("email-task-error");
      }
      context.logger.warn(
        { stage: "email-task", taskFailures: projected.taskFailures },
        "google-sync suggested task save failed"
      );
    }
  };
  try {
    const provider = new GoogleEmailReadProvider(context.deps.googleClient, query);
    const client = context.deps.googleClient;
    let page: { keys: MailMessageKey[]; nextCursor?: string } | undefined;
    const walked = await resolveHistoryWalk({
      phase,
      cursor: context.cursor,
      walkMode,
      walkAnchor,
      listedCursor,
      pageLimit,
      client,
      logger: context.logger,
      getStoredPosition: () =>
        context.connectorsRepo.getEmailHistoryId(context.scopedDb, context.account.id),
      withToken: (run) => withTokenRetry(context.scopedDb, context.deps, context.tokenHolder, run),
      failureFields: googleFailureFields
    });
    walkMode = walked.walkMode;
    walkAnchor = walked.walkAnchor;
    listedCursor = walked.listedCursor;
    page = walked.page;
    page ??= await withTokenRetry(context.scopedDb, context.deps, context.tokenHolder, (token) =>
      provider.listMessageKeyPage(token, GMAIL_READ_FOLDER, {
        cursor: listedCursor,
        limit: pageLimit
      })
    );
    nextCursor = page.nextCursor;
    const existing = await context.emailRepo.listSyncMarkers(context.scopedDb, context.account.id);
    const seen = new Map(existing.map((marker) => [marker.externalId, marker]));
    const parsedMessages: ParsedEmail[] = [];
    for (let start = 0; start < page.keys.length; start += GOOGLE_EMAIL_FETCH_CONCURRENCY) {
      // Same phase and cursor: the next chunk re-lists this page and skips what is done.
      if (timeBudgetSpent()) return outcome(undefined, true);
      const keys = page.keys.slice(start, start + GOOGLE_EMAIL_FETCH_CONCURRENCY);
      const fetched = await Promise.allSettled(
        keys.map((key) =>
          withTokenRetry(context.scopedDb, context.deps, context.tokenHolder, (token) =>
            provider.getMessage(token, key)
          )
        )
      );
      for (const result of fetched) {
        if (result.status === "fulfilled") {
          // Change history can name mail older than the window; leave that alone.
          if (
            walkMode === "history" &&
            Date.parse(result.value.receivedAt) < context.now().getTime() - EMAIL_WINDOW_MS
          ) {
            continue;
          }
          parsedMessages.push(result.value);
        } else if (walkMode === "history" && isNotFound(result.reason)) {
          // Changed and then deleted before it was fetched: nothing to keep.
          continue;
        } else {
          context.progress.emailFailures += 1;
          if (!context.progress.errors.includes("email-message-error")) {
            context.progress.errors.push("email-message-error");
          }
          context.progress.errorDetail ??= toSyncErrorDetail(result.reason);
          context.logger.warn(
            { stage: "email-message", ...googleFailureFields(result.reason) },
            "google-sync email message failed"
          );
        }
      }
      completedUnits += 1;
    }
    const recordMessageFailure = (error: unknown): void => {
      context.progress.errorDetail ??= toSyncErrorDetail(error);
      context.logger.warn(
        { stage: "email-message", ...googleFailureFields(error) },
        "google-sync email message failed"
      );
    };
    const ownAddresses = await loadOwnAddressesAndSettle(context);
    const { pending, unchangedKeys, otpKeys, ownSentKeys, rejudgeThreadRefs, rejudgeKeys } =
      await sortFetchedEmails({
        parsedMessages,
        seen,
        now: context.now(),
        ownAddresses,
        persistEmail,
        progress: context.progress,
        onFailure: recordMessageFailure
      });
    const knownSenders =
      context.deps.knownSenderAddresses && context.deps.actorUserId
        ? await context.deps.knownSenderAddresses(context.scopedDb, context.deps.actorUserId)
        : undefined;
    // The sorting pass is also an extraction attempt: if it fails retryably the
    // pending messages count as tried, just like a failed model batch below.
    inFlightKeys = pending.map((message) => message.externalId);
    const general = await sortOnSortingModelFirst(context, pending, knownSenders, {
      persistEmail,
      projectKeys
    });
    inFlightKeys = [];
    // Skipped messages never reach the model call (never sent, never logged), so the batches
    // below — and the closeScope index that finalizes a scoped CLI session on the last real
    // batch — only ever cover messages that actually go to the model.
    let processed = 0;
    const batches = general.map((message) => [message]);
    for (const [batchIndex, batch] of batches.entries()) {
      // Same phase and cursor: the next chunk re-lists this page and skips what is done.
      if (timeBudgetSpent()) return outcome(undefined, true);
      let batchResults: EmailExtractResult[];
      inFlightKeys = batch.map((message) => message.externalId);
      try {
        batchResults = await extractEmailSignalsBatch(
          batch,
          context.deps.emailExtractDeps,
          buildEmailBatchExtractOptions({
            phase,
            extractionScope,
            closeScope: batchIndex === batches.length - 1,
            knownSenders,
            runId: context.runId,
            logger: context.logger
          })
        );
      } catch (error) {
        if (!(error instanceof EmailExtractNeedsConfigurationError)) throw error;
        if (!context.progress.errors.includes("email-needs-config")) {
          context.progress.errors.push("email-needs-config");
        }
        context.logger.info(
          { stage: "email-extraction", name: error.name },
          "google-sync email extraction unavailable; continuing metadata-only"
        );
        break;
      }
      const projectedKeys = await persistExtractedBatch({
        batch,
        batchResults,
        persistEmail,
        progress: context.progress,
        onFailure: recordMessageFailure,
        actorUserId: context.deps.actorUserId,
        threadJudgementRequester: context.deps.threadJudgementRequester
      });
      await projectKeys(projectedKeys);
      // These messages just went through extraction without a retryable error, so any of them
      // still marked deferred from an earlier attempt on this run are resolved now.
      for (const key of inFlightKeys) {
        context.progress.deferredKeys.delete(key);
      }
      context.progress.emailDeferred = context.progress.deferredKeys.size;
      processed += batch.length;
      completedUnits += 1;
      context.logger.info(
        {
          stage: phase,
          batchIndex,
          batchSize: batch.length,
          processed,
          total: general.length
        },
        "google-sync email extraction progress"
      );
    }
    await projectKeys(unchangedKeys);
    await projectKeys(otpKeys);
    await projectKeys(ownSentKeys);
    await requestRejudgements(context, rejudgeThreadRefs, rejudgeKeys);
  } catch (error) {
    if (error instanceof EmailExtractRetryableError) {
      if (!extractionScope) throw error;
      context.progress.emailFailures += 1;
      // Count message units, not attempts: retrying the same page re-adds ids that are
      // already in the set, so emailDeferred can never run ahead of emailUpserted.
      // Only newly set-aside messages count a failed analysis attempt: chunk retries
      // inside the same run must not burn the whole cap at once.
      const newlyDeferred: string[] = [];
      for (const key of inFlightKeys) {
        if (context.progress.deferredKeys.size >= MAX_DEFERRED_KEYS) break;
        if (!context.progress.deferredKeys.has(key)) newlyDeferred.push(key);
        context.progress.deferredKeys.add(key);
      }
      if (newlyDeferred.length > 0) {
        try {
          await context.emailRepo.recordAnalysisAttempts(
            context.scopedDb,
            context.account.id,
            newlyDeferred
          );
        } catch (recordError) {
          context.logger.warn(
            { stage: "email-attempts", name: (recordError as Error).name },
            "google-sync analysis attempt count failed"
          );
        }
      }
      context.progress.emailDeferred = context.progress.deferredKeys.size;
      context.progress.deferredReason = deferredReasonCode(error.reason);
      if (!context.progress.errors.includes("email-message-error")) {
        context.progress.errors.push("email-message-error");
      }
      context.logger.warn(
        { stage: "email-extraction", name: error.name, reason: error.reason },
        "google-sync email unit deferred for retry"
      );
      return outcome(nextCursor, true);
    }
    const errorLabel =
      error instanceof EmailExtractNeedsConfigurationError ? "email-needs-config" : "email-error";
    const isNeedsConfig = error instanceof EmailExtractNeedsConfigurationError;
    const logData = { stage: "email", ...googleFailureFields(error) };
    if (isNeedsConfig) {
      context.logger.info(
        logData,
        "google-sync email extraction unavailable; continuing metadata-only"
      );
    } else {
      // A failed list page keeps its bounded reason in the sync record (#2804).
      context.progress.errorDetail ??= toSyncErrorDetail(error);
      context.logger.warn(logData, "google-sync email failed");
    }
    if (!context.progress.errors.includes(errorLabel)) context.progress.errors.push(errorLabel);
  }
  return outcome(nextCursor, false);
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 404;
}

/** Map the extraction layer's retry reason onto the fixed code the shared wording uses. */
function deferredReasonCode(reason: EmailExtractRetryableReason): ConnectorSyncDeferredReason {
  switch (reason) {
    case "login-expired":
      return "assistant-login-expired";
    case "structured-output":
      return "structured-output";
    default:
      return "assistant-unavailable";
  }
}
