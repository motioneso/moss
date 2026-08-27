// packages/news/src/credential-repository.ts
// #2005 — DataContext-only persistence for app.news_source_credentials
// (0200_news_source_credentials.sql). Every method asserts the branded DataContextDb, so
// all SQL runs under the actor's RLS setting: owner isolation is enforced by Postgres,
// not by a WHERE clause on the owner column.
//
// Deliberately its own file rather than an addition to personalization-repository.ts,
// which is already close to the file-size cap.
import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb, type EncryptedSecret } from "@moss/db";

/** Credential metadata. Carries no secret, no envelope, and no generation. */
export interface NewsCredentialStatusRow {
  readonly sourceId: string;
  readonly connectionId: string;
  readonly status: "configured" | "revoked";
  readonly lastValidatedAt: Date | null;
  readonly revokedAt: Date | null;
}

interface RawStatusRow {
  source_id: string;
  connection_id: string;
  status: "configured" | "revoked";
  last_validated_at: Date | null;
  revoked_at: Date | null;
}

function toStatusRow(row: RawStatusRow): NewsCredentialStatusRow {
  return {
    sourceId: row.source_id,
    connectionId: row.connection_id,
    status: row.status,
    lastValidatedAt: row.last_validated_at,
    revokedAt: row.revoked_at
  };
}

/** The subset of the repository the routes depend on, so tests can inject a fake. */
export interface NewsCredentialStore {
  readStatuses(scopedDb: DataContextDb): Promise<NewsCredentialStatusRow[]>;
  readEnvelope(scopedDb: DataContextDb, sourceId: string): Promise<EncryptedSecret | null>;
  insertCredential(
    scopedDb: DataContextDb,
    input: {
      readonly sourceId: string;
      readonly connectionId: string;
      readonly envelope: EncryptedSecret;
    }
  ): Promise<NewsCredentialStatusRow>;
  rotateCredential(
    scopedDb: DataContextDb,
    sourceId: string,
    envelope: EncryptedSecret
  ): Promise<{ readonly generation: string; readonly row: NewsCredentialStatusRow } | null>;
  revokeCredential(
    scopedDb: DataContextDb,
    sourceId: string
  ): Promise<NewsCredentialStatusRow | null>;
}

export class NewsCredentialRepository implements NewsCredentialStore {
  /**
   * Metadata for the actor's credentialed sources. Never selects encrypted_secret —
   * the "is there a usable key" question is answered by a derived boolean instead, the
   * same way listModuleCredentialMetadata does it.
   */
  async readStatuses(scopedDb: DataContextDb): Promise<NewsCredentialStatusRow[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.news_source_credentials")
      .select([
        "source_id",
        "connection_id",
        "status",
        "last_validated_at",
        "revoked_at",
        sql<boolean>`encrypted_secret IS NOT NULL AND revoked_at IS NULL`.as("has_secret")
      ])
      .orderBy("created_at")
      .execute();
    return rows.map((row) => toStatusRow(row as unknown as RawStatusRow));
  }

  /**
   * The single method that reads the ciphertext column. This slice has NO production
   * caller: #2007 (the outbound publisher request) is the consumer. Kept here so the
   * read path is defined in one auditable place rather than invented later.
   */
  async readEnvelope(scopedDb: DataContextDb, sourceId: string): Promise<EncryptedSecret | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.news_source_credentials")
      .select("encrypted_secret")
      .where("source_id", "=", sourceId)
      .where("status", "=", "configured")
      .executeTakeFirst();
    const envelope = row?.encrypted_secret ?? null;
    return envelope === null ? null : (envelope as unknown as EncryptedSecret);
  }

  /**
   * The read that the outbound publisher request (#2007) actually uses. It answers three
   * different questions in one round trip, because the runtime has to tell them apart before it
   * decides whether to fetch:
   *   - no row at all, or a configured row whose envelope has gone: the person has no key set up
   *   - a revoked row: the person had a key and took it away
   *   - a usable row: the envelope plus the generation number
   *
   * The generation comes back as text so it can be part of a cache key: rotating a key advances
   * it, which makes every answer fetched with the old key unreachable rather than merely stale.
   *
   * Deliberately on the class only, not on {@link NewsCredentialStore}: the routes from #2005
   * have no business reading key material, and their test fakes would stop compiling.
   */
  async readCredentialForUse(
    scopedDb: DataContextDb,
    sourceId: string
  ): Promise<
    | {
        readonly status: "configured";
        readonly envelope: EncryptedSecret;
        readonly generation: string;
      }
    | { readonly status: "revoked" }
    | null
  > {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      status: "configured" | "revoked";
      encrypted_secret: unknown;
      generation: string;
    }>`
      SELECT status, encrypted_secret, generation::text AS generation
        FROM app.news_source_credentials
       WHERE source_id = ${sourceId}
    `.execute(scopedDb.db);
    const row = result.rows[0];
    if (!row) return null;
    if (row.status === "revoked") return { status: "revoked" };
    // A configured row with no envelope is a broken row. Reported as "no key" so the person is
    // pointed at the action that fixes it — adding a key again — rather than at a puzzle.
    if (row.encrypted_secret === null || row.encrypted_secret === undefined) return null;
    return {
      status: "configured",
      envelope: row.encrypted_secret as EncryptedSecret,
      generation: row.generation
    };
  }

  async insertCredential(
    scopedDb: DataContextDb,
    input: {
      readonly sourceId: string;
      readonly connectionId: string;
      readonly envelope: EncryptedSecret;
    }
  ): Promise<NewsCredentialStatusRow> {
    assertDataContextDb(scopedDb);
    const result = await sql<RawStatusRow>`
      INSERT INTO app.news_source_credentials
        (owner_user_id, source_id, connection_id, encrypted_secret, status, last_validated_at)
      VALUES (app.current_actor_user_id(), ${input.sourceId}, ${input.connectionId},
              ${JSON.stringify(input.envelope)}::jsonb, 'configured', now())
      RETURNING source_id, connection_id, status, last_validated_at, revoked_at
    `.execute(scopedDb.db);
    const created = result.rows[0];
    if (!created) {
      // Says nothing about the key or the envelope.
      throw new Error("Storing the news publisher credential returned no row");
    }
    return toStatusRow(created);
  }

  /**
   * One UPDATE: new envelope, generation forward, revalidated now, back to configured.
   * Advancing the generation is what lets #2007 key a cache so a rotated-away key can
   * never serve a cached response. Returns null when no row matched (wrong source, or
   * another actor's row hidden by row security).
   */
  async rotateCredential(
    scopedDb: DataContextDb,
    sourceId: string,
    envelope: EncryptedSecret
  ): Promise<{ readonly generation: string; readonly row: NewsCredentialStatusRow } | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<RawStatusRow & { generation: string }>`
      UPDATE app.news_source_credentials
         SET encrypted_secret = ${JSON.stringify(envelope)}::jsonb,
             generation = generation + 1,
             status = 'configured',
             revoked_at = NULL,
             last_validated_at = now(),
             updated_at = now()
       WHERE source_id = ${sourceId}
      RETURNING source_id, connection_id, status, last_validated_at, revoked_at,
                generation::text AS generation
    `.execute(scopedDb.db);
    const row = result.rows[0];
    if (!row) return null;
    return { generation: row.generation, row: toStatusRow(row) };
  }

  /**
   * Scrubs the envelope and marks the row revoked. Written as an unconditional UPDATE so
   * calling it twice succeeds both times and reports the same state: the second call
   * rewrites an already-null envelope rather than raising. revoked_at is preserved on the
   * second call so the reported state does not drift.
   */
  async revokeCredential(
    scopedDb: DataContextDb,
    sourceId: string
  ): Promise<NewsCredentialStatusRow | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<RawStatusRow>`
      UPDATE app.news_source_credentials
         SET encrypted_secret = NULL,
             status = 'revoked',
             revoked_at = COALESCE(revoked_at, now()),
             updated_at = now()
       WHERE source_id = ${sourceId}
      RETURNING source_id, connection_id, status, last_validated_at, revoked_at
    `.execute(scopedDb.db);
    const row = result.rows[0];
    return row ? toStatusRow(row) : null;
  }
}
