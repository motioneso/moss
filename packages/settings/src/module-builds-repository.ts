import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";

export type ModuleBuildStatus =
  | "planning"
  | "awaiting_plan_approval"
  | "building"
  | "awaiting_change"
  | "ready"
  | "failed"
  | "cancelled";

export interface ModuleBuild {
  readonly id: string;
  readonly ownerUserId: string;
  readonly conversationId: string | null;
  readonly status: ModuleBuildStatus;
  readonly plan: Record<string, unknown> | null;
  readonly step: string | null;
  readonly moduleId: string | null;
  readonly fetchedUrls: readonly string[];
  readonly writtenFiles: readonly string[];
  readonly costCents: number;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateModuleBuildInput {
  readonly ownerUserId: string;
  readonly conversationId?: string | null;
}

function toModuleBuild(row: {
  id: string;
  owner_user_id: string;
  conversation_id: string | null;
  status: ModuleBuildStatus;
  plan: Record<string, unknown> | null;
  step: string | null;
  module_id: string | null;
  fetched_urls: string[];
  written_files: string[];
  cost_cents: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}): ModuleBuild {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    status: row.status,
    plan: row.plan,
    step: row.step,
    moduleId: row.module_id,
    fetchedUrls: row.fetched_urls,
    writtenFiles: row.written_files,
    costCents: row.cost_cents,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createModuleBuild(
  scopedDb: DataContextDb,
  input: CreateModuleBuildInput
): Promise<ModuleBuild> {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .insertInto("app.module_builds")
    .values({
      owner_user_id: input.ownerUserId,
      conversation_id: input.conversationId ?? null,
      status: "planning"
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toModuleBuild(row);
}

export async function getModuleBuild(
  scopedDb: DataContextDb,
  buildId: string
): Promise<ModuleBuild | null> {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.module_builds")
    .selectAll()
    .where("id", "=", buildId)
    .executeTakeFirst();
  return row ? toModuleBuild(row) : null;
}

export async function updateModuleBuildPlan(
  scopedDb: DataContextDb,
  buildId: string,
  plan: Record<string, unknown>
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .updateTable("app.module_builds")
    .set({ plan, updated_at: new Date() })
    .where("id", "=", buildId)
    .execute();
}

export interface UpdateModuleBuildStatusInput {
  readonly status: ModuleBuildStatus;
  readonly step?: string | null;
  readonly moduleId?: string | null;
  readonly error?: string | null;
}

export async function updateModuleBuildStatus(
  scopedDb: DataContextDb,
  buildId: string,
  input: UpdateModuleBuildStatusInput
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .updateTable("app.module_builds")
    .set({
      status: input.status,
      ...(input.step !== undefined ? { step: input.step } : {}),
      ...(input.moduleId !== undefined ? { module_id: input.moduleId } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      updated_at: new Date()
    })
    .where("id", "=", buildId)
    .execute();
}

/** Appends one URL to the build's fetched-URL trail (spec: "what the build fetched is shown"). */
export async function appendModuleBuildFetchedUrl(
  scopedDb: DataContextDb,
  buildId: string,
  url: string
): Promise<void> {
  assertDataContextDb(scopedDb);
  await sql`
    UPDATE app.module_builds
    SET fetched_urls = fetched_urls || ${JSON.stringify([url])}::jsonb,
        updated_at = now()
    WHERE id = ${buildId}
  `.execute(scopedDb.db);
}

/** Appends one path to the build's written-files trail (spec: "what it has written is shown"). */
export async function appendModuleBuildWrittenFile(
  scopedDb: DataContextDb,
  buildId: string,
  path: string
): Promise<void> {
  assertDataContextDb(scopedDb);
  await sql`
    UPDATE app.module_builds
    SET written_files = written_files || ${JSON.stringify([path])}::jsonb,
        updated_at = now()
    WHERE id = ${buildId}
  `.execute(scopedDb.db);
}

export async function listModuleBuildsForUser(
  scopedDb: DataContextDb,
  ownerUserId: string
): Promise<ModuleBuild[]> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.module_builds")
    .selectAll()
    .where("owner_user_id", "=", ownerUserId)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map(toModuleBuild);
}
