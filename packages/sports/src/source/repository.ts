// #1572 Custom public news sources — persistence for app.sports_custom_sources,
// app.sports_source_assignments, app.sports_policy_verdicts (0190_sports_custom_sources.sql).
import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { NEWS_MAX_CUSTOM_SOURCES } from "@moss/news";
import type {
  SportsCustomSourceDto,
  SportsSourceAssignmentDto,
  SportsSourceHealthState
} from "@moss/shared";

import type { VerifiedSportsSourceCandidate, VerifiedSportsSourceTarget } from "./discovery.js";

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

export interface SportsSourceBaseline {
  readonly source: SportsCustomSourceDto;
  readonly validationFingerprint: string;
  readonly recipeJson: Readonly<Record<string, unknown>> | null;
  readonly recipeFingerprint: string | null;
  readonly confirmedFetchHosts: readonly string[];
  readonly updatedAt: string;
  readonly assignments: readonly {
    readonly id: string;
    readonly followId: string;
    readonly targetUrl: string | null;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly previewStatus: SportsSourceAssignmentDto["previewStatus"];
  }[];
}

export interface SportsRuntimeSource {
  readonly id: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly feedUrl: string | null;
  readonly retrievalMethod: "feed" | "scrape";
  readonly enabled: boolean;
  readonly runtimeFingerprint: string;
  readonly recipeJson: Readonly<Record<string, unknown>> | null;
  readonly confirmedFetchHosts: readonly string[];
  readonly assignments: readonly {
    readonly id: string;
    readonly followId: string;
    readonly competitionKey: string;
    readonly teamKey: string | null;
    readonly targetUrl: string | null;
    readonly targetParameters: Readonly<Record<string, unknown>>;
    readonly previewStatus: SportsSourceAssignmentDto["previewStatus"];
  }[];
}

export interface SportsRuntimeTargetResult {
  readonly sourceId: string;
  readonly assignmentId: string;
  readonly runtimeFingerprint: string;
  readonly targetUrl: string | null;
  readonly targetParameters: Readonly<Record<string, unknown>>;
  readonly healthState: SportsSourceHealthState;
  readonly healthReasonCode: string | null;
  readonly healthMessage: string | null;
  /** Null when the target was not fetched (for example, request-budget exhaustion). */
  readonly checkedAt: Date | null;
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
  async lockOwnerAssignments(scopedDb: DataContextDb): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`SELECT pg_advisory_xact_lock(
      hashtext('sports:source-assignments:' || app.current_actor_user_id())
    )`.execute(scopedDb.db);
  }

  async countAssignments(scopedDb: DataContextDb): Promise<number> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.sports_source_assignments")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

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

  async listRuntimeSources(
    scopedDb: DataContextDb,
    sourceId?: string
  ): Promise<SportsRuntimeSource[]> {
    assertDataContextDb(scopedDb);
    let sourceQuery = scopedDb.db
      .selectFrom("app.sports_custom_sources")
      .select([
        "id",
        "label",
        "canonical_domain",
        "feed_url",
        "retrieval_method",
        "enabled",
        "validation_fingerprint",
        "recipe_fingerprint",
        "recipe_json",
        "confirmed_fetch_hosts"
      ]);
    sourceQuery = sourceId
      ? sourceQuery.where("id", "=", sourceId)
      : sourceQuery.where("enabled", "=", true);
    const sources = await sourceQuery.orderBy("created_at").orderBy("id").execute();
    if (sources.length === 0) return [];

    const assignments = await scopedDb.db
      .selectFrom("app.sports_source_assignments as assignment")
      .innerJoin("app.sports_follows as follow", "follow.id", "assignment.follow_id")
      .select([
        "assignment.id",
        "assignment.source_id",
        "assignment.follow_id",
        "assignment.target_url",
        "assignment.target_parameters",
        "assignment.preview_status",
        "follow.competition_key",
        "follow.team_key"
      ])
      .where(
        "assignment.source_id",
        "in",
        sources.map((source) => source.id)
      )
      .orderBy("assignment.created_at")
      .orderBy("assignment.id")
      .execute();
    const assignmentsBySource = new Map<string, typeof assignments>();
    for (const assignment of assignments) {
      const rows = assignmentsBySource.get(assignment.source_id) ?? [];
      rows.push(assignment);
      assignmentsBySource.set(assignment.source_id, rows);
    }
    return sources.map((source) => ({
      id: source.id,
      label: source.label,
      canonicalDomain: source.canonical_domain,
      feedUrl: source.feed_url,
      retrievalMethod: source.retrieval_method,
      enabled: source.enabled,
      runtimeFingerprint: source.recipe_fingerprint ?? source.validation_fingerprint,
      recipeJson: source.recipe_json,
      confirmedFetchHosts: source.confirmed_fetch_hosts,
      assignments: (assignmentsBySource.get(source.id) ?? []).map((assignment) => ({
        id: assignment.id,
        followId: assignment.follow_id,
        competitionKey: assignment.competition_key,
        teamKey: assignment.team_key,
        targetUrl: assignment.target_url,
        targetParameters: assignment.target_parameters,
        previewStatus: assignment.preview_status
      }))
    }));
  }

  async persistRuntimeResults(
    scopedDb: DataContextDb,
    results: readonly SportsRuntimeTargetResult[]
  ): Promise<number> {
    assertDataContextDb(scopedDb);
    const bySource = new Map<string, SportsRuntimeTargetResult[]>();
    for (const result of results) {
      const rows = bySource.get(result.sourceId) ?? [];
      rows.push(result);
      bySource.set(result.sourceId, rows);
    }

    let accepted = 0;
    for (const [sourceId, sourceResults] of bySource) {
      const source = await scopedDb.db
        .selectFrom("app.sports_custom_sources")
        .select([
          "enabled",
          "retrieval_method",
          "validation_fingerprint",
          "recipe_fingerprint",
          "recipe_status"
        ])
        .where("id", "=", sourceId)
        .forUpdate()
        .executeTakeFirst();
      if (!source) continue;
      const runtimeFingerprint = source.recipe_fingerprint ?? source.validation_fingerprint;
      const currentResults = sourceResults.filter(
        (result) => result.runtimeFingerprint === runtimeFingerprint
      );
      let sourceAccepted = 0;
      for (const result of currentResults) {
        const update = await scopedDb.db
          .updateTable("app.sports_source_assignments")
          .set({
            health_state: result.healthState,
            health_reason_code: result.healthReasonCode,
            health_message: result.healthMessage,
            ...(result.checkedAt ? { last_checked_at: result.checkedAt } : {}),
            ...(result.healthState === "healthy" && result.checkedAt
              ? { last_success_at: result.checkedAt }
              : {})
          })
          .where("id", "=", result.assignmentId)
          .where("source_id", "=", sourceId)
          .where(sql<boolean>`target_url IS NOT DISTINCT FROM ${result.targetUrl}`)
          .where(
            sql<boolean>`target_parameters = ${JSON.stringify(result.targetParameters)}::jsonb`
          )
          .executeTakeFirst();
        if ((update.numUpdatedRows ?? 0n) === 0n) continue;
        sourceAccepted += 1;
      }
      if (sourceAccepted === 0) continue;

      const assignments = await scopedDb.db
        .selectFrom("app.sports_source_assignments")
        .select(ASSIGNMENT_COLUMNS)
        .where("source_id", "=", sourceId)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      if (assignments.length === 0) continue;
      const aggregate = aggregateAssignmentHealth(source.enabled, assignments);
      const recipeStatus =
        source.retrieval_method === "feed"
          ? "feed"
          : assignments.some((assignment) => assignment.health_reason_code === "recipe_drift")
            ? "drift"
            : source.recipe_status === "missing"
              ? "missing"
              : "ready";
      await scopedDb.db
        .updateTable("app.sports_custom_sources")
        .set({
          health_state: aggregate.state,
          health_reason_code: aggregate.reason,
          health_message: aggregate.message,
          last_checked_at: newest(assignments.map((assignment) => assignment.last_checked_at)),
          last_success_at: newest(assignments.map((assignment) => assignment.last_success_at)),
          recipe_status: recipeStatus
        })
        .where("id", "=", sourceId)
        .execute();
      accepted += sourceAccepted;
    }
    return accepted;
  }

  async getBaseline(
    scopedDb: DataContextDb,
    sourceId: string
  ): Promise<SportsSourceBaseline | null> {
    assertDataContextDb(scopedDb);
    const [source, assignments] = await Promise.all([
      scopedDb.db
        .selectFrom("app.sports_custom_sources")
        .select([
          ...SOURCE_COLUMNS,
          "validation_fingerprint",
          "recipe_json",
          "recipe_fingerprint",
          "confirmed_fetch_hosts",
          "updated_at"
        ])
        .where("id", "=", sourceId)
        .executeTakeFirst(),
      scopedDb.db
        .selectFrom("app.sports_source_assignments")
        .select([...ASSIGNMENT_COLUMNS, "target_parameters"])
        .where("source_id", "=", sourceId)
        .orderBy("created_at")
        .orderBy("id")
        .execute()
    ]);
    if (!source) return null;
    return {
      source: toDto(source, assignments),
      validationFingerprint: source.validation_fingerprint,
      recipeJson: source.recipe_json,
      recipeFingerprint: source.recipe_fingerprint,
      confirmedFetchHosts: source.confirmed_fetch_hosts,
      updatedAt: source.updated_at.toISOString(),
      assignments: assignments.map((assignment) => ({
        id: assignment.id,
        followId: assignment.follow_id,
        targetUrl: assignment.target_url,
        parameters: assignment.target_parameters,
        previewStatus: assignment.preview_status
      }))
    };
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
    const checkedAt = new Date(candidate.checkedAt);
    const followIds = candidate.targets.map((target) => target.followId);
    const ownedFollows =
      followIds.length === 0
        ? []
        : await scopedDb.db
            .selectFrom("app.sports_follows")
            .select(["id"])
            .where("id", "in", followIds)
            .execute();
    if (ownedFollows.length !== followIds.length) {
      throw new Error("Sports source preview contains an unavailable follow");
    }
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
        authorization_confirmed_at: confirmedAt,
        health_state: "healthy",
        health_reason_code: null,
        health_message: null,
        last_checked_at: checkedAt,
        last_success_at: checkedAt
      })
      .onConflict((oc) => oc.doNothing())
      .returning(SOURCE_COLUMNS)
      .executeTakeFirst();
    if (row) {
      if (candidate.targets.length > 0) {
        await scopedDb.db
          .insertInto("app.sports_source_assignments")
          .values(
            candidate.targets.map((target) => ({
              owner_user_id: sql<string>`app.current_actor_user_id()`,
              source_id: row.id,
              follow_id: target.followId,
              target_url: target.targetUrl,
              target_parameters: { ...target.parameters },
              preview_status: "verified" as const,
              health_state: "healthy" as const,
              health_reason_code: null,
              health_message: null,
              last_checked_at: checkedAt,
              last_success_at: checkedAt
            }))
          )
          .execute();
      }
      const assignments = await scopedDb.db
        .selectFrom("app.sports_source_assignments")
        .select(ASSIGNMENT_COLUMNS)
        .where("source_id", "=", row.id)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return toDto(row, assignments);
    }

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

  async replaceAssignments(
    scopedDb: DataContextDb,
    sourceId: string,
    reusedAssignmentIds: readonly string[],
    verifiedTargets: readonly VerifiedSportsSourceTarget[]
  ): Promise<SportsCustomSourceDto | null> {
    assertDataContextDb(scopedDb);
    const source = await scopedDb.db
      .selectFrom("app.sports_custom_sources")
      .select(SOURCE_COLUMNS)
      .where("id", "=", sourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!source) return null;

    const followIds = verifiedTargets.map((target) => target.followId);
    const ownedFollows =
      followIds.length === 0
        ? []
        : await scopedDb.db
            .selectFrom("app.sports_follows")
            .select("id")
            .where("id", "in", followIds)
            .execute();
    if (ownedFollows.length !== followIds.length) {
      throw new Error("Sports assignment preview contains an unavailable follow");
    }

    let removal = scopedDb.db
      .deleteFrom("app.sports_source_assignments")
      .where("source_id", "=", sourceId);
    if (reusedAssignmentIds.length > 0) {
      removal = removal.where("id", "not in", reusedAssignmentIds);
    }
    await removal.execute();

    if (verifiedTargets.length > 0) {
      await scopedDb.db
        .insertInto("app.sports_source_assignments")
        .values(
          verifiedTargets.map((target) => {
            const checkedAt = new Date(target.checkedAt);
            return {
              owner_user_id: sql<string>`app.current_actor_user_id()`,
              source_id: sourceId,
              follow_id: target.followId,
              target_url: target.targetUrl,
              target_parameters: { ...target.parameters },
              preview_status: "verified" as const,
              health_state: "healthy" as const,
              health_reason_code: null,
              health_message: null,
              last_checked_at: checkedAt,
              last_success_at: checkedAt
            };
          })
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
    if (assignments.length === 0) {
      const updated = await scopedDb.db
        .updateTable("app.sports_custom_sources")
        .set({ updated_at: new Date() })
        .where("id", "=", sourceId)
        .returning(SOURCE_COLUMNS)
        .executeTakeFirstOrThrow();
      return toDto(updated, assignments);
    }

    const aggregate = aggregateAssignmentHealth(source.enabled, assignments);
    const updated = await scopedDb.db
      .updateTable("app.sports_custom_sources")
      .set({
        health_state: aggregate.state,
        health_reason_code: aggregate.reason,
        health_message: aggregate.message,
        last_checked_at: newest(assignments.map((assignment) => assignment.last_checked_at)),
        last_success_at: newest(assignments.map((assignment) => assignment.last_success_at))
      })
      .where("id", "=", sourceId)
      .returning(SOURCE_COLUMNS)
      .executeTakeFirstOrThrow();
    return toDto(updated, assignments);
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
}

function newest(values: readonly (Date | null)[]): Date | null {
  return values.reduce<Date | null>(
    (latest, value) => (!value || (latest && latest >= value) ? latest : value),
    null
  );
}

function aggregateAssignmentHealth(
  enabled: boolean,
  assignments: readonly SportsSourceAssignmentRow[]
): { state: SportsSourceHealthState; reason: string | null; message: string | null } {
  if (!enabled) return { state: "disabled", reason: null, message: null };
  if (assignments.some((assignment) => assignment.health_state === "pending")) {
    return { state: "pending", reason: null, message: null };
  }
  if (assignments.every((assignment) => assignment.health_state === "healthy")) {
    return { state: "healthy", reason: null, message: null };
  }
  const state = assignments[0]!.health_state;
  if (
    (state === "unsupported" || state === "auth_required") &&
    assignments.every((assignment) => assignment.health_state === state)
  ) {
    return {
      state,
      reason: assignments[0]!.health_reason_code,
      message: assignments[0]!.health_message
    };
  }
  const reason = assignments[0]!.health_reason_code;
  if (
    state === "failing" &&
    assignments.every(
      (assignment) =>
        assignment.health_state === "failing" && assignment.health_reason_code === reason
    )
  ) {
    return { state: "failing", reason, message: assignments[0]!.health_message };
  }
  return {
    state: "failing",
    reason: "partial_target_failure",
    message: "Some source targets could not be refreshed."
  };
}
