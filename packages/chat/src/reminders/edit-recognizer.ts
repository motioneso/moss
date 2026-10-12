import { normalizeReminderRequest } from "./recognizer.js";
import { namesQuietHoursReminder } from "./quiet-hours-recognizer.js";

/** Route explicit owner edits only; everyday uses of move/change/edit remain ordinary chat. */
export function recognizeReminderEdit(raw: string): boolean {
  if (raw.length > 700 || !namesQuietHoursReminder(raw)) return false;
  const text = normalizeReminderRequest(raw);
  return (
    /^(?:move|change|edit|update|reschedule|postpone|push back|rename|send|deliver|post|remove the deadline|clear the deadline)\b/.test(
      text
    ) && !/\breminder (?:app|application|subscription)\b/.test(text)
  );
}
