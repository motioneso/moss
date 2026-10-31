import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { HeartbeatSource } from "@moss/shared";

import { findingKey, type HeartbeatMuteRule } from "./filter.js";
import type { HeartbeatCheckpoint } from "./precheck.js";

const owner = sql<string>`app.current_actor_user_id()`;

export async function loadCheckpoints(
  scopedDb: DataContextDb
): Promise<Map<HeartbeatSource, HeartbeatCheckpoint>> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.heartbeat_source_checkpoints")
    .select(["source", "revision", "next_boundary_at"])
    .where("owner_user_id", "=", owner)
    .execute();
  return new Map(
    rows.map((row) => [
      row.source as HeartbeatSource,
      { revision: row.revision, nextBoundaryAt: row.next_boundary_at }
    ])
  );
}

/** Moves a source's checkpoint forward. Only called after the source was read and weighed. */
export async function saveCheckpoint(
  scopedDb: DataContextDb,
  input: {
    readonly source: HeartbeatSource;
    readonly revision: string;
    readonly nextBoundaryAt: string | null;
    readonly now: Date;
  }
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .insertInto("app.heartbeat_source_checkpoints")
    .values({
      owner_user_id: owner,
      source: input.source,
      revision: input.revision,
      next_boundary_at: input.nextBoundaryAt,
      evaluated_at: input.now
    })
    .onConflict((oc) =>
      oc.columns(["owner_user_id", "source"]).doUpdateSet({
        revision: input.revision,
        next_boundary_at: input.nextBoundaryAt,
        evaluated_at: input.now
      })
    )
    .execute();
}

export async function loadMuteRules(scopedDb: DataContextDb): Promise<HeartbeatMuteRule[]> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.heartbeat_mutes")
    .select(["scope", "source", "entity_key", "topic"])
    .where("owner_user_id", "=", owner)
    .execute();
  return rows.map((row) => ({
    scope: row.scope,
    source: row.source,
    entityKey: row.entity_key,
    topic: row.topic
  }));
}

/** Keys of findings already published, resolved or suppressed, for the given sources. */
export async function loadSettledKeys(
  scopedDb: DataContextDb,
  sources: readonly HeartbeatSource[]
): Promise<Set<string>> {
  assertDataContextDb(scopedDb);
  if (sources.length === 0) return new Set();
  const rows = await scopedDb.db
    .selectFrom("app.heartbeat_findings")
    .select(["source", "entity_key", "episode_key"])
    .where("owner_user_id", "=", owner)
    .where("source", "in", [...sources])
    .where("state", "in", ["published", "resolved", "suppressed"])
    .execute();
  return new Set(rows.map((row) => findingKey(row.source, row.entity_key, row.episode_key)));
}

export async function markPublished(
  scopedDb: DataContextDb,
  occurrenceId: string,
  now: Date,
  findings: readonly {
    readonly id: string;
    readonly source: HeartbeatSource;
    readonly entityKey: string;
    readonly episodeKey: string;
  }[]
): Promise<void> {
  assertDataContextDb(scopedDb);
  for (const finding of findings) {
    await scopedDb.db
      .insertInto("app.heartbeat_findings")
      .values({
        id: finding.id,
        owner_user_id: owner,
        source: finding.source,
        entity_key: finding.entityKey,
        episode_key: finding.episodeKey,
        state: "published",
        occurrence_id: occurrenceId,
        updated_at: now
      })
      .onConflict((oc) =>
        oc
          .columns(["owner_user_id", "source", "entity_key", "episode_key"])
          .doUpdateSet({ state: "published", occurrence_id: occurrenceId, updated_at: now })
      )
      .execute();
  }
}
