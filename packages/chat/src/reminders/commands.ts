// #3310: bounded recognizer for listing and cancelling reminders in a raw Main chat request.
// Like the save recognizer, it reads only the user's own words.

import { normalizeReminderRequest, recognizeRelativeReminder } from "./recognizer.js";
import type { ReminderTurnPlan } from "./turn.js";

const MAX_REQUEST_LENGTH = 700;

export type ReminderCommand =
  | { readonly kind: "none" }
  | { readonly kind: "list" }
  | { readonly kind: "cancel"; readonly target: string | null };

const LIST_FORMS: readonly RegExp[] = [
  /^(?:list|show)(?: me)?(?: all)?(?: of)? my reminders$/,
  /^what (?:are|is) my reminders$/,
  /^what reminders do i have$/,
  /^do i have any reminders$/
];

const CANCEL_VERB = "(?:cancel|delete|remove)";
const ARTICLE = "(?: my| the| that| this)?";

const CANCEL_UNTARGETED = new RegExp(`^${CANCEL_VERB}${ARTICLE} reminders?$`);
const CANCEL_TARGET_AFTER = new RegExp(
  `^${CANCEL_VERB}${ARTICLE} reminder (?:to|about|for|that) (.+)$`
);
const CANCEL_TARGET_BEFORE = new RegExp(`^${CANCEL_VERB}${ARTICLE} (.+?) reminder$`);

export function recognizeReminderCommand(raw: string): ReminderCommand {
  if (raw.length > MAX_REQUEST_LENGTH) return { kind: "none" };

  const request = normalizeReminderRequest(raw);
  if (LIST_FORMS.some((form) => form.test(request))) return { kind: "list" };
  if (CANCEL_UNTARGETED.test(request)) return { kind: "cancel", target: null };

  const target = CANCEL_TARGET_AFTER.exec(request)?.[1] ?? CANCEL_TARGET_BEFORE.exec(request)?.[1];
  return target ? { kind: "cancel", target: target.trim() } : { kind: "none" };
}

/** A save request first, then list or cancel. Undefined means ordinary chat for the model. */
export function recognizeReminderPlan(raw: string): ReminderTurnPlan | undefined {
  const save = recognizeRelativeReminder(raw);
  if (save.kind !== "none") return save;
  const command = recognizeReminderCommand(raw);
  return command.kind === "none" ? undefined : command;
}
