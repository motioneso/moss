import { controlTarget, controlRefused } from "./control-target.js";
import type { ReminderCommandHandler, ReminderTurnPlan } from "./types.js";

const forms = [
  /^((?:delete|remove))(?: my| the| that| this)? reminders?$/,
  /^((?:delete|remove))(?: my| the| that| this)? reminder (?:to|about|for|that) (.+)$/,
  /^((?:delete|remove))(?: my| the| that| this)? (.+?) reminder$/
];

export function recognizeDelete(
  request: string
): Extract<ReminderTurnPlan, { kind: "pause" | "resume" | "delete" }> | undefined {
  for (const form of forms) {
    const match = form.exec(request);
    if (match) return { kind: "delete", target: match[2]?.trim() ?? null };
  }
  return undefined;
}

export const deleteRequest: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "delete") throw new Error("invalid reminder delete plan");
  const reminder = await controlTarget(context, plan.target, false);
  if (!reminder) return controlRefused();
  return {
    reply: `Delete this reminder: ${reminder.text}? Earlier messages will stay. Type yes to delete it, or no to keep it.`,
    origin: {
      version: 1,
      kind: "reminder",
      event: "delete_requested",
      reminderId: reminder.id,
      reminderVersion: reminder.version,
      reminderState: reminder.state
    }
  };
};
