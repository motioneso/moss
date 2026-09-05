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

export interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A data-context database that compiles every Kysely query to SQL and records it instead of
 * talking to Postgres. Tests pin the exact statement and parameters a repository method runs.
 * By default the fake connection returns no rows; pass `rows` when the method under test maps a
 * returned row (every query in the test gets the same rows back).
 */
export function makeRecordingDb(options: { rows?: readonly Record<string, unknown>[] } = {}): {
  scoped: DataContextDb;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const rows = options.rows ?? [];
  const connection = {
    executeQuery: async (compiled: CompiledQuery) => {
      queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      return { rows: [...rows], numAffectedRows: BigInt(rows.length) };
    },
    streamQuery: () => {
      throw new Error("streaming is not used by repositories under test");
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
