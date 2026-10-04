import type { ActionAuditLogEntryDto, ActivityLineDto } from "@moss/shared";

import type { BadgeTone } from "./settings-ui.js";
import { assistantName, personalize } from "../api/use-assistant-name";

/**
 * #2956 (slice C): the Activity page's fixed vocabulary. Titles, sub-lines, badges and failure
 * sentences render from recorded columns only — no model call ever writes them (plan
 * determinism boundary). Unknown codes degrade to fixed fallbacks, never raw stored text.
 */

export interface ActivityBadge {
  readonly text: string;
  readonly tone: BadgeTone;
}

export type ActivityRow =
  | {
      readonly kind: "line";
      readonly line: ActivityLineDto;
      readonly children: readonly ActivityLineDto[];
      readonly tools: readonly ActionAuditLogEntryDto[];
    }
  | { readonly kind: "tool"; readonly entry: ActionAuditLogEntryDto };

/**
 * Title vocabulary for structured calls (spec section 9): each title is declared in the
 * calling module's manifest `features` metadata under the action code, so the line title
 * and the app map agree. Unknown services fall back to "Ran a structured task".
 */
export const STRUCTURED_ACTIVITY_TITLES: Record<string, string> = {
  "structured.briefings": "Prepared a briefing",
  "structured.connectors.email-sort": "Sorted new email",
  "structured.connectors.email-extract": "Checked new email for follow-ups",
  "structured.commitments.email-judgement": "Checked what new email asks of you",
  "structured.news": "Ranked your news stories",
  "structured.sports": "Ranked your sports stories",
  "structured.workshop": "Replied to a Workshop project",
  "structured.web-research": "Researched the web",
  "structured.moss.workshop-build-plan": "Planned a module build"
};

/** Title vocabulary (spec section 4): a fixed sentence per action code. */
export function activityTitle(actionCode: string | null, action: string): string {
  switch (actionCode) {
    case "chat.answer":
      return "Answered a chat message";
    case "chat.tool_check":
      return "Jev guessed which tool to use";
    case "transcribe.voice_note":
      return "Transcribed a voice note";
    case "module.build":
      return "Built a module draft";
    case "probe.reachable":
      return "Checked that a model is reachable";
    default:
      break;
  }
  if (!actionCode) return "Model activity";
  if (actionCode.startsWith("embed.")) return "Indexed notes for search";
  if (actionCode.startsWith("structured.")) {
    return STRUCTURED_ACTIVITY_TITLES[actionCode] ?? "Ran a structured task";
  }
  if (actionCode.startsWith("task.")) return humanize(actionCode.slice("task.".length));
  void action;
  return "Model activity";
}

function humanize(code: string): string {
  const words = code.split(/[-_.]/).filter(Boolean);
  if (words.length === 0) return "Model activity";
  return words
    .map((word, index) => (index === 0 ? capitalize(word) : word.toLowerCase()))
    .join(" ");
}

/** The recorded words, cut at 140 characters (spec 3.1). Null when nothing was recorded. */
export function activityQuote(quote: string | null): string | null {
  if (!quote) return null;
  if (quote.length <= 140) return `"${quote}"`;
  return `"${quote.slice(0, 140)}..."`;
}

/**
 * Sub-line: the recorded result line while the detail is unexpired, else a bare fallback
 * built from bare columns (spec section 4, "Sub-line, bare" column).
 */
export function activitySubline(line: ActivityLineDto): string {
  if (line.detail?.resultLine) return line.detail.resultLine;
  if (line.outcome === "error") {
    return `Did not work: ${lowerFirst(failureSentence(line.failureCode))}`;
  }
  const facts = line.factCounts ?? {};
  if (line.actionCode === "chat.answer") {
    const tools = num(facts.tools);
    if (tools === null) return "Answered.";
    const agreed = bool(facts.jev_agreed);
    return `Used ${tools} tool${tools === 1 ? "" : "s"}.${agreed === true ? " Jev agreed." : agreed === false ? " Jev disagreed." : ""}`;
  }
  if (line.actionCode === "chat.tool_check") {
    const confidence = num(facts.confidence);
    const agreed = bool(facts.jev_agreed);
    const sure = confidence === null ? "" : `, ${Math.round(confidence * 100)}% sure`;
    const verdict = agreed === true ? " Chat agreed." : agreed === false ? " Chat disagreed." : "";
    return `Picked a tool${sure}.${verdict}`;
  }
  return "Finished.";
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

function num(value: number | boolean | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function bool(value: number | boolean | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Meta row: model, duration, step count, joined like the mockup. */
export function activityMeta(line: ActivityLineDto, stepCount: number | null): string {
  const parts = [line.modelName];
  if (line.durationMs !== null && line.durationMs !== undefined) {
    parts.push(durationText(line.durationMs));
  }
  if (stepCount !== null && stepCount > 0) {
    parts.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`);
  }
  return parts.join(" - ");
}

/** Badges appear only for a failure, a partial failure, a Jev disagreement, or a System line. */
export function activityBadges(line: ActivityLineDto): ActivityBadge[] {
  const badges: ActivityBadge[] = [];
  if (line.ownerUserId === null) badges.push({ text: "System", tone: "steel" });
  if (line.outcome === "error") badges.push({ text: "Did not work", tone: "red" });
  // A stopped line is quiet: the person stopped it, so there is nothing to flag.
  const failed = num(line.factCounts?.tools_failed);
  if (failed !== null && failed > 0) {
    badges.push({ text: `${failed} step${failed === 1 ? "" : "s"} failed`, tone: "amber" });
  }
  if (bool(line.factCounts?.jev_agreed) === false) {
    badges.push({ text: "Jev disagreed", tone: "amber" });
  }
  return badges;
}

/**
 * Failure sentences (spec 5.4): fixed text per code, never raw provider text. The service and
 * limit fill the placeholders when the caller knows them; otherwise the sentence degrades to
 * a form with no placeholders.
 */
export function failureSentence(code: string | null, service?: string, limit?: string): string {
  const name = service ? capitalize(service) : null;
  switch (code) {
    case "timeout":
      return name && limit
        ? `${name} did not answer within ${limit}, so ${assistantName()} stopped waiting.`
        : personalize("Something did not answer in time, so Moss stopped waiting.");
    case "rate_limited":
      return personalize("The provider asked Moss to slow down. Moss will try again later.");
    case "auth_failed":
      return "The provider refused the sign-in. Check the account in Settings, AI.";
    case "bad_shape":
      return personalize("The model's answer was not in the shape Moss asked for.");
    case "provider_down":
      return "The provider was unreachable.";
    case "cancelled":
      return "You stopped it.";
    case "tool_denied":
      return "You declined this action.";
    default:
      return personalize("Something went wrong that Moss could not name.");
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Durations read like the mockup: one decimal under 30 seconds ("10.0s"), whole seconds at
 * and above ("41s").
 */
export function durationText(ms: number): string {
  const seconds = ms / 1000;
  if (seconds >= 30) return `${Math.round(seconds)}s`;
  return `${seconds.toFixed(1)}s`;
}

/**
 * Grouping (spec 3.2): a chat answer is one row holding its child lines and the turn's tool
 * rows; tools outside any turn stay their own rows. A tool row whose turn has no answer line
 * (failed, stopped and private turns write none) stays visible on its own rather than
 * vanishing with its turn.
 */
export function groupActivity(
  lines: readonly ActivityLineDto[],
  audits: readonly ActionAuditLogEntryDto[]
): ActivityRow[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const childrenByParent = new Map<string, ActivityLineDto[]>();
  const topLines: ActivityLineDto[] = [];
  for (const line of lines) {
    if (line.parentId && byId.has(line.parentId)) {
      const siblings = childrenByParent.get(line.parentId) ?? [];
      siblings.push(line);
      childrenByParent.set(line.parentId, siblings);
    } else {
      topLines.push(line);
    }
  }

  const answerByTurn = new Map<string, ActivityLineDto>();
  for (const line of topLines) {
    if (line.actionCode === "chat.answer" && line.turnId) {
      answerByTurn.set(line.turnId, line);
    }
  }

  const toolsByAnswer = new Map<string, ActionAuditLogEntryDto[]>();
  const loneTools: ActionAuditLogEntryDto[] = [];
  for (const entry of audits) {
    const answer = entry.turnId ? answerByTurn.get(entry.turnId) : undefined;
    if (answer) {
      const tools = toolsByAnswer.get(answer.id) ?? [];
      tools.push(entry);
      toolsByAnswer.set(answer.id, tools);
    } else {
      loneTools.push(entry);
    }
  }

  const byTime = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  const rows: ActivityRow[] = [
    ...topLines.map(
      (line): ActivityRow => ({
        kind: "line",
        line,
        children: [...(childrenByParent.get(line.id) ?? [])].sort((a, b) =>
          byTime(a.occurredAt, b.occurredAt)
        ),
        tools: [...(toolsByAnswer.get(line.id) ?? [])].sort((a, b) =>
          byTime(a.occurredAt, b.occurredAt)
        )
      })
    ),
    ...loneTools.map((entry): ActivityRow => ({ kind: "tool", entry }))
  ];
  rows.sort((a, b) =>
    byTime(
      a.kind === "line" ? a.line.occurredAt : a.entry.occurredAt,
      b.kind === "line" ? b.line.occurredAt : b.entry.occurredAt
    )
  );
  return rows;
}
