import { pauseReminderById } from "../controls.js";
import { controlTarget, controlRefused } from "./control-target.js";
import type { ReminderCommandHandler, ReminderTurnPlan } from "./types.js";

const forms = [
  /^(pause)(?: my| the| that| this)? reminders?$/,
  /^(pause)(?: my| the| that| this)? reminder (?:to|about|for|that) (.+)$/,
  /^(pause)(?: my| the| that| this)? (.+?) reminder$/
];

export function recognizePause(
  request: string
): Extract<ReminderTurnPlan, { kind: "pause" | "resume" | "delete" }> | undefined {
  for (const form of forms) {
    const match = form.exec(request);
    if (match) return { kind: "pause", target: match[2]?.trim() ?? null };
  }
  return undefined;
}

export const pause: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "pause") throw new Error("invalid reminder pause plan");
  const reminder = await controlTarget(context, plan.target, true);
  if (!reminder) return controlRefused();

  const result = await pauseReminderById(context.scopedDb, reminder.id);
  if (result.kind === "missing" || result.kind === "not_pending" || result.kind === "stale")
    return controlRefused("That reminder is no longer waiting. Nothing changed.");
  if (result.kind === "unchanged")
    return controlRefused(`Already paused. Nothing changed: ${result.reminder.text}`);
  return {
    reply: `Paused. I won't send this reminder until you resume it: ${result.reminder.text}`,
    origin: { version: 1, kind: "reminder", event: "paused", reminderId: result.reminder.id }
  };
};
