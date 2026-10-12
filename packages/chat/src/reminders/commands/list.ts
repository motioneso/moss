import { listReminders } from "../cancel.js";
import { reminderListReply } from "../wording.js";
import type { ReminderCommandHandler } from "./types.js";

export const list: ReminderCommandHandler = async ({ scopedDb, deps }) => {
  const reminders = await listReminders(scopedDb, deps.reminders);
  return {
    reply: reminderListReply(reminders, await deps.locale()),
    origin: { version: 1, kind: "reminder", event: "listed", reminderId: null }
  };
};
