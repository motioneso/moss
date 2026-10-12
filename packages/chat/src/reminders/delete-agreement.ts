import { sql } from "kysely";
import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";

export interface PendingReminderDeletion {
  readonly id: string;
  readonly version: number;
  readonly state: string;
}

/** Only the last completed owner turn can ask for agreement; reminder arrivals are not turns. */
export async function pendingReminderDeletion(
  scopedDb: DataContextDb,
  threadId: string
): Promise<PendingReminderDeletion | undefined> {
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
  if (answer?.role !== "assistant" || question?.role !== "user") return undefined;
  if (new Date(answer.created_at).getTime() !== new Date(question.created_at).getTime())
    return undefined;
  if (answer.tool_metadata.turnId !== question.tool_metadata.turnId) return undefined;
  const origin = answer.model_metadata.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return undefined;
  const record = origin as Record<string, unknown>;
  if (
    record.kind !== "reminder" ||
    record.event !== "delete_requested" ||
    record.version !== 1 ||
    typeof record.reminderId !== "string" ||
    !isUuid(record.reminderId) ||
    typeof record.reminderVersion !== "number" ||
    !Number.isSafeInteger(record.reminderVersion) ||
    record.reminderVersion < 1 ||
    typeof record.reminderState !== "string"
  )
    return undefined;
  return { id: record.reminderId, version: record.reminderVersion, state: record.reminderState };
}

export function typedDeletionAgreement(text: string): boolean | undefined {
  if (/^yes[.!]?$/i.test(text.trim())) return true;
  if (/^no[.!]?$/i.test(text.trim())) return false;
  return undefined;
}

export function isDeletionNearMiss(text: string): boolean {
  return /^(yeah|yep|sure|ok|nope|keep it)[.!]?$/i.test(text.trim());
}
