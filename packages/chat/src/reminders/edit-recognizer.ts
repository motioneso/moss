import { normalizeReminderRequest } from "./recognizer.js";
import { namesQuietHoursReminder } from "./quiet-hours-recognizer.js";

/** Route explicit owner edits only; everyday uses of move/change/edit remain ordinary chat. */
export function recognizeReminderEdit(raw: string): boolean {
  if (recognizeReminderDestinationEdit(raw)) return true;
  if (raw.length > 700 || !namesQuietHoursReminder(raw)) return false;
  const text = normalizeReminderRequest(raw);
  return (
    /^(?:move|change|edit|update|reschedule|postpone|push back|rename|send|deliver|post|remove the deadline|clear the deadline)\b/.test(
      text
    ) && !/\breminder (?:app|application|subscription)\b/.test(text)
  );
}

export function recognizeReminderDestinationEdit(
  raw: string
): { target: string; destination: string } | undefined {
  if (raw.length > 700) return undefined;
  const match =
    /^(?:(?:can|could|would|will) you(?: please)? |please )?(?:send|deliver|post) (?:my|the) (.+?) (?:reminder|task)(?: results)? (?:to|in) (.+?)[.!]?$/i.exec(
      raw.replace(/\s+/g, " ").trim()
    );
  if (!match) return undefined;
  const target = match[1]!.trim();
  const requested = match[2]!.trim();
  if (
    target.length > 500 ||
    requested.length > 500 ||
    /[,;]|\b(?:and|also|then|change|edit|update|rename|move|reschedule|text|time|deadline|repeat|tomorrow|tonight|today|starting|every|daily|weekly)\b|\b(?:in|after|at) \d/i.test(
      requested
    )
  )
    return undefined;
  const destination = /^this chat$/i.test(requested)
    ? "this chat"
    : requested
        .replace(/^(?:the |(?:side )?chat (?:named |called )?)/i, "")
        .replace(/ (?:side )?chat$/i, "")
        .trim();
  return destination ? { target, destination } : undefined;
}
