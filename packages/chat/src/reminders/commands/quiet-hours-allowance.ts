import { isUuid } from "@moss/db";
import { matchTarget, normalizeReminderText } from "../cancel.js";
import {
  clearQuietHoursProposal,
  hasQuietHoursAllowance,
  readQuietHoursProposal,
  readQuietHoursReminder,
  saveQuietHoursAllowance,
  saveQuietHoursProposal
} from "../quiet-hours-allowances.js";
import type { ReminderCommandHandler, ReminderTurnDecision } from "./types.js";

function refused(reply: string): ReminderTurnDecision {
  return {
    reply,
    origin: { version: 1, kind: "reminder", event: "allowance_refused", reminderId: null }
  };
}

export const quietHoursAllowance: ReminderCommandHandler = async (
  { scopedDb, deps, thread },
  plan
) => {
  if (plan.kind !== "quiet_allowance" && plan.kind !== "quiet_agreement")
    throw new Error("invalid quiet-hours allowance plan");

  let targetId: string;
  let allow: boolean;
  let expectedVersion: number | undefined;
  let interpreted = false;
  if (plan.kind === "quiet_agreement") {
    const proposal = await readQuietHoursProposal(scopedDb, thread.id);
    await clearQuietHoursProposal(scopedDb, thread.id);
    if (!proposal || !plan.agree) return refused("Nothing changed during quiet hours.");
    targetId = proposal.reminder_id;
    allow = proposal.allow;
    expectedVersion = proposal.reminder_version;
  } else {
    const owned = await deps.reminders.listOwned(scopedDb);
    const candidates = isUuid(plan.target)
      ? owned.filter((reminder) => reminder.id === plan.target)
      : matchTarget(owned, plan.target);
    if (!candidates.length)
      return refused("I couldn't find that reminder. Nothing changed during quiet hours.");
    if (candidates.length !== 1) {
      const names = candidates.map((r) => `${r.text} (${r.id})`).join("; ");
      return refused(
        `Which reminder do you mean: ${names}? Name one reminder, using its ID if the names match. Nothing changed during quiet hours.`
      );
    }
    const candidate = candidates[0]!;
    targetId = candidate.id;
    allow = plan.allow;
    interpreted =
      !isUuid(plan.target) &&
      normalizeReminderText(candidate.text) !== normalizeReminderText(plan.target);
  }

  const reminder = await readQuietHoursReminder(scopedDb, targetId);
  if (!reminder || (expectedVersion !== undefined && reminder.version !== expectedVersion))
    return refused(
      "That reminder changed or is no longer available. Nothing changed during quiet hours."
    );
  const active =
    (reminder.state === "queued" || reminder.state === "delivered") &&
    reminder.context_state !== "dismissed" &&
    (reminder.deadline_at === null || reminder.deadline_at >= (await deps.reminders.now(scopedDb)));
  if (allow && !active)
    return refused("That reminder is no longer active. Nothing changed during quiet hours.");
  if (!allow && !(await hasQuietHoursAllowance(scopedDb, targetId)))
    return refused(`The reminder to ${reminder.reminder_text} is already subject to quiet hours.`);

  if (interpreted) {
    return {
      reply: `${allow ? "Allow" : "Stop allowing"} the reminder to ${reminder.reminder_text} during quiet hours? Reply yes or no.`,
      origin: { version: 1, kind: "reminder", event: "allowance_proposed", reminderId: targetId },
      save: (sourceMessageId) =>
        saveQuietHoursProposal(scopedDb, {
          threadId: thread.id,
          reminderId: targetId,
          version: reminder.version,
          allow,
          sourceMessageId
        })
    };
  }
  return {
    reply: allow
      ? `The reminder to ${reminder.reminder_text} is allowed during quiet hours. Your other delivery controls still apply.`
      : `The reminder to ${reminder.reminder_text} will respect quiet hours again.`,
    origin: {
      version: 1,
      kind: "reminder",
      event: allow ? "allowance_saved" : "allowance_removed",
      reminderId: targetId
    },
    save: (sourceMessageId) => saveQuietHoursAllowance(scopedDb, targetId, allow, sourceMessageId)
  };
};
