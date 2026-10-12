import { localDayKey } from "@moss/module-sdk";
import { reminderClockRefusedReply, reminderClockSavedReply } from "../clock-wording.js";
import { resolveLocalClock } from "../local-clock.js";
import { save } from "./save.js";
import type { ReminderCommandHandler } from "./types.js";

export const clockRequest: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "clock_request") throw new Error("invalid clock reminder plan");
  return save(context, async () => {
    const { scopedDb, deps } = context;
    const locale = await deps.locale();
    const now = await deps.reminders.now(scopedDb);
    const today = localDayKey(now, locale.timeZone);
    const resolved = resolveLocalClock(plan.clock, now, locale.timeZone);
    if (resolved.kind === "refused")
      return {
        reply: reminderClockRefusedReply(resolved, today, locale.clockFormat),
        origin: { version: 1, kind: "reminder", event: "refused", reminderId: null }
      };
    return {
      reply: reminderClockSavedReply(resolved, plan.text, today, locale.clockFormat),
      text: plan.text,
      when: {
        timing: "local_clock",
        dueAt: resolved.dueAt,
        localDue: resolved.localDue,
        timeZone: resolved.timeZone,
        deadlineAt: resolved.deadlineAt
      }
    };
  });
};
