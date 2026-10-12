// Reminder commands run inside the turn transaction; their deferred saves commit with it.
import type { DataContextDb } from "@moss/db";
import { cancel } from "./commands/cancel.js";
import { clockRequest } from "./commands/clock-request.js";
import { list } from "./commands/list.js";
import { request } from "./commands/request.js";
import type {
  ReminderCommandContext,
  ReminderCommandHandler,
  ReminderTurnDecision,
  ReminderTurnPlan
} from "./commands/types.js";
import {
  REMINDER_MAIN_ONLY_REPLY,
  REMINDER_MANAGE_MAIN_ONLY_REPLY,
  reminderRefusedReply
} from "./wording.js";
export type { ReminderTurnDecision, ReminderTurnPlan } from "./commands/types.js";

const handlers = {
  request,
  clock_request: clockRequest,
  list,
  cancel
} satisfies Record<
  Exclude<ReminderTurnPlan["kind"], "unsupported" | "main_only">,
  ReminderCommandHandler
>;

export async function decideReminderTurn(
  scopedDb: DataContextDb,
  deps: ReminderCommandContext["deps"],
  actorUserId: string,
  thread: ReminderCommandContext["thread"],
  plan: ReminderTurnPlan
): Promise<ReminderTurnDecision> {
  if (plan.kind === "unsupported") return refused(reminderRefusedReply(plan.reason));
  if (plan.kind === "main_only" || !thread.is_main || thread.incognito) {
    const manage =
      plan.kind === "list" || plan.kind === "cancel" || (plan.kind === "main_only" && plan.manage);
    return refused(manage ? REMINDER_MANAGE_MAIN_ONLY_REPLY : REMINDER_MAIN_ONLY_REPLY);
  }
  return handlers[plan.kind]({ scopedDb, deps, actorUserId, thread }, plan);
}

function refused(reply: string): ReminderTurnDecision {
  return { reply, origin: { version: 1, kind: "reminder", event: "refused", reminderId: null } };
}
