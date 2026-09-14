import type { CalendarAutomationMode } from "@moss/shared";

export interface CalendarBriefingSignal {
  readonly type:
    | "prep_needed"
    | "travel_transition_pressure"
    | "schedule_density_overload"
    | "high_stakes_meeting"
    | "usable_open_gap";
  readonly summary: string;
  readonly eventIds: readonly string[];
  readonly day: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly relevanceReasons: readonly string[];
  readonly suggestedActions: readonly string[];
  readonly followThrough?: {
    readonly targetRef: string;
    readonly taskId?: string;
    readonly calendarEventId?: string;
    readonly intents?: readonly {
      readonly kind: "create_task" | "block_time";
      readonly targetRef: string;
      readonly title: string;
      readonly window?: {
        readonly start: string;
        readonly end: string;
        readonly durationMinutes: number;
      };
    }[];
  };
}

export interface EmailBriefingSignal {
  readonly type:
    | "needs_reply"
    | "time_sensitive"
    | "bill_due_or_past_due"
    | "follow_up_risk"
    | "planning_impact";
  readonly summary: string;
  readonly messageIds: readonly string[];
  readonly threadId?: string;
  readonly connectorAccountId: string;
  readonly connectorLabel?: string;
  readonly relevanceReasons: readonly string[];
  readonly suggestedActions: readonly string[];
}

export interface CalendarSignalSettings {
  readonly lookaheadDays: 0 | 1 | 2;
  readonly prepTaskMode: CalendarAutomationMode;
  readonly timeBlockMode: CalendarAutomationMode;
}

export interface EmailSignalSettings {
  readonly createTasks: boolean;
  readonly suggestReplies: boolean;
  readonly draftReplies: boolean;
  readonly autoSend: boolean;
}

export function contextTokens(...groups: ReadonlyArray<readonly string[]>): Set<string> {
  return new Set(
    groups
      .flat()
      .flatMap((line) => line.toLowerCase().split(/[^a-z0-9]+/))
      .filter((token) => token.length >= 5)
  );
}

export function deriveCalendarSignals(args: {
  readonly items: readonly Record<string, unknown>[];
  readonly now: Date;
  readonly timeZone: string;
  readonly context: ReadonlySet<string>;
  readonly settings: CalendarSignalSettings;
}): CalendarBriefingSignal[] {
  const todayEvents = args.items
    .map((item) => {
      const startsAt = isoString(item.startsAt);
      const endsAt = isoString(item.endsAt);
      return {
        item,
        startsAt,
        endsAt,
        diff: dayDiffFromNow(startsAt, args.now, args.timeZone),
        text: textBlob(item.title, item.summary, item.bodyExcerpt, item.location)
      };
    })
    .filter(
      (event) => event.diff !== null && event.diff >= 0 && event.diff <= args.settings.lookaheadDays
    );

  const today = todayEvents.filter((event) => event.diff === 0);
  const scored: Array<{ score: number; signal: CalendarBriefingSignal }> = [];

  for (const event of todayEvents) {
    const eventId = str(event.item.id) || str(event.item.externalId) || str(event.item.title);
    const title = str(event.item.title) || "Untitled event";
    const day = event.startsAt
      ? localDay(event.startsAt, args.timeZone)
      : localDay(args.now, args.timeZone);
    const overlap = hasContextOverlap(event.text, args.context);
    const attendeeCount =
      typeof event.item.attendeeCount === "number" && Number.isFinite(event.item.attendeeCount)
        ? event.item.attendeeCount
        : 0;
    const durationMinutes = minutesBetween(event.startsAt, event.endsAt);
    const highStakes =
      /(client|demo|review|interview|presentation|board|handoff|decision|launch|doctor|onsite|travel|1:1)/.test(
        event.text
      ) ||
      attendeeCount >= 5 ||
      overlap;
    const prepNeeded =
      /(prep|review|presentation|interview|deck|decision|handoff|travel|doctor|deadline|demo)/.test(
        event.text
      ) ||
      (event.diff !== 0 && highStakes) ||
      (event.diff === 0 && highStakes && durationMinutes >= 45);

    if (prepNeeded) {
      const relevanceReasons = uniqueStrings([
        highStakes ? "important meeting" : "",
        overlap ? "matches active work context" : "",
        event.diff === 0 ? "lands today" : `changes what today needs before ${title}`
      ]);
      scored.push({
        score: 90 - (event.diff ?? 0) * 10,
        signal: {
          type: "prep_needed",
          summary:
            event.diff === 0
              ? `${title} likely needs prep before it starts.`
              : `${title} is coming up soon and likely needs prep today.`,
          eventIds: [eventId],
          day,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          relevanceReasons,
          suggestedActions: deriveCalendarSuggestedActions("prep_needed", args.settings)
        }
      });
    }

    if (event.diff === 0 && highStakes) {
      scored.push({
        score: 80,
        signal: {
          type: "high_stakes_meeting",
          summary: `${title} is the meeting most likely to shape the day.`,
          eventIds: [eventId],
          day,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          relevanceReasons: uniqueStrings([
            attendeeCount >= 5 ? "large meeting" : "",
            overlap ? "reinforced by tasks, notes, or chats" : "",
            highStakes ? "high-stakes topic" : ""
          ]),
          suggestedActions: deriveCalendarSuggestedActions("high_stakes_meeting", args.settings)
        }
      });
    }
  }

  const sortedToday = today
    .filter((event) => event.startsAt)
    .slice()
    .sort((left, right) => left.startsAt!.localeCompare(right.startsAt!));

  let totalMinutes = 0;
  let tightTransitions = 0;
  for (let index = 0; index < sortedToday.length; index += 1) {
    const current = sortedToday[index]!;
    totalMinutes += minutesBetween(current.startsAt, current.endsAt);
    const next = sortedToday[index + 1];
    if (!next?.startsAt || !current.endsAt) continue;
    const gapMinutes = minutesBetween(current.endsAt, next.startsAt);
    const locationShift =
      str(current.item.location) !== "" &&
      str(next.item.location) !== "" &&
      str(current.item.location).toLowerCase() !== str(next.item.location).toLowerCase();
    if (gapMinutes <= 15 || locationShift) {
      tightTransitions += 1;
      scored.push({
        score: 70 - index,
        signal: {
          type: "travel_transition_pressure",
          summary: `The gap between ${str(current.item.title)} and ${str(next.item.title)} looks tight.`,
          eventIds: uniqueStrings([str(current.item.id), str(next.item.id)]),
          day: current.startsAt
            ? localDay(current.startsAt, args.timeZone)
            : localDay(args.now, args.timeZone),
          startsAt: current.startsAt,
          endsAt: next.endsAt,
          relevanceReasons: uniqueStrings([
            gapMinutes <= 15 ? "back-to-back timing" : "",
            locationShift ? "location change" : ""
          ]),
          suggestedActions: deriveCalendarSuggestedActions(
            "travel_transition_pressure",
            args.settings
          )
        }
      });
    }
  }

  if (sortedToday.length >= 4 || totalMinutes >= 300 || tightTransitions >= 2) {
    scored.push({
      score: 75,
      signal: {
        type: "schedule_density_overload",
        summary: "Today looks meeting-dense enough to squeeze prep or recovery time.",
        eventIds: uniqueStrings(sortedToday.map((event) => str(event.item.id))),
        day: localDay(args.now, args.timeZone),
        relevanceReasons: uniqueStrings([
          sortedToday.length >= 4 ? "many meetings today" : "",
          totalMinutes >= 300 ? "most of the day is already spoken for" : "",
          tightTransitions >= 2 ? "multiple tight transitions" : ""
        ]),
        suggestedActions: deriveCalendarSuggestedActions("schedule_density_overload", args.settings)
      }
    });
  }

  for (let index = 0; index < sortedToday.length - 1; index += 1) {
    const current = sortedToday[index]!;
    const next = sortedToday[index + 1]!;
    if (!current.endsAt || !next.startsAt) continue;
    const gapMinutes = minutesBetween(current.endsAt, next.startsAt);
    if (gapMinutes < 60) continue;
    scored.push({
      score: Math.min(gapMinutes, 120),
      signal: {
        type: "usable_open_gap",
        summary: `There is a usable ${gapMinutes}-minute gap after ${str(current.item.title)}.`,
        eventIds: [str(current.item.id)],
        day: current.startsAt
          ? localDay(current.startsAt, args.timeZone)
          : localDay(args.now, args.timeZone),
        startsAt: current.endsAt,
        endsAt: next.startsAt,
        relevanceReasons: ["enough open time for real work"],
        suggestedActions: deriveCalendarSuggestedActions("usable_open_gap", args.settings)
      }
    });
    break;
  }

  return topSignals(scored, 5);
}

export function deriveEmailSignals(args: {
  readonly items: readonly Record<string, unknown>[];
  readonly now: Date;
  readonly context: ReadonlySet<string>;
  readonly settings: EmailSignalSettings;
}): EmailBriefingSignal[] {
  const scored: Array<{ score: number; signal: EmailBriefingSignal }> = [];

  for (const item of args.items) {
    const sender = str(item.sender) || "Unknown sender";
    const subject = str(item.subject) || "Untitled thread";
    const snippet = str(item.snippet);
    const summary = str(item.summary);
    const text = textBlob(sender, subject, snippet, summary, JSON.stringify(item.signals ?? {}));
    const overlap = hasContextOverlap(text, args.context);
    const receivedAt = isoString(item.receivedAt);
    const ageDays =
      receivedAt != null
        ? Math.max(0, Math.floor((args.now.getTime() - new Date(receivedAt).getTime()) / 86400000))
        : 0;
    const actions = deriveEmailSuggestedActions(args.settings);
    const connectorAccountId = str(item.connectorAccountId) || "unknown";
    const messageId = str(item.id) || str(item.externalId) || subject;
    const threadId = str(item.threadId) || undefined;
    const connectorLabel = str(item.connectorLabel) || undefined;

    const push = (
      type: EmailBriefingSignal["type"],
      score: number,
      summaryText: string,
      reasons: readonly string[]
    ) => {
      scored.push({
        score,
        signal: {
          type,
          summary: summaryText,
          messageIds: [messageId],
          threadId,
          connectorAccountId,
          connectorLabel,
          relevanceReasons: uniqueStrings(reasons),
          suggestedActions: actions
        }
      });
    };

    if (/(bill|invoice|payment|due|past due|autopay|statement)/.test(text)) {
      push("bill_due_or_past_due", 100, `${sender} has a billing thread that is easy to miss.`, [
        "billing or due-date language",
        ageDays > 0 ? "still unresolved" : ""
      ]);
    }
    if (/(urgent|today|deadline|asap|eod|before|expires|due)/.test(text)) {
      push("time_sensitive", 90, `${subject} carries timing pressure today.`, [
        "deadline language",
        overlap ? "connected to the current day" : ""
      ]);
    }
    if (/\?|reply|respond|let me know|can you|please review|follow up/.test(text)) {
      push(
        "needs_reply",
        85 - Math.min(ageDays, 5),
        `${sender} likely still needs a reply on ${subject}.`,
        ["reply-shaped language", overlap ? "matches current work context" : ""]
      );
    }
    if (ageDays >= 2 && (/\?|reply|follow up|review|action/.test(text) || overlap)) {
      push(
        "follow_up_risk",
        75,
        `${subject} looks like an older unresolved thread worth rescuing.`,
        ["older unresolved obligation", overlap ? "still tied to active work" : ""]
      );
    }
    if (
      /(meeting|review|deck|draft|document|contract|prep|schedule|agenda)/.test(text) ||
      overlap
    ) {
      push("planning_impact", 70, `${subject} changes what the day likely needs attention on.`, [
        "day-planning impact",
        overlap ? "reinforced by tasks, notes, chats, or calendar" : ""
      ]);
    }
  }

  return topSignalsWithTypeReserve(scored, 5);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function textBlob(...values: unknown[]): string {
  return values
    .map((value) => str(value).toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function isoString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function minutesBetween(startIso: string | undefined, endIso: string | undefined): number {
  if (!startIso || !endIso) return 0;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 60000) : 0;
}

function localDay(value: Date | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function dayDiffFromNow(iso: string | undefined, now: Date, timeZone: string): number | null {
  if (!iso) return null;
  const start = new Date(`${localDay(iso, timeZone)}T00:00:00Z`).getTime();
  const current = new Date(`${localDay(now, timeZone)}T00:00:00Z`).getTime();
  return Math.round((start - current) / 86400000);
}

function hasContextOverlap(text: string, tokens: ReadonlySet<string>): boolean {
  for (const token of tokens) {
    if (text.includes(token)) return true;
  }
  return false;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function topSignals<T extends { readonly summary: string }>(
  scored: ReadonlyArray<{ readonly score: number; readonly signal: T }>,
  limit: number
): T[] {
  return scored
    .slice()
    .sort(
      (left, right) =>
        right.score - left.score || left.signal.summary.localeCompare(right.signal.summary)
    )
    .slice(0, limit)
    .map((entry) => entry.signal);
}

function topSignalsWithTypeReserve<T extends { readonly summary: string; readonly type: string }>(
  scored: ReadonlyArray<{ readonly score: number; readonly signal: T }>,
  limit: number
): T[] {
  const byType = new Map<
    string,
    Array<{ readonly score: number; readonly signal: T; readonly index: number }>
  >();
  scored.forEach((entry, index) => {
    const group = byType.get(entry.signal.type) ?? [];
    group.push({ ...entry, index });
    byType.set(entry.signal.type, group);
  });

  const reserve = Array.from(byType.values())
    .map(
      (group) =>
        group
          .slice()
          .sort(
            (left, right) =>
              right.score - left.score || left.signal.summary.localeCompare(right.signal.summary)
          )[0]!
    )
    .sort(
      (left, right) =>
        right.score - left.score || left.signal.summary.localeCompare(right.signal.summary)
    )
    .slice(0, limit);

  const used = new Set(reserve.map((entry) => entry.index));
  const remaining = scored
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => !used.has(entry.index))
    .sort(
      (left, right) =>
        right.score - left.score || left.signal.summary.localeCompare(right.signal.summary)
    );

  return [...reserve, ...remaining].slice(0, limit).map((entry) => entry.signal);
}

function deriveCalendarSuggestedActions(
  type: CalendarBriefingSignal["type"],
  settings: CalendarSignalSettings
): string[] {
  const actions: string[] = [];
  if (
    (type === "prep_needed" || type === "high_stakes_meeting") &&
    settings.prepTaskMode === "suggest"
  ) {
    actions.push("suggest_task");
  }
  if (type === "prep_needed" && settings.prepTaskMode === "auto") {
    actions.push("create_task");
  }
  if (
    (type === "travel_transition_pressure" ||
      type === "usable_open_gap" ||
      type === "schedule_density_overload") &&
    settings.timeBlockMode === "suggest"
  ) {
    actions.push("suggest_time_block");
  }
  if (
    (type === "prep_needed" || type === "travel_transition_pressure") &&
    settings.timeBlockMode === "auto"
  ) {
    actions.push("block_time");
  }
  return actions;
}

function deriveEmailSuggestedActions(settings: EmailSignalSettings): string[] {
  const actions: string[] = [];
  if (settings.createTasks) actions.push("create_task");
  if (settings.suggestReplies) actions.push("suggest_reply");
  if (settings.draftReplies) actions.push("draft_reply");
  if (settings.autoSend) actions.push("auto_send");
  return actions;
}
