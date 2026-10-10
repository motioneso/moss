// #3309: decides the code-written reply for a recognised reminder request and, when it is
// accepted, saves the reminder and its delivery job in the same transaction as the turn.
// #3310: list and cancel run here too, so a stopped turn rolls a cancel back.

import { randomUUID } from "node:crypto";

import type { PgBoss } from "pg-boss";

import type { DataContextDb } from "@moss/db";
import type { ChatReminderOriginV1 } from "@moss/shared";

import { cancelReminder, listReminders } from "./cancel.js";
import { enqueueReminderDelivery } from "./deliver.js";
import type { ReminderUnsupportedReason } from "./recognizer.js";
import type { ReminderRepository } from "./repository.js";
import {
  REMINDER_CAPACITY_REPLY,
  REMINDER_MAIN_ONLY_REPLY,
  REMINDER_MANAGE_MAIN_ONLY_REPLY,
  REMINDER_OPEN_LIMIT,
  reminderCancelReply,
  reminderListReply,
  reminderRefusedReply,
  reminderSavedReply
} from "./wording.js";

/** What the raw request asked for, before anything is checked against storage. */
export type ReminderTurnPlan =
  | { readonly kind: "request"; readonly delaySeconds: number; readonly text: string }
  | { readonly kind: "unsupported"; readonly reason: ReminderUnsupportedReason }
  | { readonly kind: "list" }
  | { readonly kind: "cancel"; readonly target: string | null }

  /** A save, list or cancel refused before it reaches storage. `manage` marks list or cancel. */
  | { readonly kind: "main_only"; readonly manage?: boolean };

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
    const manage =
      plan.kind === "list" || plan.kind === "cancel" || (plan.kind === "main_only" && plan.manage);
    return refused(manage ? REMINDER_MANAGE_MAIN_ONLY_REPLY : REMINDER_MAIN_ONLY_REPLY);
  }

  if (plan.kind === "list") {
    const list = await listReminders(scopedDb, deps.reminders);
    return {
      reply: reminderListReply(list),
      origin: { version: 1, kind: "reminder", event: "listed", reminderId: null }
    };
  }

  if (plan.kind === "cancel") {
    const result = await cancelReminder(scopedDb, deps.reminders, plan.target);
    return {
      reply: reminderCancelReply(result),
      origin: {
        version: 1,
        kind: "reminder",
        event: result.kind === "cancelled" ? "cancelled" : "cancel_refused",
        reminderId: "reminder" in result ? result.reminder.id : null
      }
    };
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
