import { normalizeReminderRequest } from "./recognizer.js";

export type QuietHoursCommand =
  | { readonly kind: "quiet_allowance"; readonly target: string; readonly allow: boolean }
  | { readonly kind: "quiet_agreement"; readonly agree: boolean };

const WINDOW = "(?:during|through) quiet hours|at night|overnight";
const ALLOW = [
  new RegExp(`^(?:allow|let) (.+?) (?:${WINDOW})$`),
  /^(?:let) (.+?) through (?:quiet hours|at night|overnight)$/,
  /^(.+?) can (?:buzz|notify|alert|interrupt) me (?:at night|overnight|during quiet hours)$/
];
const REMOVE = [
  new RegExp(
    `^(?:stop allowing|stop letting|don't allow|don't let|do not allow|do not let) (.+?) (?:${WINDOW})$`
  ),
  /^stop letting (.+?) through$/,
  /^(.+?) (?:cannot|can't|must not) (?:buzz|notify|alert|interrupt) me (?:at night|overnight|during quiet hours)$/
];

export function recognizeQuietHoursCommand(raw: string): QuietHoursCommand | undefined {
  if (raw.length > 700) return undefined;
  const text = normalizeReminderRequest(raw);
  if (/^(?:yes|yes please)$/.test(text)) return { kind: "quiet_agreement", agree: true };
  if (/^(?:no|no thanks|no thank you)$/.test(text))
    return { kind: "quiet_agreement", agree: false };
  for (const [patterns, allow] of [
    [REMOVE, false],
    [ALLOW, true]
  ] as const) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match?.[1]) continue;
      const target = match[1]
        .replace(/^(?:the |my |that |this )?reminder (?:to|about|for) /, "")
        .replace(/^(?:the|my|that|this) /, "")
        .replace(/ reminder$/, "")
        .trim();
      if (
        target.length < 3 ||
        /^(?:it|them|this|that|me)$/.test(target) ||
        /^(?:all|every|everything|anything|reminders?)\b/.test(target)
      )
        return undefined;
      return { kind: "quiet_allowance", target, allow };
    }
  }
  return undefined;
}

export function namesQuietHoursReminder(raw: string): boolean {
  return /\breminder\b/.test(normalizeReminderRequest(raw));
}
