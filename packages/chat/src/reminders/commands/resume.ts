import { resumeReminderById } from "../controls.js";
import { controlTarget, controlRefused } from "./control-target.js";
import type { ReminderCommandHandler, ReminderTurnPlan } from "./types.js";

const forms = [
  /^(resume)(?: my| the| that| this)? reminders?$/,
  /^(resume)(?: my| the| that| this)? reminder (?:to|about|for|that) (.+)$/,
  /^(resume)(?: my| the| that| this)? (.+?) reminder$/
];

export function recognizeResume(
  request: string
): Extract<ReminderTurnPlan, { kind: "pause" | "resume" | "delete" }> | undefined {
  for (const form of forms) {
    const match = form.exec(request);
    if (match) return { kind: "resume", target: match[2]?.trim() ?? null };
  }
  return undefined;
}

export const resume: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "resume") throw new Error("invalid reminder resume plan");
  const reminder = await controlTarget(context, plan.target, true);
  if (!reminder) return controlRefused();
  if (!context.deps.boss) throw new Error("reminder queue unavailable");
  const result = await resumeReminderById(
    context.scopedDb,
    context.deps.boss!,
    context.actorUserId,
    reminder.id
  );
  if (result.kind === "missing" || result.kind === "not_pending" || result.kind === "stale")
    return controlRefused("That reminder is no longer waiting. Nothing changed.");
  return {
    reply: `Resumed. I'll send this reminder once: ${result.reminder.text}`,
    origin: { version: 1, kind: "reminder", event: "resumed", reminderId: result.reminder.id }
  };
};
