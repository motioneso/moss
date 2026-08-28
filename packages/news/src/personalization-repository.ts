// packages/news/src/personalization-repository.ts
// #953 Task 3 — DataContext-only persistence for the four personalization tables
// (0159_news_personalization.sql). Every method asserts the branded DataContextDb, so all
// SQL runs under the actor's RLS GUC: owner isolation is enforced by Postgres, not by
// WHERE clauses here. Custom source/topic WRITES are deliberately absent — Slice 2 owns
// them behind its validation pipeline; Slice 1 only reads/exports what exists.
import { sql } from "kysely";

import {
  assertDataContextDb,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import type {
  NewsCustomSourceDto,
  NewsCustomTopicDto,
  NewsRefreshStateDto,
  NewsSourceExclusionDto
} from "@moss/shared";

import {
  assertSnapshotPayload,
  NEWS_MAX_CUSTOM_SOURCES,
  NEWS_MAX_CUSTOM_TOPICS
} from "./personalization-domain.js";

export { NEWS_MAX_CUSTOM_SOURCES, NEWS_MAX_CUSTOM_TOPICS } from "./personalization-domain.js";

/** Spec cap: at most 100 excluded domains per owner, enforced atomically in SQL. */
export const NEWS_MAX_SOURCE_EXCLUSIONS = 100;

/**
 * #2030 — the refresh history an owner who has never asked for a refresh has: none of it.
 * Kept as one constant so the no-row branch of readRefreshState cannot drift from the DTO.
 */
const EMPTY_REFRESH_HISTORY = {
  lastRequestedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureKind: null
} as const;

/**
 * #2030 — refresh status plus bounded freshness metadata for the current feed. Bounded is the
 * point: an age in seconds and an item count, never the feed itself.
 */
export interface NewsRefreshDiagnostics {
  readonly refresh: NewsRefreshStateDto;
  readonly requestedGeneration: number;
  readonly compiledGeneration: number;
  readonly snapshotCompiledAt: string | null;
  readonly snapshotExpiresAt: string | null;
  /** Null when there is no snapshot yet. */
  readonly snapshotAgeSeconds: number | null;
  /** 0 when there is no snapshot, or its payload holds no article array. */
  readonly itemCount: number;
}

/** Raw shape of the single diagnostics row. bigint columns arrive as strings from pg. */
interface RefreshDiagnosticsRow {
  state: "idle" | "queued" | "running" | "failed" | null;
  failure_kind: "fetch" | "ai" | "internal" | null;
  updated_at: Date | null;
  requested_generation: string | null;
  compiled_generation: string | null;
  last_requested_at: Date | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_failure_kind: "fetch" | "ai" | "internal" | null;
  snapshot_compiled_at: Date | null;
  snapshot_expires_at: Date | null;
  snapshot_age_seconds: string | null;
  item_count: number | null;
}

export type NewsPersonalizationLimitResource =
  | "custom_sources"
  | "custom_topics"
  | "source_exclusions";

/** Typed domain error so routes can map cap violations to a 4xx instead of a 500. */
export class NewsPersonalizationLimitError extends Error {
  constructor(
    readonly resource: NewsPersonalizationLimitResource,
    readonly limit: number
  ) {
    super(`news personalization limit reached: at most ${limit} ${resource} per user`);
    this.name = "NewsPersonalizationLimitError";
  }
}

export class NewsDuplicateSourceError extends Error {
  constructor() {
    super("news custom source already exists for this publisher");
    this.name = "NewsDuplicateSourceError";
  }
}

/** Module-private snapshot record; the payload never crosses the module's public API. */
export interface NewsSnapshotRecord {
  readonly compiledAt: Date;
  readonly expiresAt: Date;
  readonly payload: Record<string, unknown>;
}

export interface ReplaceSnapshotInput {
  readonly compiledAt: Date;
  readonly expiresAt: Date;
  readonly payload: unknown;
}

const EXCLUSION_COLUMNS = ["id", "canonical_domain", "created_at"] as const;

interface CustomSourceInput {
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | null;
  readonly retrievalMethod: "feed" | "scrape";
  readonly validationFingerprint: string;
}

interface CustomTopicInput {
  readonly label: string;
  readonly guidance: string | null;
  readonly validationFingerprint: string;
}

// #975 Slice 4 — module-internal revalidation views. These carry validation_fingerprint
// (the opaque provider/model marker) for drift comparison inside the worker, so they must
// never be mapped onto route DTOs; the shared contract deliberately has no fingerprint field.
export interface NewsSourceValidationState {
  readonly id: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | null;
  readonly retrievalMethod: "feed" | "scrape";
  readonly validationStatus: "approved" | "needs_revalidation" | "rejected";
  readonly validationFingerprint: string | null;
  readonly healthStatus:
    | "healthy"
    | "authentication_failed"
    | "temporarily_unavailable"
    | "unsupported"
    | "disabled";
}

export interface NewsTopicValidationState {
  readonly id: string;
  readonly label: string;
  readonly guidance: string | null;
  readonly validationStatus: "approved" | "needs_revalidation" | "rejected";
  readonly validationFingerprint: string | null;
}

export interface NewsValidationUpdateInput {
  readonly validationStatus: "approved" | "needs_revalidation" | "rejected";
  /** null = keep the stored fingerprint (the column is NOT NULL by schema). */
  readonly validationFingerprint: string | null;
}

export class NewsPersonalizationRepository {
  async listCustomSources(scopedDb: DataContextDb): Promise<NewsCustomSourceDto[]> {
    assertDataContextDb(scopedDb);
    // validation_fingerprint is intentionally never selected: the opaque revalidation
    // marker must not exist on the DTO at all (see the shared contract).
    const rows = await scopedDb.db
      .selectFrom("app.news_custom_sources")
      .select([
        "id",
        "label",
        "canonical_domain",
        "homepage_url",
        "feed_url",
        "retrieval_method",
        "validation_status",
        "health_status",
        "created_at"
      ])
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      canonicalDomain: row.canonical_domain,
      homepageUrl: row.homepage_url,
      feedUrl: row.feed_url,
      retrievalMethod: row.retrieval_method,
      validationStatus: row.validation_status,
      healthStatus: row.health_status,
      createdAt: row.created_at.toISOString()
    }));
  }

  async countCustomSources(scopedDb: DataContextDb): Promise<number> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.news_custom_sources")
      .select(({ fn }) => fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async createCustomSource(
    scopedDb: DataContextDb,
    input: CustomSourceInput
  ): Promise<NewsCustomSourceDto> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      id: string;
      label: string;
      canonical_domain: string;
      homepage_url: string;
      feed_url: string | null;
      retrieval_method: "feed" | "scrape";
      validation_status: "approved";
      health_status: "healthy";
      created_at: Date;
    }>`
      INSERT INTO app.news_custom_sources
        (owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
         validation_status, health_status, validation_fingerprint, validated_at)
      SELECT app.current_actor_user_id(), ${input.label}, ${input.canonicalDomain},
             ${input.homepageUrl}, ${input.feedUrl}, ${input.retrievalMethod},
             'approved', 'healthy', ${input.validationFingerprint}, now()
       WHERE (SELECT count(*) FROM app.news_custom_sources) < ${NEWS_MAX_CUSTOM_SOURCES}
      ON CONFLICT (owner_user_id, canonical_domain) DO NOTHING
      RETURNING id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
                validation_status, health_status, created_at
    `.execute(scopedDb.db);
    const created = result.rows[0];
    if (created) return toCustomSourceDto(created);
    const duplicate = await scopedDb.db
      .selectFrom("app.news_custom_sources")
      .select("id")
      .where("canonical_domain", "=", input.canonicalDomain)
      .executeTakeFirst();
    if (duplicate) throw new NewsDuplicateSourceError();
    throw new NewsPersonalizationLimitError("custom_sources", NEWS_MAX_CUSTOM_SOURCES);
  }

  async replaceCustomSource(
    scopedDb: DataContextDb,
    sourceId: string,
    input: CustomSourceInput
  ): Promise<NewsCustomSourceDto | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.news_custom_sources")
      .set({
        label: input.label,
        canonical_domain: input.canonicalDomain,
        homepage_url: input.homepageUrl,
        feed_url: input.feedUrl,
        retrieval_method: input.retrievalMethod,
        validation_status: "approved",
        health_status: "healthy",
        validation_fingerprint: input.validationFingerprint,
        validated_at: sql`now()`,
        updated_at: sql`now()`
      })
      .where("id", "=", sourceId)
      .returning([
        "id",
        "label",
        "canonical_domain",
        "homepage_url",
        "feed_url",
        "retrieval_method",
        "validation_status",
        "health_status",
        "created_at"
      ])
      .executeTakeFirst();
    return row ? toCustomSourceDto(row) : null;
  }

  async deleteCustomSource(scopedDb: DataContextDb, sourceId: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.news_custom_sources")
      .where("id", "=", sourceId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async updateSourceHealth(
    scopedDb: DataContextDb,
    sourceId: string,
    health:
      | "healthy"
      | "authentication_failed"
      | "temporarily_unavailable"
      | "unsupported"
      | "disabled"
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.news_custom_sources")
      .set({ health_status: health })
      .where("id", "=", sourceId)
      .execute();
  }

  // #975 Slice 4 — revalidation state reads/writes. These run under the app OR the worker
  // data context: migration 0161 grants the worker UPDATE on exactly
  // (validation_status, validation_fingerprint, validated_at, updated_at) with an
  // owner-scoped policy, so a cross-owner update matches 0 rows instead of erroring.
  async listSourceValidationStates(scopedDb: DataContextDb): Promise<NewsSourceValidationState[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.news_custom_sources")
      .select([
        "id",
        "label",
        "canonical_domain",
        "homepage_url",
        "feed_url",
        "retrieval_method",
        "validation_status",
        "validation_fingerprint",
        "health_status"
      ])
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      canonicalDomain: row.canonical_domain,
      homepageUrl: row.homepage_url,
      feedUrl: row.feed_url,
      retrievalMethod: row.retrieval_method,
      validationStatus: row.validation_status,
      validationFingerprint: row.validation_fingerprint,
      healthStatus: row.health_status
    }));
  }

  async listTopicValidationStates(scopedDb: DataContextDb): Promise<NewsTopicValidationState[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.news_custom_topics")
      .select(["id", "label", "guidance", "validation_status", "validation_fingerprint"])
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      guidance: row.guidance,
      validationStatus: row.validation_status,
      validationFingerprint: row.validation_fingerprint
    }));
  }

  async updateSourceValidation(
    scopedDb: DataContextDb,
    sourceId: string,
    input: NewsValidationUpdateInput
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.news_custom_sources")
      .set({
        validation_status: input.validationStatus,
        ...(input.validationFingerprint === null
          ? {}
          : { validation_fingerprint: input.validationFingerprint }),
        validated_at: sql`now()`,
        updated_at: sql`now()`
      })
      .where("id", "=", sourceId)
      .execute();
  }

  async updateTopicValidation(
    scopedDb: DataContextDb,
    topicId: string,
    input: NewsValidationUpdateInput
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.news_custom_topics")
      .set({
        validation_status: input.validationStatus,
        ...(input.validationFingerprint === null
          ? {}
          : { validation_fingerprint: input.validationFingerprint }),
        validated_at: sql`now()`,
        updated_at: sql`now()`
      })
      .where("id", "=", topicId)
      .execute();
  }

  async listCustomTopics(scopedDb: DataContextDb): Promise<NewsCustomTopicDto[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.news_custom_topics")
      .select(["id", "label", "guidance", "validation_status", "created_at"])
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      guidance: row.guidance,
      validationStatus: row.validation_status,
      createdAt: row.created_at.toISOString()
    }));
  }

  async countCustomTopics(scopedDb: DataContextDb): Promise<number> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.news_custom_topics")
      .select(({ fn }) => fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async createCustomTopic(
    scopedDb: DataContextDb,
    input: CustomTopicInput
  ): Promise<NewsCustomTopicDto> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      id: string;
      label: string;
      guidance: string | null;
      validation_status: "approved";
      created_at: Date;
    }>`
      INSERT INTO app.news_custom_topics
        (owner_user_id, label, guidance, validation_status, validation_fingerprint, validated_at)
      SELECT app.current_actor_user_id(), ${input.label}, ${input.guidance}, 'approved',
             ${input.validationFingerprint}, now()
       WHERE (SELECT count(*) FROM app.news_custom_topics) < ${NEWS_MAX_CUSTOM_TOPICS}
      RETURNING id, label, guidance, validation_status, created_at
    `.execute(scopedDb.db);
    const created = result.rows[0];
    if (created) return toCustomTopicDto(created);
    throw new NewsPersonalizationLimitError("custom_topics", NEWS_MAX_CUSTOM_TOPICS);
  }

  async updateCustomTopic(
    scopedDb: DataContextDb,
    topicId: string,
    input: {
      readonly label?: string;
      readonly guidance?: string | null;
      readonly validationFingerprint?: string;
    }
  ): Promise<NewsCustomTopicDto | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.news_custom_topics")
      .set({
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
        ...(input.validationFingerprint === undefined
          ? {}
          : {
              validation_fingerprint: input.validationFingerprint,
              validation_status: "approved" as const,
              validated_at: sql`now()`
            }),
        updated_at: sql`now()`
      })
      .where("id", "=", topicId)
      .returning(["id", "label", "guidance", "validation_status", "created_at"])
      .executeTakeFirst();
    return row ? toCustomTopicDto(row) : null;
  }

  async deleteCustomTopic(scopedDb: DataContextDb, topicId: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.news_custom_topics")
      .where("id", "=", topicId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async listExclusions(scopedDb: DataContextDb): Promise<NewsSourceExclusionDto[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.news_source_exclusions")
      .select([...EXCLUSION_COLUMNS])
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(toExclusionDto);
  }

  /**
   * Idempotent, cap-guarded create. The count guard lives INSIDE the insert statement
   * (RLS scopes it to the actor's rows), so cap enforcement is atomic — no
   * count-then-insert race can overshoot it. `canonicalDomain` must already be the
   * output of normalizePublisherDomain; the table CHECKs are defense-in-depth only.
   */
  async createExclusion(
    scopedDb: DataContextDb,
    canonicalDomain: string
  ): Promise<NewsSourceExclusionDto> {
    assertDataContextDb(scopedDb);
    const inserted = await scopedDb.db
      .insertInto("app.news_source_exclusions")
      .columns(["owner_user_id", "canonical_domain"])
      .expression((eb) =>
        eb
          .selectFrom(sql`(SELECT 1)`.as("one"))
          .select([
            sql<string>`app.current_actor_user_id()`.as("owner_user_id"),
            sql<string>`${canonicalDomain}`.as("canonical_domain")
          ])
          .where(
            sql<boolean>`(SELECT count(*) FROM app.news_source_exclusions) < ${sql.lit(
              NEWS_MAX_SOURCE_EXCLUSIONS
            )}`
          )
      )
      .onConflict((oc) => oc.columns(["owner_user_id", "canonical_domain"]).doNothing())
      .returning([...EXCLUSION_COLUMNS])
      .executeTakeFirst();
    if (inserted) return toExclusionDto(inserted);

    // No row back means duplicate (conflict) or cap reached — the duplicate case must
    // stay idempotent even when the owner is at the cap, so check for it first.
    const existing = await scopedDb.db
      .selectFrom("app.news_source_exclusions")
      .select([...EXCLUSION_COLUMNS])
      .where("canonical_domain", "=", canonicalDomain)
      .executeTakeFirst();
    if (existing) return toExclusionDto(existing);

    throw new NewsPersonalizationLimitError("source_exclusions", NEWS_MAX_SOURCE_EXCLUSIONS);
  }

  async removeExclusion(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.news_source_exclusions")
      .where("id", "=", id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  async readRefreshState(scopedDb: DataContextDb): Promise<NewsRefreshStateDto> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.news_refresh_state")
      .select([
        "state",
        "failure_kind",
        "updated_at",
        "last_requested_at",
        "last_attempt_at",
        "last_success_at",
        "last_failure_at",
        "last_failure_kind"
      ])
      .executeTakeFirst();
    if (!row) return { state: "idle", updatedAt: null, ...EMPTY_REFRESH_HISTORY };
    return {
      state: row.state,
      updatedAt: row.updated_at.toISOString(),
      ...(row.failure_kind === null ? {} : { failureKind: row.failure_kind }),
      lastRequestedAt: row.last_requested_at?.toISOString() ?? null,
      lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
      lastSuccessAt: row.last_success_at?.toISOString() ?? null,
      lastFailureAt: row.last_failure_at?.toISOString() ?? null,
      lastFailureKind: row.last_failure_kind
    };
  }

  /**
   * #2030 — one owner-scoped read that answers "when did this last run, did it work, and if not
   * what kind of failure was it", together with how stale the current feed is and how big it is.
   *
   * Deliberately never selects `payload`: the item count is computed inside Postgres so article
   * text never leaves the database. No owner filter is needed — row-level security already
   * restricts both tables to the acting user's single row, the same way every other method here
   * relies on it. The joins hang off a one-row select rather than off the refresh-state table so
   * the read still works with no refresh row, no snapshot, either, or both.
   */
  async readRefreshDiagnostics(scopedDb: DataContextDb): Promise<NewsRefreshDiagnostics> {
    assertDataContextDb(scopedDb);
    const result = await sql<RefreshDiagnosticsRow>`
      SELECT s.state, s.failure_kind, s.updated_at,
             s.requested_generation, s.compiled_generation,
             s.last_requested_at, s.last_attempt_at, s.last_success_at,
             s.last_failure_at, s.last_failure_kind,
             snap.compiled_at AS snapshot_compiled_at,
             snap.expires_at  AS snapshot_expires_at,
             EXTRACT(EPOCH FROM (now() - snap.compiled_at))::bigint AS snapshot_age_seconds,
             CASE WHEN jsonb_typeof(snap.payload -> 'articles') = 'array'
                  THEN jsonb_array_length(snap.payload -> 'articles') ELSE 0 END AS item_count
        FROM (SELECT 1) AS one
        LEFT JOIN app.news_refresh_state s ON true
        LEFT JOIN app.news_compilation_snapshots snap ON true
    `.execute(scopedDb.db);
    const row = result.rows[0];
    const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
    return {
      refresh: {
        state: row?.state ?? "idle",
        updatedAt: iso(row?.updated_at),
        ...(row?.failure_kind == null ? {} : { failureKind: row.failure_kind }),
        lastRequestedAt: iso(row?.last_requested_at),
        lastAttemptAt: iso(row?.last_attempt_at),
        lastSuccessAt: iso(row?.last_success_at),
        lastFailureAt: iso(row?.last_failure_at),
        lastFailureKind: row?.last_failure_kind ?? null
      },
      requestedGeneration: Number(row?.requested_generation ?? 0),
      compiledGeneration: Number(row?.compiled_generation ?? 0),
      snapshotCompiledAt: iso(row?.snapshot_compiled_at),
      snapshotExpiresAt: iso(row?.snapshot_expires_at),
      snapshotAgeSeconds:
        row?.snapshot_age_seconds == null ? null : Number(row.snapshot_age_seconds),
      itemCount: Number(row?.item_count ?? 0)
    };
  }

  async bumpRefreshRequest(scopedDb: DataContextDb): Promise<number> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ requested_generation: string }>`
      INSERT INTO app.news_refresh_state
        (owner_user_id, state, requested_generation, updated_at, last_requested_at)
      VALUES (app.current_actor_user_id(), 'queued', 1, now(), now())
      ON CONFLICT (owner_user_id) DO UPDATE
        SET requested_generation = app.news_refresh_state.requested_generation + 1,
            state = CASE WHEN app.news_refresh_state.state = 'running'
                         THEN 'running' ELSE 'queued' END,
            failure_kind = NULL,
            updated_at = now(),
            -- History (#2030). failure_kind above is live status and is cleared here; the
            -- last_failure_* columns are deliberately left alone.
            last_requested_at = now()
      RETURNING requested_generation
    `.execute(scopedDb.db);
    return Number(result.rows[0]!.requested_generation);
  }

  async beginRefreshRun(scopedDb: DataContextDb): Promise<number> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ requested_generation: string }>`
      INSERT INTO app.news_refresh_state (owner_user_id, state, updated_at, last_attempt_at)
      VALUES (app.current_actor_user_id(), 'running', now(), now())
      ON CONFLICT (owner_user_id) DO UPDATE
        SET state = 'running', failure_kind = NULL, updated_at = now(),
            -- History (#2030). A superseded run re-enters here, and that is a new attempt.
            last_attempt_at = now()
      RETURNING requested_generation
    `.execute(scopedDb.db);
    return Number(result.rows[0]!.requested_generation);
  }

  async publishSnapshotIfCurrent(
    scopedDb: DataContextDb,
    generation: number,
    input: ReplaceSnapshotInput
  ): Promise<boolean> {
    assertSnapshotPayload(input.payload);
    assertDataContextDb(scopedDb);
    const result = await sql<{ published: boolean }>`
      WITH cas AS (
        UPDATE app.news_refresh_state
           SET compiled_generation = ${generation}, state = 'idle', failure_kind = NULL,
               updated_at = now(),
               -- History (#2030). This clears the LIVE failure_kind but must never touch
               -- last_failure_at / last_failure_kind, or a past failure becomes unknowable.
               last_success_at = now()
         WHERE owner_user_id = app.current_actor_user_id()
           AND requested_generation = ${generation}
        RETURNING owner_user_id
      ), published AS (
        INSERT INTO app.news_compilation_snapshots
          (owner_user_id, compiled_at, expires_at, payload)
        SELECT owner_user_id, ${input.compiledAt}, ${input.expiresAt},
               ${JSON.stringify(input.payload)}::jsonb
          FROM cas
        ON CONFLICT (owner_user_id) DO UPDATE
          SET compiled_at = excluded.compiled_at,
              expires_at = excluded.expires_at,
              payload = excluded.payload,
              updated_at = now()
        RETURNING 1
      )
      SELECT EXISTS(SELECT 1 FROM published) AS published
    `.execute(scopedDb.db);
    return result.rows[0]?.published ?? false;
  }

  async failRefreshRunIfCurrent(
    dataContext: DataContextRunner,
    accessContext: AccessContext,
    generation: number,
    failureKind: "fetch" | "ai" | "internal"
  ): Promise<boolean> {
    return dataContext.withDataContext(accessContext, async (freshDb) => {
      assertDataContextDb(freshDb);
      const result = await sql<{ failed: boolean }>`
        WITH changed AS (
          UPDATE app.news_refresh_state
             SET state = 'failed', failure_kind = ${failureKind}, updated_at = now(),
                 -- History (#2030). Runs as the worker role in a fresh data context (#1590);
                 -- the 0160 grants and policies are table-level, so these columns are writable
                 -- here without a new grant.
                 last_failure_at = now(), last_failure_kind = ${failureKind}
           WHERE owner_user_id = app.current_actor_user_id()
             AND requested_generation = ${generation}
          RETURNING 1
        )
        SELECT EXISTS(SELECT 1 FROM changed) AS failed
      `.execute(freshDb.db);
      return result.rows[0]?.failed ?? false;
    });
  }

  async pruneSnapshotDomain(scopedDb: DataContextDb, canonicalDomain: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.news_compilation_snapshots
         SET payload = jsonb_set(
               payload,
               '{articles}',
               COALESCE(
                 (SELECT jsonb_agg(article)
                    FROM jsonb_array_elements(payload->'articles') AS article
                   WHERE article->>'canonicalDomain' <> ${canonicalDomain}
                     AND article->>'canonicalDomain' NOT LIKE ${`%.${canonicalDomain}`}),
                 '[]'::jsonb
               )
             ),
             updated_at = now()
       WHERE owner_user_id = app.current_actor_user_id()
    `.execute(scopedDb.db);
  }

  async readPolicyVerdict(
    scopedDb: DataContextDb,
    canonicalDomain: string,
    fingerprint: string
  ): Promise<"approved" | "rejected" | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.news_policy_verdicts")
      .select("verdict")
      .where("canonical_domain", "=", canonicalDomain)
      .where("fingerprint", "=", fingerprint)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    return row?.verdict ?? null;
  }

  async upsertPolicyVerdict(
    scopedDb: DataContextDb,
    input: {
      readonly canonicalDomain: string;
      readonly fingerprint: string;
      readonly verdict: "approved" | "rejected";
      readonly ttlMs: number;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      INSERT INTO app.news_policy_verdicts
        (owner_user_id, canonical_domain, fingerprint, verdict, decided_at, expires_at)
      VALUES (app.current_actor_user_id(), ${input.canonicalDomain}, ${input.fingerprint},
              ${input.verdict}, now(), now() + ${input.ttlMs} * interval '1 millisecond')
      ON CONFLICT (owner_user_id, canonical_domain) DO UPDATE
        SET fingerprint = excluded.fingerprint,
            verdict = excluded.verdict,
            decided_at = excluded.decided_at,
            expires_at = excluded.expires_at
    `.execute(scopedDb.db);
  }

  async readLatestSnapshot(scopedDb: DataContextDb): Promise<NewsSnapshotRecord | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.news_compilation_snapshots")
      .select(["compiled_at", "expires_at", "payload"])
      .executeTakeFirst();
    if (!row) return null;
    return { compiledAt: row.compiled_at, expiresAt: row.expires_at, payload: row.payload };
  }

  /**
   * Atomic per-owner replace (single upsert on the owner_user_id primary key). The
   * payload guard runs BEFORE any SQL so an over-cap or non-JSON payload can never
   * clobber the stored snapshot.
   */
  async replaceLatestSnapshot(scopedDb: DataContextDb, input: ReplaceSnapshotInput): Promise<void> {
    assertSnapshotPayload(input.payload);
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.news_compilation_snapshots")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        compiled_at: input.compiledAt,
        expires_at: input.expiresAt,
        payload: sql`${JSON.stringify(input.payload)}::jsonb`
      })
      .onConflict((oc) =>
        oc.column("owner_user_id").doUpdateSet({
          compiled_at: (eb) => eb.ref("excluded.compiled_at"),
          expires_at: (eb) => eb.ref("excluded.expires_at"),
          payload: (eb) => eb.ref("excluded.payload"),
          updated_at: sql`now()`
        })
      )
      .execute();
  }
}

function toCustomSourceDto(row: {
  id: string;
  label: string;
  canonical_domain: string;
  homepage_url: string;
  feed_url: string | null;
  retrieval_method: "feed" | "scrape";
  validation_status: "approved" | "needs_revalidation" | "rejected";
  health_status:
    | "healthy"
    | "authentication_failed"
    | "temporarily_unavailable"
    | "unsupported"
    | "disabled";
  created_at: Date;
}): NewsCustomSourceDto {
  return {
    id: row.id,
    label: row.label,
    canonicalDomain: row.canonical_domain,
    homepageUrl: row.homepage_url,
    feedUrl: row.feed_url,
    retrievalMethod: row.retrieval_method,
    validationStatus: row.validation_status,
    healthStatus: row.health_status,
    createdAt: row.created_at.toISOString()
  };
}

function toCustomTopicDto(row: {
  id: string;
  label: string;
  guidance: string | null;
  validation_status: "approved" | "needs_revalidation" | "rejected";
  created_at: Date;
}): NewsCustomTopicDto {
  return {
    id: row.id,
    label: row.label,
    guidance: row.guidance,
    validationStatus: row.validation_status,
    createdAt: row.created_at.toISOString()
  };
}

function toExclusionDto(row: {
  id: string;
  canonical_domain: string;
  created_at: Date;
}): NewsSourceExclusionDto {
  return {
    id: row.id,
    canonicalDomain: row.canonical_domain,
    createdAt: row.created_at.toISOString()
  };
}
