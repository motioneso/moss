import { firstClockOccurrence, reminderRepeatDescription } from "../repeating.js";
import { save } from "./save.js";
import type { ReminderCommandHandler } from "./types.js";
export const repeatRequest: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "repeat_request") throw new Error("Invalid recurring reminder plan");
  return save(context, async () => {
    const locale = await context.deps.locale();
    const now = await context.deps.reminders.now(context.scopedDb);
    try {
      const when =
        plan.repeat.kind === "interval"
          ? { timing: "relative" as const, delaySeconds: plan.repeat.seconds, repeat: plan.repeat }
          : {
              timing: "local_clock" as const,
              ...firstClockOccurrence(plan.clock!, plan.weekday, now, locale.timeZone),
              timeZone: locale.timeZone,
              deadlineAt: null,
              repeat: plan.repeat
            };
      const schedule = reminderRepeatDescription(
        plan.repeat,
        "localDue" in when ? when.localDue : null,
        locale.timeZone,
        locale.clockFormat
      );
      return {
        reply: `Okay. I'll remind you ${schedule[0]!.toLowerCase()}${schedule.slice(1)}: ${plan.text}`,
        when,
        text: plan.text
      };
    } catch {
      return {
        reply:
          "That first reminder time is invalid or ambiguous because the clocks change. Choose another start time. Nothing was saved.",
        origin: {
          version: 1 as const,
          kind: "reminder" as const,
          event: "refused" as const,
          reminderId: null
        }
      };
    }
  });
};
