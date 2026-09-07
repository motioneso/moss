import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { SettingsRepository } from "@moss/settings";
import type {
  CreateWorkshopProjectInput,
  CreateWorkshopProjectResponse,
  WorkshopProject
} from "@moss/shared";
import { deriveProjectTitle } from "@moss/shared";
import { sql } from "kysely";
import { WorkshopProjectsRepository } from "./projects-repository.js";

export class WorkshopAdminRequiredError extends Error {
  constructor() {
    super("Workshop requires an active instance admin account.");
  }
}

export async function requireWorkshopAdmin(scopedDb: DataContextDb): Promise<void> {
  assertDataContextDb(scopedDb);
  const { rows } = await sql<{
    actor: string;
  }>`select app.current_actor_user_id() as actor`.execute(scopedDb.db);
  const actor = rows[0]?.actor;
  const user = actor ? await new SettingsRepository().getUserById(scopedDb, actor) : undefined;
  if (!user?.is_instance_admin || user.status !== "active") throw new WorkshopAdminRequiredError();
}

/** Save the user's request only; execution and planning require later explicit operations. */
export async function createWorkshopProject(
  scopedDb: DataContextDb,
  input: CreateWorkshopProjectInput
): Promise<CreateWorkshopProjectResponse> {
  await requireWorkshopAdmin(scopedDb);
  // The new-project window names nothing up front: the name is the request's own first line,
  // derived the same way the chat handoff names it. A present title (the handoff tool) wins and
  // still validates as before — only an absent one derives, so a blank title stays a 400.
  const title =
    input.title === undefined ? deriveProjectTitle(input.initialRequest) : input.title;
  const result = await new WorkshopProjectsRepository().create(scopedDb, { ...input, title });
  return { ...result, destination: `/workshop/${result.project.id}` };
}

/** Rename in place; null when the project is missing or belongs to someone else (same 404). */
export async function renameWorkshopProject(
  scopedDb: DataContextDb,
  id: string,
  title: string
): Promise<WorkshopProject | null> {
  await requireWorkshopAdmin(scopedDb);
  return new WorkshopProjectsRepository().rename(scopedDb, id, title);
}

/**
 * Delete the project and its messages. True when something actually went; false reads exactly
 * like a missing project. No build can be attached to a project yet, so there is nothing else
 * to clean up — when the build link lands, its removal work extends this path with the
 * "Stop the build first" refusal instead of orphaning it.
 */
export async function deleteWorkshopProject(
  scopedDb: DataContextDb,
  id: string
): Promise<boolean> {
  await requireWorkshopAdmin(scopedDb);
  return new WorkshopProjectsRepository().remove(scopedDb, id);
}
