import { assertDataContextDb, assertUuid, type DataContextDb } from "@moss/db";
import { WorkshopInputError } from "./projects-repository.js";
import type { WorkshopFeedEntry, WorkshopFeedInput } from "@moss/shared";

export class WorkshopMessageConflictError extends Error {
  constructor() {
    super("This message ID was already used with different text");
  }
}

const columns = [
  "project_id",
  "message_id",
  "sequence",
  "kind",
  "text",
  "delivery",
  "created_at"
] as const;
type FeedRow = {
  project_id: string;
  message_id: string;
  sequence: string;
  kind: "user_message";
  text: string;
  delivery: "pending";
  created_at: Date;
};
function entry(row: FeedRow): WorkshopFeedEntry {
  return {
    projectId: row.project_id,
    messageId: row.message_id,
    sequence: row.sequence,
    kind: row.kind,
    text: row.text,
    delivery: row.delivery,
    createdAt: row.created_at.toISOString()
  };
}

export class WorkshopProjectFeed {
  async append(scopedDb: DataContextDb, projectId: string, input: WorkshopFeedInput) {
    assertDataContextDb(scopedDb);
    assertUuid(projectId, "Project id");
    assertUuid(input.messageId, "Message id");
    if (
      Object.keys(input).some((key) => !["messageId", "text"].includes(key)) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.includes("\0") ||
      Buffer.byteLength(input.text) > 16384
    )
      throw new WorkshopInputError("Invalid project message");
    // Held until the caller commits: sequence order is also commit order.
    const project = await scopedDb.db
      .selectFrom("app.workshop_projects")
      .select("id")
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();
    if (!project) return null;
    const existing = await scopedDb.db
      .selectFrom("app.workshop_project_feed")
      .select(columns)
      .where("project_id", "=", projectId)
      .where("message_id", "=", input.messageId)
      .executeTakeFirst();
    if (existing) {
      if (existing.text !== input.text) throw new WorkshopMessageConflictError();
      return { entry: entry(existing), created: false };
    }
    const counter = await scopedDb.db
      .updateTable("app.workshop_projects")
      .set((eb) => ({ feed_sequence: eb("feed_sequence", "+", "1"), updated_at: new Date() }))
      .where("id", "=", projectId)
      .returning("feed_sequence")
      .executeTakeFirstOrThrow();
    const row = await scopedDb.db
      .insertInto("app.workshop_project_feed")
      .values({
        project_id: projectId,
        message_id: input.messageId,
        sequence: counter.feed_sequence,
        text: input.text
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    return { entry: entry(row), created: true };
  }

  async list(
    scopedDb: DataContextDb,
    projectId: string,
    options: { after?: string; limit?: number } = {}
  ) {
    assertDataContextDb(scopedDb);
    assertUuid(projectId, "Project id");
    const limit = options.limit ?? 50;
    const after = options.after ?? "0";
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new WorkshopInputError("Invalid feed page size");
    if (
      typeof after !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/.test(after) ||
      BigInt(after) > 9223372036854775807n
    )
      throw new WorkshopInputError("Invalid feed cursor");
    const project = await scopedDb.db
      .selectFrom("app.workshop_projects")
      .select("id")
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!project) return null;
    const rows = await scopedDb.db
      .selectFrom("app.workshop_project_feed")
      .select(columns)
      .where("project_id", "=", projectId)
      .where("sequence", ">", after)
      .orderBy("sequence", "asc")
      .limit(limit)
      .execute();
    return { entries: rows.map(entry), nextCursor: rows.at(-1)?.sequence ?? after };
  }
}

export async function collectWorkshopProjectFeed(scopedDb: unknown) {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.workshop_project_feed")
    .select(columns)
    .orderBy("project_id", "asc")
    .orderBy("sequence", "asc")
    .execute();
  return { entries: rows.map(entry) };
}
