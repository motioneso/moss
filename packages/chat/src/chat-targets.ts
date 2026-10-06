import { assertDataContextDb, isUuid } from "@moss/db";
import { ChatMemoryFactsRepository } from "@moss/memory";
import type { RouteChatTargetResolver } from "@moss/module-sdk";

const facts = new ChatMemoryFactsRepository();

/** #3065: labels the memory fact a chat-issued DELETE /api/chat/memory/facts/:id would remove. */
export const memoryFactTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const fact = await facts.getActiveFact(db, id);
  return fact?.content ?? null;
};
