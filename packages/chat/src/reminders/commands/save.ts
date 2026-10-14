import { saveScheduledOperation } from "../../scheduled-reads/repository.js";
import { resolveReminderDestination } from "../destination.js";
import { randomUUID } from "node:crypto";
import { enqueueReminderDelivery } from "../deliver.js";
import type { ReminderTimingInput } from "../repository.js";
import { REMINDER_OPEN_LIMIT, REMINDER_CAPACITY_REPLY } from "../wording.js";
import type { ReminderCommandContext, ReminderTurnDecision } from "./types.js";

export async function save(
  context: ReminderCommandContext,
  prepare: () => Promise<
    | { reply: string; when: ReminderTimingInput; text: string; sourceItemId?: string }
    | ReminderTurnDecision
  >,
  destinationRequest?: string
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
  const destination = await resolveReminderDestination(
    scopedDb,
    actorUserId,
    destinationRequest,
    thread.id
  );
  if ("reply" in destination)
    return {
      reply: destination.reply,
      origin: { version: 1, kind: "reminder", event: "refused", reminderId: null }
    };
  const prepared = await prepare();
  if (!("when" in prepared)) return prepared;
  const reminderId = randomUUID();
  return {
    reply: prepared.reply + (destination.title ? ` I'll send it to ${destination.title}.` : ""),
    origin: { version: 1, kind: "reminder", event: "saved", reminderId },
    save: async (userMessageId) => {
      const saved = await deps.reminders.create(scopedDb, {
        id: reminderId,
        threadId: destination.threadId,
        destinationTitle: destination.title,
        sourceMessageId: userMessageId,
        when: prepared.when,
        text: prepared.text
      });
      if (prepared.sourceItemId)
        await saveScheduledOperation(scopedDb, reminderId, prepared.sourceItemId);
      await enqueueReminderDelivery(boss, scopedDb, actorUserId, saved);
    }
  };
}
