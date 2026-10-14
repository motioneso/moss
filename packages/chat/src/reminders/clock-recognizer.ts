// #3150: bounded recognizer for one reminder at a local clock time, today or tomorrow, with an
// optional deadline. Like the relative recognizer, it reads only the user's own words. It
// returns wall-clock parts; the turn resolves them in the owner's time zone.

import type { ReminderRecognition } from "./recognizer.js";

type ReminderDay = "today" | "tonight" | "tomorrow";

/** A 24-hour wall-clock time. */
export interface LocalClockTime {
  readonly hour: number;
  readonly minute: number;
}

export interface LocalClockSpec {
  /** Null means the next time the clock shows this time. */
  readonly day: ReminderDay | null;
  readonly time: LocalClockTime;
  readonly deadline: LocalClockTime | null;
}

const DAY = "(today|tonight|tomorrow)";
const TIME = "(noon|midnight|\\d{1,2}(?::\\d{2})?(?: ?(?:a\\.?m\\.?|p\\.?m\\.?))?)";
const JOINER = "(?: ?(?:,|:|to|that|about))?";
const DEADLINE = `(?:,? (?:but )?(?:not after|no later than) ${TIME}|,? unless it(?:'s| is) (?:after|past) ${TIME}|,? skip it (?:if it(?:'s| is) )?(?:after|past) ${TIME})`;

// "at 3pm" or "tomorrow at 3pm" or "at 3pm tomorrow". A set-a-reminder form also takes "for 3pm".
const WHEN = `(?:${DAY} )?at ${TIME}(?: ${DAY})?`;
const SET_WHEN = `(?:${DAY} )?(?:at|for) ${TIME}(?: ${DAY})?`;

const FORMS: readonly { readonly form: RegExp; readonly textFirst: boolean }[] = [
  { form: new RegExp(`^remind me ${WHEN}${JOINER} (.+?)${DEADLINE}?$`), textFirst: false },
  {
    form: new RegExp(`^remind me (?:to|that|about) (.+?) ${WHEN}${DEADLINE}?$`),
    textFirst: true
  },
  {
    form: new RegExp(`^set (?:a|me a) reminder (?:for )?${SET_WHEN}${JOINER} (.+?)${DEADLINE}?$`),
    textFirst: false
  },
  {
    form: new RegExp(`^set (?:a|me a) reminder (?:to|that|about) (.+?) ${SET_WHEN}${DEADLINE}?$`),
    textFirst: true
  }
];

/** True when the words carry a deadline, used to refuse one on a reminder set a time from now. */
export const DEADLINE_CUE = new RegExp(`${DEADLINE}$`);

/** Day words this slice does not resolve: weekdays, dates, weeks and months. */
export const UNSUPPORTED_DAY =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|next week|next month|tomorrow morning|tomorrow night|day after tomorrow)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?) \d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/;

export const RECURRENCE = /\b(?:every|each|daily|weekly|monthly|hourly|weekdays)\b/;

const CLOCK_IN_TEXT =
  /\b(?:at|by|before|until|after) \d|\b\d{1,2}:\d{2}\b|\b\d{1,2} ?(?:a\.?m|p\.?m)\b|\b(?:noon|midnight|today|tonight|tomorrow)\b|\b(?:in|after|within) \d/;

/**
 * Matches a clock-time reminder in an already-normalised request. Undefined means the request
 * fits no clock form, so the caller keeps looking.
 */
export function recognizeClockReminder(request: string): ReminderRecognition | undefined {
  for (const { form, textFirst } of FORMS) {
    const match = form.exec(request);
    if (!match) continue;

    const groups = match.slice(1);
    const text = textFirst ? groups[0] : groups[3];
    const [dayBefore, time, dayAfter] = textFirst ? groups.slice(1, 4) : groups.slice(0, 3);
    const deadlineRaw = groups.slice(4).find((value) => value !== undefined);
    if (text === undefined || time === undefined) continue;
    if (dayBefore !== undefined && dayAfter !== undefined) {
      return { kind: "unsupported", reason: "ambiguous" };
    }
    return buildClockRequest(dayBefore ?? dayAfter ?? null, time, deadlineRaw, text);
  }
  return undefined;
}

function buildClockRequest(
  dayWord: string | null,
  timeRaw: string,
  deadlineRaw: string | undefined,
  text: string
): ReminderRecognition {
  const day = dayWord as ReminderDay | null;
  if (RECURRENCE.test(text)) return { kind: "unsupported", reason: "recurrence" };
  if (UNSUPPORTED_DAY.test(text)) return { kind: "unsupported", reason: "unsupported_day" };
  if (text.includes("?") || CLOCK_IN_TEXT.test(text) || /\bor\b|\bish\b/.test(text)) {
    return { kind: "unsupported", reason: "ambiguous" };
  }

  const time = parseClockTime(timeRaw, day === "tonight");
  if (time.kind !== "time") return { kind: "unsupported", reason: time.reason };
  let deadline: LocalClockTime | null = null;
  if (deadlineRaw !== undefined) {
    const parsed = parseClockTime(deadlineRaw, false);
    if (parsed.kind !== "time") return { kind: "unsupported", reason: parsed.reason };
    deadline = parsed.time;
  }

  if (text.length < 1 || text.length > 500) return { kind: "unsupported", reason: "text_length" };
  return { kind: "clock_request", clock: { day, time: time.time, deadline }, text };
}

type ParsedTime =
  | { readonly kind: "time"; readonly time: LocalClockTime }
  | { readonly kind: "refused"; readonly reason: "needs_am_pm" | "ambiguous" };

/**
 * Reads one clock time. "3pm", "3:30 pm", "15:30", "09:00" and "noon" are clear. A bare hour
 * from 1 to 12 with no am or pm could be either, so it is refused, except "tonight" reads 5 to
 * 11 as pm. "Midnight" could start or end the day, so it is refused.
 */
export function parseClockTime(raw: string, evening: boolean): ParsedTime {
  if (raw === "noon") return { kind: "time", time: { hour: 12, minute: 0 } };

  const match = /^(\d{1,2})(?::(\d{2}))? ?(?:(a)|(p))?\.?m?\.?$/.exec(raw);
  if (!match) return { kind: "refused", reason: "ambiguous" };
  const [, hourText = "", minuteText, am, pm] = match;
  const hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return { kind: "refused", reason: "ambiguous" };

  if (am !== undefined || pm !== undefined) {
    if (hour < 1 || hour > 12) return { kind: "refused", reason: "ambiguous" };
    if (evening && am !== undefined) return { kind: "refused", reason: "ambiguous" };
    const base = hour % 12;
    return { kind: "time", time: { hour: pm !== undefined ? base + 12 : base, minute } };
  }

  // A leading zero or an hour past 12 reads as a 24-hour clock.
  if (hour > 23) return { kind: "refused", reason: "ambiguous" };
  if (hourText.length === 2 && hourText.startsWith("0")) {
    return { kind: "time", time: { hour, minute } };
  }
  if (hour === 0 || hour > 12) return { kind: "time", time: { hour, minute } };
  if (evening && hour >= 5 && hour < 12) return { kind: "time", time: { hour: hour + 12, minute } };
  return { kind: "refused", reason: "needs_am_pm" };
}
