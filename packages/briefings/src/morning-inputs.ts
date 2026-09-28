import type { BriefingDefinition, DataContextDb } from "@moss/db";

import {
  SECTION_CHAR_CAP,
  findExecute,
  gatherToolSection,
  isActionableTriage,
  type BriefingGap,
  type ComposeDeps,
  type ComposeRunInput,
  type Section
} from "./compose-shared.js";
import type { EmailBriefingSignal } from "./signals.js";
import { sanitizeExternal } from "./trust-boundary.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETED_TASK_CAP = 5;
const AWAITING_EMAIL_CAP = 5;
const COMMITMENT_SUGGESTION_CAP = 3;
const WORTH_KNOWING_CAP = 2;
const THREAD_JUDGEMENT_LOOKUP_CAP = 50;

export const COMPLETED_SINCE_LAST_BRIEFING = "[completed since last briefing]";

type GatherContext = readonly [
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps
];

function charCap(lines: readonly string[]): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > SECTION_CHAR_CAP) return { lines: out, truncated: true };
    out.push(line);
    total += line.length;
  }
  return { lines: out, truncated: false };
}

/**
 * Morning tasks: open tasks plus tasks completed since the previous succeeded morning run
 * (24 hours when there is none). Archived and suggested tasks never reach the prompt.
 * Open tasks come first, so a line's index matches its raw item for priority scoring.
 */
export async function gatherMorningTasks(
  ctx: GatherContext,
  gaps: BriefingGap[],
  now: Date,
  timeZone: string
): Promise<Section> {
  if (!ctx[1].selected_tool_names.includes("tasks.list")) {
    return { key: "tasks", label: "TASKS", lines: [], count: 0, rawItems: [] };
  }
  const since = ctx[2].previousMorningRunAt ?? new Date(now.getTime() - DAY_MS);
  const base = { key: "tasks", label: "TASKS", toolName: "tasks.list", arrayKey: "items" };
  const openGaps: BriefingGap[] = [];
  const open = await gatherToolSection(
    ...ctx,
    {
      ...base,
      toolInput: { status: "todo" },
      include: (t) => t.status === "todo",
      format: (t) =>
        [sanitizeExternal(t.title), sanitizeExternal(t.status)].filter(Boolean).join(" · ")
    },
    openGaps,
    now,
    timeZone
  );
  const doneGaps: BriefingGap[] = [];
  const done = await gatherToolSection(
    ...ctx,
    {
      ...base,
      toolInput: { status: "done", completedAfter: since.toISOString() },
      include: (t) => t.status === "done",
      format: (t) => `${COMPLETED_SINCE_LAST_BRIEFING} ${sanitizeExternal(t.title)}`
    },
    doneGaps,
    now,
    timeZone
  );
  const { lines, truncated } = charCap([...open.lines, ...done.lines.slice(0, COMPLETED_TASK_CAP)]);
  const scratch = [...openGaps, ...doneGaps];
  const failure = scratch.find((g) => g.reason === "tool_failed" || g.reason === "module_disabled");
  if (failure) {
    gaps.push({ source: "tasks", reason: failure.reason });
  } else if (lines.length === 0) {
    gaps.push({ source: "tasks", reason: "empty" });
  } else if (
    truncated ||
    done.lines.length > COMPLETED_TASK_CAP ||
    scratch.some((g) => g.reason === "truncated")
  ) {
    gaps.push({ source: "tasks", reason: "truncated" });
  }
  return {
    key: "tasks",
    label: "TASKS",
    lines,
    count: open.count + done.count,
    rawItems: [...(open.rawItems ?? []), ...(done.rawItems ?? [])]
  };
}

/** Task lines that are still open; completed lines always follow them. */
export function openTaskLines(lines: readonly string[]): string[] {
  return lines.filter((line) => !line.startsWith(COMPLETED_SINCE_LAST_BRIEFING));
}

/**
 * Email the morning briefing keeps: the old action labels, plus mail the sorter handed to
 * the Commitments closer look. The sorter no longer writes action labels on first pass.
 */
export function isBriefingEmailItem(item: Record<string, unknown>): boolean {
  return isActionableTriage(item) || item.awaitingJudgement === true;
}

/** The closer look queues a thread by its thread id, or by the message id when it has none. */
function threadRefOf(item: Record<string, unknown>): string | null {
  const ref = typeof item.threadId === "string" && item.threadId ? item.threadId : item.id;
  return typeof ref === "string" && ref ? ref : null;
}

/**
 * Clears the awaiting flag on mail the Commitments closer look has already judged. The
 * sorter's flag is never cleared after the judgement, so a thread judged at or after the
 * message arrived is settled: its outcome shows up as a suggestion or not at all. When the
 * judgement read is missing or fails, the mail keeps its flag.
 */
export async function settleJudgedEmail(
  ctx: GatherContext,
  items: readonly Record<string, unknown>[],
  now: Date,
  timeZone: string
): Promise<Record<string, unknown>[]> {
  const threadRefs = [
    ...new Set(
      items
        .filter((item) => item.awaitingJudgement === true)
        .map(threadRefOf)
        .filter((ref): ref is string => ref !== null)
    )
  ].slice(0, THREAD_JUDGEMENT_LOOKUP_CAP);
  if (
    threadRefs.length === 0 ||
    !findExecute(ctx[3].moduleManifests, "commitments.threadJudgements")
  ) {
    return [...items];
  }
  const section = await gatherToolSection(
    ...ctx,
    {
      key: "email_judgements",
      label: "EMAIL JUDGEMENTS",
      toolName: "commitments.threadJudgements",
      selectedVia: "email.listVisibleMessages",
      toolInput: { threadRefs },
      arrayKey: "threads",
      format: (t) => (typeof t.threadRef === "string" ? t.threadRef : "")
    },
    [],
    now,
    timeZone
  );
  const judgedAt = new Map<string, number>();
  for (const row of section.rawItems ?? []) {
    const at = typeof row.judgedAt === "string" ? Date.parse(row.judgedAt) : NaN;
    if (typeof row.threadRef === "string" && Number.isFinite(at)) judgedAt.set(row.threadRef, at);
  }
  return items.map((item) => {
    const ref = item.awaitingJudgement === true ? threadRefOf(item) : null;
    const at = ref === null ? undefined : judgedAt.get(ref);
    const received = typeof item.receivedAt === "string" ? Date.parse(item.receivedAt) : NaN;
    const settled = at !== undefined && (!Number.isFinite(received) || at >= received);
    return settled ? { ...item, awaitingJudgement: false } : item;
  });
}

/**
 * Pending commitment suggestions, read through the Commitments module's own list tool. The
 * read rides the email selection because these suggestions come from the same mail. A
 * missing or disabled Commitments module adds nothing and records no gap.
 */
export async function gatherCommitmentSuggestions(
  ctx: GatherContext,
  gaps: BriefingGap[],
  now: Date,
  timeZone: string
): Promise<string[]> {
  if (!findExecute(ctx[3].moduleManifests, "commitments.list")) return [];
  const scratch: BriefingGap[] = [];
  const section = await gatherToolSection(
    ...ctx,
    {
      key: "commitment_suggestions",
      label: "COMMITMENT SUGGESTIONS",
      toolName: "commitments.list",
      selectedVia: "email.listVisibleMessages",
      arrayKey: "items",
      format: (c) => {
        const due = sanitizeExternal(c.dueLocalDate);
        const parts = [
          sanitizeExternal(c.title),
          sanitizeExternal(c.counterpartyLabel),
          due ? `due ${due}` : ""
        ].filter(Boolean);
        return parts.length > 0 ? `[suggested commitment] ${parts.join(" · ")}` : "";
      }
    },
    scratch,
    now,
    timeZone
  );
  if (scratch.some((g) => g.reason === "tool_failed")) {
    gaps.push({ source: "commitment_suggestions", reason: "tool_failed" });
  }
  return section.lines.slice(0, COMMITMENT_SUGGESTION_CAP);
}

export interface MorningEmailLines {
  readonly lines: string[];
  readonly truncated: boolean;
  readonly breakdown: {
    readonly signals: number;
    readonly awaitingJudgement: number;
    readonly commitmentSuggestions: number;
    readonly worthKnowing: number;
  };
}

/**
 * The email section's prompt lines: ranked signals, kept mail no signal already names,
 * pending commitment suggestions, then a short worth-knowing roundup from fyi mail.
 */
export function buildMorningEmailLines(args: {
  readonly signals: readonly EmailBriefingSignal[];
  readonly items: readonly Record<string, unknown>[];
  readonly suggestionLines: readonly string[];
}): MorningEmailLines {
  const signalLines = args.signals.map((s) => sanitizeExternal(s.summary)).filter(Boolean);
  const named = new Set(args.signals.flatMap((s) => s.messageIds));
  const allAwaiting = args.items
    .filter((item) => item.awaitingJudgement === true && !named.has(String(item.id)))
    .map((item) =>
      [sanitizeExternal(item.sender), sanitizeExternal(item.subject)].filter(Boolean).join(" · ")
    )
    .filter(Boolean);
  const awaitingLines = allAwaiting
    .slice(0, AWAITING_EMAIL_CAP)
    .map((line) => `[may need you] ${line}`);
  const worthKnowingLines = args.items
    .filter((item) => item.actionability === "fyi")
    .map((item) => sanitizeExternal(item.summary))
    .filter(Boolean)
    .slice(0, WORTH_KNOWING_CAP)
    .map((line) => `[worth knowing] ${line}`);
  const { lines, truncated } = charCap([
    ...signalLines,
    ...awaitingLines,
    ...args.suggestionLines,
    ...worthKnowingLines
  ]);
  return {
    lines,
    // Mail past the awaiting cap is dropped too, so it counts as truncation.
    truncated: truncated || allAwaiting.length > AWAITING_EMAIL_CAP,
    breakdown: {
      signals: signalLines.length,
      awaitingJudgement: awaitingLines.length,
      commitmentSuggestions: args.suggestionLines.length,
      worthKnowing: worthKnowingLines.length
    }
  };
}
