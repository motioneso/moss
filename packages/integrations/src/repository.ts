import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { CredentialPlacement, IntegrationKind } from "@moss/shared";

import type { DiscoveredTool } from "./openapi-convert.js";

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
}

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
  discovered_tools: DiscoveredTool[];
  last_discovery_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, owner_user_id, name, kind, transport, url, credential_placement,
  (credential IS NOT NULL) AS has_credential, enabled, base_url, spec_pasted,
  enabled_groups, enabled_tools, muted_tools, unsuppressed_tools, discovered_tools,
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

    await sql`
      UPDATE app.integration_connections
      SET discovered_tools = ${JSON.stringify(tools)}::jsonb,
          last_discovery_at = now(),
          last_error = ${error},
          updated_at = now()
      WHERE id = ${id}::uuid
    `.execute(scopedDb.db);
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
      discoveredTools: row.discovered_tools,
      lastDiscoveryAt: row.last_discovery_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
