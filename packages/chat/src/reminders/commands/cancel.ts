import { cancelReminder } from "../cancel.js";
import { reminderCancelReply } from "../wording.js";
import type { ReminderCommandHandler } from "./types.js";

export const cancel: ReminderCommandHandler = async ({ scopedDb, deps }, plan) => {
  if (plan.kind !== "cancel") throw new Error("invalid reminder cancel plan");
  const result = await cancelReminder(scopedDb, deps.reminders, plan.target);
  return {
    reply: reminderCancelReply(result),
    origin: {
      version: 1,
      kind: "reminder",
      event: result.kind === "cancelled" ? "cancelled" : "cancel_refused",
      reminderId: "reminder" in result ? result.reminder.id : null
    }
  };
};
