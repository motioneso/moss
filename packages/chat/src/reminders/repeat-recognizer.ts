import type { ReminderRepeat } from "@moss/shared";
import { parseClockTime } from "./clock-recognizer.js";
import {
  normalizeReminderRequest,
  originalCaseText,
  type ReminderRecognition
} from "./recognizer.js";

export interface RepeatRequest {
  readonly destination?: string;
  readonly kind: "repeat_request";
  readonly repeat: ReminderRepeat;
  readonly clock: string | null;
  readonly weekday: number | null;
  readonly text: string;
}
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const CADENCE =
  "(?:every day|each day|daily|every week|weekly|every (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|hourly|every hour|every \\d{1,5} (?:seconds?|minutes?|hours?))";
const WHEN = `(${CADENCE})(?: at (noon|\\d{1,2}(?::\\d{2})?(?: ?[ap]m)?))?`;
const FORMS = [
  new RegExp(`^(?:remind me|set (?:a|me a) reminder) ${WHEN} (?:to|about|that) (.+)$`),
  new RegExp(`^(?:remind me|set (?:a|me a) reminder) (?:to|about|that) (.+) ${WHEN}$`),
  new RegExp(
    `^remind me at (noon|\\d{1,2}(?::\\d{2})?(?: ?[ap]m)?) (${CADENCE}) (?:to|about|that) (.+)$`
  )
];
export function recognizeRepeatingReminder(
  raw: string
): RepeatRequest | Extract<ReminderRecognition, { kind: "unsupported" }> | undefined {
  if (raw.length > 700) return undefined;
  const text = normalizeReminderRequest(raw);
  for (const [index, pattern] of FORMS.entries()) {
    const match = pattern.exec(text);
    if (!match) continue;
    const cadence = (index === 1 ? match[2] : index === 2 ? match[2] : match[1])!;
    const time = index === 1 ? match[3] : index === 2 ? match[1] : match[2];
    const body = (index === 1 ? match[1] : match[3])!;
    if (!body.trim() || body.length > 500 || /\b(?:until|not after|starting|start at)\b/.test(body))
      return { kind: "unsupported", reason: "ambiguous" };
    if (cadence === "hourly" || cadence === "every hour" || /^every \d/.test(cadence)) {
      const duration = /^every (\d+) (second|minute|hour)s?$/.exec(cadence);
      const seconds = duration
        ? Number(duration[1]) * ({ second: 1, minute: 60, hour: 3600 }[duration[2]!] ?? 0)
        : 3600;
      if (time || seconds < 60 || seconds >= 86400)
        return { kind: "unsupported", reason: "recurrence" };
      return {
        kind: "repeat_request",
        repeat: { kind: "interval", seconds },
        clock: null,
        weekday: null,
        text: originalCaseText(raw, body)
      };
    }
    if (!time) return { kind: "unsupported", reason: "needs_time" };
    const parsed = parseClockTime(time, false);
    if (parsed.kind !== "time") return { kind: "unsupported", reason: parsed.reason };
    const weekday = DAYS.indexOf(cadence.replace(/^every /, ""));
    if (cadence === "weekly" || cadence === "every week")
      return { kind: "unsupported", reason: "unsupported_day" };
    const clock = `${String(parsed.time.hour).padStart(2, "0")}:${String(parsed.time.minute).padStart(2, "0")}`;
    return {
      kind: "repeat_request",
      repeat: { kind: weekday >= 0 ? "weekly" : "daily" },
      clock,
      weekday: weekday >= 0 ? weekday : null,
      text: originalCaseText(raw, body)
    };
  }
  return undefined;
}
