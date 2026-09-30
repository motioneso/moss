import type { DataContextDb } from "@moss/db";
import { signInCodeDecision } from "@moss/shared/email-otp-rule";

import {
  otpSkippedResult,
  sanitizeExtractResult,
  type EmailExtractResult,
  type ParsedEmail
} from "./email-extract.js";
import {
  EMAIL_SORTING_QUESTIONS,
  buildEmailSortingState,
  decideEmailCategory,
  userSentLastInThread,
  type EmailSortingAsk,
  type EmailSortingCategory
} from "./email-sorting.js";

/**
 * #2805: sync sorts email on the sorting model first (spec 2026-09-22-sorting-model.md, section 11).
 *
 * The mapped category settles the first pass and the general model is not asked. An unsure answer
 * the decision depends on, a failed request, or no sorting model sends the message to the general
 * model's first pass, unchanged.
 *
 * Stored shapes match the general model's first pass, so every reader keeps working:
 * - sign_in_code: the sign-in code skip.
 * - noise: the gate's junk verdict, no summary.
 * - needs_reply, needs_action, time_sensitive_info: handed to the thread judgement (maybe_owed).
 * - fyi: the worth-knowing verdict with the preview summary; feeds the briefing roundup.
 * - receipt_or_notice, waiting_on_someone: that category with the preview summary. Kept and
 *   searchable; the briefing's allow-lists never read a receipt or notice.
 */

/** The sorting model, as the extraction deps expose it. */
export interface EmailSortingService {
  /** True when a sorting model is set for email sorting. Reads settings only; asks no model. */
  readonly available: () => Promise<boolean>;
  readonly ask: EmailSortingAsk;
}

export type LiveEmailSortingOutcome =
  | {
      readonly kind: "sorted";
      readonly category: EmailSortingCategory;
      readonly result: EmailExtractResult;
    }
  | { readonly kind: "general"; readonly reason: "unsure" | "failed" | "not_configured" };

export interface LiveEmailSortingInput {
  readonly parsed: ParsedEmail;
  /** `unknown` when the thread could not be read; see EmailSortingFacts. */
  readonly userSentLast: boolean | "unknown";
  readonly knownSender: boolean;
  readonly now: Date;
}

/** Errors that mean no sorting model answers email sorting: none is bound, or it needs setup. */
const NOT_CONFIGURED_ERRORS = new Set(["not_supported", "needs_config"]);

/**
 * Sort one message on the sorting model. Never throws: a thrown request reads as failed, so email
 * sorting always has the general model to fall back on.
 */
export async function sortEmailOnSortingModel(
  input: LiveEmailSortingInput,
  ask: EmailSortingAsk
): Promise<LiveEmailSortingOutcome> {
  const { parsed } = input;
  const signInCode = signInCodeDecision({
    from: parsed.from,
    subject: parsed.subject,
    body: parsed.body
  });
  let probabilities: Readonly<Record<string, number>> = {};
  if (signInCode === "ordinary") {
    const state = buildEmailSortingState(
      {
        subject: parsed.subject,
        from: parsed.from,
        receivedAt: parsed.receivedAt,
        body: parsed.body
      },
      input.now
    );
    let answer: Awaited<ReturnType<EmailSortingAsk>>;
    try {
      answer = await ask(state, EMAIL_SORTING_QUESTIONS);
    } catch {
      return { kind: "general", reason: "failed" };
    }
    if (!answer.ok) {
      return {
        kind: "general",
        reason: NOT_CONFIGURED_ERRORS.has(answer.error) ? "not_configured" : "failed"
      };
    }
    probabilities = answer.probabilities;
  }
  const decision = decideEmailCategory(
    { signInCode, userSentLast: input.userSentLast },
    probabilities
  );
  if (decision.kind === "unsure") return { kind: "general", reason: "unsure" };
  return {
    kind: "sorted",
    category: decision.category,
    result: sortingModelResult(
      parsed,
      decision.category,
      answerCertainty(probabilities),
      input.knownSender
    )
  };
}

/**
 * How sure the answers were: the least certain answer's distance from a coin flip, as 0.5..1.
 * A decision code settled alone (a sign-in code) is fully certain.
 */
export function answerCertainty(probabilities: Readonly<Record<string, number>>): number {
  const values = Object.values(probabilities).filter((p) => Number.isFinite(p));
  if (values.length === 0) return 1;
  return Math.min(...values.map((p) => Math.max(p, 1 - p)));
}

/** The stored first-pass result for a category the sorting model settled. */
export function sortingModelResult(
  parsed: ParsedEmail,
  category: EmailSortingCategory,
  confidence: number,
  knownSender: boolean
): EmailExtractResult {
  const marked = (result: EmailExtractResult): EmailExtractResult => ({
    ...result,
    signals: { ...result.signals, sortedBy: "sorting_model" }
  });
  switch (category) {
    case "sign_in_code":
      return otpSkippedResult();
    case "noise":
      return marked({
        summary: null,
        gate: "nothing",
        signals: { actionability: { category: "noise" }, confidence }
      });
    case "needs_reply":
    case "needs_action":
    case "time_sensitive_info":
      return marked({
        summary: null,
        gate: "maybe_owed",
        signals: { pendingJudgement: true, confidence }
      });
    case "fyi":
    case "receipt_or_notice":
    case "waiting_on_someone":
      // The same preview summary, body-echo guard, bulk and truncation flags as the general path.
      return marked(
        sanitizeExtractResult(
          parsed,
          {
            summary: null,
            ...(category === "fyi" ? { gate: "worth_knowing" as const } : {}),
            signals: { actionability: { category }, confidence }
          },
          knownSender
        )
      );
  }
}

export interface SortingModelPassInput {
  readonly pending: readonly ParsedEmail[];
  readonly sorting: EmailSortingService | undefined;
  readonly userSentLast: (parsed: ParsedEmail) => Promise<boolean | "unknown">;
  readonly knownSender: (parsed: ParsedEmail) => boolean;
  readonly now: () => Date;
  /** Runs one database-touching step so its failure cannot abort the sync's transaction. */
  readonly guard: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface SortingModelPassResult {
  readonly sorted: readonly { readonly parsed: ParsedEmail; readonly result: EmailExtractResult }[];
  /** Left for the general model's first pass, in the order they arrived. */
  readonly general: readonly ParsedEmail[];
  /** Metadata only: messages sorted per category, and why the rest went to the general model. */
  readonly counts: {
    readonly sorted: Readonly<Record<string, number>>;
    readonly general: Readonly<Record<string, number>>;
  };
}

/**
 * Ask the sorting model about each pending message, one at a time. The first answer that says no
 * sorting model is set stops the asking for the rest of the pass.
 */
export async function runSortingModelPass(
  input: SortingModelPassInput
): Promise<SortingModelPassResult> {
  const sorted: { parsed: ParsedEmail; result: EmailExtractResult }[] = [];
  const general: ParsedEmail[] = [];
  const sortedCounts: Record<string, number> = {};
  const generalCounts: Record<string, number> = {};
  const bump = (map: Record<string, number>, key: string, by = 1): void => {
    map[key] = (map[key] ?? 0) + by;
  };
  const counts = { sorted: sortedCounts, general: generalCounts };
  if (input.pending.length === 0) return { sorted, general, counts };

  const sorting = input.sorting;
  const available = sorting ? await input.guard(sorting.available).catch(() => false) : false;
  if (!sorting || !available) {
    bump(generalCounts, "not_configured", input.pending.length);
    return { sorted, general: [...input.pending], counts };
  }

  let configured = true;
  for (const parsed of input.pending) {
    if (!configured) {
      general.push(parsed);
      bump(generalCounts, "not_configured");
      continue;
    }
    const userSentLast = await input
      .guard(() => input.userSentLast(parsed))
      .catch(() => "unknown" as const);
    const outcome = await input
      .guard(() =>
        sortEmailOnSortingModel(
          { parsed, userSentLast, knownSender: input.knownSender(parsed), now: input.now() },
          sorting.ask
        )
      )
      .catch((): LiveEmailSortingOutcome => ({ kind: "general", reason: "failed" }));
    if (outcome.kind === "sorted") {
      sorted.push({ parsed, result: outcome.result });
      bump(sortedCounts, outcome.category);
      continue;
    }
    if (outcome.reason === "not_configured") configured = false;
    general.push(parsed);
    bump(generalCounts, outcome.reason);
  }
  return { sorted, general, counts };
}

/**
 * One sorting model across several single-message passes: the settings are read once, and the
 * first answer that says no sorting model is set stops asking for the rest.
 */
export function sortingSession(
  service: EmailSortingService | undefined
): EmailSortingService | undefined {
  if (!service) return undefined;
  let availability: Promise<boolean> | undefined;
  let stopped = false;
  return {
    available: () => (stopped ? Promise.resolve(false) : (availability ??= service.available())),
    ask: async (state, questions) => {
      const answer = await service.ask(state, questions);
      if (!answer.ok && NOT_CONFIGURED_ERRORS.has(answer.error)) stopped = true;
      return answer;
    }
  };
}

type ThreadMessage = { readonly sender: string; readonly received_at: string | Date };

/** The thread reads that "the user sent the last message" needs, as the email repository has them. */
export interface EmailThreadReader {
  listByThread(
    scopedDb: DataContextDb,
    ownerUserId: string,
    threadId: string
  ): Promise<readonly (ThreadMessage & { readonly external_id: string })[]>;
  listNewerInThreads(
    scopedDb: DataContextDb,
    ownerUserId: string,
    pairs: readonly { threadId: string; afterExternalId: string }[]
  ): Promise<readonly { readonly message: ThreadMessage }[]>;
}

/**
 * Whether the newest cached message in a message's thread came from the user. The thread read is
 * capped, so the newest message past the cap is added. Each thread is read once per pass.
 */
export function threadUserSentLast(
  reader: EmailThreadReader,
  scopedDb: DataContextDb,
  ownerUserId: string,
  ownAddresses: ReadonlySet<string>
): (parsed: ParsedEmail) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (parsed) => {
    const threadId = parsed.threadId ?? null;
    if (!threadId) {
      return userSentLastInThread(
        [{ sender: parsed.from, receivedAt: parsed.receivedAt }],
        ownAddresses
      );
    }
    const cached = cache.get(threadId);
    if (cached !== undefined) return cached;
    const thread = await reader.listByThread(scopedDb, ownerUserId, threadId);
    const last = thread.at(-1);
    const newer = last
      ? await reader.listNewerInThreads(scopedDb, ownerUserId, [
          { threadId, afterExternalId: last.external_id }
        ])
      : [];
    const value = userSentLastInThread(
      [...thread, ...newer.map((n) => n.message)].map((m) => ({
        sender: m.sender,
        receivedAt: m.received_at
      })),
      ownAddresses
    );
    cache.set(threadId, value);
    return value;
  };
}
