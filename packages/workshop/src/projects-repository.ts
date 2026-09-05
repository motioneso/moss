import { assertDataContextDb, assertUuid, type DataContextDb } from "@moss/db";
import type {
  CreateWorkshopProjectInput,
  WorkshopProject,
  WorkshopProjectCursor
} from "@moss/shared";

export class WorkshopInputError extends Error {}

export class WorkshopProjectConflictError extends Error {
  constructor() {
    super("This project request key was already used with different input");
  }
}

function boundedText(value: unknown, name: string, bytes: number, required = true): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > bytes ||
    (required && !value.trim())
  )
    throw new WorkshopInputError(`Invalid project ${name}`);
  return value;
}

const columns = ["id", "title", "initial_request", "context", "created_at", "updated_at"] as const;
type ProjectRow = {
  id: string;
  title: string;
  initial_request: string;
  context: string;
  created_at: Date;
  updated_at: Date;
};
function project(row: ProjectRow): WorkshopProject {
  return {
    id: row.id,
    title: row.title,
    initialRequest: row.initial_request,
    context: row.context,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class WorkshopProjectsRepository {
  async create(
    scopedDb: DataContextDb,
    input: CreateWorkshopProjectInput
  ): Promise<{
    project: WorkshopProject;
    created: boolean;
  }> {
    assertDataContextDb(scopedDb);
    assertUuid(input.requestKey, "Project request key");
    if (
      Object.keys(input).some(
        (key) => !["requestKey", "title", "initialRequest", "context"].includes(key)
      )
    )
      throw new WorkshopInputError("Invalid project input");
    const title = boundedText(input.title, "title", 160).trim();
    const initialRequest = boundedText(input.initialRequest, "request", 16384);
    const context = boundedText(input.context ?? "", "context", 16384, false);
    const inserted = await scopedDb.db
      .insertInto("app.workshop_projects")
      .values({ request_key: input.requestKey, title, initial_request: initialRequest, context })
      .onConflict((conflict) => conflict.columns(["owner_user_id", "request_key"]).doNothing())
      .returning(columns)
      .executeTakeFirst();
    if (inserted) return { project: project(inserted), created: true };
    // A separate statement sees a concurrently committed winner under READ COMMITTED.
    const existing = await scopedDb.db
      .selectFrom("app.workshop_projects")
      .select(columns)
      .where("request_key", "=", input.requestKey)
      .executeTakeFirstOrThrow();
    if (
      existing.title !== title ||
      existing.initial_request !== initialRequest ||
      existing.context !== context
    )
      throw new WorkshopProjectConflictError();
    return { project: project(existing), created: false };
  }

  async get(scopedDb: DataContextDb, id: string): Promise<WorkshopProject | null> {
    assertDataContextDb(scopedDb);
    assertUuid(id, "Project id");
    const row = await scopedDb.db
      .selectFrom("app.workshop_projects")
      .select(columns)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? project(row) : null;
  }

  async list(
    scopedDb: DataContextDb,
    options: { limit?: number; before?: WorkshopProjectCursor } = {}
  ): Promise<WorkshopProject[]> {
    assertDataContextDb(scopedDb);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new WorkshopInputError("Invalid project page size");
    let query = scopedDb.db.selectFrom("app.workshop_projects").select(columns);
    if (options.before) {
      const { id, createdAt } = options.before;
      assertUuid(id, "Project cursor id");
      const date = new Date(createdAt);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== createdAt)
        throw new WorkshopInputError("Invalid project cursor timestamp");
      query = query.where((eb) =>
        eb.or([
          eb("created_at", "<", date),
          eb.and([eb("created_at", "=", date), eb("id", "<", id)])
        ])
      );
    }
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(project);
  }
}

export async function collectWorkshopProjects(scopedDb: unknown) {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.workshop_projects")
    .select(columns)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  return { projects: rows.map(project) };
}
