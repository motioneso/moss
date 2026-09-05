import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { SportsFollowDto } from "@moss/shared";

interface SportsFollowRow {
  id: string;
  competition_key: string;
  team_key: string | null;
  source_team_id: string | null;
  created_at: Date;
}

/** What a saved follow is written with. The permanent provider team id is the identity; the short
 *  name is display only. A whole-competition follow has neither (both null). */
export interface CreateSportsFollowInput {
  readonly competitionKey: string;
  readonly teamKey: string | null;
  readonly sourceTeamId: string | null;
}

const FOLLOW_COLUMNS = ["id", "competition_key", "team_key", "source_team_id", "created_at"] as const;

/** Map a persisted row to the public DTO (snake_case → camelCase, Date → ISO string). */
export function toDto(row: SportsFollowRow): SportsFollowDto {
  return {
    id: row.id,
    competitionKey: row.competition_key,
    teamKey: row.team_key,
    sourceTeamId: row.source_team_id,
    createdAt: row.created_at.toISOString()
  };
}

export class SportsFollowsRepository {
  async list(scopedDb: DataContextDb): Promise<SportsFollowDto[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.sports_follows")
      .select(FOLLOW_COLUMNS)
      // #903: ascending id breaks ties on equal created_at, matching selectPrimaryFollow's
      // in-memory tie-break — same pattern as packages/briefings/src/repository.ts.
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map(toDto);
  }

  async create(
    scopedDb: DataContextDb,
    input: CreateSportsFollowInput
  ): Promise<SportsFollowDto> {
    assertDataContextDb(scopedDb);
    const teamKey = input.teamKey ?? null;
    const sourceTeamId = input.sourceTeamId ?? null;
    // One insert, untargeted ON CONFLICT DO NOTHING: no conflict-target clause, so it catches a
    // clash against either the partial unique index on (owner_user_id, competition_key,
    // source_team_id) added in 0214 or the one on (owner_user_id, competition_key) WHERE
    // team_key IS NULL. A losing concurrent insert returns no row instead of throwing 23505.
    const row = await scopedDb.db
      .insertInto("app.sports_follows")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        competition_key: input.competitionKey,
        team_key: teamKey,
        source_team_id: sourceTeamId
      })
      .onConflict((oc) => oc.doNothing())
      .returning(FOLLOW_COLUMNS)
      .executeTakeFirst();
    if (row) return toDto(row);

    // Lost the race (or this is a plain repeat call): re-read the exact owner-scoped row that
    // must now exist. Re-read by permanent id, not by short name — two teams in one competition
    // may share a short name, so a short name no longer picks one row out. RLS already scopes
    // this select to the calling actor.
    let query = scopedDb.db
      .selectFrom("app.sports_follows")
      .select(FOLLOW_COLUMNS)
      .where("competition_key", "=", input.competitionKey);
    query =
      sourceTeamId === null
        ? query.where("team_key", "is", null)
        : query.where("source_team_id", "=", sourceTeamId);
    const existing = await query.executeTakeFirstOrThrow();
    return toDto(existing);
  }

  /** Answers "which team did you mean?" for one older saved follow by writing the permanent
   *  provider team id onto it. Owner-scoped by RLS; returns undefined when the row is not the
   *  caller's or does not exist. */
  async setSourceTeamId(
    scopedDb: DataContextDb,
    id: string,
    sourceTeamId: string,
    teamKey: string | null
  ): Promise<SportsFollowDto | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.sports_follows")
      .set({ source_team_id: sourceTeamId, team_key: teamKey })
      .where("id", "=", id)
      // A whole-competition follow (team_key IS NULL) is not a team follow and must never be
      // turned into one by this route.
      .where("team_key", "is not", null)
      .returning(FOLLOW_COLUMNS)
      .executeTakeFirst();
    return row ? toDto(row) : undefined;
  }

  async remove(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.sports_follows")
      .where("id", "=", id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
