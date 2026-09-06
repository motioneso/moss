import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { SettingsRepository } from "@moss/settings";
import type { CreateWorkshopProjectInput, CreateWorkshopProjectResponse } from "@moss/shared";
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
  const result = await new WorkshopProjectsRepository().create(scopedDb, input);
  return { ...result, destination: `/workshop/${result.project.id}` };
}
