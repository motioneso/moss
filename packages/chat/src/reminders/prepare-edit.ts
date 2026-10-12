import {
  createAiSecretCipher,
  prepareStructuredGeneration,
  type AiRepository,
  type GenerateStructuredDeps
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";
import type { ReminderLocale } from "./clock-wording.js";
import { normalizeReminderText, matchTarget } from "./cancel.js";
import { pendingReminderEdit, matchReminderEditSelection } from "./edit-agreement.js";
import { readEditableReminders } from "./edit.js";
import { recognizeReminderEdit } from "./edit-recognizer.js";
import {
  reminderEditSchema,
  REMINDER_EDIT_GUIDANCE,
  validateReminderEdit
} from "./edit-interpretation.js";
import type { ReminderTurnPlan } from "./turn.js";

const REFUSED =
  "I can edit a reminder's text, time or deadline only. I can't change its actions, recipients, destination, repetition or notification permissions. Nothing changed.";

/** Prepare under RLS, execute after the transaction closes, and validate again when saving. */
export async function prepareReminderEdit(
  scopedDb: DataContextDb,
  ai: AiRepository,
  cli: GenerateStructuredDeps["createCliStructuredAdapter"],
  text: string,
  threadId: string,
  locale: ReminderLocale,
  signal?: AbortSignal
): Promise<() => Promise<ReminderTurnPlan | undefined>> {
  const pending = await pendingReminderEdit(scopedDb, threadId);
  if (pending && !recognizeReminderEdit(text)) {
    const owned = await readEditableReminders(scopedDb);
    const candidates = owned
      .filter((row) => pending.candidates.some((candidate) => candidate.id === row.id))
      .map((row) => ({ ...row, text: row.reminder_text }));
    if (
      /^(?:number |the )?\d{1,2}[.!]?$/i.test(text.trim()) ||
      matchReminderEditSelection(candidates, text).length > 0
    )
      return async () => ({ kind: "edit_selection", selection: text });
  }
  if (!recognizeReminderEdit(text)) return async () => undefined;
  const owned = await readEditableReminders(scopedDb);
  if (owned.length === 0) return async () => undefined;
  const { model } = await ai.resolveModelForService(scopedDb, "module.chat", {
    capability: "json"
  });
  if (!model)
    return async () => ({
      kind: "edit_refused",
      reply:
        "No model is configured to understand that edit. Nothing changed. Check your AI settings and try again."
    });
  const now = await scopedDb.db
    .selectNoFrom(({ fn }) => fn<Date>("now", []).as("now"))
    .executeTakeFirstOrThrow();
  const localNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: locale.timeZone,
    dateStyle: "short",
    timeStyle: "short"
  }).format(now.now);
  const run = await prepareStructuredGeneration(
    scopedDb,
    {
      service: "module.chat",
      explicitModel: model,
      schema: reminderEditSchema,
      maxOutputTokens: 1000,
      signal,
      prompt: `${REMINDER_EDIT_GUIDANCE}\n${JSON.stringify({ ownerRequest: text, localNow, timeZone: locale.timeZone, reminders: owned.map((row) => ({ text: row.reminder_text, dueAt: row.due_at, deadlineAt: row.deadline_at, state: row.state })) })}`
    },
    { repository: ai, cipher: createAiSecretCipher(), createCliStructuredAdapter: cli }
  );
  return async () => {
    const result = await run();
    const interpreted = result.ok ? validateReminderEdit(result.object) : undefined;
    if (!interpreted)
      return {
        kind: "edit_refused",
        reply:
          "I couldn't understand that edit reliably. Nothing changed. Name the reminder and its new text or time."
      };
    if (
      interpreted.target !== null &&
      !normalizeReminderText(text).includes(normalizeReminderText(interpreted.target))
    )
      return {
        kind: "edit_refused",
        reply:
          "Name the reminder using its saved words so I can change the right one. Nothing changed."
      };
    if (interpreted.unsupported) return { kind: "edit_refused", reply: REFUSED };
    const matches =
      interpreted.target === null
        ? owned
        : matchTarget(
            owned.map((row) => ({ ...row, text: row.reminder_text })),
            interpreted.target
          );
    if (!matches.length)
      return {
        kind: "edit_refused",
        reply: "I couldn't find a waiting reminder with those words. Nothing changed."
      };
    const { target: _target, unsupported: _unsupported, ...terms } = interpreted;
    if (
      terms.text === null &&
      terms.delaySeconds === null &&
      terms.localDue === null &&
      terms.deadline === "keep"
    )
      return {
        kind: "edit_refused",
        reply: "Tell me the reminder's new text, time or deadline. Nothing changed."
      };
    return {
      kind: "edit",
      proposal: { candidates: matches.map((row) => ({ id: row.id, version: row.version })), terms }
    };
  };
}
