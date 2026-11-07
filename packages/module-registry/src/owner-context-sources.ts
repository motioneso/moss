import { CalendarRepository } from "@moss/calendar";
import { assertDataContextDb, readScopedActorUserId, type DataContextDb } from "@moss/db";
import { GraphMemoryRecallService } from "@moss/memory";
import type { OwnerContextSources } from "@moss/meetings";
import { findPeopleByNames } from "@moss/people";

import { createRuntimeEmbeddingProvider } from "./built-in-module-helpers.js";

const MAX_MEMORY_QUERIES = 5;
const MEMORY_ITEMS_PER_QUERY = 3;
const MAX_MEMORY_TEXT_LENGTH = 240;

async function actorUserId(db: DataContextDb): Promise<string> {
  const id = await readScopedActorUserId(db);
  if (!id) throw new Error("owner context needs a scoped actor");
  return id;
}

/**
 * Builds the owner-context port for meetings out of calendar, people and memory.
 * Every read runs in the caller's data context, so another user's rows never appear.
 * Calendar attendee names exist only for Google-synced events.
 */
export function createOwnerContextSources(
  deps: { readonly calendar?: CalendarRepository } = {}
): OwnerContextSources {
  const calendar = deps.calendar ?? new CalendarRepository();
  return {
    async ownerProfile(db) {
      assertDataContextDb(db);
      const id = await actorUserId(db);
      const row = await db.db
        .selectFrom("app.users")
        .select("name")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const displayName = row.name.trim();
      const parts = displayName.split(/\s+/).filter((p) => p !== "");
      return { displayName, aliases: parts.length > 1 ? [parts[0]!] : [] };
    },
    calendar: (db, window) => calendar.listEventsOverlapping(db, window),
    async people(db, names) {
      return findPeopleByNames(db, await actorUserId(db), names);
    },
    async memory(db, queries) {
      const ownerUserId = await actorUserId(db);
      const service = new GraphMemoryRecallService(await createRuntimeEmbeddingProvider(db));
      const out: { query: string; text: string }[] = [];
      for (const query of queries.slice(0, MAX_MEMORY_QUERIES)) {
        const result = await service.recall(db, ownerUserId, query, {
          limit: MEMORY_ITEMS_PER_QUERY
        });
        for (const item of result.items) {
          out.push({ query, text: item.text.slice(0, MAX_MEMORY_TEXT_LENGTH) });
        }
      }
      return out;
    }
  };
}
