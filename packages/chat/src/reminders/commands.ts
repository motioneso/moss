import { recognizeRepeatingReminder } from "./repeat-recognizer.js";
// #3310: bounded recognizer for listing and cancelling reminders in a raw Main chat request.
// Like the save recognizer, it reads only the user's own words.

import { recognizeQuietHoursCommand } from "./quiet-hours-recognizer.js";
import { normalizeReminderRequest, recognizeRelativeReminder } from "./recognizer.js";
import { reminderCommands } from "./commands/registry.js";
import type { ReminderTurnPlan } from "./turn.js";

const MAX_REQUEST_LENGTH = 700;

export type ReminderCommand =
  | { readonly kind: "none" }
  | Exclude<
      ReminderTurnPlan,
      { kind: "request" | "clock_request" | "unsupported" | "main_only" | "confirm_delete" }
    >;

export function recognizeReminderCommand(raw: string): ReminderCommand {
  if (raw.length > MAX_REQUEST_LENGTH) return { kind: "none" };

  const request = normalizeReminderRequest(raw);
  for (const command of Object.values(reminderCommands)) {
    if (!("recognize" in command)) continue;
    const result = command.recognize(request);
    if (result) return result;
  }
  return { kind: "none" };
}

/** A save request first, then list or cancel. Undefined means ordinary chat for the model. */
export function recognizeReminderPlan(raw: string): ReminderTurnPlan | undefined {
  if (raw.length > MAX_REQUEST_LENGTH) return undefined;
  const quiet = recognizeQuietHoursCommand(raw);
  if (quiet) return quiet;
  const delivery =
    /(?:,\s*|\s+and\s+|\s+)(?:send|post|deliver) (?:it|(?:the |its )?results?|(?:the )?reminder) (?:to|in) (.+?)[.!]?$/i.exec(
      raw
    );
  const here = /\s+in (this chat)[.!]?$/i.exec(raw);
  const clause = delivery ?? here;
  const destination = /^this chat$/i.test(clause?.[1]?.trim() ?? "")
    ? "this chat"
    : clause?.[1]
        ?.replace(/^(?:the |(?:side )?chat (?:named |called )?)/i, "")
        .replace(/ (?:side )?chat$/i, "")
        .trim();
  const request = clause ? raw.slice(0, clause.index).trim() : raw;
  const repeat = recognizeRepeatingReminder(request);
  if (repeat)
    return destination && repeat.kind === "repeat_request" ? { ...repeat, destination } : repeat;
  const save = recognizeRelativeReminder(request);
  if (destination && (save.kind === "request" || save.kind === "clock_request"))
    return { ...save, destination };
  if (save.kind !== "none") return save;
  const command = recognizeReminderCommand(raw);
  return command.kind === "none" ? undefined : command;
}
