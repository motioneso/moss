import type {
  CommitmentCalendarWindow,
  CommitmentOpenTask,
  CommitmentPersonContext,
  EmailJudgementOutcome,
  EmailThreadMessage,
  ProposedCommitmentAction
} from "@moss/module-sdk";

/**
 * The second pass of "email as chief of staff" (spec 2026-09-04-email-chief-of-staff): one
 * reasoning-tier call per email thread that answers whether the thread creates something the
 * user owes. Pure functions only; the worker owns the model call and the store.
 *
 * The service key is the name the AI router resolves to the user's configured model for this
 * feature. Same shape as ModuleServiceKey in @moss/shared; the literal is typed locally because
 * this package does not depend on @moss/shared.
 */
export const EMAIL_JUDGEMENT_SERVICE: `module.${string}` = "module.commitments.email-judgement";
export const WHY_MAX_LINES = 3;
export const WHY_MAX_CHARS = 240;
export const ACTIONS_MAX = 4;
export const MESSAGES_MAX = 12;
const TITLE_MAX = 200;
const LABEL_MAX = 200;
const ADDRESS_MAX = 320;
const REPLY_FACTS_MAX = 6;

export const EMAIL_JUDGEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "owed",
    "title",
    "counterpartyLabel",
    "counterpartyAddress",
    "dueLocalDate",
    "confidence",
    "why",
    "actions"
  ],
  properties: {
    owed: { type: "boolean" },
    title: { type: ["string", "null"] },
    counterpartyLabel: { type: ["string", "null"] },
    counterpartyAddress: { type: ["string", "null"] },
    dueLocalDate: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    why: { type: "array", items: { type: "string" } },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          facts: { type: "array", items: { type: "string" } },
          wantsFreeSlots: { type: "boolean" },
          title: { type: "string" },
          dueLocalDate: { type: ["string", "null"] },
          untilLocalDate: { type: "string" }
        },
        required: ["kind"]
      }
    }
  }
} as const;

export type EmailJudgementMissingContext = "people" | "notes" | "tasks" | "calendar";

export interface EmailJudgementPromptInput {
  readonly today: string;
  readonly timezone: string;
  readonly messages: readonly EmailThreadMessage[];
  readonly person: CommitmentPersonContext | null;
  readonly noteLines: readonly string[];
  readonly openTasks: readonly CommitmentOpenTask[];
  readonly calendar: CommitmentCalendarWindow | null;
  readonly missing: readonly EmailJudgementMissingContext[];
  readonly senderRuledNotObligation: boolean;
}

export function buildEmailJudgementPrompt(i: EmailJudgementPromptInput): string {
  const lines: string[] = [];
  lines.push(
    "You are the user's chief of staff. Read this email thread with what you know about the user, and answer one question: does this thread create something the user owes?"
  );
  lines.push(
    "Owed means a person or institution the user deals with is waiting on them, or a date binds them. Urgent wording is not evidence. Promotions, notices, newsletters and routine back-and-forth that ask nothing are not owed."
  );
  lines.push(
    "If owed: give a short title in the form 'Do X for Y', who is waiting, the due date as when the user's reply or step is owed, never the event date, a confidence, up to three why lines (quote at most one sentence from the email; otherwise say which fact you leaned on), and up to four proposed actions from: reply (with facts to use and whether free slots help), task (title, dueLocalDate), snooze (untilLocalDate), dismiss."
  );
  lines.push(
    "Dates are YYYY-MM-DD in the user's timezone. If not owed, answer owed:false and nothing else."
  );
  lines.push(`Today: ${i.today} (${i.timezone})`);
  if (i.senderRuledNotObligation) {
    lines.push(
      "The user has ruled that mail from this sender is not something they owe. Only answer owed:true if this thread is clearly different."
    );
  }
  lines.push("", "## Thread (oldest first)");
  for (const m of i.messages.slice(-MESSAGES_MAX)) {
    const who = m.fromIsUser ? "the user" : m.fromAddress;
    lines.push(`- ${m.receivedAt} from ${who}: ${m.subject}\n  ${m.bodyExcerpt}`);
  }
  lines.push("", "## Who this is");
  if (i.missing.includes("people")) lines.push("People: unavailable");
  else if (i.person) {
    const name = i.person.displayName ?? "(unnamed)";
    const rel = i.person.relationshipSummary ? `, ${i.person.relationshipSummary}` : "";
    lines.push(`Person: ${name}${rel}`);
    for (const l of i.person.recentNoteLines) lines.push(`- ${l}`);
  } else lines.push("Person: not in the user's People.");
  lines.push("", "## Notes that mention them");
  if (i.missing.includes("notes")) lines.push("Notes: unavailable");
  else if (i.noteLines.length === 0) lines.push("None.");
  else for (const l of i.noteLines) lines.push(`- ${l}`);
  lines.push("", "## Open tasks that may relate");
  if (i.missing.includes("tasks")) lines.push("Tasks: unavailable");
  else if (i.openTasks.length === 0) lines.push("None.");
  else
    for (const t of i.openTasks)
      lines.push(`- ${t.title}${t.dueLocalDate ? ` (due ${t.dueLocalDate})` : ""}`);
  lines.push("", "## Calendar, next 14 days (busy)");
  if (i.missing.includes("calendar")) lines.push("Calendar: unavailable");
  else if (!i.calendar) lines.push("Not needed for this thread.");
  else if (i.calendar.busy.length === 0) lines.push("Nothing booked.");
  else for (const b of i.calendar.busy) lines.push(`- ${b.start} to ${b.end}: ${b.title}`);
  return lines.join("\n");
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One sentence at most, quotes preserved, never longer than a why line may be. */
export function capQuoteToOneSentence(s: string): string {
  const t = s.trim().slice(0, WHY_MAX_CHARS);
  const quoted = t.startsWith('"');
  const inner = quoted ? t.slice(1).replace(/"$/, "") : t;
  const m = inner.match(/^[^.!?]*[.!?]/);
  const one = m ? m[0] : inner;
  return (quoted ? `"${one}"` : one).slice(0, WHY_MAX_CHARS);
}

function parseAction(raw: unknown): ProposedCommitmentAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.kind) {
    case "reply":
      return {
        kind: "reply",
        facts: Array.isArray(a.facts)
          ? a.facts.filter((f): f is string => typeof f === "string").slice(0, REPLY_FACTS_MAX)
          : [],
        wantsFreeSlots: a.wantsFreeSlots === true
      };
    case "task":
      return typeof a.title === "string"
        ? {
            kind: "task",
            title: a.title.slice(0, TITLE_MAX),
            dueLocalDate:
              typeof a.dueLocalDate === "string" && DATE.test(a.dueLocalDate)
                ? a.dueLocalDate
                : null
          }
        : null;
    case "snooze":
      return typeof a.untilLocalDate === "string" && DATE.test(a.untilLocalDate)
        ? { kind: "snooze", untilLocalDate: a.untilLocalDate }
        : null;
    case "dismiss":
      return { kind: "dismiss" };
    default:
      return null;
  }
}

const NOT_OWED: EmailJudgementOutcome = {
  owed: false,
  title: null,
  counterpartyLabel: null,
  counterpartyAddress: null,
  dueLocalDate: null,
  confidence: "low",
  why: [],
  actions: []
};

/** Null on anything malformed; otherwise a capped, deduplicated outcome safe to store. */
export function parseEmailJudgement(raw: unknown): EmailJudgementOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.owed !== "boolean") return null;
  if (!r.owed) return { ...NOT_OWED };
  if (typeof r.title !== "string" || r.title.trim() === "") return null;
  if (
    r.dueLocalDate != null &&
    !(typeof r.dueLocalDate === "string" && DATE.test(r.dueLocalDate))
  ) {
    return null;
  }
  const confidence =
    r.confidence === "high" || r.confidence === "medium" || r.confidence === "low"
      ? r.confidence
      : "low";
  const why = (Array.isArray(r.why) ? r.why : [])
    .filter((w): w is string => typeof w === "string")
    .slice(0, WHY_MAX_LINES)
    .map(capQuoteToOneSentence);
  const seen = new Set<string>();
  const actions: ProposedCommitmentAction[] = [];
  for (const candidate of Array.isArray(r.actions) ? r.actions : []) {
    const action = parseAction(candidate);
    if (action === null || seen.has(action.kind)) continue;
    seen.add(action.kind);
    actions.push(action);
    if (actions.length === ACTIONS_MAX) break;
  }
  return {
    owed: true,
    title: r.title.trim().slice(0, TITLE_MAX),
    counterpartyLabel:
      typeof r.counterpartyLabel === "string" ? r.counterpartyLabel.slice(0, LABEL_MAX) : null,
    counterpartyAddress:
      typeof r.counterpartyAddress === "string"
        ? r.counterpartyAddress.trim().toLowerCase().slice(0, ADDRESS_MAX)
        : null,
    dueLocalDate: (r.dueLocalDate as string | null | undefined) ?? null,
    confidence,
    why,
    actions
  };
}
