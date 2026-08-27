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

import {
  dataContextBrand,
  type DataContextDb,
  type EncryptedSecret,
  type MossDatabase
} from "@moss/db";

import { NewsCredentialRepository } from "../../packages/news/src/credential-repository.js";

/**
 * #2005 — NewsCredentialRepository against a recording Kysely driver.
 *
 * These are the SQL-shape and leak guarantees that can be pinned without a database:
 * every method refuses an unscoped handle, the ciphertext column never reaches a status
 * object, ownership comes from the RLS actor rather than a caller-supplied id, rotation
 * advances the generation, and revoke is written so a second call cannot raise. The
 * behaviour that only a real database can prove (FORCE RLS, cross-user isolation,
 * cascade deletes) is in tests/integration/news-credentials.test.ts.
 */

const ENVELOPE: EncryptedSecret = {
  version: 1,
  algorithm: "aes-256-gcm",
  keyId: "k1",
  iv: "aXY=",
  tag: "dGFn",
  ciphertext: "Y2lwaGVydGV4dC1tYXJrZXI="
};

const SOURCE_ID = "33333333-3333-3333-3333-333333333333";

interface Recorded {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** A Kysely whose driver records every compiled query and replays queued result rows. */
function makeRecordingDb(): {
  db: Kysely<MossDatabase>;
  scoped: DataContextDb;
  queries: Recorded[];
  queue: (rows: Record<string, unknown>[]) => void;
} {
  const queries: Recorded[] = [];
  const pending: Record<string, unknown>[][] = [];

  const connection = {
    executeQuery: async (compiled: CompiledQuery) => {
      queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      return { rows: pending.shift() ?? [] };
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

  return {
    db,
    scoped: { db, [dataContextBrand]: true } as unknown as DataContextDb,
    queries,
    queue: (rows) => pending.push(rows)
  };
}

/** Compiled SQL, lowercased, so an assertion does not depend on keyword casing. */
function compiledSql(queries: Recorded[], index = 0): string {
  return (queries[index]?.sql ?? "").toLowerCase();
}

function statusRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: SOURCE_ID,
    connection_id: "example-wire",
    status: "configured",
    last_validated_at: new Date("2026-08-27T09:00:00.000Z"),
    revoked_at: null,
    ...overrides
  };
}

describe("news credential repository (#2005)", () => {
  const repo = new NewsCredentialRepository();

  it("refuses an unscoped database handle on every method", async () => {
    // A handle that is not the branded DataContextDb has no actor setting, so RLS would
    // not apply. Each method must refuse it rather than run unscoped SQL.
    const unscoped = { db: makeRecordingDb().db } as unknown as DataContextDb;
    const message = "Repository access requires withDataContext";

    await expect(repo.readStatuses(unscoped)).rejects.toThrow(message);
    await expect(repo.readEnvelope(unscoped, SOURCE_ID)).rejects.toThrow(message);
    await expect(
      repo.insertCredential(unscoped, {
        sourceId: SOURCE_ID,
        connectionId: "example-wire",
        envelope: ENVELOPE
      })
    ).rejects.toThrow(message);
    await expect(repo.rotateCredential(unscoped, SOURCE_ID, ENVELOPE)).rejects.toThrow(message);
    await expect(repo.revokeCredential(unscoped, SOURCE_ID)).rejects.toThrow(message);
  });

  it("readStatuses returns metadata only, even when the row carries ciphertext", async () => {
    const { scoped, queue } = makeRecordingDb();
    // The driver hands back a row that DOES carry the envelope and the generation. A
    // build that spread the row into its result would leak both here.
    queue([
      statusRow({
        encrypted_secret: ENVELOPE,
        generation: "7",
        owner_user_id: "11111111-1111-1111-1111-111111111111",
        has_secret: true
      })
    ]);

    const rows = await repo.readStatuses(scoped);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "connectionId",
      "lastValidatedAt",
      "revokedAt",
      "sourceId",
      "status"
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("Y2lwaGVydGV4dC1tYXJrZXI=");
    expect(serialized).not.toContain("generation");
    expect(serialized).not.toContain("owner_user_id");
  });

  it("readStatuses asks the database for a derived flag, never the ciphertext column", async () => {
    const { scoped, queue, queries } = makeRecordingDb();
    queue([]);
    await repo.readStatuses(scoped);

    const compiled = compiledSql(queries);
    // The only mention of the ciphertext column is the "is there a usable key" test.
    // Selecting the column itself would pull the envelope into the route layer.
    expect(compiled).toContain("encrypted_secret is not null");
    expect(compiled.match(/encrypted_secret/g) ?? []).toHaveLength(1);
  });

  it("readEnvelope reads only a configured row and reports nothing when there is none", async () => {
    const { scoped, queue, queries } = makeRecordingDb();
    queue([{ encrypted_secret: ENVELOPE }]);
    await expect(repo.readEnvelope(scoped, SOURCE_ID)).resolves.toEqual(ENVELOPE);
    // A revoked row has a null envelope; the status filter keeps it out of the read path.
    expect(queries[0]?.parameters).toContain("configured");

    queue([]);
    await expect(repo.readEnvelope(scoped, SOURCE_ID)).resolves.toBeNull();

    queue([{ encrypted_secret: null }]);
    await expect(repo.readEnvelope(scoped, SOURCE_ID)).resolves.toBeNull();
  });

  it("insertCredential takes ownership from the actor setting, not from its caller", async () => {
    const { scoped, queue, queries } = makeRecordingDb();
    queue([statusRow()]);

    const created = await repo.insertCredential(scoped, {
      sourceId: SOURCE_ID,
      connectionId: "example-wire",
      envelope: ENVELOPE
    });

    expect(created.sourceId).toBe(SOURCE_ID);
    expect(created.status).toBe("configured");
    const compiled = compiledSql(queries);
    // Owner comes from the database's own view of who is acting. A build that accepted an
    // owner id as a parameter could be told to write a row for somebody else.
    expect(compiled).toContain("app.current_actor_user_id()");
    expect(compiled).toContain("'configured'");
    expect(queries[0]?.parameters).toEqual([SOURCE_ID, "example-wire", JSON.stringify(ENVELOPE)]);
  });

  it("insertCredential fails without repeating the key or the envelope", async () => {
    const { scoped, queue } = makeRecordingDb();
    queue([]);
    await expect(
      repo.insertCredential(scoped, {
        sourceId: SOURCE_ID,
        connectionId: "example-wire",
        envelope: ENVELOPE
      })
    ).rejects.toThrow(/returned no row/);

    const { scoped: second, queue: queueSecond } = makeRecordingDb();
    queueSecond([]);
    const error = await repo
      .insertCredential(second, {
        sourceId: SOURCE_ID,
        connectionId: "example-wire",
        envelope: ENVELOPE
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as Error);
    expect(error).not.toBeNull();
    expect(error?.message).not.toContain("ciphertext");
    expect(error?.message).not.toContain(ENVELOPE.ciphertext);
  });

  it("rotateCredential advances the generation and reports it as text", async () => {
    const { scoped, queue, queries } = makeRecordingDb();
    queue([statusRow({ generation: "2" })]);

    const rotated = await repo.rotateCredential(scoped, SOURCE_ID, ENVELOPE);

    expect(rotated?.generation).toBe("2");
    expect(Object.keys(rotated?.row ?? {})).not.toContain("generation");
    const compiled = compiledSql(queries);
    // Forgetting the bump would let a later slice serve a cached answer under a key the
    // user has already replaced.
    expect(compiled).toContain("generation = generation + 1");
    expect(compiled).toContain("status = 'configured'");
    expect(compiled).toContain("revoked_at = null");
  });

  it("rotateCredential reports nothing when no row matched", async () => {
    const { scoped, queue } = makeRecordingDb();
    queue([]);
    // No row matched means the source is unknown or row security hid somebody else's row.
    await expect(repo.rotateCredential(scoped, SOURCE_ID, ENVELOPE)).resolves.toBeNull();
  });

  it("revokeCredential scrubs the stored key and is written to survive a second call", async () => {
    const { scoped, queue, queries } = makeRecordingDb();
    const revokedAt = new Date("2026-08-27T10:00:00.000Z");
    queue([statusRow({ status: "revoked", revoked_at: revokedAt })]);

    const first = await repo.revokeCredential(scoped, SOURCE_ID);
    expect(first).toEqual({
      sourceId: SOURCE_ID,
      connectionId: "example-wire",
      status: "revoked",
      lastValidatedAt: new Date("2026-08-27T09:00:00.000Z"),
      revokedAt
    });

    const compiled = compiledSql(queries);
    expect(compiled).toContain("encrypted_secret = null");
    expect(compiled).toContain("status = 'revoked'");
    // Keeping the original revocation time means a repeat call reports the same state
    // instead of quietly moving the timestamp forward.
    expect(compiled).toContain("revoked_at = coalesce(revoked_at, now())");
    // No filter on the current status, so revoking an already-revoked row is a no-op
    // update rather than a miss that raises.
    expect(compiled).not.toContain("status = 'configured'");

    queue([statusRow({ status: "revoked", revoked_at: revokedAt })]);
    await expect(repo.revokeCredential(scoped, SOURCE_ID)).resolves.toEqual(first);
  });

  it("revokeCredential reports nothing when no row matched", async () => {
    const { scoped, queue } = makeRecordingDb();
    queue([]);
    await expect(repo.revokeCredential(scoped, SOURCE_ID)).resolves.toBeNull();
  });
});
