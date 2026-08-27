import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { SportsSourceAssignmentTarget } from "@moss/shared";

import { hasValidSportsSourceTargets, isSportsSportKey } from "./scope.js";

export interface SportsEspnCoverageState {
  readonly enabled: boolean;
  readonly usesDefaultCoverage: boolean;
  readonly assignments: readonly SportsSourceAssignmentTarget[];
}

export class SportsEspnCoverageRepository {
  async get(scopedDb: DataContextDb): Promise<SportsEspnCoverageState> {
    assertDataContextDb(scopedDb);
    const [preference, rows] = await Promise.all([
      scopedDb.db
        .selectFrom("app.sports_headline_prefs")
        .select("espn_headlines_enabled")
        .executeTakeFirst(),
      scopedDb.db
        .selectFrom("app.sports_espn_source_assignments")
        .select(["sport_key", "follow_id"])
        .orderBy("created_at")
        .orderBy("id")
        .execute()
    ]);
    const enabled = preference?.espn_headlines_enabled ?? true;
    const assignments = rows.map((row): SportsSourceAssignmentTarget => {
      if (row.sport_key !== null) {
        if (!isSportsSportKey(row.sport_key)) throw new Error("Unknown ESPN sports coverage key");
        return { kind: "sport", sportKey: row.sport_key };
      }
      if (row.follow_id === null) throw new Error("ESPN coverage row has no target");
      return { kind: "follow", followId: row.follow_id };
    });
    return {
      enabled,
      usesDefaultCoverage: enabled && assignments.length === 0,
      assignments
    };
  }

  async replace(
    scopedDb: DataContextDb,
    targets: readonly SportsSourceAssignmentTarget[]
  ): Promise<SportsEspnCoverageState> {
    assertDataContextDb(scopedDb);
    if (!hasValidSportsSourceTargets(targets)) {
      throw new Error("Invalid ESPN sports coverage targets");
    }
    const followIds = targets.flatMap((target) =>
      target.kind === "follow" ? [target.followId] : []
    );
    const ownedFollows =
      followIds.length === 0
        ? []
        : await scopedDb.db
            .selectFrom("app.sports_follows")
            .select("id")
            .where("id", "in", followIds)
            .execute();
    if (ownedFollows.length !== followIds.length) {
      throw new Error("ESPN coverage contains an unavailable follow");
    }

    await sql`SELECT pg_advisory_xact_lock(
      hashtext('sports:source-assignments:' || app.current_actor_user_id())
    )`.execute(scopedDb.db);
    await scopedDb.db.deleteFrom("app.sports_espn_source_assignments").execute();
    const enabled = targets.length > 0;
    await scopedDb.db
      .insertInto("app.sports_headline_prefs")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        espn_headlines_enabled: enabled,
        updated_at: new Date()
      })
      .onConflict((conflict) =>
        conflict.column("owner_user_id").doUpdateSet({
          espn_headlines_enabled: enabled,
          updated_at: new Date()
        })
      )
      .execute();
    if (targets.length > 0) {
      await scopedDb.db
        .insertInto("app.sports_espn_source_assignments")
        .values(
          targets.map((target) => ({
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            sport_key: target.kind === "sport" ? target.sportKey : null,
            follow_id: target.kind === "follow" ? target.followId : null
          }))
        )
        .execute();
    }
    return this.get(scopedDb);
  }
}
