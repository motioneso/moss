import { sql } from "kysely";

import type { DataContextDb } from "@moss/db";
import type { CalendarRepository } from "@moss/calendar";
import type { EmailRepository } from "@moss/email";
import type { PreferencesRepository } from "@moss/structured-state";

import type { GoogleCalendarEvent } from "./google-api-client.js";
import {
  EmailExtractNeedsConfigurationError,
  EmailExtractRetryableError,
  extractEmailSignalsBatch,
  type EmailExtractResult,
  type ParsedEmail
} from "./email-extract.js";
import { GoogleEmailReadProvider, GMAIL_READ_FOLDER } from "./email-read-provider.js";
import { projectEmailActions } from "./monitor-jobs.js";
import { listSavedEmailContext } from "./source-context/email.js";
import type { ConnectorsRepository } from "./repository.js";
import type { GoogleSyncDeps, SyncLogger } from "./sync-jobs.js";

export const GOOGLE_EMAIL_CHUNK_SIZE = 8;
export const GOOGLE_CURRENT_DAY_EMAIL_PAGE_SIZE = 500;
export const GOOGLE_EMAIL_FETCH_CONCURRENCY = 8;
export const GOOGLE_CALENDAR_CHUNK_SIZE = 100;

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
}

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

async function withTokenRetry<T>(
  scopedDb: DataContextDb,
  deps: GoogleSyncDeps,
  holder: TokenHolder,
  op: (token: string) => Promise<T>
): Promise<T> {
  const attemptedToken = holder.token;
  try {
    return await op(attemptedToken);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 401) throw error;
    if (holder.token === attemptedToken) {
      holder.refreshing ??= deps.getFreshAccessToken(scopedDb, { force: true });
      try {
        holder.token = await holder.refreshing;
      } finally {
        holder.refreshing = undefined;
      }
    }
    return op(holder.token);
  }
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

export async function runGoogleEmailPhase(
  context: PhaseContext,
  phase: "email-current-day" | "email"
): Promise<{ readonly nextCursor: string | undefined; readonly retry: boolean }> {
  let nextCursor: string | undefined;
  const query = phase === "email-current-day" ? CURRENT_DAY_EMAIL_QUERY : EMAIL_QUERY;
  const pageLimit =
    phase === "email-current-day" ? GOOGLE_CURRENT_DAY_EMAIL_PAGE_SIZE : GOOGLE_EMAIL_CHUNK_SIZE;
  const extractionScope = context.deps.actorUserId
    ? {
        actorUserId: context.deps.actorUserId,
        connectorAccountId: context.account.id,
        lineageId: context.runId
      }
    : undefined;
  const persistEmail = (parsed: ParsedEmail, extracted: EmailExtractResult) =>
    withSavepoint(context.scopedDb, (savepointDb) =>
      context.emailRepo.upsertCachedMessage(savepointDb, {
        connectorAccountId: context.account.id,
        externalId: parsed.externalId,
        sender: parsed.from,
        recipients: parsed.recipients,
        subject: parsed.subject,
        snippet: parsed.snippet,
        receivedAt: parsed.receivedAt,
        externalMetadata: {
          labelIds: parsed.labelIds,
          historyId: parsed.historyId ?? null,
          threadId: parsed.threadId ?? null
        },
        summary: extracted.summary,
        signals: extracted.signals as Record<string, unknown>
      })
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
    await projectEmailActions(context.scopedDb, saved.items, {
      ...projection,
      taskPort: {
        create: (db, input) =>
          withSavepoint(db, (savepointDb) => projection.taskPort.create(savepointDb, input))
      },
      now: projection.now ?? context.now
    });
  };
  try {
    const provider = new GoogleEmailReadProvider(context.deps.googleClient, query);
    const page = await withTokenRetry(
      context.scopedDb,
      context.deps,
      context.tokenHolder,
      (token) =>
        provider.listMessageKeyPage(token, GMAIL_READ_FOLDER, {
          cursor: context.cursor,
          limit: pageLimit
        })
    );
    nextCursor = page.nextCursor;
    const existing = await context.emailRepo.listSyncMarkers(context.scopedDb, context.account.id);
    const seen = new Map(existing.map((marker) => [marker.externalId, marker]));
    const parsedMessages: ParsedEmail[] = [];
    for (let start = 0; start < page.keys.length; start += GOOGLE_EMAIL_FETCH_CONCURRENCY) {
      const keys = page.keys.slice(start, start + GOOGLE_EMAIL_FETCH_CONCURRENCY);
      const fetched = await Promise.allSettled(
        keys.map((key) =>
          withTokenRetry(context.scopedDb, context.deps, context.tokenHolder, (token) =>
            provider.getMessage(token, key)
          )
        )
      );
      for (const result of fetched) {
        if (result.status === "fulfilled") parsedMessages.push(result.value);
        else {
          context.progress.emailFailures += 1;
          if (!context.progress.errors.includes("email-message-error")) {
            context.progress.errors.push("email-message-error");
          }
          context.logger.warn(
            { stage: "email-message", name: "ProviderReadError", status: null },
            "google-sync email message failed"
          );
        }
      }
    }
    const pending: ParsedEmail[] = [];
    const unchangedKeys: string[] = [];
    for (const parsed of parsedMessages) {
      const prior = seen.get(parsed.externalId);
      if (
        parsed.historyId &&
        prior?.historyId === parsed.historyId &&
        prior.hasSummary &&
        prior.hasCompleteTriage
      ) {
        unchangedKeys.push(parsed.externalId);
        continue;
      }
      try {
        await persistEmail(parsed, { summary: null, signals: {} });
        context.progress.emailUpserted += 1;
        pending.push(parsed);
      } catch (error) {
        context.progress.emailFailures += 1;
        if (!context.progress.errors.includes("email-message-error")) {
          context.progress.errors.push("email-message-error");
        }
        context.logger.warn(
          {
            stage: "email-message",
            name: (error as Error).name,
            status: (error as { statusCode?: number }).statusCode ?? null
          },
          "google-sync email message failed"
        );
      }
    }
    pending.sort(
      (left, right) =>
        right.receivedAt.localeCompare(left.receivedAt) ||
        left.externalId.localeCompare(right.externalId)
    );
    let processed = 0;
    const batches = pending.map((message) => [message]);
    for (const [batchIndex, batch] of batches.entries()) {
      let batchResults: EmailExtractResult[];
      try {
        batchResults = await extractEmailSignalsBatch(batch, context.deps.emailExtractDeps, {
          priority: phase === "email-current-day" ? "foreground" : "background",
          scope: extractionScope,
          closeScope: batchIndex === batches.length - 1,
          telemetry: (telemetryBatchIndex, telemetryBatchSize) => ({
            emit: (event) =>
              context.logger.info(
                {
                  stage: "email-extraction",
                  jobId: context.runId,
                  batchIndex: telemetryBatchIndex,
                  batchSize: telemetryBatchSize,
                  ...event
                },
                "google-sync email extraction telemetry"
              )
          })
        });
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
      const projectedKeys: string[] = [];
      for (let index = 0; index < batch.length; index += 1) {
        try {
          const extracted = batchResults[index]!;
          if (extracted.escalated) context.progress.escalations += 1;
          await persistEmail(batch[index]!, extracted);
          projectedKeys.push(batch[index]!.externalId);
        } catch (error) {
          context.progress.emailFailures += 1;
          if (!context.progress.errors.includes("email-message-error")) {
            context.progress.errors.push("email-message-error");
          }
          context.logger.warn(
            {
              stage: "email-message",
              name: (error as Error).name,
              status: (error as { statusCode?: number }).statusCode ?? null
            },
            "google-sync email message failed"
          );
        }
      }
      await projectKeys(projectedKeys);
      processed += batch.length;
      context.logger.info(
        { stage: phase, batchIndex, batchSize: batch.length, processed, total: pending.length },
        "google-sync email extraction progress"
      );
    }
    await projectKeys(unchangedKeys);
  } catch (error) {
    if (error instanceof EmailExtractRetryableError) {
      if (!extractionScope) throw error;
      context.progress.emailFailures += 1;
      if (!context.progress.errors.includes("email-message-error")) {
        context.progress.errors.push("email-message-error");
      }
      context.logger.warn(
        { stage: "email-extraction", name: error.name, reason: error.reason },
        "google-sync email unit deferred for retry"
      );
      return { nextCursor, retry: true };
    }
    const errorLabel =
      error instanceof EmailExtractNeedsConfigurationError ? "email-needs-config" : "email-error";
    const isNeedsConfig = error instanceof EmailExtractNeedsConfigurationError;
    const logData = {
      stage: "email",
      name: (error as Error).name,
      status: (error as { statusCode?: number }).statusCode ?? null,
      reason: (error as { reason?: string }).reason ?? null
    };
    if (isNeedsConfig) {
      context.logger.info(
        logData,
        "google-sync email extraction unavailable; continuing metadata-only"
      );
    } else {
      context.logger.warn(logData, "google-sync email failed");
    }
    if (!context.progress.errors.includes(errorLabel)) context.progress.errors.push(errorLabel);
  }
  return { nextCursor, retry: false };
}
