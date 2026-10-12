import { sql } from "kysely";
import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import type { ReminderEditProposal } from "@moss/shared";
import { matchTarget, normalizeReminderText } from "./cancel.js";
import { validateReminderEdit } from "./edit-interpretation.js";

/** Only the last completed owner turn can offer candidates; delivered reminders are not turns. */
export async function pendingReminderEdit(
  scopedDb: DataContextDb,
  threadId: string
): Promise<ReminderEditProposal | undefined> {
  assertDataContextDb(scopedDb);
  const latest = await scopedDb.db
    .selectFrom("app.chat_messages")
    .select(["role", "created_at", "model_metadata", "tool_metadata"])
    .where("thread_id", "=", threadId)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("status", "=", "stored")
    .where(sql<boolean>`coalesce(model_metadata->'origin'->>'event', '') <> 'delivered'`)
    .where(sql<boolean>`coalesce(tool_metadata->>'actionOutcomeOnly', 'false') <> 'true'`)
    .orderBy("created_at", "desc")
    .orderBy(sql<number>`case when role = 'assistant' then 0 else 1 end`)
    .orderBy("id", "desc")
    .limit(2)
    .execute();
  const [answer, question] = latest;
  if (
    answer?.role !== "assistant" ||
    question?.role !== "user" ||
    new Date(answer.created_at).getTime() !== new Date(question.created_at).getTime() ||
    answer.tool_metadata.turnId !== question.tool_metadata.turnId
  )
    return undefined;
  const origin = answer.model_metadata.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return undefined;
  const record = origin as Record<string, unknown>;
  if (record.kind !== "reminder" || record.event !== "edit_requested" || record.version !== 1)
    return undefined;
  const proposal = record.editProposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return undefined;
  const row = proposal as Record<string, unknown>;
  if (!Array.isArray(row.candidates) || row.candidates.length < 2 || row.candidates.length > 20)
    return undefined;
  const candidates: { id: string; version: number }[] = [];
  for (const candidate of row.candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !isUuid(item.id) ||
      typeof item.version !== "number" ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1
    )
      return undefined;
    candidates.push({ id: item.id, version: item.version });
  }
  if (!row.terms || typeof row.terms !== "object" || Array.isArray(row.terms)) return undefined;
  const interpreted = validateReminderEdit({ ...row.terms, target: null, unsupported: false });
  if (!interpreted) return undefined;
  const { target: _target, unsupported: _unsupported, ...terms } = interpreted;
  return { candidates, terms };
}

/** An acknowledgment alone never identifies a reminder to edit. */
export function matchReminderEditSelection<T extends { readonly text: string }>(
  candidates: readonly T[],
  selection: string
): readonly T[] {
  return /^(?:yes|ok|okay)$/.test(normalizeReminderText(selection))
    ? []
    : matchTarget(candidates, selection);
}
