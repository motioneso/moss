import { authorizeTaskBackgroundRead } from "@moss/tasks";
import { localDayKey } from "@moss/module-sdk";
import { whenPhrase, reminderClockRefusedReply } from "../clock-wording.js";
import { resolveLocalClock } from "../local-clock.js";
import { save } from "./save.js";
import type { ReminderCommandHandler } from "./types.js";

export const scheduledRead: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "scheduled_read") throw new Error("invalid scheduled read plan");
  const refused = {
    reply:
      "I didn't set a check. Name one task you own and one time; I can only read its status once.",
    origin: {
      version: 1 as const,
      kind: "reminder" as const,
      event: "refused" as const,
      reminderId: null
    }
  };
  if (
    !plan.taskId ||
    !plan.when ||
    !(await authorizeTaskBackgroundRead(context.scopedDb, { taskId: plan.taskId }, context))
  )
    return refused;
  const itemId = plan.taskId;
  const timing = plan.when;
  return save(context, async () => {
    const locale = await context.deps.locale();
    const now = await context.deps.reminders.now(context.scopedDb);
    const title = plan.title.replace(/[\r\n]/g, " ").slice(0, 400);
    const text = `Check task status: ${title}`;
    if (timing.kind === "request")
      return {
        reply: `I'll check ${title} once in ${timing.delaySeconds} seconds and report its status here.`,
        text,
        when: { timing: "relative", delaySeconds: timing.delaySeconds },
        sourceItemId: itemId
      };
    const resolved = resolveLocalClock(timing.clock, now, locale.timeZone);
    const today = localDayKey(now, locale.timeZone);
    if (resolved.kind === "refused")
      return { ...refused, reply: reminderClockRefusedReply(resolved, today, locale.clockFormat) };
    return {
      reply: `I'll check ${title} once ${whenPhrase(resolved.localDue, today, locale.clockFormat)} (${locale.timeZone}) and report its status here.${resolved.localDeadline ? " If its deadline passes, I'll skip it." : ""}`,
      text,
      when: {
        timing: "local_clock",
        dueAt: resolved.dueAt,
        localDue: resolved.localDue,
        timeZone: resolved.timeZone,
        deadlineAt: resolved.deadlineAt
      },
      sourceItemId: itemId
    };
  });
};
