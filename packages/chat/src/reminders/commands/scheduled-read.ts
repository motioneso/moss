import { authorizeTaskBackgroundRead } from "@moss/tasks";
import { firstClockOccurrence, reminderRepeatDescription } from "../repeating.js";
import { localDayKey } from "@moss/module-sdk";
import { whenPhrase, reminderClockRefusedReply } from "../clock-wording.js";
import { resolveLocalClock } from "../local-clock.js";
import { save } from "./save.js";
import type { ReminderCommandHandler } from "./types.js";

export const scheduledRead: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "scheduled_read") throw new Error("invalid scheduled read plan");
  const refused = {
    reply:
      plan.failure === "unavailable"
        ? "I couldn't set that check right now, so nothing is set. Try again in a moment."
        : "I didn't set a check. Name one task you own and one supported time or cadence; I can only read its status.",
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
    if (timing.kind === "repeat_request") {
      try {
        const when =
          timing.repeat.kind === "interval"
            ? {
                timing: "relative" as const,
                delaySeconds: timing.repeat.seconds,
                repeat: timing.repeat
              }
            : {
                timing: "local_clock" as const,
                ...firstClockOccurrence(timing.clock!, timing.weekday, now, locale.timeZone),
                timeZone: locale.timeZone,
                deadlineAt: null,
                repeat: timing.repeat
              };
        const schedule = reminderRepeatDescription(
          timing.repeat,
          "localDue" in when ? when.localDue : null,
          locale.timeZone,
          locale.clockFormat
        );
        return {
          reply: `I'll check ${title} ${schedule.toLowerCase()}. The first check will establish a quiet baseline; after that I'll report changes to its title or status here.`,
          text,
          when,
          sourceItemId: itemId
        };
      } catch {
        return {
          ...refused,
          reply:
            "That first check time is invalid or ambiguous because the clocks change. Choose another start time. Nothing was saved."
        };
      }
    }
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
