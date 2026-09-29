import { signInCodeDecision } from "@moss/shared/email-otp-rule";

import {
  EMAIL_SORTING_QUESTIONS,
  buildEmailSortingState,
  decideEmailCategory,
  type EmailSortingCategory,
  type EmailSortingDecision,
  type EmailSortingQuestionId
} from "./email-sorting.js";

/**
 * #2805 shadow comparison: re-sort mail the current model already sorted through the sorting-model
 * path, side by side with the stored verdict. Read-only; the stored verdict is never changed.
 */

/** The stored verdict as the comparison reads it. `pending` is held for the thread's closer look. */
export type StoredEmailVerdict =
  | "sign_in_code"
  | "pending"
  | "noise"
  | "needs_reply"
  | "needs_action"
  | "waiting_on_someone"
  | "time_sensitive_info"
  | "fyi"
  | "unknown";

const STORED_CATEGORIES = new Set<string>([
  "noise",
  "needs_reply",
  "needs_action",
  "waiting_on_someone",
  "time_sensitive_info",
  "fyi",
  "unknown"
]);

/** Null when the message has no finished verdict to compare against. */
export function storedVerdictOf(signals: unknown): StoredEmailVerdict | null {
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) return null;
  const record = signals as Record<string, unknown>;
  if (record.skipped === "otp") return "sign_in_code";
  if (record.pendingJudgement === true) return "pending";
  const actionability = record.actionability as Record<string, unknown> | undefined;
  const category = actionability?.category;
  return typeof category === "string" && STORED_CATEGORIES.has(category)
    ? (category as StoredEmailVerdict)
    : null;
}

export interface EmailSortingComparisonMessage {
  readonly id: string;
  readonly subject: string;
  readonly sender: string;
  readonly receivedAt: string | Date;
  /** What the cache holds: the stored excerpt, else the snippet. */
  readonly text: string;
  readonly signals: unknown;
  readonly userSentLast: boolean;
}

export type EmailSortingAsk = (
  state: Record<string, unknown>,
  questions: typeof EMAIL_SORTING_QUESTIONS
) => Promise<
  | { readonly ok: true; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly error: string }
>;

export type EmailSortingShadowOutcome =
  | EmailSortingDecision
  | { readonly kind: "failed"; readonly error: string };

export interface EmailSortingComparisonRow {
  readonly id: string;
  readonly stored: StoredEmailVerdict;
  readonly shadow: EmailSortingShadowOutcome;
  readonly probabilities: Readonly<Partial<Record<EmailSortingQuestionId, number>>> | null;
}

/** Sort one message on the shadow path. Skips the request when code alone settles or defers it. */
export async function shadowSortEmail(
  message: EmailSortingComparisonMessage,
  ask: EmailSortingAsk,
  now: Date
): Promise<Omit<EmailSortingComparisonRow, "stored">> {
  const signInCode = signInCodeDecision({
    from: message.sender,
    subject: message.subject,
    body: message.text
  });
  const facts = { signInCode, userSentLast: message.userSentLast };
  if (signInCode !== "ordinary") {
    return { id: message.id, shadow: decideEmailCategory(facts, {}), probabilities: null };
  }
  const state = buildEmailSortingState(
    {
      subject: message.subject,
      from: message.sender,
      receivedAt: message.receivedAt,
      body: message.text
    },
    now
  );
  const result = await ask(state, EMAIL_SORTING_QUESTIONS);
  if (!result.ok) {
    return { id: message.id, shadow: { kind: "failed", error: result.error }, probabilities: null };
  }
  const probabilities = result.probabilities as Partial<Record<EmailSortingQuestionId, number>>;
  return { id: message.id, shadow: decideEmailCategory(facts, probabilities), probabilities };
}

export interface EmailSortingComparisonSummary {
  /** Messages with a finished, non-pending stored verdict that the shadow path sorted. */
  readonly decided: number;
  readonly agreed: number;
  /** agreed / decided, or null when nothing was decided. */
  readonly agreementRate: number | null;
  /** Would have gone to the general model, by the step that could not be settled. */
  readonly unsure: Readonly<Record<string, number>>;
  readonly failed: number;
  /** Held for a closer look today: how the shadow path would have sorted them instead. */
  readonly pending: Readonly<Record<string, number>>;
  /** stored verdict -> shadow category -> count, over decided messages. */
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly disagreements: readonly EmailSortingComparisonRow[];
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function summarizeEmailSortingComparison(
  rows: readonly EmailSortingComparisonRow[]
): EmailSortingComparisonSummary {
  let decided = 0;
  let agreed = 0;
  let failed = 0;
  const unsure: Record<string, number> = {};
  const pending: Record<string, number> = {};
  const confusion: Record<string, Record<string, number>> = {};
  const disagreements: EmailSortingComparisonRow[] = [];

  for (const row of rows) {
    if (row.shadow.kind === "failed") {
      failed += 1;
      continue;
    }
    const shadowLabel: EmailSortingCategory | "unsure" =
      row.shadow.kind === "category" ? row.shadow.category : "unsure";
    if (row.stored === "pending") {
      bump(pending, shadowLabel);
      continue;
    }
    if (row.shadow.kind === "unsure") {
      bump(unsure, row.shadow.reason);
      continue;
    }
    decided += 1;
    bump((confusion[row.stored] ??= {}), row.shadow.category);
    if (row.shadow.category === row.stored) agreed += 1;
    else disagreements.push(row);
  }

  return {
    decided,
    agreed,
    agreementRate: decided > 0 ? agreed / decided : null,
    unsure,
    failed,
    pending,
    confusion,
    disagreements
  };
}
