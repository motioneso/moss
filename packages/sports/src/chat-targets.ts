import { sql } from "kysely";

import { assertDataContextDb, isUuid } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";

import { catalogEntry } from "./source/catalog.js";

/** #3065: target labels read only module-owned rows through the actor-scoped transaction. */
export const sportsFollowTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const follow = await db.db
    .selectFrom("app.sports_follows")
    .select(["competition_key", "team_key", "source_team_id"])
    .where("id", "=", id)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();
  if (!follow) return null;
  const competition = catalogEntry(follow.competition_key)?.label ?? follow.competition_key;
  if (!follow.team_key) return competition;
  // Use the saved identity, never a provider lookup or a label supplied by the model.
  const identity = follow.source_team_id ? `; team ${follow.source_team_id}` : "";
  return `${follow.team_key} (${competition}${identity})`;
};

/** Shared by removing a saved source and forgetting that source's photo instructions. */
export const sportsSourceTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const source = await db.db
    .selectFrom("app.sports_custom_sources")
    .select(["label", "canonical_domain"])
    .where("id", "=", id)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();
  return source ? `${source.label} (${source.canonical_domain})` : null;
};
