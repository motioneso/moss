// #3310: bounded recognizer for listing and cancelling reminders in a raw Main chat request.
// Like the save recognizer, it reads only the user's own words.

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
  const save = recognizeRelativeReminder(raw);
  if (save.kind !== "none") return save;
  const command = recognizeReminderCommand(raw);
  return command.kind === "none" ? undefined : command;
}
