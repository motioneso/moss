import type { PgBoss } from "pg-boss";
import type { DataContextRunner } from "@moss/db";
import { registerDataContextWorker } from "@moss/jobs";
import type {
  CommitmentCalendarWindow,
  CommitmentContextProviders,
  CommitmentOpenTask,
  CommitmentPersonContext,
  EmailThreadProvider
} from "@moss/module-sdk";
import { COMMITMENT_EMAIL_JUDGEMENT_QUEUE } from "./manifest.js";
import type { EmailThreadJudgementJobPayload } from "./jobs.js";
import type { CommitmentsRepository } from "./repository.js";
import {
  buildEmailJudgementPrompt,
  parseEmailJudgement,
  type EmailJudgementMissingContext
} from "./email-judgement.js";
import { buildCandidateSignature, sha8 } from "./signature.js";
import type { CommitmentExtractionWarnLogger } from "./extractor.js";

/**
 * What the per-thread email judgement worker needs (spec 2026-09-04-email-chief-of-staff §3.2).
 * Every collaborator is a declared contract; the worker never reaches into another module.
 */
export interface EmailJudgementWorkerDeps {
  readonly repository: Pick<
    CommitmentsRepository,
    "getThreadJudgement" | "upsertEmailCandidate" | "recordThreadJudgement"
  >;
  readonly threads: EmailThreadProvider;
  readonly context: CommitmentContextProviders;
  /** Returns the parsed JSON answer; throws on model failure so pg-boss retries. */
  readonly generate: (scopedDb: unknown, actorUserId: string, prompt: string) => Promise<unknown>;
  /** Slice 3 supplies the "never owed" sender rule; default false. */
  readonly senderRuledNotObligation?: (
    scopedDb: unknown,
    actorUserId: string,
    address: string
  ) => Promise<boolean>;
  /** Slice 3 setting; default true. */
  readonly contextEnabled?: (scopedDb: unknown, actorUserId: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly timezoneFor?: (scopedDb: unknown, actorUserId: string) => Promise<string>;
  readonly logger?: CommitmentExtractionWarnLogger;
}

export type EmailThreadJudgementResult = "no_item" | "item" | "skipped";

const MEETING_WORDS =
  /\b(meet|meeting|call|appointment|schedule|reschedule|availability|available|time that works|slot|calendar|zoom|coffee|lunch)\b/i;
const NOTE_LINES_LIMIT = 5;
const OPEN_TASKS_LIMIT = 25;
const CALENDAR_DAYS = 14;

async function tryProvider<T>(
  missing: EmailJudgementMissingContext[],
  name: EmailJudgementMissingContext,
  fn: (() => Promise<T>) | undefined,
  fallback: T
): Promise<T> {
  if (!fn) return fallback;
  try {
    return await fn();
  } catch {
    missing.push(name);
    return fallback;
  }
}

function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

/**
 * Judge one thread. Pure apart from its collaborators, so the unit tests drive it directly. A
 * model failure throws (pg-boss retries); a malformed answer is recorded as no item so the thread
 * is not judged again until a newer message arrives.
 */
export async function judgeEmailThread(
  scopedDb: unknown,
  payload: EmailThreadJudgementJobPayload,
  deps: EmailJudgementWorkerDeps
): Promise<EmailThreadJudgementResult> {
  const { actorUserId, threadRef } = payload;
  const messages = await deps.threads.listThreadMessages(scopedDb, actorUserId, threadRef);
  const newest = messages[messages.length - 1];
  if (!newest || newest.fromIsUser) return "skipped";
  const prior = await deps.repository.getThreadJudgement(scopedDb, actorUserId, threadRef);
  if (prior && prior.lastJudgedExternalId === newest.externalId) return "skipped";

  const contextOn = deps.contextEnabled ? await deps.contextEnabled(scopedDb, actorUserId) : true;
  const missing: EmailJudgementMissingContext[] = [];
  const sender = newest.fromAddress;
  const wantsCalendar = messages.some((m) => MEETING_WORDS.test(`${m.subject} ${m.bodyExcerpt}`));
  const ctx: CommitmentContextProviders = contextOn ? deps.context : {};
  const people = ctx.people;
  const notes = ctx.notes;
  const tasks = ctx.tasks;
  const calendarProvider = ctx.calendar;
  const person = await tryProvider<CommitmentPersonContext | null>(
    missing,
    "people",
    people ? () => people.resolveByEmail(scopedDb, actorUserId, sender) : undefined,
    null
  );
  const noteLines = await tryProvider<readonly string[]>(
    missing,
    "notes",
    notes
      ? () =>
          notes.searchLines(scopedDb, actorUserId, person?.displayName ?? sender, NOTE_LINES_LIMIT)
      : undefined,
    []
  );
  const openTasks = await tryProvider<readonly CommitmentOpenTask[]>(
    missing,
    "tasks",
    tasks ? () => tasks.listOpen(scopedDb, actorUserId, OPEN_TASKS_LIMIT) : undefined,
    []
  );
  const calendar = wantsCalendar
    ? await tryProvider<CommitmentCalendarWindow | null>(
        missing,
        "calendar",
        calendarProvider
          ? () => calendarProvider.windowFromNow(scopedDb, actorUserId, CALENDAR_DAYS)
          : undefined,
        null
      )
    : null;
  const ruled = deps.senderRuledNotObligation
    ? await deps.senderRuledNotObligation(scopedDb, actorUserId, sender)
    : false;
  const timezone = deps.timezoneFor ? await deps.timezoneFor(scopedDb, actorUserId) : "UTC";
  const now = deps.now ? deps.now() : new Date();

  const prompt = buildEmailJudgementPrompt({
    today: localDate(now, timezone),
    timezone,
    messages,
    person,
    noteLines,
    openTasks,
    calendar,
    missing,
    senderRuledNotObligation: ruled
  });
  const raw = await deps.generate(scopedDb, actorUserId, prompt);
  const outcome = parseEmailJudgement(raw);
  if (!outcome) {
    deps.logger?.warn(
      { event: "commitments.email_judgement_malformed", threadRefHash: sha8(threadRef) },
      "email judgement answer did not parse"
    );
    await deps.repository.recordThreadJudgement(
      scopedDb,
      actorUserId,
      threadRef,
      newest.externalId,
      "no_item"
    );
    return "no_item";
  }
  if (!outcome.owed || !outcome.title) {
    await deps.repository.recordThreadJudgement(
      scopedDb,
      actorUserId,
      threadRef,
      newest.externalId,
      "no_item"
    );
    return "no_item";
  }
  const hasTask = outcome.actions.some((a) => a.kind === "task");
  await deps.repository.upsertEmailCandidate(scopedDb, {
    ownerUserId: actorUserId,
    candidateSignature: buildCandidateSignature({
      kind: "obligation",
      counterpartyLabel: null,
      title: "email-thread",
      dueLocalDate: null,
      sourceKind: "email",
      sourceRef: threadRef
    }),
    kind: "obligation",
    title: outcome.title,
    dueLocalDate: outcome.dueLocalDate,
    counterpartyLabel: outcome.counterpartyLabel ?? person?.displayName ?? sender,
    confidence: outcome.confidence,
    suggestedHandling: hasTask ? "create_task" : null,
    counterpartyPersonId: person?.personId ?? null,
    counterpartyAddress: outcome.counterpartyAddress ?? sender,
    proposedActions: [...outcome.actions],
    whyLines: [...outcome.why],
    threadRef,
    lastJudgedExternalId: newest.externalId
  });
  await deps.repository.recordThreadJudgement(
    scopedDb,
    actorUserId,
    threadRef,
    newest.externalId,
    "item"
  );
  return "item";
}

export async function registerEmailThreadJudgementWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  deps: EmailJudgementWorkerDeps
): Promise<string> {
  return registerDataContextWorker<EmailThreadJudgementJobPayload, void>(
    boss,
    COMMITMENT_EMAIL_JUDGEMENT_QUEUE,
    dataContext,
    async (job, scopedDb) => {
      await judgeEmailThread(scopedDb, job.data, deps);
    }
  );
}
