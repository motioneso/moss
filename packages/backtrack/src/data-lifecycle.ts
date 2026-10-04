import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ModuleLifecycleContext } from "@moss/module-sdk";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
type ExportRow = Record<string, JsonValue>;

/**
 * The user-export contribution for Backtrack (#2638 plan §4.2): every column of the actor's own
 * segments except `search` (derived from the others, not independent data) and with `body_hash`
 * rendered as hex rather than raw bytes, matching the manifest's dataLifecycle.exportSections.
 * A flat row array, like the other single-table export sections (e.g. focus_judgments) — unlike
 * wellness or sports, backtrack has only one row-set to export, so there is no grouping to name.
 */
export async function collectBacktrackSegmentsExportSection(
  scopedDb: unknown,
  ctx: ModuleLifecycleContext
): Promise<readonly ExportRow[]> {
  assertDataContextDb(scopedDb as DataContextDb);
  const db = (scopedDb as DataContextDb).db;
  const ownerUserId = ctx.actorUserId;

  const segments = await sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      device_id::text AS "deviceId",
      started_at AS "startedAt",
      ended_at AS "endedAt",
      app_name AS "appName",
      bundle_id AS "bundleId",
      window_title AS "windowTitle",
      address,
      body,
      encode(body_hash, 'hex') AS "bodyHash",
      indexed_at AS "indexedAt",
      created_at AS "createdAt",
      client_started_at AS "clientStartedAt"
    FROM app.backtrack_segments
    WHERE owner_user_id = ${ownerUserId}::uuid
    ORDER BY started_at DESC, id
  `.execute(db);

  return segments.rows as readonly ExportRow[];
}
