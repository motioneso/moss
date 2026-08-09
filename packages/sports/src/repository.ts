import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { CreateSportsFollowRequest, SportsFollowDto } from "@moss/shared";

interface SportsFollowRow {
  id: string;
  competition_key: string;
  team_key: string | null;
  created_at: Date;
}

/** Map a persisted row to the public DTO (snake_case → camelCase, Date → ISO string). */
export function toDto(row: SportsFollowRow): SportsFollowDto {
  return {
    id: row.id,
    competitionKey: row.competition_key,
    teamKey: row.team_key,
    createdAt: row.created_at.toISOString()
  };
}

export class SportsFollowsRepository {
  async list(scopedDb: DataContextDb): Promise<SportsFollowDto[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.sports_follows")
      .select(["id", "competition_key", "team_key", "created_at"])
      // #903: ascending id breaks ties on equal created_at, matching selectPrimaryFollow's
      // in-memory tie-break — same pattern as packages/briefings/src/repository.ts.
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map(toDto);
  }

  async create(
    scopedDb: DataContextDb,
    input: CreateSportsFollowRequest
  ): Promise<SportsFollowDto> {
    assertDataContextDb(scopedDb);
    const teamKey = input.teamKey ?? null;
    // Guard whole-competition duplicates: Postgres treats NULL as distinct in a UNIQUE
    // constraint, so a null team_key is not deduped by the index — check explicitly first.
    const existing = await scopedDb.db
      .selectFrom("app.sports_follows")
      .select(["id", "competition_key", "team_key", "created_at"])
      .where("competition_key", "=", input.competitionKey)
      .where("team_key", teamKey === null ? "is" : "=", teamKey as never)
      .executeTakeFirst();
    if (existing) return toDto(existing);

    const row = await scopedDb.db
      .insertInto("app.sports_follows")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        competition_key: input.competitionKey,
        team_key: teamKey
      })
      .returning(["id", "competition_key", "team_key", "created_at"])
      .executeTakeFirstOrThrow();
    return toDto(row);
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
