import { resolveClassifier, type ClassifierDeps } from "@moss/ai";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { MODULE_WORKER_SERVICE_KEY } from "@moss/shared";

import type { GateMode } from "./live/classifier-gate.js";

/**
 * The classifier gate's kill gate, #2984 R2.4 (spec 8.5, 8.10 ruling 1).
 *
 * One admin row per classifier selection records the shadow review that unlocks `on`. The stored
 * mode is checked against the current selection whenever it is read, so a changed classifier or a
 * deleted row drops `on` back to `shadow` at once. Instance-global admin data: every authed actor
 * may read, only admins may write (migration 0271). This module only reads.
 */

/** The configured model the classifier binding resolves to. */
export interface ClassifierSelection {
  readonly modelId: string;
  readonly providerModelId: string;
}

export type HasReviewForSelection = (
  scopedDb: DataContextDb,
  selection: ClassifierSelection
) => Promise<boolean>;

/** True when a shadow review row matches this exact selection. */
export const hasReviewForSelection: HasReviewForSelection = async (scopedDb, selection) => {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.chat_classifier_shadow_reviews")
    .select("id")
    .where("classifier_model_id", "=", selection.modelId)
    .where("classifier_provider_model_id", "=", selection.providerModelId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
};

export interface ClassifierShadowReviewDeps {
  readonly classifierDeps: Pick<ClassifierDeps, "repository">;
  /** Defaults to the table read; injectable for tests. */
  readonly hasReviewForSelection?: HasReviewForSelection;
}

/** True when the current classifier selection has a shadow review. No classifier fails closed. */
export async function isCurrentClassifierReviewed(
  scopedDb: DataContextDb,
  deps: ClassifierShadowReviewDeps
): Promise<boolean> {
  const handle = await resolveClassifier(scopedDb, MODULE_WORKER_SERVICE_KEY, deps.classifierDeps);
  if (!handle) return false;
  const check = deps.hasReviewForSelection ?? hasReviewForSelection;
  return check(scopedDb, {
    modelId: handle.model.id,
    providerModelId: handle.model.provider_model_id
  });
}

/** The mode the gate runs in: a stored `on` reads as `shadow` until the current classifier is reviewed. */
export async function resolveEffectiveGateMode(
  scopedDb: DataContextDb,
  storedMode: GateMode,
  deps: ClassifierShadowReviewDeps
): Promise<GateMode> {
  if (storedMode !== "on") return storedMode;
  return (await isCurrentClassifierReviewed(scopedDb, deps)) ? "on" : "shadow";
}
