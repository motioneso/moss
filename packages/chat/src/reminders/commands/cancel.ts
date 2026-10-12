import { cancelReminder } from "../cancel.js";
import { reminderCancelReply } from "../wording.js";
import type { ReminderCommandHandler, ReminderTurnPlan } from "./types.js";

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

const CANCEL_VERB = "(?:cancel|delete|remove)";
const ARTICLE = "(?: my| the| that| this)?";

const CANCEL_UNTARGETED = new RegExp(`^${CANCEL_VERB}${ARTICLE} reminders?$`);
const CANCEL_TARGET_AFTER = new RegExp(
  `^${CANCEL_VERB}${ARTICLE} reminder (?:to|about|for|that) (.+)$`
);
const CANCEL_TARGET_BEFORE = new RegExp(`^${CANCEL_VERB}${ARTICLE} (.+?) reminder$`);

export function recognizeCancel(
  request: string
): Extract<ReminderTurnPlan, { kind: "cancel" }> | undefined {
  if (CANCEL_UNTARGETED.test(request)) return { kind: "cancel", target: null };
  const target = CANCEL_TARGET_AFTER.exec(request)?.[1] ?? CANCEL_TARGET_BEFORE.exec(request)?.[1];
  return target ? { kind: "cancel", target: target.trim() } : undefined;
}
