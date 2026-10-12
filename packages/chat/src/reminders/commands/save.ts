import { randomUUID } from "node:crypto";
import { enqueueReminderDelivery } from "../deliver.js";
import type { ReminderTimingInput } from "../repository.js";
import { REMINDER_OPEN_LIMIT, REMINDER_CAPACITY_REPLY } from "../wording.js";
import type { ReminderCommandContext, ReminderTurnDecision } from "./types.js";

export async function save(
  context: ReminderCommandContext,
  prepare: () => Promise<
    { reply: string; when: ReminderTimingInput; text: string } | ReminderTurnDecision
  >
): Promise<ReminderTurnDecision> {
  const { scopedDb, deps, actorUserId, thread } = context;
  const boss = deps.boss;
  if (!boss) throw new Error("chat reminder delivery queue is unavailable");
  const open = await deps.reminders.openCountLocked(scopedDb, actorUserId);
  if (open >= REMINDER_OPEN_LIMIT)
    return {
      reply: REMINDER_CAPACITY_REPLY,
      origin: { version: 1, kind: "reminder", event: "refused", reminderId: null }
    };
  const prepared = await prepare();
  if (!("when" in prepared)) return prepared;
  const reminderId = randomUUID();
  return {
    reply: prepared.reply,
    origin: { version: 1, kind: "reminder", event: "saved", reminderId },
    save: async (userMessageId) => {
      const saved = await deps.reminders.create(scopedDb, {
        id: reminderId,
        threadId: thread.id,
        sourceMessageId: userMessageId,
        when: prepared.when,
        text: prepared.text
      });
      await enqueueReminderDelivery(boss, scopedDb, actorUserId, saved);
    }
  };
}
