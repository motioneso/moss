import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection
} from "kysely";

import { dataContextBrand, type DataContextDb, type MossDatabase } from "@moss/db";

import { AiRepository } from "../../packages/ai/src/repository.js";

/**
 * #2208 — the prune rule behind `deleteModelsForProviderExceptSentinel`, pinned at the SQL level
 * against a recording Kysely driver (no database needed):
 *   - the `"default"` sentinel is never deleted,
 *   - `manual` rows (added by hand through POST /api/ai/models) are never deleted,
 *   - only `discovered` rows absent from the vendor's new list go.
 * The integration test in tests/integration/ai-provider-model-refresh.test.ts proves the same
 * rule end to end against Postgres.
 */

interface Recorded {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function makeRecordingDb(): { scoped: DataContextDb; queries: Recorded[] } {
  const queries: Recorded[] = [];
  const connection = {
    executeQuery: async (compiled: CompiledQuery) => {
      queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      return { rows: [] };
    },
    streamQuery: () => {
      throw new Error("streaming is not used by this repository");
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
      createIntrospector: (kyselyDb) => new PostgresIntrospector(kyselyDb),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  return { scoped: { db, [dataContextBrand]: true } as unknown as DataContextDb, queries };
}

const PROVIDER_ID = "11111111-1111-1111-1111-111111111111";

describe("AiRepository.deleteModelsForProviderExceptSentinel (#2208 prune rule)", () => {
  const repository = new AiRepository();

  it("deletes only discovered rows, keeps the sentinel, and preserves the new list", async () => {
    const { scoped, queries } = makeRecordingDb();
    await repository.deleteModelsForProviderExceptSentinel(scoped, PROVIDER_ID, [
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001"
    ]);

    expect(queries).toHaveLength(1);
    const sql = queries[0]!.sql.toLowerCase();
    expect(sql).toContain('delete from "app"."ai_configured_models"');
    expect(sql).toContain('"provider_config_id" = $1');
    // The sentinel row is never touched.
    expect(sql).toContain('"provider_model_id" != $2');
    // Manual rows are never touched: the delete is scoped to discovery's own rows.
    expect(sql).toContain('"origin" = $3');
    // Rows still on the vendor's list survive.
    expect(sql).toContain('"provider_model_id" not in ($4, $5)');
    expect(queries[0]!.parameters).toEqual([
      PROVIDER_ID,
      "default",
      "discovered",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001"
    ]);
  });

  it("with an empty new list still restricts the delete to discovered, non-sentinel rows", async () => {
    const { scoped, queries } = makeRecordingDb();
    await repository.deleteModelsForProviderExceptSentinel(scoped, PROVIDER_ID, []);

    expect(queries).toHaveLength(1);
    const sql = queries[0]!.sql.toLowerCase();
    expect(sql).toContain('"provider_model_id" != $2');
    expect(sql).toContain('"origin" = $3');
    expect(sql).not.toContain("not in");
    expect(queries[0]!.parameters).toEqual([PROVIDER_ID, "default", "discovered"]);
  });

  it("refuses an unscoped database handle", async () => {
    const unscoped = { db: makeRecordingDb().scoped.db } as unknown as DataContextDb;
    await expect(
      repository.deleteModelsForProviderExceptSentinel(unscoped, PROVIDER_ID, [])
    ).rejects.toThrow("Repository access requires withDataContext");
  });
});
