import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";

/** One segment as sent by the Mac, owner taken from the credential (never the body). */
export interface NewBacktrackSegmentInput {
  readonly deviceId: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly appName: string;
  readonly bundleId: string;
  readonly windowTitle: string;
  readonly address: string | null;
  readonly body: string;
  /** SHA-256 of the redacted UTF-8 body, computed server-side (32 bytes). */
  readonly bodyHash: Buffer;
  /** The Mac's raw, unshifted clock reading — used only for the idempotency key (decision 10). */
  readonly clientStartedAt: Date;
}

export interface BacktrackSegment {
  readonly id: string;
  readonly ownerUserId: string;
  readonly deviceId: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly appName: string;
  readonly bundleId: string;
  readonly windowTitle: string;
  readonly address: string | null;
  readonly body: string;
  readonly bodyHash: Buffer;
  readonly indexedAt: Date | null;
  readonly createdAt: Date;
  readonly clientStartedAt: Date;
}

export interface BacktrackPreferences {
  readonly ownerUserId: string;
  readonly paused: boolean;
  readonly updatedAt: Date;
}

export interface BacktrackDeletionMarker {
  readonly id: string;
  readonly ownerUserId: string;
  /** Null means unbounded ("everything"). */
  readonly lower: Date | null;
  readonly upper: Date;
  readonly createdAt: Date;
}

export interface BacktrackStatusSummary {
  readonly macs: number;
  readonly days: number;
  readonly bytes: number;
  readonly oldest: Date | null;
  readonly lastReceivedAt: Date | null;
}

interface SegmentRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly device_id: string;
  readonly started_at: Date;
  readonly ended_at: Date;
  readonly app_name: string;
  readonly bundle_id: string;
  readonly window_title: string;
  readonly address: string | null;
  readonly body: string;
  readonly body_hash: Buffer;
  readonly indexed_at: Date | null;
  readonly created_at: Date;
  readonly client_started_at: Date;
}

function rowToSegment(row: SegmentRow): BacktrackSegment {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    deviceId: row.device_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    appName: row.app_name,
    bundleId: row.bundle_id,
    windowTitle: row.window_title,
    address: row.address,
    body: row.body,
    bodyHash: row.body_hash,
    indexedAt: row.indexed_at,
    createdAt: row.created_at,
    clientStartedAt: row.client_started_at
  };
}

/**
 * Data-access primitives for the backtrack module (#2638 plan §4.2). No route or job logic lives
 * here — the ingest route (Task B), the index/upkeep jobs and the user routes (Task C) call these.
 */
export class BacktrackRepository {
  /**
   * Decision 3: index, purge and user delete each take this lock before touching a row, so a
   * queued index job can never recreate an embedding a purge or delete just removed. Must be
   * called inside the same transaction (DataContextDb's scoped connection) as the work it guards —
   * `pg_advisory_xact_lock` releases automatically at COMMIT/ROLLBACK.
   */
  async lockOwner(scopedDb: DataContextDb, ownerUserId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended('backtrack:' || ${ownerUserId}::text, 0))
    `.execute(scopedDb.db);
  }

  /**
   * Insert a batch of segments for one owner, `ON CONFLICT DO NOTHING` on the idempotency key
   * (owner, device, body hash, the Mac's raw clock reading). Returns the ids of the rows actually
   * inserted; a duplicate in the batch produces no id and no error.
   */
  async insertSegments(
    scopedDb: DataContextDb,
    ownerUserId: string,
    segments: readonly NewBacktrackSegmentInput[]
  ): Promise<readonly string[]> {
    assertDataContextDb(scopedDb);
    if (segments.length === 0) return [];

    const rows = sql.join(
      segments.map(
        (segment) => sql`(
          ${ownerUserId}::uuid,
          ${segment.deviceId}::uuid,
          ${segment.startedAt},
          ${segment.endedAt},
          ${segment.appName},
          ${segment.bundleId},
          ${segment.windowTitle},
          ${segment.address},
          ${segment.body},
          ${segment.bodyHash},
          ${segment.clientStartedAt}
        )`
      )
    );

    const result = await sql<{ id: string }>`
      INSERT INTO app.backtrack_segments
        (owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title,
         address, body, body_hash, client_started_at)
      VALUES ${rows}
      ON CONFLICT (owner_user_id, device_id, body_hash, client_started_at) DO NOTHING
      RETURNING id
    `.execute(scopedDb.db);

    return result.rows.map((row) => row.id);
  }

  /** Full rows for a set of ids, scoped to one owner (RLS scopes it too; this is defense in depth). */
  async selectSegmentsByIds(
    scopedDb: DataContextDb,
    ownerUserId: string,
    ids: readonly string[]
  ): Promise<readonly BacktrackSegment[]> {
    assertDataContextDb(scopedDb);
    if (ids.length === 0) return [];

    const result = await sql<SegmentRow>`
      SELECT id, owner_user_id, device_id, started_at, ended_at, app_name, bundle_id,
             window_title, address, body, body_hash, indexed_at, created_at, client_started_at
      FROM app.backtrack_segments
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ANY(${[...ids]}::uuid[])
    `.execute(scopedDb.db);

    return result.rows.map(rowToSegment);
  }

  /**
   * Delete every segment of one owner whose `[started_at, ended_at]` overlaps `[from, to)`,
   * returning the deleted ids (the caller removes their memory chunks separately, by id, through
   * memory's public API — this module never touches `app.memory_chunks`). `from`/`to` both null
   * deletes everything for the owner (decision 7/10: "Everything" sends no range).
   */
  async deleteSegmentsInRange(
    scopedDb: DataContextDb,
    ownerUserId: string,
    range: { readonly from: Date | null; readonly to: Date | null }
  ): Promise<readonly string[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ id: string }>`
      DELETE FROM app.backtrack_segments
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND NOT (
          ended_at < COALESCE(${range.from}::timestamptz, '-infinity'::timestamptz)
          OR started_at >= COALESCE(${range.to}::timestamptz, 'infinity'::timestamptz)
        )
      RETURNING id
    `.execute(scopedDb.db);

    return result.rows.map((row) => row.id);
  }

  /**
   * Write a deletion marker (decision 10): upper bound is always the deletion instant `D`, or
   * `least(to, D)` when the person named an upper bound narrower than now; lower bound is `from`,
   * or unbounded (`-infinity`) for "Everything". Checked by the ingest route and by delete under
   * the same owner lock, so a retried or late upload can never undo a delete.
   */
  async insertDeletionMarker(
    scopedDb: DataContextDb,
    ownerUserId: string,
    from: Date | null,
    to: Date | null,
    deletedAt: Date = new Date()
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      INSERT INTO app.backtrack_deletions (owner_user_id, range)
      VALUES (
        ${ownerUserId}::uuid,
        tstzrange(
          ${from}::timestamptz,
          LEAST(COALESCE(${to}::timestamptz, ${deletedAt}::timestamptz), ${deletedAt}::timestamptz),
          '[)'
        )
      )
    `.execute(scopedDb.db);
  }

  /** Every deletion marker for one owner, oldest first. */
  async listDeletionMarkers(
    scopedDb: DataContextDb,
    ownerUserId: string
  ): Promise<readonly BacktrackDeletionMarker[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      id: string;
      owner_user_id: string;
      lower_bound: Date | null;
      upper_bound: Date;
      created_at: Date;
    }>`
      SELECT id, owner_user_id, lower(range) AS lower_bound, upper(range) AS upper_bound, created_at
      FROM app.backtrack_deletions
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY created_at ASC
    `.execute(scopedDb.db);

    return result.rows.map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
      lower: row.lower_bound,
      upper: row.upper_bound,
      createdAt: row.created_at
    }));
  }

  /** Delete markers older than `olderThan` for one owner (the hourly upkeep job, decision 10). */
  async deleteExpiredDeletionMarkers(
    scopedDb: DataContextDb,
    ownerUserId: string,
    olderThan: Date
  ): Promise<readonly string[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ id: string }>`
      DELETE FROM app.backtrack_deletions
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND created_at < ${olderThan}
      RETURNING id
    `.execute(scopedDb.db);

    return result.rows.map((row) => row.id);
  }

  /** The owner's pause row, or null when they have never set one (treated as not paused). */
  async getPreferences(
    scopedDb: DataContextDb,
    ownerUserId: string
  ): Promise<BacktrackPreferences | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ owner_user_id: string; paused: boolean; updated_at: Date }>`
      SELECT owner_user_id, paused, updated_at
      FROM app.backtrack_preferences
      WHERE owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);
    const row = result.rows[0];
    return row
      ? { ownerUserId: row.owner_user_id, paused: row.paused, updatedAt: row.updated_at }
      : null;
  }

  /** Upsert the owner's pause switch (decision 6: one switch, across every linked Mac). */
  async setPaused(
    scopedDb: DataContextDb,
    ownerUserId: string,
    paused: boolean
  ): Promise<BacktrackPreferences> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ owner_user_id: string; paused: boolean; updated_at: Date }>`
      INSERT INTO app.backtrack_preferences (owner_user_id, paused, updated_at)
      VALUES (${ownerUserId}::uuid, ${paused}, now())
      ON CONFLICT (owner_user_id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = now()
      RETURNING owner_user_id, paused, updated_at
    `.execute(scopedDb.db);
    const row = result.rows[0];
    if (!row) throw new Error("backtrack preferences upsert returned no row");
    return { ownerUserId: row.owner_user_id, paused: row.paused, updatedAt: row.updated_at };
  }

  /**
   * Aggregate status for the Moss Settings screen (§4.7's `GET /api/backtrack/status`): distinct
   * Macs seen in the last `recentDeviceWindowDays` days, distinct days with a segment, an
   * approximate stored-byte count, and the oldest/most recent rows.
   */
  async getStatusSummary(
    scopedDb: DataContextDb,
    ownerUserId: string,
    recentDeviceWindowDays = 30
  ): Promise<BacktrackStatusSummary> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      macs: string;
      days: string;
      bytes: string | null;
      oldest: Date | null;
      last_received_at: Date | null;
    }>`
      SELECT
        count(DISTINCT device_id) FILTER (
          WHERE started_at >= now() - (${recentDeviceWindowDays} || ' days')::interval
        ) AS macs,
        count(DISTINCT date_trunc('day', started_at)) AS days,
        coalesce(
          sum(
            octet_length(app_name) + octet_length(bundle_id) + octet_length(window_title)
            + coalesce(octet_length(address), 0) + octet_length(body)
          ),
          0
        ) AS bytes,
        min(started_at) AS oldest,
        max(created_at) AS last_received_at
      FROM app.backtrack_segments
      WHERE owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);

    const row = result.rows[0];
    return {
      macs: Number(row?.macs ?? 0),
      days: Number(row?.days ?? 0),
      bytes: Number(row?.bytes ?? 0),
      oldest: row?.oldest ?? null,
      lastReceivedAt: row?.last_received_at ?? null
    };
  }
}
