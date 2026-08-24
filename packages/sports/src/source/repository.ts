// #1572 Custom public news sources — persistence for app.sports_custom_sources,
// app.sports_source_assignments, app.sports_policy_verdicts (0190_sports_custom_sources.sql).
import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { NEWS_MAX_CUSTOM_SOURCES } from "@moss/news";
import type { SportsCustomSourceDto, SportsSourceAssignmentDto } from "@moss/shared";

import type { VerifiedSportsSourceCandidate } from "./discovery.js";

export class SportsSourceLimitError extends Error {
  constructor() {
    super(`A maximum of ${NEWS_MAX_CUSTOM_SOURCES} custom sources is allowed`);
    this.name = "SportsSourceLimitError";
  }
}

interface SportsCustomSourceRow {
  id: string;
  label: string;
  canonical_domain: string;
  homepage_url: string;
  feed_url: string | null;
  retrieval_method: "feed" | "scrape";
  enabled: boolean;
  health_state: "pending" | "healthy" | "failing" | "unsupported" | "auth_required" | "disabled";
  health_reason_code: string | null;
  health_message: string | null;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  recipe_status: "feed" | "ready" | "missing" | "drift";
  created_at: Date;
}

interface SportsSourceAssignmentRow {
  id: string;
  follow_id: string;
  target_url: string | null;
  preview_status: "pending" | "verified" | "recipe_missing";
  health_state: SportsCustomSourceRow["health_state"];
  health_reason_code: string | null;
  health_message: string | null;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  created_at: Date;
}

const SOURCE_COLUMNS = [
  "id",
  "label",
  "canonical_domain",
  "homepage_url",
  "feed_url",
  "retrieval_method",
  "enabled",
  "health_state",
  "health_reason_code",
  "health_message",
  "last_checked_at",
  "last_success_at",
  "recipe_status",
  "created_at"
] as const;

const ASSIGNMENT_COLUMNS = [
  "id",
  "follow_id",
  "target_url",
  "preview_status",
  "health_state",
  "health_reason_code",
  "health_message",
  "last_checked_at",
  "last_success_at",
  "created_at"
] as const;

function assignmentToDto(row: SportsSourceAssignmentRow): SportsSourceAssignmentDto {
  return {
    id: row.id,
    followId: row.follow_id,
    targetUrl: row.target_url,
    previewStatus: row.preview_status,
    healthState: row.health_state,
    healthReasonCode: row.health_reason_code,
    healthMessage: row.health_message,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString()
  };
}

function toDto(
  row: SportsCustomSourceRow,
  assignmentRows: readonly SportsSourceAssignmentRow[]
): SportsCustomSourceDto {
  const assignments = assignmentRows.map(assignmentToDto);
  return {
    id: row.id,
    label: row.label,
    canonicalDomain: row.canonical_domain,
    homepageUrl: row.homepage_url,
    feedUrl: row.feed_url,
    retrievalMethod: row.retrieval_method,
    enabled: row.enabled,
    healthState: row.health_state,
    healthReasonCode: row.health_reason_code,
    healthMessage: row.health_message,
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    lastSuccessAt: row.last_success_at ? row.last_success_at.toISOString() : null,
    recipeStatus: row.recipe_status,
    assignedFollowIds: assignments.map((assignment) => assignment.followId),
    assignments,
    createdAt: row.created_at.toISOString()
  };
}

export class SportsSourcesRepository {
  async list(scopedDb: DataContextDb): Promise<SportsCustomSourceDto[]> {
    assertDataContextDb(scopedDb);
    const [rows, assignments] = await Promise.all([
      scopedDb.db
        .selectFrom("app.sports_custom_sources")
        .select(SOURCE_COLUMNS)
        .orderBy("created_at", "desc")
        .orderBy("id")
        .execute(),
      scopedDb.db
        .selectFrom("app.sports_source_assignments")
        .select(["source_id", ...ASSIGNMENT_COLUMNS])
        .orderBy("created_at")
        .orderBy("id")
        .execute()
    ]);
    const bySource = new Map<string, SportsSourceAssignmentRow[]>();
    for (const assignment of assignments) {
      const list = bySource.get(assignment.source_id) ?? [];
      list.push(assignment);
      bySource.set(assignment.source_id, list);
    }
    return rows.map((row) => toDto(row, bySource.get(row.id) ?? []));
  }

  async create(
    scopedDb: DataContextDb,
    input: { candidate: VerifiedSportsSourceCandidate }
  ): Promise<SportsCustomSourceDto | { limitExceeded: true }> {
    assertDataContextDb(scopedDb);
    const { count } = await scopedDb.db
      .selectFrom("app.sports_custom_sources")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    if (Number(count) >= NEWS_MAX_CUSTOM_SOURCES) {
      return { limitExceeded: true };
    }
    const { candidate } = input;
    const confirmedAt = new Date();
    const row = await scopedDb.db
      .insertInto("app.sports_custom_sources")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        label: candidate.label,
        canonical_domain: candidate.canonicalDomain,
        homepage_url: candidate.homepageUrl,
        feed_url: candidate.feedUrl,
        retrieval_method: candidate.retrievalMethod,
        validation_fingerprint: candidate.validationFingerprint,
        validated_at: confirmedAt,
        recipe_json: candidate.recipe === null ? null : { ...candidate.recipe },
        recipe_schema_version: candidate.recipe?.version ?? null,
        recipe_fingerprint: candidate.recipeFingerprint,
        recipe_status: candidate.retrievalMethod === "feed" ? "feed" : "ready",
        confirmed_fetch_hosts: [...candidate.confirmedFetchHosts],
        authorization_confirmed_at: confirmedAt
      })
      .onConflict((oc) => oc.doNothing())
      .returning(SOURCE_COLUMNS)
      .executeTakeFirst();
    if (row) return toDto(row, []);

    const existing = await scopedDb.db
      .selectFrom("app.sports_custom_sources")
      .select(SOURCE_COLUMNS)
      .where("canonical_domain", "=", candidate.canonicalDomain)
      .executeTakeFirstOrThrow();
    return toDto(existing, []);
  }

  async remove(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.sports_custom_sources")
      .where("id", "=", id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Replaces the full assignment set for one source. Postgres foreign-key checks bypass RLS (a
   * FK reference does not fail on a row the caller's policies would hide from SELECT), so a
   * `followId` belonging to another owner would otherwise be silently accepted. Explicitly
   * re-select the caller's own visible follows and only insert the ones that intersect.
   */
  async setAssignments(
    scopedDb: DataContextDb,
    sourceId: string,
    followIds: readonly string[]
  ): Promise<SportsCustomSourceDto | null> {
    assertDataContextDb(scopedDb);
    const source = await scopedDb.db
      .selectFrom("app.sports_custom_sources")
      .select(SOURCE_COLUMNS)
      .where("id", "=", sourceId)
      .executeTakeFirst();
    if (!source) return null;

    const ownedFollows =
      followIds.length > 0
        ? await scopedDb.db
            .selectFrom("app.sports_follows")
            .select(["id"])
            .where("id", "in", followIds)
            .execute()
        : [];
    const ownedFollowIds = new Set(ownedFollows.map((row) => row.id));

    await scopedDb.db
      .deleteFrom("app.sports_source_assignments")
      .where("source_id", "=", sourceId)
      .execute();
    if (ownedFollowIds.size > 0) {
      await scopedDb.db
        .insertInto("app.sports_source_assignments")
        .values(
          [...ownedFollowIds].map((followId) => ({
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            source_id: sourceId,
            follow_id: followId
          }))
        )
        .execute();
    }
    const assignments = await scopedDb.db
      .selectFrom("app.sports_source_assignments")
      .select(ASSIGNMENT_COLUMNS)
      .where("source_id", "=", sourceId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return toDto(source, assignments);
  }

  async readPolicyVerdict(
    scopedDb: DataContextDb,
    canonicalDomain: string,
    fingerprint: string
  ): Promise<"approved" | "rejected" | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.sports_policy_verdicts")
      .select(["verdict"])
      .where("canonical_domain", "=", canonicalDomain)
      .where("fingerprint", "=", fingerprint)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
    return row?.verdict ?? null;
  }

  async upsertPolicyVerdict(
    scopedDb: DataContextDb,
    input: {
      canonicalDomain: string;
      fingerprint: string;
      verdict: "approved" | "rejected";
      ttlMs: number;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    const expiresAt = new Date(Date.now() + input.ttlMs);
    await scopedDb.db
      .insertInto("app.sports_policy_verdicts")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        canonical_domain: input.canonicalDomain,
        fingerprint: input.fingerprint,
        verdict: input.verdict,
        expires_at: expiresAt
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "canonical_domain"]).doUpdateSet({
          fingerprint: input.fingerprint,
          verdict: input.verdict,
          decided_at: sql`now()`,
          expires_at: expiresAt
        })
      )
      .execute();
  }
}
