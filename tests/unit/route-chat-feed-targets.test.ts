import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection
} from "kysely";
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb, type MossDatabase } from "@moss/db";

import { sportsFollowTarget, sportsSourceTarget } from "../../packages/sports/src/chat-targets.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** Compiles real PostgreSQL queries without opening a connection or simulating RLS. */
function recordingDb(rows: Record<string, unknown>[] = []) {
  const queries: CompiledQuery[] = [];
  const connection = {
    executeQuery: async (query: CompiledQuery) => {
      queries.push(query);
      return { rows };
    },
    streamQuery: () => {
      throw new Error("streaming is not used by target resolvers");
    }
  } as unknown as DatabaseConnection;
  class RecordingDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return connection;
    }
  }
  const db = new Kysely<MossDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (value) => new PostgresIntrospector(value),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  return { scoped: { db, [dataContextBrand]: true } as unknown as DataContextDb, queries };
}

describe("Sports chat destructive targets", () => {
  it.each([
    ["follow", sportsFollowTarget],
    ["source", sportsSourceTarget]
  ] as const)("refuses an unscoped %s target read", async (_name, target) => {
    await expect(target({}, { id: ID })).rejects.toThrow("requires withDataContext");
  });

  it.each([
    ["follow", sportsFollowTarget],
    ["source", sportsSourceTarget]
  ] as const)("does not query a missing or malformed %s id", async (_name, target) => {
    const { scoped, queries } = recordingDb();
    expect(await target(scoped, {})).toBeNull();
    expect(await target(scoped, { id: "not-a-uuid" })).toBeNull();
    expect(queries).toEqual([]);
  });

  it.each([
    ["follow", sportsFollowTarget, "sports_follows"],
    ["source", sportsSourceTarget, "sports_custom_sources"]
  ] as const)(
    "reads only an actor-owned %s row, returning null when absent",
    async (_name, target, table) => {
      const { scoped, queries } = recordingDb();
      expect(await target(scoped, { id: ID })).toBeNull();
      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toContain(`from "app"."${table}"`);
      expect(queries[0]?.sql).toContain('"id" = $1');
      expect(queries[0]?.sql).toContain('"owner_user_id" = app.current_actor_user_id()');
      expect(queries[0]?.parameters).toEqual([ID]);
    }
  );

  it("names a saved source from only its stored label and domain", async () => {
    const { scoped, queries } = recordingDb([
      { label: "Local sports", canonical_domain: "example.com" }
    ]);
    expect(await sportsSourceTarget(scoped, { id: ID, label: "Model's false label" })).toBe(
      "Local sports (example.com)"
    );
    expect(queries[0]?.sql).toMatch(/^select "label", "canonical_domain" from/);
  });

  it("uses the saved permanent team id to distinguish equal provider abbreviations", async () => {
    const first = recordingDb([{ competition_key: "nfl", team_key: "SAME", source_team_id: "1" }]);
    const second = recordingDb([{ competition_key: "nfl", team_key: "SAME", source_team_id: "2" }]);
    const a = await sportsFollowTarget(first.scoped, { id: ID });
    const b = await sportsFollowTarget(second.scoped, { id: ID });
    expect(a).toBe("SAME (NFL; team 1)");
    expect(b).toBe("SAME (NFL; team 2)");
    expect(a).not.toBe(b);
    expect(first.queries[0]?.sql).toMatch(
      /^select "competition_key", "team_key", "source_team_id" from/
    );
  });

  it("labels whole competitions and unresolved saved teams without any provider lookup", async () => {
    const competition = recordingDb([
      { competition_key: "nfl", team_key: null, source_team_id: null }
    ]);
    expect(await sportsFollowTarget(competition.scoped, { id: ID })).toBe("NFL");
    const legacy = recordingDb([
      { competition_key: "retired-league", team_key: "Legacy", source_team_id: null }
    ]);
    expect(await sportsFollowTarget(legacy.scoped, { id: ID })).toBe("Legacy (retired-league)");
  });
});
