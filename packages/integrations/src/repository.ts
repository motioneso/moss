import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { CredentialPlacement, IntegrationKind } from "@moss/shared";

import { toolDefinitionFingerprint } from "./classifier-fingerprint.js";
import {
  emptyPreparationMap,
  emptySortMap,
  parsePreparationMap,
  parseSortMap,
  preparationEntry,
  preparationHasRoom,
  withoutStaleSendChoices,
  withPreparationFailure,
  withSendWithoutAsking,
  withSortResult,
  type ClassifierPreparationEntry,
  type ClassifierPreparationFailure,
  type ClassifierPreparationMap,
  type ClassifierSortMap,
  type ClassifierSortResult,
  type ReviewedEntryInput
} from "./classifier-settings.js";
import type { DiscoveredTool } from "./openapi-convert.js";

/**
 * True when the stored map has the shape `parsePreparationMap` reads (version 1, object entries).
 * Anything else reads as empty, so a write starts a clean map instead of patching a damaged one.
 */
const WELL_FORMED_PREPARATION = sql`(
  jsonb_typeof(classifier_preparation) = 'object'
  AND classifier_preparation->'version' = '1'::jsonb
  AND jsonb_typeof(classifier_preparation->'entries') = 'object'
)`;

export interface ConnectionRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly kind: IntegrationKind;
  readonly transport: string;
  readonly url: string;
  readonly credentialPlacement: CredentialPlacement | null;
  readonly hasCredential: boolean;
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  readonly specPasted: boolean;
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
  readonly unsuppressedTools: readonly string[];
  readonly classifierEnabled: boolean;
  readonly classifierPreparation: ClassifierPreparationMap;
  /** Per-tool sorting results and send-without-asking choices (#2984). */
  readonly classifierSort: ClassifierSortMap;
  /** Tools the owner kept out of the classifier. They stay on for ordinary chat (#2984). */
  readonly classifierKeptOutTools: readonly string[];
  readonly discoveredTools: readonly DiscoveredTool[];
  readonly lastDiscoveryAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateConnectionInput {
  readonly name: string;
  readonly kind: IntegrationKind;
  readonly url: string;
  readonly baseUrl: string | null;
  readonly specPasted: boolean;
  readonly credentialEnvelope: unknown | null;
  readonly credentialPlacement: CredentialPlacement | null;
}

export interface UpdateConnectionInput {
  readonly name?: string;
  readonly url?: string;
  readonly enabled?: boolean;
  readonly baseUrl?: string | null;
  readonly specPasted?: boolean;
  /** `null` clears the stored credential. */
  readonly credentialEnvelope?: unknown | null;
  readonly credentialPlacement?: CredentialPlacement | null;
  readonly enabledGroups?: readonly string[];
  readonly enabledTools?: readonly string[];
  readonly mutedTools?: readonly string[];
  readonly unsuppressedTools?: readonly string[];
  /** Per-connection classifier opt-in (#2884). */
  readonly classifierEnabled?: boolean;
}

/** Outcome of saving one reviewed classifier tool entry (#2884). */
export type SaveClassifierToolReviewResult =
  | { readonly status: "saved"; readonly connection: ConnectionRow }
  /** The tool is gone or its definition moved on since the tab loaded it. */
  | { readonly status: "conflict"; readonly reason: "unknown_tool" | "stale" }
  | { readonly status: "not_found" }
  /** The stored map is at its bounded size. */
  | { readonly status: "too_many" };

/** Outcome of setting or clearing send-without-asking on some tools (#2984). */
export type SetSendWithoutAskingResult =
  | { readonly status: "saved"; readonly connection: ConnectionRow }
  | { readonly status: "not_found" }
  /** A named tool is gone, or has no current Sends things out sort. Nothing was written. */
  | { readonly status: "refused"; readonly toolName: string };

interface ConnectionSqlRow {
  id: string;
  owner_user_id: string;
  name: string;
  kind: string;
  transport: string;
  url: string;
  credential_placement: CredentialPlacement | null;
  has_credential: boolean;
  enabled: boolean;
  base_url: string | null;
  spec_pasted: boolean;
  enabled_groups: string[];
  enabled_tools: string[];
  muted_tools: string[];
  unsuppressed_tools: string[];
  classifier_enabled: boolean;
  classifier_preparation: unknown;
  classifier_sort: unknown;
  classifier_kept_out_tools: string[];
  discovered_tools: DiscoveredTool[];
  last_discovery_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, owner_user_id, name, kind, transport, url, credential_placement,
  (credential IS NOT NULL) AS has_credential, enabled, base_url, spec_pasted,
  enabled_groups, enabled_tools, muted_tools, unsuppressed_tools, classifier_enabled,
  classifier_preparation, classifier_sort, classifier_kept_out_tools, discovered_tools,
  last_discovery_at, last_error, created_at, updated_at
`;

export class IntegrationsRepository {
  async createConnection(
    scopedDb: DataContextDb,
    input: CreateConnectionInput
  ): Promise<ConnectionRow> {
    assertDataContextDb(scopedDb);

    const credential =
      input.credentialEnvelope === null ? null : JSON.stringify(input.credentialEnvelope);
    const credentialPlacement =
      input.credentialPlacement === null ? null : JSON.stringify(input.credentialPlacement);

    const result = await sql<ConnectionSqlRow>`
      INSERT INTO app.integration_connections (
        owner_user_id, name, kind, url, credential, credential_placement, base_url, spec_pasted
      ) VALUES (
        app.current_actor_user_id(), ${input.name}, ${input.kind}, ${input.url},
        ${credential}::jsonb, ${credentialPlacement}::jsonb, ${input.baseUrl}, ${input.specPasted}
      )
      RETURNING ${sql.raw(SELECT_COLUMNS)}
    `.execute(scopedDb.db);

    return this.mapRow(result.rows[0]!);
  }

  async listConnections(scopedDb: DataContextDb): Promise<ConnectionRow[]> {
    assertDataContextDb(scopedDb);

    const result = await sql<ConnectionSqlRow>`
      SELECT ${sql.raw(SELECT_COLUMNS)}
      FROM app.integration_connections
      ORDER BY created_at DESC
    `.execute(scopedDb.db);

    return result.rows.map((row) => this.mapRow(row));
  }

  async getConnection(scopedDb: DataContextDb, id: string): Promise<ConnectionRow | null> {
    assertDataContextDb(scopedDb);

    const result = await sql<ConnectionSqlRow>`
      SELECT ${sql.raw(SELECT_COLUMNS)}
      FROM app.integration_connections
      WHERE id = ${id}::uuid
    `.execute(scopedDb.db);

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private async lockConnection(scopedDb: DataContextDb, id: string): Promise<ConnectionRow | null> {
    const result = await sql<ConnectionSqlRow>`
      SELECT ${sql.raw(SELECT_COLUMNS)}
      FROM app.integration_connections
      WHERE id = ${id}::uuid
      FOR UPDATE
    `.execute(scopedDb.db);

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async updateConnection(
    scopedDb: DataContextDb,
    id: string,
    patch: UpdateConnectionInput
  ): Promise<ConnectionRow | null> {
    assertDataContextDb(scopedDb);

    const sets = [];
    if ("name" in patch) sets.push(sql`name = ${patch.name}`);
    if ("url" in patch) sets.push(sql`url = ${patch.url}`);
    if ("enabled" in patch) sets.push(sql`enabled = ${patch.enabled}`);
    if ("baseUrl" in patch) sets.push(sql`base_url = ${patch.baseUrl}`);
    if ("specPasted" in patch) sets.push(sql`spec_pasted = ${patch.specPasted}`);
    if ("credentialEnvelope" in patch) {
      const credential =
        patch.credentialEnvelope === null ? null : JSON.stringify(patch.credentialEnvelope);
      sets.push(sql`credential = ${credential}::jsonb`);
    }
    if ("credentialPlacement" in patch) {
      const credentialPlacement =
        patch.credentialPlacement === null ? null : JSON.stringify(patch.credentialPlacement);
      sets.push(sql`credential_placement = ${credentialPlacement}::jsonb`);
    }
    if ("enabledGroups" in patch) {
      sets.push(sql`enabled_groups = ${[...(patch.enabledGroups ?? [])]}::text[]`);
    }
    if ("enabledTools" in patch) {
      sets.push(sql`enabled_tools = ${[...(patch.enabledTools ?? [])]}::text[]`);
    }
    if ("mutedTools" in patch) {
      sets.push(sql`muted_tools = ${[...(patch.mutedTools ?? [])]}::text[]`);
    }
    if ("unsuppressedTools" in patch) {
      sets.push(sql`unsuppressed_tools = ${[...(patch.unsuppressedTools ?? [])]}::text[]`);
    }
    if ("classifierEnabled" in patch) {
      sets.push(sql`classifier_enabled = ${patch.classifierEnabled}`);
    }
    sets.push(sql`updated_at = now()`);

    const result = await sql<ConnectionSqlRow>`
      UPDATE app.integration_connections
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}::uuid
      RETURNING ${sql.raw(SELECT_COLUMNS)}
    `.execute(scopedDb.db);

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async deleteConnection(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);

    const result = await sql`
      DELETE FROM app.integration_connections WHERE id = ${id}::uuid
    `.execute(scopedDb.db);

    return (result.numAffectedRows ?? 0n) > 0n;
  }

  /** The only function that reads the `credential` column. */
  async loadCredentialEnvelope(scopedDb: DataContextDb, id: string): Promise<unknown | null> {
    assertDataContextDb(scopedDb);

    const result = await sql<{ credential: unknown | null }>`
      SELECT credential FROM app.integration_connections WHERE id = ${id}::uuid
    `.execute(scopedDb.db);

    return result.rows[0]?.credential ?? null;
  }

  async saveDiscovery(
    scopedDb: DataContextDb,
    id: string,
    tools: DiscoveredTool[] | null,
    error: string | null
  ): Promise<void> {
    assertDataContextDb(scopedDb);

    if (tools === null) {
      await sql`
        UPDATE app.integration_connections
        SET last_error = ${error}, updated_at = now()
        WHERE id = ${id}::uuid
      `.execute(scopedDb.db);
      return;
    }

    // A send-without-asking choice dies with the sort it was set on, so a tool whose risk inputs
    // changed asks again even if a later discovery changes them back.
    const row = await this.lockConnection(scopedDb, id);
    if (!row) return;
    const sort = withoutStaleSendChoices(row.classifierSort, tools);

    await sql`
      UPDATE app.integration_connections
      SET discovered_tools = ${JSON.stringify(tools)}::jsonb,
          classifier_sort = ${JSON.stringify(sort)}::jsonb,
          last_discovery_at = now(),
          last_error = ${error},
          updated_at = now()
      WHERE id = ${id}::uuid
    `.execute(scopedDb.db);
  }

  /**
   * Save one owner-reviewed classifier preparation, keyed by the discovered tool name (#2884).
   *
   * `reviewedFingerprint` is compared against the tool's current definition before anything is
   * written. A missing tool or a moved-on definition is a conflict, so a stale tab cannot approve
   * a superseded review. The per-tool `preparationVersion` only ever grows.
   */
  async saveClassifierToolReview(
    scopedDb: DataContextDb,
    id: string,
    toolName: string,
    input: ReviewedEntryInput
  ): Promise<SaveClassifierToolReviewResult> {
    assertDataContextDb(scopedDb);

    // Lock the row for the rest of the request transaction, so the cap and version below are read
    // and written as one step. A concurrent save waits here, then sees this save's entry.
    const row = await this.lockConnection(scopedDb, id);
    if (!row) return { status: "not_found" };
    const tool = row.discoveredTools.find((candidate) => candidate.name === toolName);
    if (!tool) return { status: "conflict", reason: "unknown_tool" };
    if (toolDefinitionFingerprint(tool) !== input.reviewedFingerprint) {
      return { status: "conflict", reason: "stale" };
    }

    const map = row.classifierPreparation;
    const existing = preparationEntry(map, toolName);
    if (!preparationHasRoom(map, toolName)) return { status: "too_many" };
    const entry: ClassifierPreparationEntry = {
      optIn: input.optIn,
      reviewedRisk: input.reviewedRisk,
      description: input.description,
      arguments: input.arguments,
      replyTemplate: input.replyTemplate,
      ...(input.candidateSource !== undefined ? { candidateSource: input.candidateSource } : {}),
      definitionFingerprint: input.reviewedFingerprint,
      reviewedAt: new Date().toISOString(),
      preparationVersion: (existing?.preparationVersion ?? 0) + 1
    };

    const updated = await this.writePreparationEntry(scopedDb, id, toolName, entry);
    return updated ? { status: "saved", connection: updated } : { status: "not_found" };
  }

  /**
   * Record that automatic preparation failed for one tool (#2984 R2.4). The failure is tied to the
   * definition it was attempted against, so the job leaves it for the owner's Try again. Only a
   * discovered tool is recorded. Failures that can no longer block a run are dropped in the same
   * write, and the row lock keeps the rewrite of the whole failure set from losing another write.
   */
  async saveClassifierPreparationFailure(
    scopedDb: DataContextDb,
    id: string,
    toolName: string,
    failure: ClassifierPreparationFailure
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const row = await this.lockConnection(scopedDb, id);
    if (!row?.discoveredTools.some((tool) => tool.name === toolName)) return false;
    const failures = withPreparationFailure(
      row.classifierPreparation,
      row.discoveredTools,
      toolName,
      failure
    );
    if (!failures) return false;

    const result = await sql`
      UPDATE app.integration_connections
      SET classifier_preparation = jsonb_set(
            CASE
              WHEN ${WELL_FORMED_PREPARATION} THEN classifier_preparation
              ELSE '{"version": 1, "entries": {}}'::jsonb
            END,
            ARRAY['failures'],
            ${JSON.stringify(failures)}::jsonb,
            true
          ),
          updated_at = now()
      WHERE id = ${id}::uuid
    `.execute(scopedDb.db);
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  /** Remove one saved classifier preparation entry (opt-out / discard a stale review). */
  async removeClassifierToolReview(
    scopedDb: DataContextDb,
    id: string,
    toolName: string
  ): Promise<ConnectionRow | null> {
    assertDataContextDb(scopedDb);

    // One statement, one key: removing a tool cannot clobber a concurrent save of another tool.
    const result = await sql<ConnectionSqlRow>`
      UPDATE app.integration_connections
      SET classifier_preparation = CASE
            WHEN ${WELL_FORMED_PREPARATION}
            THEN classifier_preparation #- ARRAY['entries', ${toolName}]
            ELSE classifier_preparation
          END,
          updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING ${sql.raw(SELECT_COLUMNS)}
    `.execute(scopedDb.db);

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Store sorting results for some of a connection's tools (#2984). A result for a tool that is no
   * longer discovered, or whose shape is not storable, is skipped. The row is locked for the
   * request transaction, so the whole-map write cannot lose a concurrent change.
   */
  async saveClassifierToolSorts(
    scopedDb: DataContextDb,
    id: string,
    results: readonly { readonly toolName: string; readonly result: ClassifierSortResult }[]
  ): Promise<ConnectionRow | null> {
    assertDataContextDb(scopedDb);

    const row = await this.lockConnection(scopedDb, id);
    if (!row) return null;
    const discovered = new Set(row.discoveredTools.map((tool) => tool.name));
    let sort = row.classifierSort;
    for (const { toolName, result } of results) {
      if (!discovered.has(toolName)) continue;
      sort = withSortResult(sort, toolName, result) ?? sort;
    }
    return this.writeSort(scopedDb, id, sort);
  }

  /**
   * Set or clear the owner's send-without-asking choice on the named tools, all or nothing.
   * Only the owner's own request reaches this; row-level security keeps every other actor out.
   */
  async setClassifierSendWithoutAsking(
    scopedDb: DataContextDb,
    id: string,
    toolNames: readonly string[],
    allow: boolean
  ): Promise<SetSendWithoutAskingResult> {
    assertDataContextDb(scopedDb);

    const row = await this.lockConnection(scopedDb, id);
    if (!row) return { status: "not_found" };
    let sort = row.classifierSort;
    for (const toolName of toolNames) {
      const tool = row.discoveredTools.find((candidate) => candidate.name === toolName);
      const next = tool ? withSendWithoutAsking(sort, tool, allow) : allow ? null : sort;
      if (!next) return { status: "refused", toolName };
      sort = next;
    }
    const updated = await this.writeSort(scopedDb, id, sort);
    return updated ? { status: "saved", connection: updated } : { status: "not_found" };
  }

  /** Keep one tool out of the classifier, or let it back in. Ordinary chat is unaffected. */
  async setClassifierToolKeptOut(
    scopedDb: DataContextDb,
    id: string,
    toolName: string,
    keptOut: boolean
  ): Promise<ConnectionRow | null> {
    assertDataContextDb(scopedDb);

    const result = await sql<ConnectionSqlRow>`
      UPDATE app.integration_connections
      SET classifier_kept_out_tools = CASE
            WHEN ${keptOut} AND NOT (${toolName} = ANY(classifier_kept_out_tools))
            THEN array_append(classifier_kept_out_tools, ${toolName})
            WHEN NOT ${keptOut} THEN array_remove(classifier_kept_out_tools, ${toolName})
            ELSE classifier_kept_out_tools
          END,
          updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING ${sql.raw(SELECT_COLUMNS)}
    `.execute(scopedDb.db);

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private async writeSort(
    scopedDb: DataContextDb,
    id: string,
    sort: ClassifierSortMap
  ): Promise<ConnectionRow | null> {
    const result = await sql<ConnectionSqlRow>`
      UPDATE app.integration_connections
      SET classifier_sort = ${JSON.stringify(sort)}::jsonb,
          updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING ${sql.raw(SELECT_COLUMNS)}
    `.execute(scopedDb.db);

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Write a single entry with `jsonb_set`, touching only that tool's key, and clear the tool's
   * stored failure. Two writers saving different tools therefore merge instead of overwriting each
   * other's map.
   */
  private async writePreparationEntry(
    scopedDb: DataContextDb,
    id: string,
    toolName: string,
    entry: ClassifierPreparationEntry
  ): Promise<ConnectionRow | null> {
    const entryJson = JSON.stringify(entry);
    const result = await sql<ConnectionSqlRow>`
      UPDATE app.integration_connections
      SET classifier_preparation = jsonb_set(
            CASE
              WHEN ${WELL_FORMED_PREPARATION} THEN classifier_preparation
              ELSE '{"version": 1, "entries": {}}'::jsonb
            END,
            ARRAY['entries', ${toolName}],
            ${entryJson}::jsonb,
            true
          ) #- ARRAY['failures', ${toolName}],
          updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING ${sql.raw(SELECT_COLUMNS)}
    `.execute(scopedDb.db);

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private mapRow(row: ConnectionSqlRow): ConnectionRow {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      kind: row.kind as IntegrationKind,
      transport: row.transport,
      url: row.url,
      credentialPlacement: row.credential_placement,
      hasCredential: row.has_credential,
      enabled: row.enabled,
      baseUrl: row.base_url,
      specPasted: row.spec_pasted,
      enabledGroups: row.enabled_groups,
      enabledTools: row.enabled_tools,
      mutedTools: row.muted_tools,
      unsuppressedTools: row.unsuppressed_tools,
      classifierEnabled: row.classifier_enabled,
      classifierPreparation: parsePreparationMap(
        row.classifier_preparation ?? emptyPreparationMap()
      ),
      classifierSort: parseSortMap(row.classifier_sort ?? emptySortMap()),
      classifierKeptOutTools: row.classifier_kept_out_tools ?? [],
      discoveredTools: row.discovered_tools,
      lastDiscoveryAt: row.last_discovery_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
