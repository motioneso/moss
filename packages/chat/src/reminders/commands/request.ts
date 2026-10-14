import { reminderSavedReply } from "../wording.js";
import { save } from "./save.js";
import type { ReminderCommandHandler } from "./types.js";

export const request: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind !== "request") throw new Error("invalid relative reminder plan");
  return save(
    context,
    async () => ({
      reply: reminderSavedReply(plan.delaySeconds, plan.text),
      text: plan.text,
      when: { timing: "relative", delaySeconds: plan.delaySeconds }
    }),
    plan.destination
  );
};
