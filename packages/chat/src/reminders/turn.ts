// #3309: decides the code-written reply for a recognised reminder request and, when it is
// accepted, saves the reminder and its delivery job in the same transaction as the turn.

import { randomUUID } from "node:crypto";

import type { PgBoss } from "pg-boss";

import type { DataContextDb } from "@moss/db";
import type { ChatReminderOriginV1 } from "@moss/shared";

import { enqueueReminderDelivery } from "./deliver.js";
import type { ReminderUnsupportedReason } from "./recognizer.js";
import type { ReminderRepository } from "./repository.js";
import {
  REMINDER_CAPACITY_REPLY,
  REMINDER_MAIN_ONLY_REPLY,
  REMINDER_OPEN_LIMIT,
  reminderRefusedReply,
  reminderSavedReply
} from "./wording.js";

/** What the raw request asked for, before anything is checked against storage. */
export type ReminderTurnPlan =
  | { readonly kind: "request"; readonly delaySeconds: number; readonly text: string }
  | { readonly kind: "unsupported"; readonly reason: ReminderUnsupportedReason }
  | { readonly kind: "main_only" };

export interface ReminderTurnDecision {
  readonly reply: string;
  readonly origin: ChatReminderOriginV1;

  /** Saves the reminder once the user message exists. Absent when nothing is saved. */
  readonly save?: (userMessageId: string) => Promise<void>;
}

/**
 * Runs inside the turn's transaction after the thread lock. The owner lock taken by the count
 * holds until commit, so the capacity answer cannot go stale before the save.
 */
export async function decideReminderTurn(
  scopedDb: DataContextDb,
  deps: { readonly reminders: ReminderRepository; readonly boss: Pick<PgBoss, "send"> | undefined },
  actorUserId: string,
  thread: { readonly id: string; readonly is_main: boolean; readonly incognito: boolean },
  plan: ReminderTurnPlan
): Promise<ReminderTurnDecision> {
  if (plan.kind === "unsupported") return refused(reminderRefusedReply(plan.reason));
  if (plan.kind === "main_only" || !thread.is_main || thread.incognito) {
    return refused(REMINDER_MAIN_ONLY_REPLY);
  }

  const boss = deps.boss;
  if (!boss) throw new Error("chat reminder delivery queue is unavailable");

  const open = await deps.reminders.openCountLocked(scopedDb, actorUserId);
  if (open >= REMINDER_OPEN_LIMIT) return refused(REMINDER_CAPACITY_REPLY);

  const reminderId = randomUUID();
  return {
    reply: reminderSavedReply(plan.delaySeconds, plan.text),
    origin: { version: 1, kind: "reminder", event: "saved", reminderId },
    save: async (userMessageId) => {
      const saved = await deps.reminders.create(scopedDb, {
        id: reminderId,
        threadId: thread.id,
        sourceMessageId: userMessageId,
        delaySeconds: plan.delaySeconds,
        text: plan.text
      });
      await enqueueReminderDelivery(boss, scopedDb, actorUserId, saved);
    }
  };
}

function refused(reply: string): ReminderTurnDecision {
  return { reply, origin: { version: 1, kind: "reminder", event: "refused", reminderId: null } };
}
