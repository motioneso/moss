import { deleteReminderById, lockReminderControl } from "../controls.js";
import { pendingReminderDeletion, typedDeletionAgreement } from "../delete-agreement.js";
import { controlRefused } from "./control-target.js";
import type { ReminderCommandHandler } from "./types.js";

export const confirmDelete: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "confirm_delete") throw new Error("invalid reminder agreement plan");
  if (typedDeletionAgreement(context.userText ?? "") !== plan.agree)
    return controlRefused("Type yes to delete the reminder, or no to keep it. Nothing changed.");
  const pending = await pendingReminderDeletion(context.scopedDb, context.thread.id);
  if (!pending)
    return controlRefused("There is no reminder deletion awaiting agreement. Nothing changed.");
  if (!plan.agree)
    return {
      reply: "Kept the reminder. Nothing changed.",
      origin: { version: 1, kind: "reminder", event: "delete_declined", reminderId: pending.id }
    };
  const current = await lockReminderControl(context.scopedDb, pending.id);
  if (!current || current.version !== pending.version || current.state !== pending.state)
    return controlRefused(
      "That reminder changed since I asked. Ask to delete it again so you can review its current state."
    );
  const result = await deleteReminderById(context.scopedDb, pending.id, pending.version);
  if (result.kind !== "changed")
    return controlRefused("That reminder changed. Nothing was deleted.");
  return {
    reply: `Deleted the reminder: ${result.reminder.text}. Earlier messages are kept.`,
    origin: { version: 1, kind: "reminder", event: "deleted", reminderId: pending.id }
  };
};
