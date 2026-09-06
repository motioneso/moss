import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ModuleLifecycleContext } from "@moss/module-sdk";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
type ExportRow = Record<string, JsonValue>;

export interface SportsSourcesExportSectionData {
  readonly assignments: readonly ExportRow[];
  readonly espnAssignments: readonly ExportRow[];
  readonly headlinePreferences: readonly ExportRow[];
  readonly sources: readonly ExportRow[];
}

export async function collectSportsSourcesExportSection(
  scopedDb: unknown,
  ctx: ModuleLifecycleContext
): Promise<SportsSourcesExportSectionData> {
  assertDataContextDb(scopedDb as DataContextDb);
  const db = (scopedDb as DataContextDb).db;
  const userId = ctx.actorUserId;

  const sources = await sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      label,
      canonical_domain AS "canonicalDomain",
      homepage_url AS "homepageUrl",
      feed_url AS "feedUrl",
      retrieval_method AS "retrievalMethod",
      enabled,
      health_state AS "healthState",
      health_reason_code AS "healthReasonCode",
      health_message AS "healthMessage",
      last_checked_at AS "lastCheckedAt",
      last_success_at AS "lastSuccessAt",
      recipe_status AS "recipeStatus",
      -- #2237 the export carries what the settings row says about photos, not the instruction
      -- behind it: the instruction is internal, like the stored icon URL, and never exported.
      photo_rule_state AS "photoRuleState",
      photo_last_outcome AS "photoLastOutcome",
      recipe_schema_version AS "recipeSchemaVersion",
      authorization_confirmed_at AS "authorizationConfirmedAt",
      validated_at AS "validatedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.sports_custom_sources
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at DESC, id
  `.execute(db);

  const assignments = await sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      source_id::text AS "sourceId",
      follow_id::text AS "followId",
      sport_key AS "sportKey",
      target_url AS "targetUrl",
      health_state AS "healthState",
      health_reason_code AS "healthReasonCode",
      health_message AS "healthMessage",
      last_checked_at AS "lastCheckedAt",
      last_success_at AS "lastSuccessAt",
      created_at AS "createdAt"
    FROM app.sports_source_assignments
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at DESC, id
  `.execute(db);

  const espnAssignments = await sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      follow_id::text AS "followId",
      sport_key AS "sportKey",
      created_at AS "createdAt"
    FROM app.sports_espn_source_assignments
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at DESC, id
  `.execute(db);

  const headlinePreferences = await sql<Record<string, unknown>>`
    SELECT
      owner_user_id::text AS "ownerUserId",
      espn_headlines_enabled AS "espnHeadlinesEnabled",
      updated_at AS "updatedAt"
    FROM app.sports_headline_prefs
    WHERE owner_user_id = ${userId}::uuid
  `.execute(db);

  return {
    assignments: assignments.rows.map(normalizeRow),
    espnAssignments: espnAssignments.rows.map(normalizeRow),
    headlinePreferences: headlinePreferences.rows.map(normalizeRow),
    sources: sources.rows.map(normalizeRow)
  };
}

function normalizeRow(row: Record<string, unknown>): ExportRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  ) as ExportRow;
}

function normalizeValue(value: unknown): JsonValue {
  if (value instanceof Date) return value.toISOString();
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalizeValue(nested)
      ])
    );
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  return String(value);
}
