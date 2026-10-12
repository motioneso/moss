import { matchTarget } from "../cancel.js";
import { pendingReminderEdit } from "../edit-agreement.js";
import { editReminderById, readEditableReminders } from "../edit.js";
import { reminderEditedReply, reminderEditChoiceReply } from "../wording.js";
import { controlRefused } from "./control-target.js";
import type { ReminderCommandHandler } from "./types.js";

export const edit: ReminderCommandHandler = async (context, plan) => {
  if (plan.kind === "edit_refused") return controlRefused(plan.reply);
  if (plan.kind !== "edit" && plan.kind !== "edit_selection")
    throw new Error("invalid reminder edit plan");
  const proposal =
    plan.kind === "edit"
      ? plan.proposal
      : await pendingReminderEdit(context.scopedDb, context.thread.id);
  if (!proposal)
    return controlRefused("That choice is no longer current. Ask me to edit the reminder again.");
  const owned = await readEditableReminders(context.scopedDb);
  const candidates = proposal.candidates.map((candidate) => {
    const row = owned.find(
      (item) => item.id === candidate.id && item.version === candidate.version
    );
    return row && { ...row, text: row.reminder_text };
  });
  if (candidates.some((row) => !row))
    return controlRefused(
      "A matching reminder changed or was already sent. Nothing changed. Ask again."
    );
  const current = candidates.filter((row) => row !== undefined);
  let chosen = current.length === 1 ? current[0] : undefined;
  if (plan.kind === "edit_selection") {
    // The raw typed reply is the authority, never a model/tool-generated selection.
    if (context.userText !== plan.selection) return controlRefused();
    const raw = plan.selection.trim();
    const numbered = /^(?:number |the )?(\d{1,2})[.!]?$/i.exec(raw);
    if (numbered) chosen = current[Number(numbered[1]) - 1];
    else {
      const matches = matchTarget(current, raw);
      if (matches.length === 1) chosen = matches[0];
    }
    if (!chosen)
      return controlRefused("Choose one reminder by its number or exact words. Nothing changed.");
  }
  const locale = await context.deps.locale();
  if (!chosen)
    return {
      reply: reminderEditChoiceReply(current, locale),
      origin: {
        version: 1,
        kind: "reminder",
        event: "edit_requested",
        reminderId: null,
        editProposal: proposal
      }
    };
  if (!context.deps.boss) throw new Error("chat reminder delivery queue is unavailable");
  const result = await editReminderById(
    context.scopedDb,
    context.deps.boss,
    context.actorUserId,
    chosen.id,
    chosen.version,
    proposal.terms,
    locale.timeZone
  );
  if (result.kind === "invalid") return controlRefused(result.reply);
  if (result.kind !== "changed" && result.kind !== "unchanged")
    return controlRefused(
      "That reminder changed or is no longer waiting. Nothing changed. Ask again."
    );
  return {
    reply: reminderEditedReply(result.reminder, locale, result.kind === "unchanged"),
    origin: {
      version: 1,
      kind: "reminder",
      event: "edited",
      reminderId: result.reminder.id,
      reminderVersion: result.reminder.version
    }
  };
};
