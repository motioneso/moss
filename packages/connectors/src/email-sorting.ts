import type { SignInCodeDecision } from "@moss/shared/email-otp-rule";

/**
 * #2805: email sorting on the sorting model (spec 2026-09-22-sorting-model.md, section 11).
 *
 * The sorting model answers six atomic yes/no questions per email. Code, not the model, turns the
 * answers and two code-side facts into a category, first match wins. When an answer the decision
 * depends on sits inside the unsure band, the email goes to the general model instead.
 *
 * Sync stores this verdict (email-sorting-live.ts); the comparison command re-sorts stored mail.
 */

/** A job key of its own, so an admin can bind or bypass email sorting separately. */
export const EMAIL_SORTING_SERVICE = "module.connectors.email-sort" as const;

export type EmailSortingQuestionId =
  | "personal_sender"
  | "asks_reply"
  | "asks_action"
  | "near_deadline"
  | "marketing"
  | "receipt_or_notice";

/** The six agreed questions (Ben, 2026-09-29). Wording is part of the approved design. */
export const EMAIL_SORTING_QUESTIONS: Readonly<
  Record<EmailSortingQuestionId, { readonly instructions: string }>
> = {
  personal_sender: {
    instructions:
      "Did a real person write this to you personally, rather than an automated or bulk sender?"
  },
  asks_reply: { instructions: "Does it ask you a question or expect a reply?" },
  asks_action: {
    instructions: "Does it ask you to do something (pay, sign, book, fill in a form)?"
  },
  near_deadline: { instructions: "Does it mention a date or deadline in the next week?" },
  marketing: { instructions: "Is it marketing, a newsletter or a promotion?" },
  receipt_or_notice: {
    instructions:
      "Is this a receipt, order or booking confirmation, or an account or policy notice?"
  }
};

export const EMAIL_SORTING_QUESTION_IDS = Object.keys(
  EMAIL_SORTING_QUESTIONS
) as EmailSortingQuestionId[];

/** Answers inside this closed band are unsure. Below it is no, above it is yes. */
export const EMAIL_SORTING_UNSURE_LOW = 0.35;
export const EMAIL_SORTING_UNSURE_HIGH = 0.65;

export type EmailSortingCategory =
  | "sign_in_code"
  | "noise"
  | "needs_reply"
  | "needs_action"
  | "receipt_or_notice"
  | "waiting_on_someone"
  | "time_sensitive_info"
  | "fyi";

export type EmailSortingDecision =
  | { readonly kind: "category"; readonly category: EmailSortingCategory }
  /** The general model decides. `reason` names the step that could not be settled. */
  | {
      readonly kind: "unsure";
      readonly reason: EmailSortingCategory;
      readonly questions: readonly EmailSortingQuestionId[];
    };

export interface EmailSortingFacts {
  /** The existing code check. `unclear` counts as a sign-in code too (Ben, 2026-09-29). */
  readonly signInCode: SignInCodeDecision;
  /** The newest cached message in the email's thread was sent by the user. */
  readonly userSentLast: boolean;
}

type Answer = "yes" | "no" | "unsure";

export function readSortingAnswer(probability: number): Answer {
  if (probability > EMAIL_SORTING_UNSURE_HIGH) return "yes";
  if (probability < EMAIL_SORTING_UNSURE_LOW) return "no";
  return "unsure";
}

/**
 * The agreed mapping, first match wins: sign-in code, noise (marketing and not a personal
 * sender), needs_reply, needs_action, receipt_or_notice, waiting_on_someone,
 * time_sensitive_info, fyi. A receipt that asks for a reply or an action keeps that label.
 *
 * Each step is three-valued. A step that is clearly true decides; clearly false moves on; a step
 * that depends on an unsure answer stops the walk and hands the email to the general model. An
 * unsure answer that no reached step depends on never causes a fallback.
 */
export function decideEmailCategory(
  facts: EmailSortingFacts,
  probabilities: Readonly<Partial<Record<EmailSortingQuestionId, number>>>
): EmailSortingDecision {
  // An unclear sign-in code is filtered as one and never reaches a model (Ben, 2026-09-29).
  if (facts.signInCode !== "ordinary") return { kind: "category", category: "sign_in_code" };

  const answer = (id: EmailSortingQuestionId): Answer => {
    const value = probabilities[id];
    return typeof value === "number" && Number.isFinite(value)
      ? readSortingAnswer(value)
      : "unsure";
  };

  const marketing = answer("marketing");
  const personal = answer("personal_sender");
  // Noise needs marketing yes AND personal sender no. Either side clearly failing settles it.
  if (marketing === "yes" && personal === "no") return { kind: "category", category: "noise" };
  if (marketing !== "no" && personal !== "yes") {
    const unsure: EmailSortingQuestionId[] = [];
    if (marketing === "unsure") unsure.push("marketing");
    if (personal === "unsure") unsure.push("personal_sender");
    return { kind: "unsure", reason: "noise", questions: unsure };
  }

  const steps: readonly [EmailSortingQuestionId, EmailSortingCategory][] = [
    ["asks_reply", "needs_reply"],
    ["asks_action", "needs_action"],
    ["receipt_or_notice", "receipt_or_notice"]
  ];
  for (const [id, category] of steps) {
    const value = answer(id);
    if (value === "yes") return { kind: "category", category };
    if (value === "unsure") return { kind: "unsure", reason: category, questions: [id] };
  }

  if (facts.userSentLast) return { kind: "category", category: "waiting_on_someone" };

  const deadline = answer("near_deadline");
  if (deadline === "yes") return { kind: "category", category: "time_sensitive_info" };
  if (deadline === "unsure") {
    return { kind: "unsure", reason: "time_sensitive_info", questions: ["near_deadline"] };
  }
  return { kind: "category", category: "fyi" };
}

/** System One refuses bodies over 12,000 bytes; leave room for the model name and envelope. */
export const EMAIL_SORTING_MAX_REQUEST_BYTES = 12_000;
const ENVELOPE_RESERVE_BYTES = 400;

export interface EmailSortingInput {
  readonly subject: string;
  readonly from: string;
  readonly receivedAt: string | Date;
  readonly body: string;
}

function calendarDate(value: string | Date): string | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The state the questions read. Dates travel so "in the next week" has an anchor. The body is cut
 * until the whole request, questions included, fits under the provider's byte cap.
 */
export function buildEmailSortingState(
  email: EmailSortingInput,
  now: Date
): Record<string, unknown> {
  const head = {
    subject: email.subject,
    from: email.from,
    received: calendarDate(email.receivedAt),
    today: calendarDate(now)
  };
  const budget =
    EMAIL_SORTING_MAX_REQUEST_BYTES -
    ENVELOPE_RESERVE_BYTES -
    jsonBytes(EMAIL_SORTING_QUESTIONS) -
    jsonBytes({ ...head, body: "" });
  let body = email.body;
  let size = jsonBytes(body);
  while (size > budget && body.length > 0) {
    const next = Math.floor((body.length * Math.max(budget, 0)) / size);
    body = body.slice(0, Math.min(next, body.length - 1));
    size = jsonBytes(body);
  }
  return { ...head, body };
}

/**
 * Whether the newest cached message in the thread came from one of the user's own addresses.
 * Messages are compared by received time; an empty thread is false.
 */
export function userSentLastInThread(
  thread: readonly { readonly sender: string; readonly receivedAt: string | Date }[],
  userAddresses: ReadonlySet<string>
): boolean {
  let newest: { sender: string; at: number } | null = null;
  for (const message of thread) {
    const at = new Date(message.receivedAt).getTime();
    if (Number.isNaN(at)) continue;
    if (!newest || at >= newest.at) newest = { sender: message.sender, at };
  }
  return newest !== null && userAddresses.has(bareAddress(newest.sender));
}

function bareAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

/** Raw address header values as the bare, lower-cased set userSentLastInThread compares with. */
export function ownAddressSet(raw: readonly string[]): ReadonlySet<string> {
  return new Set(raw.map(bareAddress).filter((address) => address.length > 0));
}

/** Ask the sorting model the questions; the probability of yes per question id, or an error. */
export type EmailSortingAsk = (
  state: Record<string, unknown>,
  questions: typeof EMAIL_SORTING_QUESTIONS
) => Promise<
  | { readonly ok: true; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly error: string }
>;
