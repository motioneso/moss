// Reminder commands run inside the turn transaction; their deferred saves commit with it.
import { clearResponsibilityProposals } from "../responsibility-agreements/repository.js";
import { clearQuietHoursProposal } from "./quiet-hours-allowances.js";
import type { DataContextDb } from "@moss/db";
import { reminderCommands } from "./commands/registry.js";
import type {
  ReminderCommandContext,
  ReminderTurnDecision,
  ReminderTurnPlan
} from "./commands/types.js";
import {
  REMINDER_MAIN_ONLY_REPLY,
  REMINDER_MANAGE_MAIN_ONLY_REPLY,
  reminderRefusedReply
} from "./wording.js";
export type { ReminderTurnDecision, ReminderTurnPlan } from "./commands/types.js";

export async function decideReminderTurn(
  scopedDb: DataContextDb,
  deps: ReminderCommandContext["deps"],
  actorUserId: string,
  thread: ReminderCommandContext["thread"],
  plan: ReminderTurnPlan,
  userText?: string
): Promise<ReminderTurnDecision> {
  if (
    plan.kind !== "quiet_agreement" &&
    plan.kind !== "main_only" &&
    thread.is_main &&
    !thread.incognito
  )
    await clearQuietHoursProposal(scopedDb, thread.id);
  if (
    plan.kind !== "main_only" &&
    plan.kind !== "scope_proposal" &&
    plan.kind !== "scope_agreement" &&
    plan.kind !== "scope_refused"
  )
    await clearResponsibilityProposals(scopedDb, thread.id);
  if (plan.kind === "unsupported") return refused(reminderRefusedReply(plan.reason));
  if (plan.kind === "main_only" || !thread.is_main || thread.incognito) {
    const manage =
      plan.kind === "main_only"
        ? plan.manage
        : plan.kind !== "request" &&
          plan.kind !== "clock_request" &&
          plan.kind !== "scheduled_read" &&
          plan.kind !== "repeat_request";
    return refused(manage ? REMINDER_MANAGE_MAIN_ONLY_REPLY : REMINDER_MAIN_ONLY_REPLY);
  }
  return reminderCommands[plan.kind].execute(
    { scopedDb, deps, actorUserId, thread, userText },
    plan
  );
}

function refused(reply: string): ReminderTurnDecision {
  return { reply, origin: { version: 1, kind: "reminder", event: "refused", reminderId: null } };
}
