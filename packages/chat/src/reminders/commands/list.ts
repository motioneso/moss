import { listReminders } from "../cancel.js";
import { reminderListReply } from "../wording.js";
import type { ReminderCommandHandler, ReminderTurnPlan } from "./types.js";

export const list: ReminderCommandHandler = async ({ scopedDb, deps }) => {
  const reminders = await listReminders(scopedDb, deps.reminders);
  return {
    reply: reminderListReply(reminders, await deps.locale()),
    origin: { version: 1, kind: "reminder", event: "listed", reminderId: null }
  };
};

const LIST_FORMS: readonly RegExp[] = [
  /^(?:list|show)(?: me)?(?: all)?(?: of)? my reminders$/,
  /^what (?:are|is) my reminders$/,
  /^what reminders do i have$/,
  /^do i have any reminders$/
];

export function recognizeList(
  request: string
): Extract<ReminderTurnPlan, { kind: "list" }> | undefined {
  return LIST_FORMS.some((form) => form.test(request)) ? { kind: "list" } : undefined;
}
